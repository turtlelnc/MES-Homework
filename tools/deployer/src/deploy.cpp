// 校园作业分析 · 一键部署器 —— 部署核心实现
#include "deploy.h"

#include <windows.h>

#include <algorithm>
#include <sstream>

#include "cloudflare.h"
#include "util.h"

namespace sc {

namespace {
const char *kNodeWingetId = "OpenJS.NodeJS";
const char *kCloudflaredWingetId = "Cloudflare.cloudflared";

/// 从 node -v 输出解析主版本号；失败返回 -1。
int parseNodeMajor(const std::string &versionText) {
  std::string text = trim(versionText);
  if (!text.empty() && text[0] == 'v') text.erase(text.begin());
  std::string digits;
  for (char ch : text) {
    if (std::isdigit((unsigned char)ch)) digits.push_back(ch);
    else break;
  }
  if (digits.empty()) return -1;
  try {
    return std::stoi(digits);
  } catch (...) {
    return -1;
  }
}

std::string firstLine(const std::string &text) {
  std::vector<std::string> lines = splitLines(text);
  for (const std::string &line : lines)
    if (!trim(line).empty()) return trim(line);
  return "";
}

/// 在注册表用户 PATH 中追加目录（幂等）。
void appendUserPath(const std::string &dir) {
  std::string current = envVar("PATH");  // 进程内 PATH，仅作回退
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Environment", 0, KEY_READ | KEY_WRITE, &key) !=
      ERROR_SUCCESS)
    return;
  wchar_t buffer[32767] = {0};
  DWORD size = sizeof(buffer) - sizeof(wchar_t);
  DWORD type = 0;
  std::wstring existing;
  if (RegQueryValueExW(key, L"Path", nullptr, &type, (LPBYTE)buffer, &size) == ERROR_SUCCESS)
    existing = buffer;
  std::wstring wideDir = utf8ToWide(dir);
  if (existing.find(wideDir) == std::wstring::npos) {
    if (!existing.empty() && existing.back() != L';') existing.push_back(L';');
    existing += wideDir;
    RegSetValueExW(key, L"Path", 0, REG_EXPAND_SZ, (const BYTE *)existing.c_str(),
                   (DWORD)((existing.size() + 1) * sizeof(wchar_t)));
    // 广播环境变更，让新开的程序能立刻看到
    DWORD_PTR result = 0;
    SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Environment",
                        SMTO_ABORTIFHUNG, 3000, &result);
  }
  RegCloseKey(key);
  (void)current;
}
}  // namespace

std::string modeName(Mode mode) {
  switch (mode) {
    case Mode::Lan: return "局域网（内网）访问";
    case Mode::QuickTunnel: return "Cloudflare 公网隧道（临时域名）";
    case Mode::CustomDomain: return "Cloudflare 自定义域名";
  }
  return "未知模式";
}

Deployer::Deployer() = default;

Deployer::~Deployer() { stop(); }

void Deployer::emit(const std::string &level, const std::string &message) {
  if (logSink_) logSink_(level, message);
}

size_t Deployer::addStep(const std::string &title) {
  steps_.push_back(Step{title, StepState::Pending, ""});
  return steps_.size() - 1;
}

void Deployer::setStep(size_t index, StepState state, const std::string &detail) {
  if (index >= steps_.size()) return;
  steps_[index].state = state;
  if (!detail.empty()) steps_[index].detail = detail;
  report();
}

void Deployer::report() {
  if (!progress_) return;
  size_t done = 0;
  for (const Step &step : steps_)
    if (step.state == StepState::Done || step.state == StepState::Skipped) ++done;
  int percent = steps_.empty() ? 0 : (int)(done * 100 / steps_.size());
  progress_(steps_, percent);
}

std::string Deployer::toolsDir() const {
  std::string local = envVar("LOCALAPPDATA");
  if (local.empty()) local = currentDir();
  return joinPath(joinPath(local, "SmartCampusDeployer"), "tools");
}

void Deployer::registerToolPath(const std::string &dir) {
  appendUserPath(dir);
  // 关键：同时更新当前进程的 PATH，否则本进程后续检测仍然找不到刚装好的命令
  std::string current = envVar("PATH");
  std::wstring wideDir = utf8ToWide(dir);
  if (current.find(dir) == std::string::npos) {
    std::string updated = dir + ";" + current;
    SetEnvironmentVariableW(L"PATH", utf8ToWide(updated).c_str());
  }
  (void)wideDir;
}

// ============================ 环境检测 ============================

