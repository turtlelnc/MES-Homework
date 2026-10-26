// 校园作业分析 · 桌面部署器 —— 部署编排引擎
// 负责：系统检查 → 解析/下载安装包 → SHA-256 校验 → 解压 → 写配置 →
//       安装系统服务（服务器版开机自启）→ 启动 → 健康检查 → 记录状态。
// 平台相关操作一律通过 platform::；本文件只做流程与文本编排。
#include "core/core.h"
#include "core/core_util.h"
#include "core/elevated.h"
#include "core/manifest_parse.h"
#include "platform/platform.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace mes::core {
namespace {

constexpr int kStepCount = 10;
constexpr int kHealthTimeoutMs = 60000;
constexpr int kHealthPollMs = 700;
constexpr int kStartHealthTimeoutMs = 20000;

constexpr int kStepSystem = 0;
constexpr int kStepResolve = 1;
constexpr int kStepDownload = 2;
constexpr int kStepVerify = 3;
constexpr int kStepExtract = 4;
constexpr int kStepConfigure = 5;
constexpr int kStepService = 6;
constexpr int kStepLaunch = 7;
constexpr int kStepHealth = 8;
constexpr int kStepFinalize = 9;

const char* kTaskName = "MES-Homework";

void sleepMs(int milliseconds) {
  std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

bool endsWithNoCase(const std::string& text, const std::string& suffix) {
  if (suffix.size() > text.size()) return false;
  const size_t offset = text.size() - suffix.size();
  for (size_t i = 0; i < suffix.size(); ++i) {
    char a = text[offset + i];
    char b = suffix[i];
    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
    if (a != b) return false;
  }
  return true;
}

std::string tempRootDir() {
  std::string base = mes::platform::tempDir();
  if (base.empty()) base = mes::platform::currentDir();
  if (base.empty()) base = ".";
  const std::string name = mes::platform::randomHex(6);
  return mes::platform::joinPath(
      base, "mes-deployer-" + (name.empty() ? std::string("work") : name));
}

std::string readSecretFromEnvFile(const Options& options) {
  std::string content;
  if (!mes::platform::readFile(envFileOf(options), content)) return {};
  size_t position = 0;
  while (position <= content.size()) {
    size_t end = content.find('\n', position);
    if (end == std::string::npos) end = content.size();
    std::string line = content.substr(position, end - position);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.rfind("APP_SECRET=", 0) == 0) {
      std::string value = trimText(line.substr(11));
      if (value.size() >= 2 && ((value.front() == '"' && value.back() == '"') ||
                                (value.front() == '\'' && value.back() == '\'')))
        value = value.substr(1, value.size() - 2);
      return value;
    }
    if (end == content.size()) break;
    position = end + 1;
  }
  return {};
}

std::vector<mes::platform::EnvPair> buildEnvPairs(const Options& options,
                                                  const std::string& secret) {
  std::vector<mes::platform::EnvPair> env;
  if (!secret.empty()) env.emplace_back("APP_SECRET", secret);
  env.emplace_back("PORT", std::to_string(options.port));
  env.emplace_back("HOST", hostOf(options));
  env.emplace_back("NODE_ENV", nodeEnvOf(options));
  env.emplace_back("DATA_DIR", dataDirOf(options));
  return env;
}

bool readPidFile(const std::string& path, uint64_t& pid) {
  pid = 0;
  std::string content;
  if (!mes::platform::readFile(path, content)) return false;
  content = trimText(content);
  if (content.empty() || content.size() > 20) return false;
  uint64_t value = 0;
  for (char ch : content) {
    if (ch < '0' || ch > '9') return false;
    value = value * 10 + static_cast<uint64_t>(ch - '0');
  }
  if (value == 0) return false;
  pid = value;
  return true;
}

// 防止 pid 被系统复用后误杀无关进程：先确认镜像/命令名像 Node。
bool pidLooksLikeNode(uint64_t pid) {
  if (pid == 0) return false;
  std::string output;
  std::string error;
#if defined(_WIN32)
  const bool ok = mes::platform::runCommand(
      {"tasklist", "/FI", "PID eq " + std::to_string(pid), "/FO", "CSV", "/NH"},
      "", output, error, 15000);
  if (!ok) return false;
  return output.find("node.exe") != std::string::npos;
#elif defined(__APPLE__)
  const bool ok = mes::platform::runCommand(
      {"ps", "-p", std::to_string(pid), "-o", "comm="}, "", output, error, 15000);
  if (!ok) return false;
  return output.find("node") != std::string::npos;
#else
  const std::string cmdlinePath = "/proc/" + std::to_string(pid) + "/cmdline";
  if (!mes::platform::readFile(cmdlinePath, output)) return false;
  return output.find("node") != std::string::npos;
#endif
}

// 删除数据目录前的安全校验：必须是绝对路径、足够深的目录，且不是用户主目录。
bool isSafeToRemoveDataDir(const std::string& path) {
  if (!isAbsolutePath(path)) return false;
  const std::string normalized = normalizeSlashes(path);
  if (normalized.size() < 6) return false;
  if (normalized == "/" || normalized == "//") return false;
  // Windows 盘符根（C:/）长度 3。
  if (normalized.size() <= 3) return false;
  const std::string home = normalizeSlashes(mes::platform::homeDir());
  if (!home.empty() && normalized == home) return false;
  return true;
}

Options effectiveOptionsFromState(const Options& options) {
  Options effective = options;
  InstallState state;
  if (readState(state)) {
    if (!state.installDir.empty()) effective.installDir = state.installDir;
    if (!state.dataDir.empty()) effective.dataDir = state.dataDir;
    if (state.port >= 1 && state.port <= 65535) effective.port = state.port;
    if (state.edition == "server")
      effective.edition = Edition::Server;
    else if (state.edition == "local")
      effective.edition = Edition::Local;
  }
  return effective;
}

void rememberAction(const std::string& action) {
  InstallState state;
  if (!readState(state) || state.installDir.empty()) return;
  state.lastAction = action;
  writeState(state);
}

// ---------------------------------------------------------------- 提权动作执行
// 由提权后的部署器实例调用：执行单个系统级动作，返回是否成功。
bool executeElevatedAction(const std::string& action, const Options& options,
                           std::string& error);

bool runElevatedActionWithResult(const std::string& action,
                                 const Options& options, std::string& error) {
  error.clear();
  const std::string resultPath = elevatedResultPathOf(options);
  mes::platform::removeTree(resultPath);  // 清理上一次的结果文件（文件也可删除）
  std::vector<std::string> args = elevatedActionArgs(action, options);
  std::string elevatedError;
  const bool invoked = mes::platform::runElevated(args, elevatedError);
  std::string resultContent;
  const bool hasResult = mes::platform::readFile(resultPath, resultContent);
  mes::platform::removeTree(resultPath);
  const std::string trimmed = trimText(resultContent);
  if (!invoked) {
    error = elevatedError.empty() ? "管理员权限操作失败" : elevatedError;
    return false;
  }
  if (hasResult && !trimmed.empty()) {
    if (trimmed.rfind("OK", 0) == 0) return true;
    error = trimmed;
    return false;
  }
  return true;
}

// 当前进程已是管理员/root 时直接执行，否则通过 UAC/提权子进程执行。
bool performPrivilegedAction(const std::string& action, const Options& options,
                             std::string& error) {
  if (mes::platform::isRunningAsAdmin()) {
    std::string failure;
    if (executeElevatedAction(action, options, failure)) return true;
    error = failure.empty() ? "系统级操作失败" : failure;
    return false;
  }
  return runElevatedActionWithResult(action, options, error);
}

bool serviceQueryInstalled(const Options& options) {
  (void)options;
  std::string output;
  std::string error;
#if defined(_WIN32)
  return mes::platform::runCommand({"schtasks", "/Query", "/TN", kTaskName}, "",
                                   output, error, 15000);
#elif defined(__APPLE__)
  return mes::platform::runCommand({"launchctl", "list", serviceLabel()}, "",
                                   output, error, 15000);
#else
  return mes::platform::runCommand(
      {"systemctl", "is-enabled", std::string(serviceLabel()) + ".service"}, "",
      output, error, 15000);
#endif
}

bool waitForHealth(const Options& options, int timeoutMs,
                   std::atomic<bool>* cancel, std::string& error) {
  const std::string url = healthUrl(options);
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  int attempt = 0;
  while (std::chrono::steady_clock::now() < deadline) {
    if (cancel && cancel->load()) {
      error = "已取消";
      return false;
    }
    std::atomic<bool> localCancel{false};
    std::string body;
    mes::platform::HttpResult http =
        mes::platform::httpGet(url, body, cancel ? *cancel : localCancel);
    if (http.ok) return true;
    ++attempt;
    sleepMs(kHealthPollMs);
  }
  error = "健康检查超时（" + std::to_string(timeoutMs / 1000) + " 秒）：应用未在 " +
          url + " 就绪，请查看日志：" +
          mes::platform::joinPath(installDirOf(options), "logs/server.log");
  return false;
}

bool healthReachable(const Options& options) {
  std::atomic<bool> noCancel{false};
  std::string body;
  return mes::platform::httpGet(healthUrl(options), body, noCancel).ok;
}

// ---------------------------------------------------------------- 部署运行器
class DeploymentRunner {
 public:
  DeploymentRunner(const Options& options, RunCallbacks callbacks,
                   std::atomic<bool>& cancel)
      : options_(options), callbacks_(std::move(callbacks)), cancel_(cancel) {
    effective_ = options;
    if (!effective_.payloadDir.empty()) {
      // 开发目录模式：直接把该目录当作安装目录使用，不复制文件。
      effective_.installDir = effective_.payloadDir;
      if (effective_.dataDir.empty())
        effective_.dataDir =
            mes::platform::joinPath(effective_.payloadDir, "data");
    }
    installDir_ = installDirOf(effective_);
    appDir_ = appDirOf(effective_);
    logPath_ = logFilePath(effective_);
    result_.logPath = logPath_;
    result_.installDir = installDir_;
    initializeSteps();
  }

