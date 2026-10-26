// 应用状态机：页面切换、后台部署线程、已安装实例检测与轻提示。
#include "app.h"

#include "imgui.h"
#include "platform/platform.h"

#include <chrono>
#include <cstdio>
#include <exception>
#include <string>

namespace mes {
namespace {

constexpr size_t kMaxLogLines = 500;

core::ProgressState demoProgress(const core::PlatformInfo& platform) {
  core::ProgressState progress;
  progress.running = true;
  progress.percent = 46;
  progress.message = "正在解压应用文件…";
  const struct {
    const char* id;
    const char* title;
    const char* detail;
    core::StepState state;
  } steps[] = {
      {"platform", "检查系统兼容性", "当前运行环境", core::StepState::Done},
      {"download", "获取安装包", "演示下载步骤（未下载真实文件）", core::StepState::Done},
      {"verify", "校验安装包", "演示校验步骤", core::StepState::Done},
      {"extract", "解压应用文件", "演示解压步骤（未写入真实文件）", core::StepState::Running},
      {"config", "写入配置", "生成 .env 与启动脚本", core::StepState::Pending},
      {"service", "安装系统服务", "创建开机启动项", core::StepState::Pending},
      {"start", "启动应用", "等待本地服务就绪", core::StepState::Pending},
      {"health", "健康检查", "读取实际配置的健康检查地址", core::StepState::Pending},
  };
  for (const auto& step : steps) {
    core::Step item;
    item.id = step.id;
    item.title = step.title;
    item.detail = std::string(step.id)=="platform" ? platform.osLabel+" · "+platform.archLabel : step.detail;
    item.state = step.state;
    progress.steps.push_back(item);
  }
  return progress;
}

std::deque<LogLine> demoLogs(const core::PlatformInfo& platform) {
  return {{"info",std::string("演示模式 · 部署器 ")+core::kVersion+" (build "+core::kBuild+")"},
          {"info",platform.osLabel+" · "+platform.archLabel},
          {"info","仅预览操作流程：不显示虚构的磁盘容量、下载速度或校验结果。"},
          {"step","实际安装时将读取清单、下载文件、验证 SHA-256 并记录真实结果。"}};
}

void setDemoPreview(AppState& state) {
  state.previewData = true;
  state.uiProgress = demoProgress(state.platform);
  state.progress = state.uiProgress;
  state.uiLogs = demoLogs(state.platform);
  state.logs = state.uiLogs;
  state.uiResult = core::DeploymentResult{};
  state.uiResult.ok = true;
  state.uiResult.installDir = state.options.installDir;
  state.uiResult.url = "http://127.0.0.1:" + std::to_string(state.options.port);
  state.uiResult.logPath = core::logFilePath(state.options);
  state.uiResult.bundleVersion = core::kVersion;
  state.uiResultReady = false;
}

void postBanner(AppState& state, const std::string& text, bool error) {
  std::lock_guard<std::mutex> lock(state.mutex);
  state.hasPendingBanner = true;
  state.pendingBannerText = text;
  state.pendingBannerError = error;
}

bool beginAction(AppState& state) {
  if (state.actionBusy.load()) return false;
  if (state.actionWorker.joinable()) state.actionWorker.join();
  state.actionBusy = true;
  return true;
}

void runAction(AppState& state, std::function<void()> task) {
  state.actionWorker = std::thread([&state, task]() {
    try {
      task();
    } catch (const std::exception& error) {
      postBanner(state, std::string("操作异常：") + error.what(), true);
    } catch (...) {
      postBanner(state, "操作出现未知异常", true);
    }
    state.actionBusy = false;
  });
}

}  // namespace

std::string normalizePath(const std::string& path) {
#if defined(_WIN32)
  std::string out = path;
  for (char& ch : out) {
    if (ch == '/') ch = '\\';
  }
  return out;
#else
  return path;
#endif
}

bool modalOpen(const AppState& state) {
  return state.showCancelConfirm || state.confirmUninstall;
}

bool deploymentPending(const AppState& state) { return state.busy; }

core::Options effectiveOptions(const AppState& state) {
  core::Options options = state.options;
  if (state.installed && !state.installState.installDir.empty()) {
    options.installDir = state.installState.installDir;
    if (state.installState.port > 0) options.port = state.installState.port;
    options.edition = state.installState.edition == "server"
                          ? core::Edition::Server
                          : core::Edition::Local;
  }
  return options;
}

void appInit(AppState& state, bool demoMode) {
  state.platform = core::detectPlatform();
  state.demoMode = demoMode;
  state.startedAt = ImGui::GetTime();
  state.now = state.startedAt;
  state.cancel = false;
  state.options = core::Options{};
  state.edition = core::Edition::Local;
  state.options.edition = state.edition;
  state.options.releaseTag = core::kReleaseTag;
  state.options.openBrowser = true;
  state.options.installDir = normalizePath(core::defaultInstallDir(state.edition));

  if (demoMode) {
    state.options.embedDemoPayload = true;
    state.demoMode = true;
    // 演示模式不伪造"已安装"实例：欢迎页保持首次使用状态；
    // 安装/结果页的演示数据由 setDemoPreview 提供（仅用于界面预览）。
    setDemoPreview(state);
    return;
  }
  refreshInstalledState(state);
}

void refreshInstalledState(AppState& state) {
  core::InstallState fresh;
  bool ok = core::readState(fresh);
  if (ok && fresh.installDir.empty()) ok = false;
  bool running = false;
  if (ok) {
    core::Options probe = state.options;
    probe.installDir = normalizePath(fresh.installDir);
    if (fresh.port > 0) probe.port = fresh.port;
    if (fresh.edition == "server") probe.edition = core::Edition::Server;
    running = core::serviceInstalled(probe);
  }
  std::lock_guard<std::mutex> lock(state.mutex);
  state.installed = ok;
  state.serviceRunning = ok ? running : false;
  if (!ok) return;
  fresh.installDir = normalizePath(fresh.installDir);
  fresh.dataDir = normalizePath(fresh.dataDir);
  state.installState = fresh;
  state.options.installDir = fresh.installDir;
  if (fresh.port > 0) state.options.port = fresh.port;
  if (fresh.edition == "server") {
    state.options.edition = core::Edition::Server;
    state.edition = core::Edition::Server;
  } else if (fresh.edition == "local") {
    state.options.edition = core::Edition::Local;
    state.edition = core::Edition::Local;
  }
}

void appFrame(AppState& state) {
  ImGuiIO& io = ImGui::GetIO();
  state.now = ImGui::GetTime();
  state.spinnerPhase += io.DeltaTime * 2.0f;
  if (state.spinnerPhase > 1000.0f) state.spinnerPhase -= 1000.0f;

  bool hasPending = false;
  std::string pendingText;
  bool pendingError = false;
  bool gotResult = false;
  bool refresh = false;
  bool postUninstall = false;
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.hasPendingBanner) {
      hasPending = true;
      pendingText = state.pendingBannerText;
      pendingError = state.pendingBannerError;
      state.hasPendingBanner = false;
    }
    if (state.progressDirty) {
      state.uiProgress = state.progress;
      state.progressDirty = false;
    }
    if (state.logsDirty) {
      state.uiLogs = state.logs;
      state.logsDirty = false;
    }
    if (state.resultReady) {
      state.uiResult = state.result;
      state.resultReady = false;
      gotResult = true;
    }
    if (state.actionRefresh) {
      refresh = true;
      state.actionRefresh = false;
    }
    if (state.postUninstall) {
      postUninstall = true;
      state.postUninstall = false;
    }
  }
  if (hasPending) notify(state, pendingText, pendingError);

  if (gotResult) {
    if (state.worker.joinable()) state.worker.join();
    state.busy = false;
    state.cancelRequested = false;
    state.cancel = false;
    state.uiResultReady = true;
    state.previewData = false;
    state.screen = Screen::Result;
    if (!state.demoMode) refreshInstalledState(state);
  }

  if (refresh && !state.demoMode) refreshInstalledState(state);
  if (postUninstall) {
    state.screen = Screen::Welcome;
    state.confirmUninstall = false;
    if (!state.demoMode) refreshInstalledState(state);
  }

  if (state.actionWorker.joinable() && !state.actionBusy.load()) {
    state.actionWorker.join();
  }

  if (!state.bannerText.empty() && state.now - state.bannerAt > 2.8) {
    state.bannerText.clear();
  }
}