bool Deployer::detectNode(std::string &version, std::string &nodePath, std::string &npmPath) {
  ProcessResult node = runProcess("node -v", "", nullptr);
  if (node.exitCode != 0) return false;
  version = firstLine(node.output);
  int major = parseNodeMajor(version);
  if (major < 24) return false;
  ProcessResult nodeWhere = runProcess("where node", "", nullptr);
  nodePath = firstLine(nodeWhere.output);
  ProcessResult npm = runProcess("npm -v", "", nullptr);
  if (npm.exitCode != 0) return false;
  ProcessResult npmWhere = runProcess("where npm.cmd", "", nullptr);
  npmPath = firstLine(npmWhere.output);
  if (npmPath.empty()) {
    ProcessResult npmWhere2 = runProcess("where npm", "", nullptr);
    npmPath = firstLine(npmWhere2.output);
  }
  return true;
}

std::vector<Dependency> Deployer::inspect() {
  std::vector<Dependency> dependencies;

  Dependency node{"node", "Node.js 运行环境", true, false, "", "winget",
                  "要求 24 或更高版本（node:sqlite 内置模块所需）"};
  std::string version, nodePath, npmPath;
  if (detectNode(version, nodePath, npmPath)) {
    node.available = true;
    node.version = version + "（" + nodePath + "）";
    node.note = "版本满足要求";
  } else {
    ProcessResult raw = runProcess("node -v", "", nullptr);
    if (raw.exitCode == 0) {
      node.version = firstLine(raw.output);
      node.note = "版本过低，需要升级到 24 或更高版本";
    } else {
      node.note = "未安装，需要下载安装";
    }
  }
  dependencies.push_back(node);

  Dependency npm{"npm", "npm 包管理器", true, !npmPath.empty(), "", "随 Node.js 安装",
                 npmPath.empty() ? "未检测到，通常随 Node.js 一起安装" : "可用于安装项目依赖"};
  dependencies.push_back(npm);

  ProcessResult curlVersion = runProcess("curl.exe --version", "", nullptr);
  dependencies.push_back(Dependency{"curl", "curl 下载工具", true, curlVersion.exitCode == 0,
                                    curlVersion.exitCode == 0 ? firstLine(curlVersion.output) : "",
                                    "系统自带", "Windows 10 1803 以后自带，用于下载与接口调用"});

  ProcessResult cloudflared = runProcess("cloudflared --version", "", nullptr);
  const bool needTunnel = options_.mode != Mode::Lan;
  dependencies.push_back(Dependency{
      "cloudflared", "cloudflared 隧道客户端", needTunnel, cloudflared.exitCode == 0,
      cloudflared.exitCode == 0 ? firstLine(cloudflared.output) : "", "winget / 官方下载",
      needTunnel ? "公网访问模式必需" : "仅在选择公网访问时需要"});

  ProcessResult git = runProcess("git --version", "", nullptr);
  dependencies.push_back(Dependency{"git", "Git（可选）", false, git.exitCode == 0,
                                    git.exitCode == 0 ? firstLine(git.output) : "",
                                    "MinGit / winget",
                                    "有源码时非必需；没有 git 也能直接下载源码压缩包"});

  return dependencies;
}

bool Deployer::installWithWinget(const std::string &id, const std::string &label) {
  if (!hasCommand("winget")) {
    emit("warn", "未检测到 winget，改用直接下载方式安装 " + label);
    return false;
  }
  emit("info", "使用 winget 安装 " + label + "（" + id + "）…");
  ProcessResult result = runProcess(
      "winget install --id " + id +
          " --exact --silent --accept-package-agreements --accept-source-agreements "
          "--disable-interactivity",
      "", [&](const std::string &line) {
        if (!trim(line).empty() && options_.verbose) emit("detail", line);
      });
  if (result.exitCode == 0) return true;
  // winget 对已安装的包会返回非 0，做一次实际可用性判断
  if (contains(toLower(result.output), "already installed")) return true;
  emit("warn", "winget 安装 " + label + " 未成功（退出码 " +
                   std::to_string(result.exitCode) + "），尝试其它方式");
  return false;
}

bool Deployer::installCloudflaredByDownload(std::string &installedPath) {
  const std::string dir = toolsDir();
  if (!makeDirs(dir)) {
    emit("error", "无法创建目录：" + dir);
    return false;
  }
  const std::string target = joinPath(dir, "cloudflared.exe");
  emit("info", "从 Cloudflare 官方 GitHub Release 下载 cloudflared…");
  const std::string url =
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-"
      "amd64.exe";
  if (!downloadFile(url, target)) {
    emit("error", "cloudflared 下载失败，请检查网络或手动安装后重试");
    return false;
  }
  registerToolPath(dir);
  installedPath = target;
  emit("ok", "cloudflared 已安装到 " + target);
  return true;
}