  DeploymentResult run() {
    report();
    return options_.embedDemoPayload ? runDemo() : runReal();
  }

 private:
  // -------------------------------------------------------------- 基础状态
  void initializeSteps() {
    addStep("system", "检查系统环境");
    addStep("resolve", "获取安装清单");
    addStep("download", "下载安装包");
    addStep("verify", "校验安装包");
    addStep("extract", "解压安装文件");
    addStep("configure", "写入配置与启动脚本");
    addStep("service", "安装开机自启服务");
    addStep("launch", "启动应用");
    addStep("health", "健康检查");
    addStep("finalize", "完成安装");
  }

  void addStep(const std::string& id, const std::string& title) {
    Step step;
    step.id = id;
    step.title = title;
    progress_.steps.push_back(step);
  }

  void report() {
    if (callbacks_.onProgress) callbacks_.onProgress(progress_);
  }

  void log(const std::string& level, const std::string& text) {
    if (callbacks_.onLog) callbacks_.onLog(level, text);
    logBuffer_ += isoNow();
    logBuffer_ += " [";
    logBuffer_ += level;
    logBuffer_ += "] ";
    logBuffer_ += text;
    logBuffer_.push_back('\n');
  }

  void flushLog() {
    // demo 模式承诺不写真实目录，日志只走回调。
    if (options_.embedDemoPayload) return;
    if (!logPath_.empty() && !logBuffer_.empty())
      mes::platform::writeFile(logPath_, logBuffer_);
  }

  void setPercent(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    if (percent == progress_.percent) return;
    progress_.percent = percent;
    report();
  }

  int percentAfterStep(int index) const { return ((index + 1) * 100) / kStepCount; }
  int percentBeforeStep(int index) const { return (index * 100) / kStepCount; }

  bool beginStep(int index) {
    if (finished_) return false;
    activeStep_ = index;
    progress_.steps[index].state = StepState::Running;
    progress_.running = true;
    progress_.message = progress_.steps[index].title;
    report();
    log("info", progress_.steps[index].title + "…");
    return true;
  }