void appShutdown(AppState& state) {
  state.cancel = true;
  if (state.worker.joinable()) state.worker.join();
  if (state.actionWorker.joinable()) state.actionWorker.join();
  state.busy = false;
  state.actionBusy = false;
}

void notify(AppState& state, const std::string& text, bool error) {
  state.bannerText = text;
  state.bannerError = error;
  state.bannerAt = ImGui::GetCurrentContext() ? ImGui::GetTime() : 0.0;
}

void startDeployment(AppState& state) {
  if (state.busy) {
    notify(state, "部署正在进行中，请等待完成", true);
    return;
  }
  if (state.worker.joinable()) state.worker.join();
  state.options.edition = state.edition;
  if (state.options.installDir.empty())
    state.options.installDir = core::defaultInstallDir(state.edition);
  state.options.installDir = normalizePath(state.options.installDir);
  std::string error = core::validateOptions(state.options);
  if (error.empty() && state.options.installDir.empty())
    error = "请选择安装目录";
  if (error.empty() && !state.options.payloadZip.empty() &&
      !platform::fileExists(state.options.payloadZip)) {
    error = "所选安装包不存在：" + state.options.payloadZip;
  }
  if (error.empty() && !state.options.payloadUrl.empty() &&
      state.options.payloadUrl.rfind("http", 0) != 0) {
    error = "自定义下载地址需以 http:// 或 https:// 开头";
  }
  if (!error.empty()) {
    notify(state, error, true);
    return;
  }

  {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.progress = core::ProgressState{};
    state.logs.clear();
    state.result = core::DeploymentResult{};
    state.progressDirty = true;
    state.logsDirty = true;
    state.resultReady = false;
    state.hasPendingBanner = false;
  }
  state.uiProgress = core::ProgressState{};
  state.uiLogs.clear();
  state.uiResult = core::DeploymentResult{};
  state.uiResultReady = false;
  state.previewData = false;
  state.screen = Screen::Installing;
  state.busy = true;
  state.cancel = false;
  state.cancelRequested = false;
  state.showCancelConfirm = false;
  state.confirmUninstall = false;
  state.logAutoScroll = true;
  state.logScroll = 0.0f;
  state.startedAt = ImGui::GetTime();

  const core::Options options = state.options;
  state.worker = std::thread([&state, options]() {
    core::RunCallbacks callbacks;
    callbacks.onProgress = [&state](const core::ProgressState& progress) {
      std::lock_guard<std::mutex> lock(state.mutex);
      state.progress = progress;
      state.progressDirty = true;
    };
    callbacks.onLog = [&state](const std::string& level,
                               const std::string& text) {
      std::lock_guard<std::mutex> lock(state.mutex);
      if (state.logs.size() >= kMaxLogLines) state.logs.pop_front();
      state.logs.push_back(LogLine{level, text});
      state.logsDirty = true;
    };
    core::DeploymentResult result;
    try {
      result = core::runDeployment(options, callbacks, state.cancel);
    } catch (const std::exception& error) {
      result = core::DeploymentResult{};
      result.ok = false;
      result.error = std::string("部署过程异常：") + error.what();
    } catch (...) {
      result = core::DeploymentResult{};
      result.ok = false;
      result.error = "部署过程出现未知异常";
    }
    if (result.installDir.empty()) result.installDir = options.installDir;
    if (result.logPath.empty()) result.logPath = core::logFilePath(options);
    std::lock_guard<std::mutex> lock(state.mutex);
    state.result = result;
    state.resultReady = true;
  });
}