bool Deployer::installMinGitByDownload() {
  const std::string dir = joinPath(toolsDir(), "MinGit");
  emit("info", "下载 MinGit（可选组件，用于 git 方式获取源码）…");
  const std::string zip = joinPath(toolsDir(), "MinGit.zip");
  const std::string url =
      "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/"
      "MinGit-2.55.0.5-64-bit.zip";
  if (!downloadFile(url, zip)) {
    emit("warn", "MinGit 下载失败，将改用源码压缩包方式（不影响部署）");
    return false;
  }
  if (makeDirs(dir)) {
    ProcessResult extract =
        runProcess("tar.exe -xf \"" + zip + "\" -C \"" + dir + "\"", "", nullptr);
    if (extract.exitCode == 0) {
      registerToolPath(joinPath(dir, "cmd"));
      DeleteFileW(utf8ToWide(zip).c_str());  // 删除临时压缩包
      emit("ok", "MinGit 已安装到 " + dir);
      return true;
    }
  }
  DeleteFileW(utf8ToWide(zip).c_str());
  emit("warn", "MinGit 解压失败，将改用源码压缩包方式");
  return false;
}

bool Deployer::installDependencies(std::vector<Dependency> &dependencies) {
  bool allReady = true;
  for (Dependency &dependency : dependencies) {
    if (dependency.available) continue;
    if (!dependency.required && dependency.id == "git") {
      // git 非必需：优先尝试轻量安装，失败则跳过
      if (!installMinGitByDownload()) {
        dependency.note = "跳过（将使用源码压缩包）";
        dependency.available = false;
      }
      continue;
    }
    if (!dependency.required) continue;

    emit("step", "安装 " + dependency.title + "…");
    bool installed = false;
    if (dependency.id == "node" || dependency.id == "npm") {
      installed = installWithWinget(kNodeWingetId, "Node.js");
    } else if (dependency.id == "cloudflared") {
      installed = installWithWinget(kCloudflaredWingetId, "cloudflared");
      if (!installed) {
        std::string path;
        installed = installCloudflaredByDownload(path);
      }
    } else if (dependency.id == "curl") {
      emit("error", "缺少 curl.exe：本程序依赖 Windows 10 1803 及以上系统自带的 curl");
      installed = false;
    }

    if (!installed) {
      allReady = false;
      emit("error", dependency.title + " 安装失败");
      continue;
    }
    // 重新检测
    std::vector<Dependency> refreshed = inspect();
    for (const Dependency &item : refreshed) {
      if (item.id == dependency.id) {
        dependency.available = item.available;
        dependency.version = item.version;
        dependency.note = item.available ? "安装完成" : item.note;
      }
    }
    if (dependency.available)
      emit("ok", dependency.title + " 已就绪" +
                     (dependency.version.empty() ? "" : "（" + dependency.version + "）"));
    else {
      // winget 安装后当前进程 PATH 未刷新，提示重开
      emit("warn", dependency.title +
                       " 已安装，但当前窗口的环境变量未刷新。若后续步骤报找不到命令，请重新运行本程序。");
      dependency.available = true;
    }
  }
  return allReady;
}

// ============================ 源码准备 ============================

namespace {
bool looksLikeProject(const std::string &dir) {
  return isFile(joinPath(dir, "package.json")) &&
         isFile(joinPath(dir, "server\\index.mjs")) && isDirectory(joinPath(dir, "src"));
}

/// 递归找出目录下最新的修改时间（毫秒时间戳）。
uint64_t newestWriteTime(const std::string &dir) {
  uint64_t newest = 0;
  std::wstring pattern = utf8ToWide(joinPath(dir, "*"));
  WIN32_FIND_DATAW data{};
  HANDLE handle = FindFirstFileW(pattern.c_str(), &data);
  if (handle == INVALID_HANDLE_VALUE) return newest;
  do {
    std::wstring name = data.cFileName;
    if (name == L"." || name == L"..") continue;
    uint64_t stamp = ((uint64_t)data.ftLastWriteTime.dwHighDateTime << 32) |
                     data.ftLastWriteTime.dwLowDateTime;
    if (stamp > newest) newest = stamp;
    if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      if (name == L"node_modules" || name == L"dist" || name == L".git") continue;
      uint64_t child = newestWriteTime(joinPath(dir, wideToUtf8(name)));
      if (child > newest) newest = child;
    }
  } while (FindNextFileW(handle, &data));
  FindClose(handle);
  return newest;
}

