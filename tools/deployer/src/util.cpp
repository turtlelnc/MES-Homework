// 校园作业分析 · 一键部署器 —— 基础设施层实现（Win32 + C++17）
#include "util.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <shlobj.h>  // SHCreateDirectoryExW

#include <iphlpapi.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <sstream>

namespace sc {

// ============================ 编解码与控制台 ============================

std::wstring utf8ToWide(const std::string &text) {
  if (text.empty()) return std::wstring();
  int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), nullptr, 0);
  std::wstring out((size_t)size, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), &out[0], size);
  return out;
}

std::string wideToUtf8(const std::wstring &text) {
  if (text.empty()) return std::string();
  int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.size(), nullptr, 0, nullptr,
                                 nullptr);
  std::string out((size_t)size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.size(), &out[0], size, nullptr, nullptr);
  return out;
}

namespace {
bool g_ansi = false;
bool g_consoleReady = false;
}  // namespace

void initConsole() {
  if (g_consoleReady) return;
  g_consoleReady = true;
  // 输入输出都切到 UTF-8，中文与 emoji 才能正确显示
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (out != INVALID_HANDLE_VALUE && out != nullptr) {
    DWORD mode = 0;
    if (GetConsoleMode(out, &mode)) {
      // ENABLE_VIRTUAL_TERMINAL_PROCESSING：让 Win10 控制台支持 ANSI 颜色
      if (SetConsoleMode(out, mode | 0x0004)) g_ansi = true;
    }
  }
}

void setColor(Color color) {
  if (!g_ansi) return;
  const char *code = "";
  switch (color) {
    case Color::Dim: code = "\x1b[90m"; break;
    case Color::Red: code = "\x1b[31m"; break;
    case Color::Green: code = "\x1b[32m"; break;
    case Color::Yellow: code = "\x1b[33m"; break;
    case Color::Blue: code = "\x1b[34m"; break;
    case Color::Cyan: code = "\x1b[36m"; break;
    case Color::Bold: code = "\x1b[1m"; break;
    default: code = "\x1b[0m"; break;
  }
  std::fputs(code, stdout);
}

void resetColor() {
  if (!g_ansi) return;
  std::fputs("\x1b[0m", stdout);
}

namespace {
LogSink g_sink;

struct LevelStyle {
  Color color;
  const char *prefix;
};

LevelStyle styleFor(const std::string &level) {
  if (level == "step") return {Color::Blue, "▶ "};
  if (level == "ok") return {Color::Green, "✔ "};
  if (level == "warn") return {Color::Yellow, "! "};
  if (level == "error") return {Color::Red, "✘ "};
  if (level == "detail") return {Color::Dim, "    "};
  return {Color::Default, "  "};
}

void emit(const std::string &level, const std::string &message) {
  LevelStyle style = styleFor(level);
  setColor(style.color);
  std::fputs(style.prefix, stdout);
  resetColor();
  std::fputs(message.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
  if (g_sink) g_sink(level, message);
}
}  // namespace

void setLogSink(LogSink sink) { g_sink = std::move(sink); }

void logInfo(const std::string &message) { emit("info", message); }
void logStep(const std::string &message) { emit("step", message); }
void logOk(const std::string &message) { emit("ok", message); }
void logWarn(const std::string &message) { emit("warn", message); }
void logError(const std::string &message) { emit("error", message); }
void logDetail(const std::string &message) { emit("detail", message); }

// ============================ 字符串工具 ============================

std::string trim(const std::string &text) {
  size_t begin = text.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) return "";
  size_t end = text.find_last_not_of(" \t\r\n");
  return text.substr(begin, end - begin + 1);
}

std::string toLower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(),
                 [](unsigned char c) { return (char)std::tolower(c); });
  return text;
}

