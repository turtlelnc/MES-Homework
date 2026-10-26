// 校园作业分析 · 桌面部署器 —— 核心引擎接口
// 纯逻辑（可单测）+ 平台无关；平台能力通过 platform:: 调用。
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace mes::core {

#ifndef MES_VERSION_STRING
#error "MES_VERSION_STRING must come from the build configuration"
#endif
#ifndef MES_BUILD_STRING
#error "MES_BUILD_STRING must come from the build configuration"
#endif

extern const char* const kVersion;
extern const char* const kBuild;
extern const char* const kReleaseTag;
extern const char* const kRepoSlug;

// ------------------------------------------------------------------ 基础模型
enum class Edition { Local = 0, Server = 1 };

const char* editionName(Edition edition);
const char* editionTagline(Edition edition);
const char* editionDescription(Edition edition);

struct PlatformInfo {
  std::string os;       // windows / linux / macos
  std::string arch;     // x64 / x86 / arm64
  std::string osLabel;  // 展示用，如 "Windows 11"
  std::string archLabel;
  bool appRuntimeSupported = false;  // 是否有官方 Node 24 运行时（32 位为 false）
  std::string runtimeNote;           // 不支持时给用户的中文说明
};

PlatformInfo detectPlatform();
const char* currentOsSlug();
const char* currentArchSlug();

struct ManifestEntry {
  std::string platform;
  std::string arch;
  std::string asset;
  std::string sha256;
  uint64_t size = 0;
  std::string nodeVersion;
};

struct Manifest {
  std::string version;
  std::string createdAt;
  std::vector<ManifestEntry> entries;
};

std::string manifestAssetName();
std::string appAssetName(const PlatformInfo& platform);
std::string releaseBaseUrl(const std::string& tag = kReleaseTag);
std::string payloadUrlFor(const std::string& tag, const PlatformInfo& platform);
std::string deployerAssetName(const PlatformInfo& platform);

// ------------------------------------------------------------------ 安装选项
struct Options {
  Edition edition = Edition::Local;
  std::string installDir;   // 空 = defaultInstallDir(edition)
  std::string dataDir;      // 空 = installDir/data
  int port = 8787;
  bool lan = false;         // 服务器版：监听 0.0.0.0
  bool autostart = false;   // 开机自启（服务器版）
  bool firewall = false;    // 自动放行防火墙端口（服务器版）
  bool production = false;  // NODE_ENV=production（要求 HTTPS 反向代理）
  bool openBrowser = true;  // 完成后打开浏览器
  std::string releaseTag = kReleaseTag;
  std::string payloadUrl;   // 完整下载地址覆盖（高级）
  std::string payloadZip;   // 本地安装包 zip 覆盖（离线）
  std::string payloadDir;   // 本地未打包应用目录（开发/调试）
  bool embedDemoPayload = false;  // 演示数据（用于 UI 演示）
};

std::string defaultInstallDir(Edition edition);
std::string defaultDataDir(const Options& options);
std::string validateOptions(const Options& options);  // 返回错误文案，合法返回空串
std::string generateSecret();
std::string envFileContent(const Options& options, const std::string& secret, const std::string& existing = "");
std::string stateFilePath();
std::string logFilePath(const Options& options);

// ------------------------------------------------------------------ 解压 / 校验
std::string sha256HexFile(const std::string& path);
std::string sha256Hex(const void* data, size_t size);
bool extractZip(const std::string& zipPath, const std::string& destDir,
                std::string& error);

// ------------------------------------------------------------------ 安装状态
struct InstallState {
  std::string version;
  std::string edition;     // local / server
  std::string installDir;
  std::string dataDir;
  int port = 8787;
  std::string installedAt;
  std::string bundleVersion;
  std::string lastAction;  // install / start / stop / uninstall
};

bool readState(InstallState& out);
bool writeState(const InstallState& state);
bool isInstalled();
std::string isoNow();

// ------------------------------------------------------------------ 服务配置
// 生成的文本均可单元测试；真正写入/提权由引擎完成。
std::string windowsStartScript(const Options& options);
std::string windowsServerTaskCommand(const Options& options);
std::string systemdUnit(const Options& options, const std::string& execPath);
std::string launchdPlist(const Options& options, const std::string& execPath,
                         const std::string& label);
std::string serviceLabel();
std::string healthUrl(const Options& options);

// ------------------------------------------------------------------ 部署引擎
enum class StepState { Pending, Running, Done, Failed, Skipped };

struct Step {
  std::string id;
  std::string title;
  std::string detail;
  StepState state = StepState::Pending;
};

struct ProgressState {
  std::vector<Step> steps;
  int percent = 0;
  bool running = false;
  bool failed = false;
  bool done = false;
  std::string message;
};

struct DeploymentResult {
  bool ok = false;
  bool cancelled = false;
  std::string error;
  std::string installDir;
  std::string url;
  std::string logPath;
  std::string bundleVersion;
};

struct RunCallbacks {
  // 在部署工作线程中调用；UI 侧自行加锁/入队。
  std::function<void(const ProgressState&)> onProgress;
  std::function<void(const std::string& level, const std::string& text)> onLog;
};

/**
 * 执行完整的一键部署（阻塞）。调用方应在后台线程运行，并在取消时置
 * cancel=true。所有步骤都会通过 callbacks 报告，便于 UI 展示。
 */
DeploymentResult runDeployment(const Options& options, RunCallbacks callbacks,
                               std::atomic<bool>& cancel);

bool stopDeployment(const Options& options, std::string& error);
bool uninstallDeployment(const Options& options, bool removeData,
                         std::string& error);
bool serviceInstalled(const Options& options);
bool startInstalled(const Options& options, std::string& error);
bool openInstalled(const Options& options, std::string& error);

// 供 --self-test 使用：运行核心逻辑自检，返回是否全部通过。
bool runSelfTest(bool verbose);

}  // namespace mes::core