/// dist 是否比源码新（新则无需重新构建）。
bool buildUpToDate(const std::string &projectDir) {
  const std::string distIndex = joinPath(joinPath(projectDir, "dist"), "index.html");
  if (!isFile(distIndex)) return false;
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if (!GetFileAttributesExW(utf8ToWide(distIndex).c_str(), GetFileExInfoStandard, &info))
    return false;
  uint64_t distStamp =
      ((uint64_t)info.ftLastWriteTime.dwHighDateTime << 32) | info.ftLastWriteTime.dwLowDateTime;
  return distStamp >= newestWriteTime(joinPath(projectDir, "src"));
}
}  // namespace

bool Deployer::ensureSource(bool allowDownload) {
  // 1) 命令行指定
  if (!options_.projectDir.empty()) {
    if (looksLikeProject(options_.projectDir)) {
      projectDir_ = options_.projectDir;
      emit("ok", "使用指定源码目录：" + projectDir_);
      return true;
    }
    emit("warn", "指定目录不是有效项目：" + options_.projectDir);
  }
  // 2) 可执行文件所在目录（部署包与源码放在一起时）
  std::string exeDir = parentDir(currentDir());  // currentDir 在这里是 exe 目录
  {
    wchar_t buffer[MAX_PATH] = {0};
    GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    exeDir = parentDir(wideToUtf8(buffer));
  }
  if (looksLikeProject(exeDir)) {
    projectDir_ = exeDir;
    emit("ok", "在程序目录发现源码：" + projectDir_);
    return true;
  }
  // 3) 程序目录的子目录（部署包常见结构）
  std::vector<std::string> candidates = {joinPath(exeDir, "source"),
                                         joinPath(exeDir, "MES-Homework"),
                                         joinPath(exeDir, "app")};
  for (const std::string &candidate : candidates) {
    if (looksLikeProject(candidate)) {
      projectDir_ = candidate;
      emit("ok", "在程序目录发现源码：" + projectDir_);
      return true;
    }
  }
  // 4) 从 GitHub 下载
  if (!allowDownload) {
    emit("error", "未找到源码，且当前不允许联网下载");
    return false;
  }
  const std::string target = joinPath(exeDir, "source");
  emit("step", "本地没有源码，从 GitHub 下载…");
  if (makeDirs(target)) {
    const std::string zip = joinPath(exeDir, "source.zip");
    emit("info", "下载 " + options_.archive);
    if (!downloadFile(options_.archive, zip)) {
      // 回退：走 git clone
      emit("warn", "压缩包下载失败，尝试 git clone…");
      if (hasCommand("git")) {
        ProcessResult clone = runProcess(
            "git clone --depth 1 " + options_.repo + " \"" + target + "\"", exeDir,
            [&](const std::string &line) {
              if (options_.verbose) emit("detail", line);
            });
        if (clone.exitCode == 0 && looksLikeProject(target)) {
          projectDir_ = target;
          emit("ok", "源码已通过 git clone 获取：" + projectDir_);
          return true;
        }
      }
      emit("error", "源码下载失败，请检查网络，或手动把源码放到：" + exeDir);
      return false;
    }
    emit("info", "解压源码…");
    ProcessResult extract = runProcess("tar.exe -xf \"" + zip + "\" -C \"" + target + "\"",
                                      exeDir, nullptr);
    DeleteFileW(utf8ToWide(zip).c_str());
    if (extract.exitCode != 0) {
      emit("error", "源码解压失败");
      return false;
    }
    // 压缩包会解出 MES-Homework-main 这样的单层目录
    ProcessResult listing = runProcess("cmd.exe /d /s /c dir /b /ad \"" + target + "\"",
                                      exeDir, nullptr);
    for (const std::string &line : splitLines(listing.output)) {
      std::string name = trim(line);
      if (name.empty() || name == "." || name == "..") continue;
      std::string nested = joinPath(target, name);
      if (!looksLikeProject(nested)) continue;
      // 把内层目录内容上移一层，保持目录结构干净
      ProcessResult move = runProcess(
          "cmd.exe /d /s /c \"move /y \\\"" + nested + "\\*\\\" \\\"" + target + "\\\" >nul\"",
          exeDir, nullptr);
      if (move.exitCode == 0) {
        runProcess("cmd.exe /d /s /c rmdir /s /q \"" + nested + "\"", exeDir, nullptr);
      } else {
        projectDir_ = nested;
        emit("ok", "源码已就绪：" + projectDir_);
        return true;
      }
      break;
    }
    if (looksLikeProject(target)) {
      projectDir_ = target;
      emit("ok", "源码已就绪：" + projectDir_);
      return true;
    }
  }
  emit("error", "源码准备失败");
  return false;
}