  void markDone(const std::string& detail) {
    if (activeStep_ < 0) return;
    progress_.steps[activeStep_].state = StepState::Done;
    if (!detail.empty()) {
      progress_.steps[activeStep_].detail = detail;
      log("info", detail);
    }
    setPercent(percentAfterStep(activeStep_));
    activeStep_ = -1;
    flushLog();
  }

  void markSkipped(const std::string& detail) {
    if (activeStep_ < 0) return;
    progress_.steps[activeStep_].state = StepState::Skipped;
    progress_.steps[activeStep_].detail = detail;
    setPercent(percentAfterStep(activeStep_));
    activeStep_ = -1;
    log("info", detail);
    flushLog();
  }

  // 取消检查：已取消时完成清理并结束。
  bool guard() {
    if (!cancel_.load()) return true;
    if (finished_) return false;
    finished_ = true;
    result_.ok = false;
    result_.cancelled = true;
    result_.error.clear();
    if (activeStep_ >= 0) {
      progress_.steps[activeStep_].state = StepState::Pending;
      progress_.steps[activeStep_].detail = "已取消";
      activeStep_ = -1;
    }
    progress_.running = false;
    progress_.failed = false;
    progress_.message = "部署已取消";
    log("warn", "已取消部署，正在清理临时文件（保留已有安装）…");
    flushLog();
    cleanup();
    report();
    return false;
  }

  DeploymentResult fail(const std::string& message) {
    if (!finished_) {
      finished_ = true;
      result_.ok = false;
      result_.error = message;
      if (activeStep_ >= 0) {
        progress_.steps[activeStep_].state = StepState::Failed;
        progress_.steps[activeStep_].detail = message;
        activeStep_ = -1;
      }
      progress_.failed = true;
      progress_.running = false;
      progress_.message = message;
      log("error", message);
      flushLog();
      cleanup();
      report();
    }
    return result_;
  }

  // 清理：失败/取消时撤销对安装目录的改动，保留失败前的已有安装；成功时只清临时目录。
  void cleanup() {
    if (cleanedUp_) return;
    cleanedUp_ = true;
    if (!succeeded_) {
      if (process_ && process_->running()) process_->stop();
      if (serviceCreated_) {
        std::string ignore;
        performPrivilegedAction("service-remove", effective_, ignore);
        serviceCreated_ = false;
      }
      if (effective_.payloadDir.empty()) {
        const std::string appBackup = mes::platform::joinPath(backupRoot_, "app");
        const std::string runtimeBackup =
            mes::platform::joinPath(backupRoot_, "runtime");
        const bool haveBackup =
            !backupRoot_.empty() && mes::platform::dirExists(backupRoot_);
        if (haveBackup) {
          log("warn", "正在回滚安装目录（保留数据目录）…");
          mes::platform::removeTree(mes::platform::joinPath(installDir_, "app"));
          mes::platform::removeTree(
              mes::platform::joinPath(installDir_, "runtime"));
          std::string copyError;
          if (mes::platform::dirExists(appBackup))
            mes::platform::copyTree(
                appBackup, mes::platform::joinPath(installDir_, "app"), copyError);
          if (mes::platform::dirExists(runtimeBackup))
            mes::platform::copyTree(runtimeBackup,
                                    mes::platform::joinPath(installDir_, "runtime"),
                                    copyError);
        } else if (createdInstallDir_) {
          mes::platform::removeTree(installDir_);
        } else if (installTouched_) {
          mes::platform::removeTree(mes::platform::joinPath(installDir_, "app"));
          mes::platform::removeTree(
              mes::platform::joinPath(installDir_, "runtime"));
        }
      }
    }
    if (!tempRoot_.empty()) mes::platform::removeTree(tempRoot_);
  }

  // -------------------------------------------------------------- demo 模式
  DeploymentResult runDemo() {
    log("info", "演示模式：不联网、不写入真实目录。");
    if (!guard()) return result_;
    for (int index = 0; index < kStepCount; ++index) {
      if (!beginStep(index)) return result_;
      sleepMs(140 + index * 12);
      if (!guard()) return result_;
      if (index == kStepService &&
          !(effective_.edition == Edition::Server && effective_.autostart)) {
        markSkipped(effective_.edition == Edition::Local ? "本地版无需系统服务"
                                                          : "未勾选开机自启");
      } else if (index == kStepDownload) {
        markSkipped("演示模式：跳过下载");
      } else if (index == kStepVerify) {
        markSkipped("演示模式：跳过校验");
      } else if (index == kStepExtract) {
        markDone("演示模式");
      } else {
        markDone("");
      }
    }
    succeeded_ = true;
    result_.ok = true;
    result_.installDir = installDir_;
    result_.bundleVersion = "demo";
    result_.url = "http://127.0.0.1:" + std::to_string(effective_.port) + "/";
    progress_.running = false;
    progress_.done = true;
    progress_.percent = 100;
    progress_.message = "演示部署完成";
    setPercent(100);
    log("success", "演示部署完成 → " + result_.url);
    cleanup();
    flushLog();
    report();
    return result_;
  }

