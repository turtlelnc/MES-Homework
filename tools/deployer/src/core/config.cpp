// 校园作业分析 · 桌面部署器 —— 平台默认值 / 环境文件 / 选项校验
#include "core/core.h"
#include "core/core_util.h"
#include "platform/platform.h"

#include <cctype>
#include <cstdlib>
#include <ctime>
#include <string>

namespace mes::core {

const char* const kVersion = MES_VERSION_STRING;
const char* const kBuild = MES_BUILD_STRING;
const char* const kReleaseTag = MES_VERSION_STRING;
const char* const kRepoSlug = "turtlelnc/MES-Homework";

namespace {

// 用户主目录；极端环境（无 HOME/USERPROFILE）时回退到当前目录，保证路径可用。
std::string userHome() {
  std::string home = mes::platform::homeDir();
  if (!home.empty()) return home;
  std::string current = mes::platform::currentDir();
  if (!current.empty()) return current;
  return ".";
}

// Windows 文件/目录名非法字符与危险路径片段。
std::string validatePathText(const std::string& path, const std::string& label) {
  if (path.empty()) return label + "不能为空";
  if (path.size() > 240)
    return label + "过长（超过 240 个字符可能导致 Node.js 无法加载深层依赖）";
  for (char raw : path) {
    if (static_cast<unsigned char>(raw) < 0x20)
      return label + "包含控制字符，请重新选择";
  }
  const std::string invalid = "<>\"|?*";
  for (char ch : path) {
    if (invalid.find(ch) != std::string::npos)
      return label + "包含非法字符：" + std::string(1, ch);
  }
  // 逐段检查 ".." 与首尾空格/点（Windows 会静默去掉尾随空格和点）。
  std::string segment;
  std::string normalized = path;
  normalized.push_back('/');
  for (char ch : normalized) {
    if (ch == '/' || ch == '\\') {
      if (segment == "..") return label + "不能包含上级目录（..）";
      if (!segment.empty() && (segment.back() == ' ' || segment.back() == '.'))
        return label + "包含以空格或点结尾的目录名，Windows 无法可靠创建";
      segment.clear();
    } else {
      segment.push_back(ch);
    }
  }
  return {};
}

}  // namespace

const char* editionName(Edition edition) {
  return edition == Edition::Local ? "本地版" : "服务器版";
}
const char* editionTagline(Edition edition) {
  return edition == Edition::Local ? "在这台电脑上直接使用"
                                   : "部署为局域网/公网可访问的服务";
}
const char* editionDescription(Edition edition) {
  return edition == Edition::Local
             ? "数据保存在本机，只监听 127.0.0.1，安装后自动打开浏览器。"
             : "监听局域网，支持开机自启、防火墙与数据目录分离，适合班级/学校服务器。";
}

const char* currentOsSlug() {
#if defined(_WIN32)
  return "windows";
#elif defined(__APPLE__)
  return "macos";
#elif defined(__linux__)
  return "linux";
#else
  return "unknown";
#endif
}

const char* currentArchSlug() {
#if defined(__x86_64__) || defined(_M_X64)
  return "x64";
#elif defined(__aarch64__) || defined(_M_ARM64)
  return "arm64";
#elif defined(__i386__) || defined(_M_IX86)
  return "x86";
#else
  return "unknown";
#endif
}

PlatformInfo detectPlatform() {
  PlatformInfo info;
  info.os = currentOsSlug();
  info.arch = currentArchSlug();
  info.osLabel = mes::platform::osVersionLabel();
  if (info.osLabel.empty()) {
    if (info.os == "windows")
      info.osLabel = "Windows";
    else if (info.os == "macos")
      info.osLabel = "macOS";
    else
      info.osLabel = info.os == "linux" ? "Linux" : "未识别的系统";
  }
  if (info.arch == "x64")
    info.archLabel = "64 位（x64）";
  else if (info.arch == "arm64")
    info.archLabel = "ARM 64 位（arm64）";
  else
    info.archLabel = info.arch == "x86" ? "32 位（x86）" : "未识别的架构";
  info.appRuntimeSupported = (info.arch == "x64" || info.arch == "arm64") &&
      (info.os == "windows" || info.os == "linux" ||
       (info.os == "macos" && info.arch == "arm64"));
  if (!info.appRuntimeSupported) {
    info.runtimeNote = info.arch == "x86"
        ? "当前是 32 位系统：官方 Node.js 24 已不再提供 32 位运行时，应用无法运行。"
          "请改用受支持的 64 位设备或服务器。"
        : "当前系统/架构没有本项目的应用运行时包，不能推测为其他平台。";
  } else {
    info.runtimeNote = "系统架构受支持，将安装自带 Node.js 24 运行时。";
  }
  return info;
}

std::string defaultInstallDir(Edition edition) {
  return mes::platform::joinPath(userHome(),
                                 edition == Edition::Local ? ".mes-homework"
                                                           : "mes-homework-server");
}

std::string defaultDataDir(const Options& options) {
  return mes::platform::joinPath(installDirOf(options), "data");
}

std::string installDirOf(const Options& options) {
  return options.installDir.empty() ? defaultInstallDir(options.edition)
                                    : options.installDir;
}

std::string dataDirOf(const Options& options) {
  return options.dataDir.empty() ? defaultDataDir(options) : options.dataDir;
}

std::string validateOptions(const Options& options) {
  if (options.port < 1 || options.port > 65535)
    return "端口需在 1-65535 之间（默认 8787）";
  if (options.port < 1024 && options.edition == Edition::Server)
    return "服务器版端口需 ≥ 1024（1024 以下端口在 Linux/macOS 上需要 root 权限）";
  if (!options.payloadZip.empty() && !options.payloadDir.empty())
    return "不能同时指定本地安装包（payloadZip）与本地应用目录（payloadDir）";
  if (!options.payloadUrl.empty() && !options.payloadZip.empty())
    return "不能同时指定在线下载地址（payloadUrl）与本地安装包（payloadZip）";

  const std::string installDir = installDirOf(options);
  std::string pathError = validatePathText(installDir, "安装目录");
  if (!pathError.empty()) return pathError;
  if (!isAbsolutePath(installDir))
    return "安装目录必须是绝对路径：" + installDir;
  const std::string dataDir = dataDirOf(options);
  pathError = validatePathText(dataDir, "数据目录");
  if (!pathError.empty()) return pathError;
  if (!isAbsolutePath(dataDir)) return "数据目录必须是绝对路径：" + dataDir;
  if (normalizeSlashes(installDir) == normalizeSlashes(dataDir))
    return "数据目录不能与安装目录相同（需要独立保存数据库与上传文件）";

  if (!options.payloadZip.empty()) {
    if (!mes::platform::fileExists(options.payloadZip))
      return "找不到本地安装包：" + options.payloadZip;
  }
  if (!options.payloadDir.empty()) {
    if (!mes::platform::dirExists(options.payloadDir))
      return "找不到本地应用目录：" + options.payloadDir;
  }
  if (!options.payloadUrl.empty()) {
    if (options.payloadUrl.rfind("https://", 0) != 0 &&
        options.payloadUrl.rfind("http://", 0) != 0)
      return "下载地址必须以 http:// 或 https:// 开头";
  }
  if (!options.releaseTag.empty() && options.releaseTag.find_first_of(" /\\?#") !=
                                        std::string::npos)
    return "Release 版本号包含非法字符：" + options.releaseTag;
  if (!options.embedDemoPayload && !options.payloadDir.empty()) {
    // 本地应用目录模式要求目录里至少有启动脚本。
    const std::string entry =
        mes::platform::joinPath(options.payloadDir, "server/index.mjs");
    const std::string package = mes::platform::joinPath(options.payloadDir,
                                                        "package.json");
    if (!mes::platform::fileExists(entry) && !mes::platform::fileExists(package))
      return "本地应用目录看起来不是有效安装包（缺少 server/index.mjs 或 package.json）：" +
             options.payloadDir;
  }
  return {};
}

std::string generateSecret() {
  // 48 字节 → 96 位十六进制，满足 server 对 ≥32 位随机密钥的要求。
  std::string secret = mes::platform::randomHex(48);
  return secret;
}

std::string envFileContent(const Options& options, const std::string& secret, const std::string& existing) {
  std::string content;
  content += "# 校园作业分析 · 由桌面部署器自动生成，请勿提交到版本库\n";
  content += "APP_SECRET=" + envValue(secret, false) + "\n";
  content += "PORT=" + std::to_string(options.port) + "\n";
  content += "HOST=" + std::string(options.lan ? "0.0.0.0" : "127.0.0.1") + "\n";
  content += "NODE_ENV=" +
             std::string(options.production ? "production" : "development") + "\n";
  content += "DATA_DIR=" + envValue(dataDirOf(options), true) + "\n";
  size_t position = 0;
  while (position < existing.size()) {
    size_t end = existing.find('\n', position);
    if (end == std::string::npos) end = existing.size();
    const std::string line = existing.substr(position, end - position);
    std::string key = trimText(line.substr(0, line.find('=')));
    if (key.rfind("export ", 0) == 0) key = trimText(key.substr(7));
    if (key != "APP_SECRET" && key != "PORT" && key != "HOST" &&
        key != "NODE_ENV" && key != "DATA_DIR")
      content += line + "\n";
    position = end + 1;
  }
  return content;
}

std::string stateFilePath() {
  return mes::platform::joinPath(userHome(), ".mes-homework-deployer.json");
}

std::string logFilePath(const Options& options) {
  return mes::platform::joinPath(installDirOf(options), "deployer.log");
}

std::string isoNow() {
  std::time_t now = std::time(nullptr);
  std::tm tm{};
#if defined(_WIN32)
  gmtime_s(&tm, &now);
#else
  gmtime_r(&now, &tm);
#endif
  char buffer[32] = {0};
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buffer;
}

// ---------------------------------------------------------------- core_util 实现
bool isAbsolutePath(const std::string& path) {
  if (path.empty()) return false;
  if (path[0] == '/' || path[0] == '\\') return true;
  if (path.size() >= 3 && std::isalpha(static_cast<unsigned char>(path[0])) &&
      path[1] == ':' && (path[2] == '/' || path[2] == '\\'))
    return true;
  return false;
}

std::string normalizeSlashes(const std::string& path) {
  std::string normalized = path;
  for (char& ch : normalized) {
    if (ch == '\\') ch = '/';
  }
  return normalized;
}

std::string trimText(const std::string& text) {
  size_t begin = 0;
  size_t end = text.size();
  while (begin < end && std::isspace(static_cast<unsigned char>(text[begin])))
    ++begin;
  while (end > begin &&
         std::isspace(static_cast<unsigned char>(text[end - 1])))
    --end;
  return text.substr(begin, end - begin);
}

std::string envValue(const std::string& value, bool isPathLike) {
  std::string normalized = isPathLike ? normalizeSlashes(value) : value;
  // 去掉换行/回车，防止 .env 行结构被破坏。
  std::string cleaned;
  cleaned.reserve(normalized.size());
  for (char ch : normalized) {
    if (ch == '\r' || ch == '\n') continue;
    cleaned.push_back(ch);
  }
  const bool simple = [&cleaned]() {
    if (cleaned.empty()) return false;
    for (char raw : cleaned) {
      const unsigned char ch = static_cast<unsigned char>(raw);
      const bool alpha = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
      const bool digit = ch >= '0' && ch <= '9';
      if (!alpha && !digit && ch != '_' && ch != '.' && ch != '/' && ch != '-' &&
          ch != ':' && ch != '=' && ch != ',' && ch != '+')
        return false;
    }
    return true;
  }();
  if (simple && !isPathLike) return cleaned;
  // 路径类值统一加双引号（Node 的 --env-file 会把引号内容原样作为值），
  // 这样含空格/中文的安装目录都能稳定解析；路径已转成正斜杠且无换行，
  // 双引号值里只解释 \n、\r 转义，因此不会出现转义问题。
  std::string quoted = "\"";
  for (char ch : cleaned) {
    if (ch == '"') continue;  // Windows 路径不允许 "，遇到只可能来自异常输入
    quoted.push_back(ch);
  }
  quoted.push_back('"');
  return quoted;
}

std::string cmdQuote(const std::string& value) {
  // cmd 用双引号包裹；内部 % 需要写成 %% 才能在 .cmd 里避免被展开。
  std::string quoted = "\"";
  for (char ch : value) {
    if (ch == '%') {
      quoted += "%%";
      continue;
    }
    quoted.push_back(ch);
  }
  quoted.push_back('"');
  return quoted;
}

std::string maskSecret(const std::string& secret) {
  if (secret.size() <= 8) return "********";
  return secret.substr(0, 4) + "…" + secret.substr(secret.size() - 4);
}

// ---------------------------------------------------------------- 路径推导
std::string hostOf(const Options& options) {
  return options.lan ? "0.0.0.0" : "127.0.0.1";
}

std::string nodeEnvOf(const Options& options) {
  return options.production ? "production" : "development";
}

std::string appDirOf(const Options& options) {
  return mes::platform::joinPath(installDirOf(options), "app");
}

std::string serverEntryOf(const Options& options) {
  return mes::platform::joinPath(appDirOf(options), "server/index.mjs");
}

std::string launchEntryOf(const Options& options) {
  const std::string supervisor=mes::platform::joinPath(appDirOf(options),"tools/ops/supervise.mjs");
  return mes::platform::fileExists(supervisor)?supervisor:serverEntryOf(options);
}

std::string logsDirOf(const Options& options) {
  return mes::platform::joinPath(installDirOf(options), "logs");
}

std::string serverLogOf(const Options& options) {
  return mes::platform::joinPath(logsDirOf(options), "server.log");
}

std::string envFileOf(const Options& options) {
  return mes::platform::joinPath(installDirOf(options), ".env");
}

std::string platformNodeOf(const Options& options) {
#if defined(_WIN32)
  return mes::platform::joinPath(installDirOf(options), "runtime/node.exe");
#else
  return mes::platform::joinPath(installDirOf(options), "runtime/node");
#endif
}

std::string startScriptPathOf(const Options& options) {
#if defined(_WIN32)
  return mes::platform::joinPath(installDirOf(options), "start.cmd");
#else
  return mes::platform::joinPath(installDirOf(options), "start.sh");
#endif
}

std::string serviceDefinitionPathOf(const Options& options) {
#if defined(_WIN32)
  return mes::platform::joinPath(installDirOf(options), "mes-homework-task.xml");
#elif defined(__APPLE__)
  return mes::platform::joinPath(installDirOf(options), "MES-Homework.plist");
#else
  return mes::platform::joinPath(installDirOf(options), "MES-Homework.service");
#endif
}

std::string instancePidPathOf(const Options& options) {
  return mes::platform::joinPath(installDirOf(options), "instance.pid");
}

std::string elevatedResultPathOf(const Options& options) {
  return mes::platform::joinPath(installDirOf(options), ".elevated-result");
}

}  // namespace mes::core