// ============================ 构建与启动 ============================

bool Deployer::runNpm(const std::string &args, const std::string &label) {
  emit("info", "执行 npm " + args);
  ProcessResult result = runProcess("npm.cmd " + args, projectDir_,
                                   [&](const std::string &line) {
                                     std::string text = trim(line);
                                     if (text.empty()) return;
                                     if (options_.verbose ||
                                         contains(text, "error") || contains(text, "ERR") ||
                                         contains(text, "warn") || contains(text, "added") ||
                                         contains(text, "vite v") || contains(text, "built in"))
                                       emit(contains(text, "error") || contains(text, "ERR")
                                                ? "error"
                                                : "detail",
                                            text);
                                   });
  if (result.exitCode != 0) {
    emit("error", label + " 失败（退出码 " + std::to_string(result.exitCode) + "）");
    std::vector<std::string> lines = splitLines(result.output);
    for (size_t i = 0; i < lines.size() && i < 12; ++i)
      if (!trim(lines[i]).empty()) emit("error", "  " + trim(lines[i]));
    return false;
  }
  return true;
}

bool Deployer::prepareEnvFile() {
  const std::string envPath = joinPath(projectDir_, ".env");
  std::string content;
  readFileUtf8(envPath, content);

  // 复用已有 APP_SECRET，避免每次部署让所有登录态失效
  appSecret_.clear();
  for (const std::string &line : splitLines(content)) {
    std::string text = trim(line);
    if (startsWith(text, "APP_SECRET=")) {
      std::string value = trim(text.substr(std::string("APP_SECRET=").size()));
      if (value.size() >= 32) appSecret_ = value;
    }
  }
  if (appSecret_.empty()) {
    appSecret_ = randomHex(32);
    emit("info", "已生成新的 APP_SECRET（会话与密钥加密依赖它）");
  }

  std::ostringstream out;
  out << "PORT=" << options_.port << "\n";
  out << "DATA_DIR=./data\n";
  out << "APP_SECRET=" << appSecret_ << "\n";
  out << "NODE_ENV=production\n";
  out << "HOST=" << (options_.mode == Mode::Lan || options_.mode == Mode::QuickTunnel ||
                            options_.mode == Mode::CustomDomain
                        ? "0.0.0.0"
                        : "127.0.0.1")
      << "\n";
  if (!writeFileUtf8(envPath, out.str())) {
    emit("warn", "无法写入 .env，将改用命令行环境变量启动");
    return false;
  }
  emit("ok", "已写入运行配置：" + envPath);
  return true;
}

bool Deployer::checkHealth(int timeoutMs) {
  HttpResponse response = httpGet(localUrl_ + "/api/health");
  (void)timeoutMs;
  return response.ok && contains(response.body, "\"ok\":true");
}

bool Deployer::waitForHealth(int timeoutMs) {
  const int step = 400;
  for (int waited = 0; waited < timeoutMs; waited += step) {
    if (checkHealth(step)) return true;
    if (serverProcess_ && !isProcessRunning(serverProcess_)) return false;
    Sleep(step);
  }
  return false;
}

bool Deployer::startServer() {
  localUrl_ = "http://127.0.0.1:" + std::to_string(options_.port);
  if (checkHealth(1000)) {
    emit("warn", "检测到 " + localUrl_ + " 已有同一个网站在运行，直接复用该服务");
    emit("detail", "如需让本程序接管，请先关闭原来启动服务的窗口");
    reusedServer_ = true;
    return true;
  }
  if (portInUse(options_.port)) {
    emit("error", "端口 " + std::to_string(options_.port) +
                      " 已被其它程序占用，请用 --port 指定其它端口");
    return false;
  }
  std::ostringstream command;
  command << "set \"PORT=" << options_.port << "\" && set \"HOST=0.0.0.0\" && set \"NODE_ENV=production\"";
  if (!appSecret_.empty()) command << " && set \"APP_SECRET=" << appSecret_ << "\"";
  command << " && node server/index.mjs";

  emit("info", "启动服务进程（端口 " + std::to_string(options_.port) + "）…");
  unsigned long pid = 0;
  serverProcess_ = startBackground(command.str(), projectDir_, &pid);
  if (!serverProcess_) {
    emit("error", "服务进程启动失败，请确认 Node.js 可用");
    return false;
  }
  emit("detail", "服务进程 PID " + std::to_string(pid));
  if (!waitForHealth(30000)) {
    emit("error", "服务在 30 秒内没有就绪，请检查上方日志");
    return false;
  }
  ownsServer_ = true;
  return true;
}

