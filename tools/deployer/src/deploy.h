// 校园作业分析 · 一键部署器 —— 部署核心
#pragma once

#include <functional>
#include <string>
#include <vector>

namespace sc {

enum class Mode { Lan, QuickTunnel, CustomDomain };

struct Options {
  Mode mode = Mode::Lan;
  int port = 8787;
  std::string projectDir;    // 源码目录（空则自动探测）
  std::string repo = "https://github.com/turtlelnc/MES-Homework.git";
  std::string archive = "https://codeload.github.com/turtlelnc/MES-Homework/zip/refs/heads/main";
  std::string domain;        // 自定义域名
  std::string apiToken;      // Cloudflare API Token
  std::string tunnelToken;   // 命名隧道连接器令牌
  std::string tunnelId;      // 已有命名隧道 ID（可选）
  bool skipInstall = false;
  bool skipBuild = false;
  bool openBrowser = true;
  bool verbose = false;
};

struct Dependency {
  std::string id;
  std::string title;         // 中文名称
  bool required = true;
  bool available = false;
  std::string version;       // 检测到的版本
  std::string installMethod; // winget / download / manual
  std::string note;
};

enum class StepState { Pending, Running, Done, Failed, Skipped };
struct Step {
  std::string title;
  StepState state = StepState::Pending;
  std::string detail;
};

using ProgressFn = std::function<void(const std::vector<Step> &steps, int percent)>;
using LogFn = std::function<void(const std::string &level, const std::string &message)>;

class Deployer {
 public:
  Deployer();
  ~Deployer();

  Options &options() { return options_; }
  const Options &options() const { return options_; }

  void setProgressSink(ProgressFn sink) { progress_ = std::move(sink); }
  void setLogSink(LogFn sink) { logSink_ = std::move(sink); }

  // ---- 环境 ----
  /// 检测依赖与源码状态（不改动系统）。
  std::vector<Dependency> inspect();
  /// 安装缺失依赖；返回是否全部就绪。
  bool installDependencies(std::vector<Dependency> &dependencies);
  /// 定位项目根目录：优先使用 --dir，其次 exe 目录，最后从 GitHub 下载。
  bool ensureSource(bool allowDownload);

  // ---- 部署 ----
  /// 完整部署流程；成功后 publicUrls 给出访问地址。
  bool deploy(std::vector<std::string> &publicUrls);
  void stop();
  /// 服务进程是否仍在运行。
  bool serviceRunning() const;

  std::string projectDir() const { return projectDir_; }
  std::string appSecret() const { return appSecret_; }
  const std::vector<Step> &steps() const { return steps_; }

 private:
  Options options_;
  std::string projectDir_;
  std::string appSecret_;
  std::string localUrl_;
  std::vector<Step> steps_;
  std::vector<std::string> publicUrls_;
  void *serverProcess_ = nullptr;
  void *tunnelProcess_ = nullptr;
  bool ownsServer_ = false;    // 服务进程由本程序启动
  bool reusedServer_ = false;  // 复用了已在运行的服务
  std::string tunnelUrl_;
  ProgressFn progress_;
  LogFn logSink_;

  void emit(const std::string &level, const std::string &message);
  void setStep(size_t index, StepState state, const std::string &detail = "");
  void report();
  size_t addStep(const std::string &title);

  bool detectNode(std::string &version, std::string &nodePath, std::string &npmPath);
  bool checkHealth(int timeoutMs);
  bool waitForHealth(int timeoutMs);
  bool prepareEnvFile();
  bool runNpm(const std::string &args, const std::string &label);
  bool startServer();
  bool startQuickTunnel();
  bool startCustomDomainTunnel();
  bool installWithWinget(const std::string &id, const std::string &label);
  bool installCloudflaredByDownload(std::string &installedPath);
  bool installMinGitByDownload();
  std::string toolsDir() const;
  void registerToolPath(const std::string &dir);
};

std::string modeName(Mode mode);

}  // namespace sc