  // -------------------------------------------------------------- 真实部署
  DeploymentResult runReal() {
    // 先记录安装目录是否已存在（后续写日志会创建目录），用于失败时回滚。
    if (effective_.payloadDir.empty())
      createdInstallDir_ = !mes::platform::dirExists(installDir_);
    // 1. 系统检查
    if (!beginStep(kStepSystem)) return result_;
    const PlatformInfo platform = detectPlatform();
    log("info", "部署器版本 " + std::string(kVersion) + "（build " + kBuild + "）");
    log("info", "当前平台：" + platform.osLabel + " · " + platform.archLabel);
    if (!platform.appRuntimeSupported) return fail(platform.runtimeNote);
    const std::string optionError = validateOptions(effective_);
    if (!optionError.empty()) return fail(optionError);
    markDone(platform.osLabel + " · " + platform.archLabel);
    if (!guard()) return result_;

    // 2. 解析安装包
    if (!beginStep(kStepResolve)) return result_;
    tempRoot_ = tempRootDir();
    if (!mes::platform::ensureDir(tempRoot_))
      return fail("无法创建临时目录：" + tempRoot_ +
                  "（请检查磁盘空间与用户目录权限）");
    std::string zipPath;
    std::string downloadUrl;
    std::string expectedSha;
    uint64_t expectedSize = 0;
    if (!effective_.payloadDir.empty()) {
      bundleVersion_ = "本地开发目录";
      appDir_ = effective_.payloadDir;
      nodeExe_ = platformNodeOf(effective_);
      if (!mes::platform::fileExists(nodeExe_)) nodeExe_ = "node";  // 开发机自带 node
      markSkipped("开发目录模式：直接使用 " + effective_.payloadDir);
    } else if (!effective_.payloadZip.empty()) {
      zipPath = effective_.payloadZip;
      bundleVersion_ = "本地安装包";
      markDone("使用本地安装包：" + mes::platform::baseName(zipPath));
    } else if (!effective_.payloadUrl.empty()) {
      downloadUrl = effective_.payloadUrl;
      zipPath = mes::platform::joinPath(tempRoot_, "payload.zip");
      bundleVersion_ = "自定义下载地址";
      markDone("使用自定义下载地址");
    } else {
      const std::string tag =
          effective_.releaseTag.empty() ? kReleaseTag : effective_.releaseTag;
      const std::string manifestUrl = releaseBaseUrl(tag) + manifestAssetName();
      log("info", "获取安装清单：" + manifestUrl);
      std::string body;
      const mes::platform::HttpResult http =
          mes::platform::httpGet(manifestUrl, body, cancel_);
      if (!guard()) return result_;
      if (!http.ok)
        return fail("无法获取安装清单（HTTP " + std::to_string(http.status) +
                    "）：" + http.error +
                    "。请检查网络/代理，或使用离线安装包。");
      Manifest manifest;
      std::string parseError;
      if (!parseManifest(body, manifest, parseError)) return fail(parseError);
      const ManifestEntry* entry = findManifestEntry(manifest, platform);
      if (entry == nullptr)
        return fail("安装清单中没有适用于 " + platform.osLabel + " · " +
                    platform.archLabel + "（" + platform.os + "/" +
                    platform.arch +
                    "）的安装包，请确认该 Release 已上传对应平台产物。");
      downloadUrl = manifestEntryUrl(tag, *entry);
      zipPath = mes::platform::joinPath(tempRoot_, "payload.zip");
      expectedSha = entry->sha256;
      expectedSize = entry->size;
      bundleVersion_ = manifest.version;
      if (!entry->nodeVersion.empty())
        log("info", "安装包自带 Node 运行时：" + entry->nodeVersion);
      markDone("版本 " + manifest.version + " → " + entry->asset);
    }
    if (!guard()) return result_;

    // 3. 下载
    if (!beginStep(kStepDownload)) return result_;
    if (downloadUrl.empty()) {
      markSkipped("使用本地安装包，无需下载");
    } else {
      log("info", "开始下载：" + downloadUrl);
      const int basePercent = percentBeforeStep(kStepDownload);
      const int span = percentAfterStep(kStepDownload) - basePercent;
      mes::platform::DownloadProgress progress =
          [this, basePercent, span](uint64_t received, uint64_t total) {
            if (finished_ || cancel_.load()) return;
            double fraction = 0.0;
            if (total > 0)
              fraction = static_cast<double>(received) / static_cast<double>(total);
            if (fraction > 1.0) fraction = 1.0;
            const int percent =
                basePercent + static_cast<int>(fraction * static_cast<double>(span));
            if (percent > progress_.percent) {
              progress_.percent = percent;
              report();
            }
          };
      const mes::platform::HttpResult download =
          mes::platform::httpDownload(downloadUrl, zipPath, progress, cancel_);
      if (!guard()) return result_;
      if (!download.ok)
        return fail("下载安装包失败（HTTP " + std::to_string(download.status) +
                    "）：" + download.error +
                    "。请检查网络、代理或磁盘空间后重试。");
      const uint64_t bytes =
          download.bytes > 0 ? download.bytes : mes::platform::fileSize(zipPath);
      log("info", "下载完成：" + std::to_string(bytes / (1024 * 1024)) + " MiB");
      markDone("已下载 " + std::to_string(bytes / 1024) + " KiB");
    }
    if (!guard()) return result_;

    // 4. 校验
    if (!beginStep(kStepVerify)) return result_;
    if (zipPath.empty()) {
      markSkipped("开发目录模式，跳过安装包校验");
    } else {
      if (expectedSize > 0) {
        const uint64_t actualSize = mes::platform::fileSize(zipPath);
        if (actualSize != expectedSize)
          return fail("安装包大小不匹配（期望 " + std::to_string(expectedSize) +
                      " 字节，实际 " + std::to_string(actualSize) +
                      " 字节）：下载可能不完整，请重试。");
      }
      const std::string actualSha = sha256HexFile(zipPath);
      if (actualSha.empty())
        return fail("无法读取安装包以计算 SHA-256：" + zipPath);
      if (!expectedSha.empty()) {
        if (actualSha.size() != expectedSha.size() ||
            !endsWithNoCase(actualSha, expectedSha))
          return fail("安装包 SHA-256 校验失败：期望 " + expectedSha + "，实际 " +
                      actualSha + "。文件可能被篡改或下载不完整，请重试。");
        log("info", "SHA-256：" + actualSha);
        markDone("SHA-256 校验通过");
      } else {
        log("info", "本地安装包 SHA-256：" + actualSha + "（无官方校验值）");
        markDone("本地安装包（未提供官方校验值）");
      }
    }
    if (!guard()) return result_;

    // 5. 解压
    if (!beginStep(kStepExtract)) return result_;
    if (!effective_.payloadDir.empty()) {
      markSkipped("开发目录模式，跳过解压");
    } else {
      installTouched_ = true;
      if (!createdInstallDir_) {
        backupRoot_ = mes::platform::joinPath(tempRoot_, "backup");
        const std::string appBackup = mes::platform::joinPath(backupRoot_, "app");
        const std::string runtimeBackup =
            mes::platform::joinPath(backupRoot_, "runtime");
        const std::string appSource = mes::platform::joinPath(installDir_, "app");
        const std::string runtimeSource =
            mes::platform::joinPath(installDir_, "runtime");
        if (mes::platform::dirExists(appSource) ||
            mes::platform::dirExists(runtimeSource)) {
          if (!mes::platform::ensureDir(backupRoot_))
            return fail("无法创建备份目录：" + backupRoot_);
          std::string copyError;
          if (mes::platform::dirExists(appSource) &&
              !mes::platform::copyTree(appSource, appBackup, copyError))
            return fail("备份现有安装失败：" + copyError);
          if (mes::platform::dirExists(runtimeSource) &&
              !mes::platform::copyTree(runtimeSource, runtimeBackup, copyError))
            return fail("备份现有运行时失败：" + copyError);
        }
      }
      // 只替换受管目录，保留 data/ 与日志。
      mes::platform::removeTree(mes::platform::joinPath(installDir_, "app"));
      mes::platform::removeTree(mes::platform::joinPath(installDir_, "runtime"));
      if (!mes::platform::ensureDir(installDir_))
        return fail("无法创建安装目录：" + installDir_);
      log("info", "解压安装包到 " + installDir_ + "（zip-slip 防护已启用）");
      std::string extractError;
      if (!extractZip(zipPath, installDir_, extractError))
        return fail(extractError);
      if (!guard()) return result_;
      appDir_ = appDirOf(effective_);
      nodeExe_ = platformNodeOf(effective_);
      if (!mes::platform::fileExists(serverEntryOf(effective_)))
        return fail("安装包结构不符合预期：缺少 app/server/index.mjs，请确认下载的是完整应用安装包。");
      if (!mes::platform::fileExists(nodeExe_))
        return fail("安装包缺少自带的 Node.js 运行时（" + nodeExe_ +
                    "），请确认下载的是完整应用安装包。");
      markDone("已解压到 " + installDir_);
    }
    if (!guard()) return result_;

    // 6. 配置与启动脚本
    if (!beginStep(kStepConfigure)) return result_;
    const std::string dataDir = dataDirOf(effective_);
    if (!mes::platform::ensureDir(installDir_) ||
        !mes::platform::ensureDir(logsDirOf(effective_)) ||
        !mes::platform::ensureDir(dataDir))
      return fail("无法创建安装/日志/数据目录（请检查目录权限）：" +
                  installDir_);
    std::string secret = readSecretFromEnvFile(effective_);
    const bool secretGenerated = secret.empty();
    if (secret.empty()) secret = generateSecret();
    if (secret.empty())
      return fail("无法生成安全密钥（系统随机数不可用），请检查系统权限后重试。");
    std::string previousEnvironment;
    mes::platform::readFile(envFileOf(effective_),previousEnvironment);
    const std::string envContent = envFileContent(effective_, secret, previousEnvironment);
    if (!mes::platform::writeFile(envFileOf(effective_), envContent))
      return fail("无法写入配置文件：" + envFileOf(effective_));
    if (!secretGenerated)
      log("info", "已沿用现有 APP_SECRET（保持已登录用户的会话有效）");
    log("info", "APP_SECRET 已安全写入（不显示内容）");
    if (effective_.payloadDir.empty()) {
#if defined(_WIN32)
      const std::string startScript = windowsStartScript(effective_);
#else
      const std::string startScript = posixStartScript(effective_);
#endif
      if (!mes::platform::writeFile(startScriptPathOf(effective_), startScript))
        return fail("无法写入启动脚本：" + startScriptPathOf(effective_));
      mes::platform::makeExecutable(startScriptPathOf(effective_));
      // 服务器版 + 开机自启：预生成服务定义文件（提权时安装）。
      if (effective_.edition == Edition::Server && effective_.autostart) {
#if defined(_WIN32)
        const std::string definition =
            utf16LeWithBom(windowsTaskXml(effective_));
#elif defined(__APPLE__)
        const std::string definition =
            launchdPlist(effective_, nodeExe_, serviceLabel());
#else
        const std::string definition = systemdUnit(effective_, nodeExe_);
#endif
        if (!mes::platform::writeFile(serviceDefinitionPathOf(effective_),
                                      definition))
          return fail("无法写入服务定义文件：" +
                      serviceDefinitionPathOf(effective_));
      }
#if !defined(_WIN32)
      {
        std::string chmodOutput;
        std::string chmodError;
        mes::platform::runCommand({"chmod", "600", envFileOf(effective_)}, "",
                                  chmodOutput, chmodError, 10000);
      }
#endif
    } else {
      // 开发目录模式：同时把 .env 放进应用目录，便于 node --env-file 调试。
      mes::platform::writeFile(
          mes::platform::joinPath(effective_.payloadDir, ".env"), envContent);
    }
    secret_ = secret;
    markDone("配置已写入：" + envFileOf(effective_));
    if (!guard()) return result_;

    // 7. 系统服务（服务器版 + 开机自启）
    if (!beginStep(kStepService)) return result_;
    const bool needService = effective_.edition == Edition::Server &&
                             effective_.autostart &&
                             effective_.payloadDir.empty();
    if (!needService) {
      markSkipped(effective_.edition == Edition::Local
                      ? "本地版无需系统服务"
                      : (effective_.payloadDir.empty() ? "未勾选开机自启"
                                                       : "开发目录模式不安装服务"));
    } else {
      std::string serviceError;
      if (!performPrivilegedAction("service-install", effective_, serviceError))
        return fail("安装开机自启服务失败：" + serviceError +
                    "。可尝试以管理员身份重新运行部署器后重试。");
      if (!serviceQueryInstalled(effective_))
        return fail("开机自启服务安装后校验失败：系统中未找到 " +
                    std::string(kTaskName) + "，请尝试以管理员身份重新运行。");
      serviceCreated_ = true;
      markDone("已安装开机自启（" + std::string(serviceLabel()) + "）");
      if (effective_.firewall) {
        std::string firewallError;
        if (performPrivilegedAction("firewall-open", effective_, firewallError))
          log("info", "已放行防火墙 TCP 端口 " + std::to_string(effective_.port));
        else
          log("warn", "防火墙放行失败（不影响安装，可手动放行端口 " +
                          std::to_string(effective_.port) + "）：" +
                          firewallError);
      }
    }
    if (!guard()) return result_;

    // 8. 启动应用
    if (!beginStep(kStepLaunch)) return result_;
    if (needService) {
      // 重新部署时服务可能已在运行：先停再启，确保运行的是新解压的程序。
      if (healthReachable(effective_)) {
        log("warn", "检测到系统服务已在运行，正在重启以应用新版本…");
        std::string stopError;
        performPrivilegedAction("service-stop", effective_, stopError);
      }
      std::string startError;
      if (!performPrivilegedAction("service-start", effective_, startError))
        return fail("启动系统服务失败：" + startError);
      markDone("已通过系统服务启动应用");
    } else {
      // 本地版重新部署：端口上若有旧实例，先停掉再启动新进程，避免端口占用。
      if (healthReachable(effective_)) {
        log("warn", "检测到端口 " + std::to_string(effective_.port) +
                        " 上已有实例在运行，正在停止旧实例…");
        uint64_t oldPid = 0;
        if (readPidFile(instancePidPathOf(effective_), oldPid) &&
            pidLooksLikeNode(oldPid))
          mes::platform::killProcessTree(oldPid);
        mes::platform::removeTree(instancePidPathOf(effective_));
        for (int attempt = 0; attempt < 10 && healthReachable(effective_);
             ++attempt)
          sleepMs(300);
        if (healthReachable(effective_))
          return fail("端口 " + std::to_string(effective_.port) +
                      " 上仍有实例未停止，请先手动停止旧应用后重试。");
      }
      const std::string supervisor=mes::platform::joinPath(appDir_,"tools/ops/supervise.mjs");
      const std::string entry = mes::platform::fileExists(supervisor)?supervisor:mes::platform::joinPath(appDir_, "server/index.mjs");
      std::string spawnError;
      process_ = mes::platform::spawnProcess(
          {nodeExe_, "--env-file="+envFileOf(effective_), entry}, appDir_, buildEnvPairs(effective_, secret_),
          serverLogOf(effective_), spawnError, true);
      if (!process_)
        return fail("启动应用进程失败：" + spawnError +
                    "。请查看日志：" + serverLogOf(effective_));
      const uint64_t pid = process_->pid();
      if (pid != 0)
        mes::platform::writeFile(instancePidPathOf(effective_),
                                 std::to_string(pid));
      markDone("应用已启动（PID " + std::to_string(pid) + "）");
    }
    if (!guard()) return result_;

    // 9. 健康检查
    if (!beginStep(kStepHealth)) return result_;
    {
      const std::string url = healthUrl(effective_);
      const auto deadline = std::chrono::steady_clock::now() +
                            std::chrono::milliseconds(kHealthTimeoutMs);
      bool healthy = false;
      int attempt = 0;
      while (std::chrono::steady_clock::now() < deadline) {
        if (!guard()) return result_;
        std::string body;
        const mes::platform::HttpResult http =
            mes::platform::httpGet(url, body, cancel_);
        if (http.ok) {
          healthy = true;
          break;
        }
        ++attempt;
        if (process_ != nullptr && !process_->running()) {
          const int code = process_->exitCode();
          return fail("应用启动后立即退出（退出码 " + std::to_string(code) +
                      "），请查看日志：" + serverLogOf(effective_));
        }
        sleepMs(kHealthPollMs);
      }
      if (!healthy)
        return fail("健康检查超时（60 秒）：应用未在 " + url +
                    " 就绪，请查看日志：" + serverLogOf(effective_));
      log("info", "健康检查通过（第 " + std::to_string(attempt + 1) + " 次探测）");
      markDone(url);
    }
    if (!guard()) return result_;

    // 10. 完成安装
    if (!beginStep(kStepFinalize)) return result_;
    InstallState state;
    state.version = kVersion;
    state.edition =
        effective_.edition == Edition::Server ? "server" : "local";
    state.installDir = installDir_;
    state.dataDir = dataDirOf(effective_);
    state.port = effective_.port;
    state.installedAt = isoNow();
    state.bundleVersion = bundleVersion_;
    state.lastAction = "install";
    if (!writeState(state))
      log("warn", "安装完成，但无法写入安装状态文件：" + stateFilePath() +
                      "（不影响应用使用）");
    result_.ok = true;
    result_.installDir = installDir_;
    result_.bundleVersion = bundleVersion_;
    result_.url =
        "http://127.0.0.1:" + std::to_string(effective_.port) + "/";
    progress_.running = false;
    progress_.done = true;
    progress_.message = "安装完成";
    succeeded_ = true;
    markDone("安装完成 → " + result_.url);
    setPercent(100);
    log("success", "安装完成，访问地址：" + result_.url);
    if (effective_.edition == Edition::Server && effective_.lan)
      log("info", "局域网内可用 http://<本机IP>:" +
                      std::to_string(effective_.port) + "/ 访问");
    if (options_.openBrowser && !cancel_.load()) {
      if (!mes::platform::openBrowser(result_.url))
        log("warn", "无法自动打开浏览器，请手动访问：" + result_.url);
    }
    cleanup();
    flushLog();
    report();
    return result_;
  }