// ============================ 公网隧道 ============================

bool Deployer::startQuickTunnel() {
  emit("info", "启动 Cloudflare 临时隧道（trycloudflare.com）…");
  const std::string logPath = joinPath(projectDir(), "cloudflared-tunnel.log");
  std::string command = "cloudflared tunnel --no-autoupdate --url " + localUrl_ +
                        " > \"" + logPath + "\" 2>&1";
  unsigned long pid = 0;
  tunnelProcess_ = startBackground(command, projectDir_, &pid);
  if (!tunnelProcess_) {
    emit("error", "cloudflared 启动失败，请确认已安装");
    return false;
  }
  emit("detail", "cloudflared PID " + std::to_string(pid));

  // 从日志中解析分配的临时域名
  for (int waited = 0; waited < 60000; waited += 500) {
    Sleep(500);
    std::string log;
    if (readFileUtf8(logPath, log)) {
      size_t pos = log.find("https://");
      while (pos != std::string::npos) {
        size_t end = log.find_first_of(" \r\n\t\"", pos);
        std::string url = log.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
        if (contains(url, ".trycloudflare.com")) {
          tunnelUrl_ = url;
          emit("ok", "临时公网地址：" + tunnelUrl_);
          return true;
        }
        pos = log.find("https://", pos + 1);
      }
    }
    if (!isProcessRunning(tunnelProcess_)) {
      emit("error", "cloudflared 进程已退出，请查看日志：" + logPath);
      return false;
    }
  }
  emit("error", "60 秒内没有拿到临时公网地址，请查看日志：" + logPath);
  return false;
}