bool startsWith(const std::string &text, const std::string &prefix) {
  return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

bool endsWith(const std::string &text, const std::string &suffix) {
  return text.size() >= suffix.size() &&
         text.compare(text.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool contains(const std::string &text, const std::string &needle) {
  return text.find(needle) != std::string::npos;
}

std::vector<std::string> splitLines(const std::string &text) {
  std::vector<std::string> lines;
  std::string current;
  for (char ch : text) {
    if (ch == '\n') {
      if (!current.empty() && current.back() == '\r') current.pop_back();
      lines.push_back(current);
      current.clear();
    } else {
      current.push_back(ch);
    }
  }
  if (!current.empty()) lines.push_back(current);
  return lines;
}

std::string replaceAll(std::string text, const std::string &from, const std::string &to) {
  if (from.empty()) return text;
  size_t pos = 0;
  while ((pos = text.find(from, pos)) != std::string::npos) {
    text.replace(pos, from.size(), to);
    pos += to.size();
  }
  return text;
}

std::string urlEncode(const std::string &text) {
  static const char *hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : text) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back((char)c);
    } else {
      out.push_back('%');
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 0x0F]);
    }
  }
  return out;
}

std::string jsonEscape(const std::string &text) {
  std::string out;
  for (unsigned char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back((char)c);
        }
    }
  }
  return out;
}

std::string randomHex(int bytes) {
  std::random_device device;
  std::mt19937_64 engine(((uint64_t)device() << 32) ^ device() ^ (uint64_t)GetTickCount64());
  static const char *hex = "0123456789abcdef";
  std::string out;
  for (int i = 0; i < bytes; ++i) {
    unsigned value = (unsigned)(engine() & 0xFF);
    out.push_back(hex[value >> 4]);
    out.push_back(hex[value & 0x0F]);
  }
  return out;
}

// ============================ 文件系统 ============================

bool pathExists(const std::string &utf8Path) {
  return GetFileAttributesW(utf8ToWide(utf8Path).c_str()) != INVALID_FILE_ATTRIBUTES;
}