  Options options_;
  Options effective_;
  RunCallbacks callbacks_;
  std::atomic<bool>& cancel_;
  ProgressState progress_;
  DeploymentResult result_;
  bool finished_ = false;
  bool succeeded_ = false;
  bool cleanedUp_ = false;
  int activeStep_ = -1;
  std::string logBuffer_;
  std::string logPath_;
  std::string installDir_;
  std::string appDir_;
  std::string nodeExe_;
  std::string bundleVersion_;
  std::string secret_;
  std::string tempRoot_;
  std::string backupRoot_;
  bool installTouched_ = false;
  bool createdInstallDir_ = false;
  bool serviceCreated_ = false;
  std::unique_ptr<mes::platform::Process> process_;
};

// ---------------------------------------------------------------- 提权动作实现
bool executeElevatedAction(const std::string& action, const Options& options,
                           std::string& error) {
  error.clear();
  std::string output;
  auto run = [&output](const std::vector<std::string>& args, int timeoutMs) {
    std::string commandError;
    const bool ok =
        mes::platform::runCommand(args, "", output, commandError, timeoutMs);
    if (!ok && output.empty()) output = commandError;
    return ok;
  };
#if defined(_WIN32)
  if (action == "service-install") {
    const std::string definition = serviceDefinitionPathOf(options);
    if (!mes::platform::fileExists(definition)) {
      error = "缺少计划任务定义文件：" + definition;
      return false;
    }
    if (!run({"schtasks", "/Create", "/TN", kTaskName, "/XML", definition,
              "/F"},
             60000)) {
      error = "创建计划任务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-remove") {
    run({"schtasks", "/End", "/TN", kTaskName}, 30000);
    if (!run({"schtasks", "/Delete", "/TN", kTaskName, "/F"}, 30000)) {
      error = "删除计划任务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-start") {
    if (!run({"schtasks", "/Run", "/TN", kTaskName}, 60000)) {
      error = "启动计划任务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-stop") {
    if (!run({"schtasks", "/End", "/TN", kTaskName}, 60000)) {
      error = "停止计划任务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-query") {
    if (!run({"schtasks", "/Query", "/TN", kTaskName}, 30000)) {
      error = "查询计划任务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "firewall-open") {
    const std::string rule = "MES Homework " + std::to_string(options.port);
    run({"netsh", "advfirewall", "firewall", "delete", "rule",
         "name=" + rule},
        30000);
    if (!run({"netsh", "advfirewall", "firewall", "add", "rule",
              "name=" + rule, "dir=in", "action=allow", "protocol=TCP",
              "localport=" + std::to_string(options.port)},
             30000)) {
      error = "添加防火墙规则失败：" + trimText(output);
      return false;
    }
    return true;
  }
#elif defined(__APPLE__)
  if (action == "service-install") {
    const std::string target =
        "/Library/LaunchDaemons/" + std::string(kTaskName) + ".plist";
    const std::string content =
        launchdPlist(options, platformNodeOf(options), serviceLabel());
    if (!mes::platform::writeFile(target, content)) {
      error = "无法写入 launchd 配置：" + target;
      return false;
    }
    if (!run({"launchctl", "load", "-w", target}, 60000)) {
      error = "加载 launchd 服务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-remove") {
    const std::string target =
        "/Library/LaunchDaemons/" + std::string(kTaskName) + ".plist";
    run({"launchctl", "unload", "-w", target}, 30000);
    mes::platform::removeTree(target);
    return true;
  }
  if (action == "service-start") {
    if (!run({"launchctl", "start", serviceLabel()}, 60000)) {
      error = "启动 launchd 服务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-stop") {
    if (!run({"launchctl", "stop", serviceLabel()}, 30000)) {
      error = "停止 launchd 服务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-query") {
    if (!run({"launchctl", "list", serviceLabel()}, 30000)) {
      error = "查询 launchd 服务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "firewall-open") {
    // macOS 应用防火墙按可执行文件授权，安装时无法静默放行；保持成功并提示。
    error.clear();
    return true;
  }
#else
  if (action == "service-install") {
    const std::string target =
        "/etc/systemd/system/" + std::string(serviceLabel()) + ".service";
    const std::string content = systemdUnit(options, platformNodeOf(options));
    if (!mes::platform::writeFile(target, content)) {
      error = "无法写入 systemd 单元：" + target;
      return false;
    }
    if (!run({"systemctl", "daemon-reload"}, 30000)) {
      error = "systemctl daemon-reload 失败：" + trimText(output);
      return false;
    }
    if (!run({"systemctl", "enable", std::string(serviceLabel()) + ".service"},
             60000)) {
      error = "设置 systemd 开机自启失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-remove") {
    run({"systemctl", "disable", "--now",
         std::string(serviceLabel()) + ".service"},
        60000);
    mes::platform::removeTree("/etc/systemd/system/" +
                              std::string(serviceLabel()) + ".service");
    run({"systemctl", "daemon-reload"}, 30000);
    return true;
  }
  if (action == "service-start") {
    if (!run({"systemctl", "start", std::string(serviceLabel()) + ".service"},
             60000)) {
      error = "启动 systemd 服务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-stop") {
    if (!run({"systemctl", "stop", std::string(serviceLabel()) + ".service"},
             60000)) {
      error = "停止 systemd 服务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "service-query") {
    if (!run({"systemctl", "is-enabled",
              std::string(serviceLabel()) + ".service"},
             30000)) {
      error = "查询 systemd 服务失败：" + trimText(output);
      return false;
    }
    return true;
  }
  if (action == "firewall-open") {
    const std::string port = std::to_string(options.port);
    if (run({"ufw", "allow", port + "/tcp"}, 30000)) return true;
    if (run({"firewall-cmd", "--add-port=" + port + "/tcp",
             "--permanent"},
            30000)) {
      run({"firewall-cmd", "--reload"}, 30000);
      return true;
    }
    error = "未找到 ufw/firewalld，无法自动放行端口：" + trimText(output);
    return false;
  }
#endif
  error = "不支持的提权动作：" + action;
  return false;
}

}  // namespace

// ================================================================ 对外接口
DeploymentResult runDeployment(const Options& options, RunCallbacks callbacks,
                               std::atomic<bool>& cancel) {
  DeploymentRunner runner(options, std::move(callbacks), cancel);
  return runner.run();
}

bool serviceInstalled(const Options& options) {
  return serviceQueryInstalled(effectiveOptionsFromState(options));
}

bool stopDeployment(const Options& options, std::string& error) {
  error.clear();
  const Options effective = effectiveOptionsFromState(options);
  bool didSomething = false;
  bool killFailed = false;

  if (serviceQueryInstalled(effective)) {
    std::string stopError;
    if (!performPrivilegedAction("service-stop", effective, stopError)) {
      error = "停止系统服务失败：" + stopError;
      return false;
    }
    didSomething = true;
  }

  const std::string pidPath = instancePidPathOf(effective);
  uint64_t pid = 0;
  if (readPidFile(pidPath, pid)) {
    if (pidLooksLikeNode(pid)) {
      if (mes::platform::killProcessTree(pid))
        didSomething = true;
      else
        killFailed = true;
    }
    mes::platform::removeTree(pidPath);
  }

  if (!didSomething) {
    error = "没有找到正在运行的应用（可能已经停止），如需启动请使用「启动应用」。";
    return false;
  }
  if (killFailed) {
    error = "已停止系统服务，但仍有进程未能结束，请稍后手动检查。";
    return false;
  }
  rememberAction("stop");
  return true;
}

bool uninstallDeployment(const Options& options, bool removeData,
                         std::string& error) {
  error.clear();
  const Options effective = effectiveOptionsFromState(options);
  InstallState state;
  const bool haveState = readState(state);
  const std::string install = installDirOf(effective);
  if (!haveState && !mes::platform::dirExists(install)) {
    error = "尚未安装应用，无需卸载。";
    return false;
  }

  std::string stopError;
  stopDeployment(effective, stopError);  // 尽力停止，不因未运行而中止卸载

  if (serviceQueryInstalled(effective)) {
    std::string removeError;
    if (!performPrivilegedAction("service-remove", effective, removeError)) {
      error = "移除系统服务失败：" + removeError +
              "。请以管理员身份重试后再卸载。";
      return false;
    }
    if (serviceQueryInstalled(effective)) {
      error = "系统服务仍然存在，卸载已中止（请以管理员身份重试）。";
      return false;
    }
  }

  if (mes::platform::dirExists(install)) {
    if (!mes::platform::removeTree(install)) {
      error = "无法删除安装目录：" + install +
              "（可能仍有进程占用，请关闭相关程序后重试）。";
      return false;
    }
  }

  const std::string dataDir =
      !effective.dataDir.empty()
          ? effective.dataDir
          : (state.dataDir.empty() ? dataDirOf(effective) : state.dataDir);
  if (removeData && !dataDir.empty() && mes::platform::dirExists(dataDir) &&
      normalizeSlashes(dataDir) != normalizeSlashes(install)) {
    if (!isSafeToRemoveDataDir(dataDir)) {
      error = "数据目录路径异常，出于安全考虑已拒绝删除：" + dataDir;
      return false;
    }
    if (!mes::platform::removeTree(dataDir)) {
      error = "无法删除数据目录：" + dataDir;
      return false;
    }
  }

  InstallState cleared;
  writeState(cleared);
  return true;
}

bool startInstalled(const Options& options, std::string& error) {
  error.clear();
  const Options effective = effectiveOptionsFromState(options);
  if (!isInstalled()) {
    error = "尚未安装应用，请先完成安装。";
    return false;
  }
  if (serviceQueryInstalled(effective)) {
    std::string startError;
    if (!performPrivilegedAction("service-start", effective, startError)) {
      error = "启动系统服务失败：" + startError;
      return false;
    }
  } else {
    std::string appDir = appDirOf(effective);
    std::string entry = serverEntryOf(effective);
    std::string node = platformNodeOf(effective);
    // 兼容开发目录模式安装（应用目录就是安装目录本身）。
    const std::string directEntry =
        mes::platform::joinPath(installDirOf(effective), "server/index.mjs");
    if (!mes::platform::fileExists(entry) &&
        mes::platform::fileExists(directEntry)) {
      appDir = installDirOf(effective);
      entry = directEntry;
    }
    if (!mes::platform::fileExists(node)) node = "node";  // 开发机自带 node
    if (!mes::platform::fileExists(entry)) {
      error = "安装目录中缺少应用入口：" + entry + "，请重新安装。";
      return false;
    }
    const std::string secret = readSecretFromEnvFile(effective);
    if (secret.empty()) {
      error = "安装目录缺少配置中的 APP_SECRET：" + envFileOf(effective) +
              "，请重新安装。";
      return false;
    }
    std::string spawnError;
    std::unique_ptr<mes::platform::Process> process =
        mes::platform::spawnProcess({node, "--env-file="+envFileOf(effective), mes::platform::fileExists(mes::platform::joinPath(appDir,"tools/ops/supervise.mjs"))?mes::platform::joinPath(appDir,"tools/ops/supervise.mjs"):entry}, appDir,
                                    buildEnvPairs(effective, secret),
                                    serverLogOf(effective), spawnError, true);
    if (!process) {
      error = "启动应用进程失败：" + spawnError;
      return false;
    }
    if (process->pid() != 0)
      mes::platform::writeFile(instancePidPathOf(effective),
                               std::to_string(process->pid()));
  }
  std::string healthError;
  if (!waitForHealth(effective, kStartHealthTimeoutMs, nullptr, healthError)) {
    error = healthError;
    return false;
  }
  rememberAction("start");
  return true;
}

bool openInstalled(const Options& options, std::string& error) {
  error.clear();
  const Options effective = effectiveOptionsFromState(options);
  if (!isInstalled()) {
    error = "尚未安装应用，请先完成安装。";
    return false;
  }
  const std::string url =
      "http://127.0.0.1:" + std::to_string(effective.port) + "/";
  if (!mes::platform::openBrowser(url)) {
    error = "无法打开浏览器，请手动访问：" + url;
    return false;
  }
  return true;
}

int runElevatedAction(const std::vector<std::string>& args) {
  std::string action;
  Options options;
  std::string parseError;
  if (!parseElevatedActionArgs(args, action, options, parseError)) {
    std::fprintf(stderr, "提权动作参数无效：%s\n", parseError.c_str());
    return 2;
  }
  const std::string resultPath = elevatedResultPathOf(options);
  std::string failure;
  const bool ok = executeElevatedAction(action, options, failure);
  if (ok) {
    mes::platform::writeFile(resultPath, "OK");
    return 0;
  }
  if (failure.empty()) failure = "系统级操作失败：" + action;
  mes::platform::writeFile(resultPath, failure);
  std::fprintf(stderr, "%s\n", failure.c_str());
  return 1;
}

}  // namespace mes::core