bool Deployer::startCustomDomainTunnel() {
  if (options_.domain.empty()) {
    emit("error", "自定义域名模式必须提供 --domain");
    return false;
  }
  const std::string configDir = joinPath(envVar("USERPROFILE"), ".cloudflared");
  if (!makeDirs(configDir)) {
    emit("error", "无法创建 cloudflared 配置目录：" + configDir);
    return false;
  }

  const std::string credentialsFile = joinPath(configDir, "tunnel.json");
  std::string tunnelId = options_.tunnelId;

  // 1) 已有凭证文件可直接解析隧道 ID
  {
    std::string credentials;
    if (readFileUtf8(credentialsFile, credentials)) {
      Json json;
      if (Json::parse(credentials, json, nullptr)) {
        tunnelId = json["TunnelID"].toStringOr("");
        if (tunnelId.empty()) tunnelId = json["tunnel_id"].toStringOr("");
      }
    }
  }

  // 2) 用 Cloudflare API 创建隧道（需要 API Token）
  if (tunnelId.empty() && !options_.apiToken.empty()) {
    std::string accountId;
    cf::Result verified = cf::verifyToken(options_.apiToken, accountId);
    if (!verified.ok) {
      emit("error", verified.message);
      return false;
    }
    emit("ok", verified.message);
    if (accountId.empty()) {
      emit("warn", "无法确定账户 ID，将改用连接器令牌方式");
    } else {
      const std::string tunnelName = "smart-campus-homework";
      const std::string body =
          "{\"name\":\"" + jsonEscape(tunnelName) + "\",\"config_src\":\"local\"}";
      HttpResponse response = httpPostJson(
          "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/cfd_tunnel", body,
          {"authorization: Bearer " + options_.apiToken});
      Json root;
      std::string parseError;
      if (Json::parse(response.body, root, &parseError) &&
          root["success"].type() == Json::Type::Bool && root["success"].asBool()) {
        tunnelId = root["result"]["id"].toStringOr("");
        if (!tunnelId.empty())
          emit("ok", "已创建命名隧道 " + tunnelName + "（ID " + tunnelId + "）");
      } else {
        const std::string message = root["errors"].at(0)["message"].toStringOr(response.body);
        emit("warn", "创建隧道失败：" + message);
      }
    }
  }
  if (tunnelId.empty() && options_.tunnelToken.empty()) {
    emit("error",
         "无法确定隧道 ID。请任选一种方式：\n"
         "    1) 提供 --api-token，程序会自动创建命名隧道；\n"
         "    2) 先在 Cloudflare Zero Trust 面板创建隧道并复制连接器令牌，用 --tunnel-token 传入；\n"
         "    3) 若已执行过 cloudflared tunnel login，可指定 --tunnel-id。");
    return false;
  }

  // 3) 写入隧道配置（凭证文件缺失时用令牌方式启动）
  const std::string configFile = joinPath(configDir, "config.yml");
  const bool hasCredentials = isFile(credentialsFile);
  std::ostringstream config;
  config << "tunnel: " << (tunnelId.empty() ? "smart-campus-homework" : tunnelId) << "\n";
  config << "credentials-file: " << replaceAll(credentialsFile, "\\", "/") << "\n";
  config << "ingress:\n";
  config << "  - hostname: " << options_.domain << "\n";
  config << "    service: " << localUrl_ << "\n";
  config << "  - service: http_status:404\n";
  if (hasCredentials) {
    if (!writeFileUtf8(configFile, config.str())) {
      emit("error", "无法写入隧道配置：" + configFile);
      return false;
    }
    emit("ok", "已写入隧道配置：" + configFile);
  }

  // 4) 写入 DNS 记录（把域名指向隧道）
  if (!options_.apiToken.empty() && !tunnelId.empty()) {
    std::string zoneId, zoneName;
    cf::Result zone = cf::findZoneId(options_.apiToken, options_.domain, zoneId, zoneName);
    if (!zone.ok) {
      emit("error", zone.message);
      return false;
    }
    emit("ok", zone.message);
    cf::Result dns =
        cf::upsertTunnelDns(options_.apiToken, zoneId, options_.domain, tunnelId, true);
    if (!dns.ok) {
      emit("error", dns.message);
      return false;
    }
    emit("ok", dns.message);
  } else {
    emit("warn", "未提供 API Token，跳过 DNS 自动配置。请手动在 Cloudflare 面板把 " +
                     options_.domain + " 的 CNAME 指向 " +
                     (tunnelId.empty() ? "<隧道ID>" : tunnelId) + ".cfargotunnel.com");
  }

  // 5) 启动隧道连接器
  const std::string logPath = joinPath(projectDir(), "cloudflared-tunnel.log");
  const std::string runMode = options_.tunnelToken.empty()
                                  ? "run " + (tunnelId.empty() ? std::string() : tunnelId)
                                  : "run --token " + options_.tunnelToken;
  const std::string command = "cloudflared tunnel --no-autoupdate " + runMode +
                              " > \"" + logPath + "\" 2>&1";
  emit("info", "启动隧道连接器…");
  unsigned long pid = 0;
  tunnelProcess_ = startBackground(command, projectDir_, &pid);
  if (!tunnelProcess_) {
    emit("error", "cloudflared 启动失败");
    return false;
  }
  emit("detail", "cloudflared PID " + std::to_string(pid));

  for (int waited = 0; waited < 30000; waited += 500) {
    Sleep(500);
    std::string log;
    if (readFileUtf8(logPath, log)) {
      if (contains(log, "Registered tunnel connection") ||
          contains(log, "Connection registered") || contains(log, "connIndex=")) {
        tunnelUrl_ = "https://" + options_.domain;
        emit("ok", "隧道已建立：" + tunnelUrl_);
        return true;
      }
      if (contains(log, "failed to") || contains(log, "error")) {
        if (contains(log, "credentials") || contains(log, "Unauthorized")) {
          emit("error", "隧道鉴权失败，请检查连接器令牌或凭证文件。日志：" + logPath);
          return false;
        }
      }
    }
    if (!isProcessRunning(tunnelProcess_)) {
      emit("error", "cloudflared 已退出，请查看日志：" + logPath);
      return false;
    }
  }
  emit("warn", "隧道启动较慢，请稍候几秒后用 https://" + options_.domain + " 访问");
  tunnelUrl_ = "https://" + options_.domain;
  return true;
}

// ============================ 主流程 ============================