void startStop(AppState& state) {
  if (!state.installed) {
    notify(state, "尚未检测到已安装的应用", true);
    return;
  }
  if (!beginAction(state)) return;
  const core::Options options = effectiveOptions(state);
  runAction(state, [&state, options]() {
    std::string error;
    const bool ok = core::stopDeployment(options, error);
    postBanner(state, ok ? "服务已停止" : (error.empty() ? "停止服务失败" : error),
               !ok);
    std::lock_guard<std::mutex> lock(state.mutex);
    state.actionRefresh = true;
  });
}

void startUninstall(AppState& state) {
  if (!state.installed) {
    notify(state, "尚未检测到已安装的应用", true);
    return;
  }
  if (!beginAction(state)) return;
  const core::Options options = effectiveOptions(state);
  const bool removeData = state.uninstallRemoveData;
  state.confirmUninstall = false;
  runAction(state, [&state, options, removeData]() {
    std::string error;
    const bool ok = core::uninstallDeployment(options, removeData, error);
    postBanner(state, ok ? "已卸载校园作业分析" : (error.empty() ? "卸载失败" : error),
               !ok);
    std::lock_guard<std::mutex> lock(state.mutex);
    state.actionRefresh = true;
    if (ok) state.postUninstall = true;
  });
}

void startOpenApp(AppState& state) {
  if (!state.installed) {
    notify(state, "尚未检测到已安装的应用", true);
    return;
  }
  if (!beginAction(state)) return;
  const core::Options options = effectiveOptions(state);
  runAction(state, [&state, options]() {
    std::string error;
    const bool ok = core::openInstalled(options, error);
    if (!ok) postBanner(state, error.empty() ? "打开应用失败" : error, true);
  });
}

void resetToWelcome(AppState& state) {
  state.screen = Screen::Welcome;
  state.showCancelConfirm = false;
  state.confirmUninstall = false;
  state.cancelRequested = false;
  state.uiResultReady = false;
  state.previewData = state.demoMode;
}

}  // namespace mes