bool isDirectory(const std::string &utf8Path) {
  DWORD attributes = GetFileAttributesW(utf8ToWide(utf8Path).c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

bool isFile(const std::string &utf8Path) {
  DWORD attributes = GetFileAttributesW(utf8ToWide(utf8Path).c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

bool makeDirs(const std::string &utf8Path) {
  if (utf8Path.empty()) return false;
  if (isDirectory(utf8Path)) return true;
  std::wstring wide = utf8ToWide(utf8Path);
  int result = SHCreateDirectoryExW(nullptr, wide.c_str(), nullptr);
  return result == ERROR_SUCCESS || result == ERROR_ALREADY_EXISTS ||
         isDirectory(utf8Path);
}

bool writeFileUtf8(const std::string &utf8Path, const std::string &content) {
  std::ofstream file(utf8ToWide(utf8Path).c_str(), std::ios::binary | std::ios::trunc);
  if (!file) return false;
  file.write(content.data(), (std::streamsize)content.size());
  return file.good();
}

bool readFileUtf8(const std::string &utf8Path, std::string &out) {
  std::ifstream file(utf8ToWide(utf8Path).c_str(), std::ios::binary);
  if (!file) return false;
  std::ostringstream buffer;
  buffer << file.rdbuf();
  out = buffer.str();
  return true;
}

std::string joinPath(const std::string &a, const std::string &b) {
  if (a.empty()) return b;
  if (b.empty()) return a;
  std::string out = a;
  if (out.back() != '\\' && out.back() != '/') out.push_back('\\');
  size_t begin = b.find_first_not_of("\\/");
  out += (begin == std::string::npos) ? "" : b.substr(begin);
  return out;
}

std::string parentDir(const std::string &utf8Path) {
  std::string path = utf8Path;
  while (!path.empty() && (path.back() == '\\' || path.back() == '/')) path.pop_back();
  size_t pos = path.find_last_of("\\/");
  if (pos == std::string::npos) return path;
  return path.substr(0, pos);
}

std::string baseName(const std::string &utf8Path) {
  std::string path = utf8Path;
  while (!path.empty() && (path.back() == '\\' || path.back() == '/')) path.pop_back();
  size_t pos = path.find_last_of("\\/");
  return pos == std::string::npos ? path : path.substr(pos + 1);
}

std::string currentDir() {
  DWORD size = GetCurrentDirectoryW(0, nullptr);
  std::wstring buffer((size_t)size, L'\0');
  GetCurrentDirectoryW(size, &buffer[0]);
  if (!buffer.empty() && buffer.back() == L'\0') buffer.pop_back();
  return wideToUtf8(buffer);
}

std::string envVar(const std::string &name) {
  std::wstring wideName = utf8ToWide(name);
  DWORD size = GetEnvironmentVariableW(wideName.c_str(), nullptr, 0);
  if (size == 0) return "";
  std::wstring buffer((size_t)size, L'\0');
  GetEnvironmentVariableW(wideName.c_str(), &buffer[0], size);
  if (!buffer.empty() && buffer.back() == L'\0') buffer.pop_back();
  return wideToUtf8(buffer);
}

uint64_t fileSize(const std::string &utf8Path) {
  WIN32_FILE_ATTRIBUTE_DATA data{};
  if (!GetFileAttributesExW(utf8ToWide(utf8Path).c_str(), GetFileExInfoStandard, &data))
    return 0;
  return ((uint64_t)data.nFileSizeHigh << 32) | data.nFileSizeLow;
}

bool copyTree(const std::string &from, const std::string &to, std::string &error) {
  if (!makeDirs(to)) {
    error = "无法创建目录：" + to;
    return false;
  }
  std::wstring pattern = utf8ToWide(joinPath(from, "*"));
  WIN32_FIND_DATAW data{};
  HANDLE handle = FindFirstFileW(pattern.c_str(), &data);
  if (handle == INVALID_HANDLE_VALUE) {
    error = "无法枚举目录：" + from;
    return false;
  }
  bool ok = true;
  do {
    std::wstring name = data.cFileName;
    if (name == L"." || name == L"..") continue;
    std::string childFrom = joinPath(from, wideToUtf8(name));
    std::string childTo = joinPath(to, wideToUtf8(name));
    if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      if (!copyTree(childFrom, childTo, error)) ok = false;
    } else if (!CopyFileW(utf8ToWide(childFrom).c_str(), utf8ToWide(childTo).c_str(), FALSE)) {
      error = "无法复制文件：" + childFrom;
      ok = false;
    }
  } while (FindNextFileW(handle, &data));
  FindClose(handle);
  return ok;
}

// ============================ 进程 ============================

namespace {
std::vector<HANDLE> g_background;
std::string tempPath(const std::string &name) {
  return joinPath(envVar("TEMP").empty() ? "." : envVar("TEMP"), name);
}
}  // namespace

ProcessResult runProcess(const std::string &commandLine, const std::string &workingDir,
                         const std::function<void(const std::string &line)> &onLine) {
  ProcessResult result;
  // 通过 cmd.exe 执行，兼容 npm.cmd / 内置命令 / 引号参数
  std::string full = "cmd.exe /d /s /c \"" + commandLine + "\"";
  std::wstring wideCommand = utf8ToWide(full);
  std::vector<wchar_t> buffer(wideCommand.begin(), wideCommand.end());
  buffer.push_back(L'\0');

  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE readEnd = nullptr, writeEnd = nullptr;
  if (!CreatePipe(&readEnd, &writeEnd, &attributes, 0)) {
    result.output = "创建管道失败";
    return result;
  }
  SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdOutput = writeEnd;
  startup.hStdError = writeEnd;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

  PROCESS_INFORMATION info{};
  std::wstring wideDir = utf8ToWide(workingDir);
  BOOL created = CreateProcessW(nullptr, buffer.data(), nullptr, nullptr, TRUE,
                                CREATE_NO_WINDOW, nullptr,
                                workingDir.empty() ? nullptr : wideDir.c_str(), &startup, &info);
  CloseHandle(writeEnd);
  if (!created) {
    CloseHandle(readEnd);
    result.output = "无法启动命令：" + commandLine;
    return result;
  }
  result.started = true;

  std::string pending;
  char chunk[4096];
  DWORD read = 0;
  for (;;) {
    BOOL ok = ReadFile(readEnd, chunk, sizeof(chunk), &read, nullptr);
    if (!ok || read == 0) break;
    pending.append(chunk, read);
    size_t pos;
    while ((pos = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, pos);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      result.output += line;
      result.output.push_back('\n');
      if (onLine) onLine(line);
      pending.erase(0, pos + 1);
    }
  }
  if (!pending.empty()) {
    result.output += pending;
    if (onLine) onLine(pending);
  }
  CloseHandle(readEnd);

  WaitForSingleObject(info.hProcess, INFINITE);
  DWORD exitCode = 0;
  GetExitCodeProcess(info.hProcess, &exitCode);
  result.exitCode = (int)exitCode;
  CloseHandle(info.hThread);
  CloseHandle(info.hProcess);
  return result;
}

void *startBackground(const std::string &commandLine, const std::string &workingDir,
                      unsigned long *outPid) {
  std::string full = "cmd.exe /d /s /c \"" + commandLine + "\"";
  std::wstring wideCommand = utf8ToWide(full);
  std::vector<wchar_t> buffer(wideCommand.begin(), wideCommand.end());
  buffer.push_back(L'\0');

  // 后台服务保留自己的控制台窗口，便于老师直接看到运行日志
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION info{};
  std::wstring wideDir = utf8ToWide(workingDir);
  BOOL created = CreateProcessW(nullptr, buffer.data(), nullptr, nullptr, FALSE,
                                CREATE_NEW_PROCESS_GROUP, nullptr,
                                workingDir.empty() ? nullptr : wideDir.c_str(), &startup, &info);
  if (!created) return nullptr;
  if (outPid) *outPid = info.dwProcessId;
  CloseHandle(info.hThread);
  g_background.push_back(info.hProcess);
  return info.hProcess;
}

bool killProcess(void *handle) {
  if (!handle) return false;
  HANDLE process = (HANDLE)handle;
  // 先尝试温和结束进程树，再强制
  std::string pid = std::to_string(GetProcessId(process));
  runProcess("taskkill /PID " + pid + " /T /F >nul 2>&1", "", nullptr);
  return true;
}

bool stopProcessGracefully(void *handle, int waitMs) {
  if (!handle) return false;
  HANDLE process = (HANDLE)handle;
  if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) return true;
  std::string pid = std::to_string(GetProcessId(process));
  runProcess("taskkill /PID " + pid + " /T >nul 2>&1", "", nullptr);
  if (WaitForSingleObject(process, (DWORD)waitMs) == WAIT_OBJECT_0) return true;
  runProcess("taskkill /PID " + pid + " /T /F >nul 2>&1", "", nullptr);
  return WaitForSingleObject(process, 3000) == WAIT_OBJECT_0;
}

bool isProcessRunning(void *handle) {
  if (!handle) return false;
  return WaitForSingleObject((HANDLE)handle, 0) == WAIT_TIMEOUT;
}

void closeProcess(void *handle) {
  if (!handle) return;
  HANDLE process = (HANDLE)handle;
  for (size_t i = 0; i < g_background.size(); ++i) {
    if (g_background[i] == process) {
      g_background.erase(g_background.begin() + (long)i);
      break;
    }
  }
  CloseHandle(process);
}

void killAllBackground() {
  for (HANDLE process : g_background) {
    if (WaitForSingleObject(process, 0) == WAIT_TIMEOUT) {
      std::string pid = std::to_string(GetProcessId(process));
      runProcess("taskkill /PID " + pid + " /T /F >nul 2>&1", "", nullptr);
    }
    CloseHandle(process);
  }
  g_background.clear();
}

void openInShell(const std::string &target) {
  std::wstring wide = utf8ToWide(target);
  ShellExecuteW(nullptr, L"open", wide.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// ============================ HTTP（基于系统 curl.exe） ============================

namespace {
bool ensureWinsock() {
  static bool ready = false;
  if (!ready) {
    WSADATA data{};
    ready = WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }
  return ready;
}
}  // namespace

HttpResponse httpRequest(const std::string &url, const std::string &method,
                         const std::vector<std::string> &headers, const std::string &body) {
  HttpResponse response;
  std::string configPath = tempPath("sc-deploy-curl-" + randomHex(6) + ".cfg");
  std::string bodyPath;
  std::ostringstream config;
  config << "url = \"" << url << "\"\n";
  config << "request = \"" << method << "\"\n";
  config << "silent\nshow-error\nlocation\nmax-time = 120\n";
  config << "write-out = \"\\n%{http_code}\"\n";
  for (const std::string &header : headers) config << "header = \"" << header << "\"\n";
  if (!body.empty()) {
    bodyPath = tempPath("sc-deploy-body-" + randomHex(6) + ".tmp");
    writeFileUtf8(bodyPath, body);
    config << "data-binary = \"@" << bodyPath << "\"\n";
  }
  if (!writeFileUtf8(configPath, config.str())) {
    response.error = "无法写入 curl 配置";
    return response;
  }

  ProcessResult result =
      runProcess("curl.exe --config \"" + configPath + "\"", "", nullptr);
  DeleteFileW(utf8ToWide(configPath).c_str());
  if (!bodyPath.empty()) DeleteFileW(utf8ToWide(bodyPath).c_str());

  if (!result.started) {
    response.error = "未找到 curl.exe（Windows 10 1803+ 系统自带）";
    return response;
  }
  response.started = true;
  std::string output = result.output;
  size_t pos = output.find_last_of('\n');
  std::string statusText = (pos == std::string::npos) ? "" : trim(output.substr(pos + 1));
  response.body = (pos == std::string::npos) ? output : output.substr(0, pos);
  try {
    response.status = std::stol(statusText);
  } catch (...) {
    response.status = 0;
  }
  response.ok = response.status >= 200 && response.status < 300;
  if (!response.ok && response.error.empty())
    response.error = "HTTP " + std::to_string(response.status);
  return response;
}

HttpResponse httpGet(const std::string &url, const std::vector<std::string> &headers) {
  return httpRequest(url, "GET", headers, "");
}

HttpResponse httpPostJson(const std::string &url, const std::string &json,
                          const std::vector<std::string> &extraHeaders) {
  std::vector<std::string> headers = {"content-type: application/json"};
  headers.insert(headers.end(), extraHeaders.begin(), extraHeaders.end());
  return httpRequest(url, "POST", headers, json);
}

bool downloadFile(const std::string &url, const std::string &targetPath,
                  const std::function<void(int)> &onProgress) {
  std::string dir = parentDir(targetPath);
  if (!dir.empty()) makeDirs(dir);
  ProcessResult result = runProcess(
      "curl.exe -L --fail --silent --show-error -o \"" + targetPath + "\" \"" + url + "\"", "",
      [&](const std::string &line) {
        if (onProgress && !line.empty()) onProgress(-1);
      });
  if (result.exitCode != 0) return false;
  return isFile(targetPath) && fileSize(targetPath) > 0;
}

bool hasCommand(const std::string &command) {
  ProcessResult result = runProcess("where " + command + " >nul 2>&1", "", nullptr);
  return result.exitCode == 0;
}

// ============================ 网络 ============================

std::vector<std::string> localIPv4Addresses() {
  std::vector<std::string> addresses;
  if (!ensureWinsock()) return addresses;

  ULONG size = 16 * 1024;
  std::vector<char> buffer(size);
  ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
  ULONG status = GetAdaptersAddresses(AF_INET, flags, nullptr,
                                      (IP_ADAPTER_ADDRESSES *)buffer.data(), &size);
  if (status == ERROR_BUFFER_OVERFLOW) {
    buffer.resize(size);
    status = GetAdaptersAddresses(AF_INET, flags, nullptr,
                                  (IP_ADAPTER_ADDRESSES *)buffer.data(), &size);
  }
  if (status != NO_ERROR) return addresses;

  for (IP_ADAPTER_ADDRESSES *adapter = (IP_ADAPTER_ADDRESSES *)buffer.data(); adapter;
       adapter = adapter->Next) {
    if (adapter->OperStatus != IfOperStatusUp) continue;
    if (adapter->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
    for (IP_ADAPTER_UNICAST_ADDRESS *unicast = adapter->FirstUnicastAddress; unicast;
         unicast = unicast->Next) {
      if (unicast->Address.lpSockaddr->sa_family != AF_INET) continue;
      char text[INET_ADDRSTRLEN] = {0};
      sockaddr_in *addr = (sockaddr_in *)unicast->Address.lpSockaddr;
      if (!inet_ntop(AF_INET, &addr->sin_addr, text, sizeof(text))) continue;
      std::string ip = text;
      if (startsWith(ip, "127.") || startsWith(ip, "169.254.")) continue;
      if (std::find(addresses.begin(), addresses.end(), ip) == addresses.end())
        addresses.push_back(ip);
    }
  }
  return addresses;
}

bool portInUse(int port) {
  if (!ensureWinsock()) return false;
  SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock == INVALID_SOCKET) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((u_short)port);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  bool inUse = connect(sock, (sockaddr *)&addr, sizeof(addr)) == 0;
  closesocket(sock);
  return inUse;
}

// ============================ 命令行 ============================

std::string Args::get(const std::string &key, const std::string &fallback) const {
  for (const auto &item : items)
    if (item.first == key) return item.second;
  return fallback;
}

bool isTrue(const std::string &value) {
  std::string text = toLower(trim(value));
  return text == "true" || text == "1" || text == "yes" || text == "on" || text == "是";
}

Args parseArgs(int argc, char **argv) {
  Args args;
  for (int i = 1; i < argc; ++i) {
    std::string token = argv[i];
    if (token.empty() || token[0] != '-') continue;
    std::string key = token;
    while (!key.empty() && key[0] == '-') key.erase(key.begin());
    std::string value;
    size_t equals = key.find('=');
    if (equals != std::string::npos) {
      value = key.substr(equals + 1);
      key = key.substr(0, equals);
    } else if (i + 1 < argc && argv[i + 1][0] != '-') {
      value = argv[++i];
    }
    if (value.empty()) value = "true";  // --flag 形式（无取值）视为 true
    args.items.emplace_back(toLower(key), value);
  }
  args.mode = toLower(args.get("mode"));
  args.domain = args.get("domain");
  args.tunnelToken = args.get("tunnel-token", args.get("token"));
  args.apiToken = args.get("api-token");
  args.dir = args.get("dir");
  args.repo = args.get("repo");
  args.web = isTrue(args.get("web"));
  args.yes = isTrue(args.get("yes"));
  args.verbose = isTrue(args.get("verbose"));
  args.help = isTrue(args.get("help"));
  args.version = isTrue(args.get("version"));
  args.skipInstall = isTrue(args.get("skip-install"));
  args.skipBuild = isTrue(args.get("skip-build"));
  args.tunnelId = args.get("tunnel-id");
  try {
    if (!args.get("port").empty()) args.port = std::stoi(args.get("port"));
  } catch (...) {
  }
  try {
    if (!args.get("web-port").empty()) args.webPort = std::stoi(args.get("web-port"));
  } catch (...) {
  }
  return args;
}

}  // namespace sc