bool Deployer::deploy(std::vector<std::string> &publicUrls) {
  steps_.clear();
  publicUrls_.clear();
  ownsServer_ = false;
  reusedServer_ = false;

  const size_t stepSource = addStep("准备源码");
  const size_t stepDeps = addStep("安装项目依赖");
  const size_t stepBuild = addStep("构建前端");
  const size_t stepConfig = addStep("生成运行配置");
  const size_t stepStart = addStep("启动服务");
  const size_t stepHealth = addStep("健康检查");
  const size_t stepPublic = addStep(options_.mode == Mode::Lan ? "准备局域网访问"
                                                               : "建立公网隧道");
  report();

  // 1) 源码
  setStep(stepSource, StepState::Running);
  if (!ensureSource(true)) {
    setStep(stepSource, StepState::Failed);
    return false;
  }
  setStep(stepSource, StepState::Done, projectDir_);

  // 2) 依赖
  setStep(stepDeps, StepState::Running);
  if (options_.skipInstall) {
    setStep(stepDeps, StepState::Skipped, "已按参数跳过");
  } else if (isDirectory(joinPath(projectDir_, "node_modules"))) {
    emit("info", "检测到 node_modules，执行增量安装以保证依赖完整");
    if (!runNpm("install --no-audit --no-fund", "npm install")) {
      setStep(stepDeps, StepState::Failed);
      return false;
    }
    setStep(stepDeps, StepState::Done, "依赖已就绪");
  } else {
    if (!runNpm("install --no-audit --no-fund", "npm install")) {
      setStep(stepDeps, StepState::Failed);
      return false;
    }
    setStep(stepDeps, StepState::Done, "依赖安装完成");
  }

  // 3) 构建
  setStep(stepBuild, StepState::Running);
  if (options_.skipBuild) {
    setStep(stepBuild, StepState::Skipped, "已按参数跳过");
  } else if (buildUpToDate(projectDir_)) {
    setStep(stepBuild, StepState::Skipped, "dist/ 已是最新，无需重新构建");
    emit("info", "前端产物比源码新，跳过构建（改动源码后会自动重建）");
  } else if (!runNpm("run build", "npm run build")) {
    setStep(stepBuild, StepState::Failed);
    return false;
  } else {
    setStep(stepBuild, StepState::Done, "前端产物已生成到 dist/");
  }

  // 4) 配置
  setStep(stepConfig, StepState::Running);
  prepareEnvFile();
  setStep(stepConfig, StepState::Done, ".env 已写入");

  // 5) 启动
  setStep(stepStart, StepState::Running);
  if (!startServer()) {
    setStep(stepStart, StepState::Failed);
    return false;
  }
  setStep(stepStart, StepState::Done, "PID " + std::to_string((unsigned long)GetProcessId((HANDLE)serverProcess_)));

  // 6) 健康检查
  setStep(stepHealth, StepState::Running);
  if (!checkHealth(5000)) {
    setStep(stepHealth, StepState::Failed, "服务未响应 /api/health");
    return false;
  }
  setStep(stepHealth, StepState::Done, localUrl_ + "/api/health 正常");

  // 7) 对外访问
  setStep(stepPublic, StepState::Running);
  if (options_.mode == Mode::Lan) {
    std::vector<std::string> addresses = localIPv4Addresses();
    if (addresses.empty()) {
      setStep(stepPublic, StepState::Failed, "没有找到可用的局域网地址");
      emit("error", "未检测到局域网 IPv4 地址，请确认已连接网络");
      return false;
    }
    for (const std::string &ip : addresses)
      publicUrls_.push_back("http://" + ip + ":" + std::to_string(options_.port));
    setStep(stepPublic, StepState::Done, std::to_string(publicUrls_.size()) + " 个局域网地址");
    emit("info", "同一局域网内的其它设备可直接访问下面的地址");
  } else if (options_.mode == Mode::QuickTunnel) {
    if (!startQuickTunnel()) {
      setStep(stepPublic, StepState::Failed);
      return false;
    }
    publicUrls_.push_back(tunnelUrl_);
    setStep(stepPublic, StepState::Done, tunnelUrl_);
  } else {
    if (!startCustomDomainTunnel()) {
      setStep(stepPublic, StepState::Failed);
      return false;
    }
    publicUrls_.push_back(tunnelUrl_);
    setStep(stepPublic, StepState::Done, tunnelUrl_);
  }

  publicUrls.push_back(localUrl_);
  for (const std::string &url : publicUrls_) publicUrls.push_back(url);
  return true;
}

bool Deployer::serviceRunning() const {
  if (serverProcess_ != nullptr) return isProcessRunning(serverProcess_);
  // 复用的服务：以健康检查结果判断存活
  if (!reusedServer_ || localUrl_.empty()) return false;
  return const_cast<Deployer *>(this)->checkHealth(1000);
}

void Deployer::stop() {
  if (tunnelProcess_) {
    emit("info", "正在关闭隧道…");
    stopProcessGracefully(tunnelProcess_, 3000);
    closeProcess(tunnelProcess_);
    tunnelProcess_ = nullptr;
  }
  if (serverProcess_) {
    emit("info", "正在关闭服务…");
    stopProcessGracefully(serverProcess_, 5000);
    closeProcess(serverProcess_);
    serverProcess_ = nullptr;
  }
  if (reusedServer_)
    emit("info", "服务由其它窗口启动，本程序不做关闭（需要停止请关闭那个窗口）");
  reusedServer_ = false;
  ownsServer_ = false;
}

}  // namespace sc
