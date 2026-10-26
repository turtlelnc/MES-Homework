// 校园作业分析 · 桌面部署器 —— CTest 核心用例
// 1) 调用 runSelfTest 覆盖纯逻辑；
// 2) 额外的引擎编排用例：demo 模式、取消、失败快速返回、文件摘要、zip-slip。
#include "core/core.h"
#include "core/core_util.h"
#include "core/json.h"
#include "core/manifest_parse.h"
#include "platform/platform.h"

#include "miniz.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace {

int gFailures = 0;

void expect(bool condition, const std::string& name,
            const std::string& detail = std::string()) {
  if (condition) {
    std::printf("  ok   %s\n", name.c_str());
    return;
  }
  ++gFailures;
  std::printf("  FAIL %s", name.c_str());
  if (!detail.empty()) std::printf("（%s）", detail.c_str());
  std::printf("\n");
}

void section(const char* title) { std::printf("\n== %s ==\n", title); }

bool platformFileIoAvailable() {
  const std::string base = mes::platform::tempDir();
  if (base.empty()) return false;
  const std::string probe = mes::platform::joinPath(
      base, "mes-coretest-probe-" + mes::platform::randomHex(4));
  if (!mes::platform::ensureDir(probe)) return false;
  const std::string file = mes::platform::joinPath(probe, "probe.txt");
  const bool wrote = mes::platform::writeFile(file, "ok");
  std::string content;
  const bool read = mes::platform::readFile(file, content);
  mes::platform::removeTree(probe);
  return wrote && read && content == "ok";
}

std::string uniqueTempPath(const std::string& name) {
  return mes::platform::joinPath(
      mes::platform::tempDir(),
      name + "-" + mes::platform::randomHex(6));
}

void testSelfTest() {
  section("核心自检");
  expect(mes::core::runSelfTest(true), "runSelfTest 全部通过");
}

void testFileSha256() {
  section("文件 SHA-256");
  if (!platformFileIoAvailable()) {
    std::printf("  skip 平台文件 IO 不可用\n");
    return;
  }
  const std::string base = uniqueTempPath("mes-coretest-sha");
  const std::string file = mes::platform::joinPath(base, "abc.bin");
  expect(mes::platform::writeFile(file, "abc"), "写入测试文件");
  expect(mes::core::sha256HexFile(file) ==
             "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
         "sha256HexFile 与标准向量一致");
  expect(mes::core::sha256HexFile(
             mes::platform::joinPath(base, "not-exists.bin")).empty(),
         "不存在的文件返回空摘要");
  mes::platform::removeTree(base);
}

void testDemoDeployment() {
  section("部署引擎 demo 模式");
  const std::string installDir = uniqueTempPath("mes-coretest-demo");
  mes::core::Options options;
  options.embedDemoPayload = true;
  options.port = 8899;
  options.installDir = installDir;
  options.openBrowser = false;

  std::atomic<bool> cancel{false};
  int progressCount = 0;
  int logCount = 0;
  mes::core::ProgressState lastProgress;
  mes::core::RunCallbacks callbacks;
  callbacks.onProgress = [&](const mes::core::ProgressState& progress) {
    ++progressCount;
    lastProgress = progress;
  };
  callbacks.onLog = [&](const std::string& level, const std::string& text) {
    if (!level.empty() && !text.empty()) ++logCount;
  };

  const mes::core::DeploymentResult result =
      mes::core::runDeployment(options, callbacks, cancel);
  expect(result.ok, "demo 部署成功", result.error);
  expect(!result.cancelled, "demo 部署未取消");
  expect(result.url.find("8899") != std::string::npos,
         "demo 返回示例访问地址", result.url);
  expect(progressCount >= 5, "进度回调多次触发");
  expect(logCount >= 5, "日志回调多次触发");
  expect(lastProgress.steps.size() == 10, "步骤数量为 10");
  expect(lastProgress.done, "进度状态 done");
  expect(!lastProgress.failed, "进度状态未失败");
  expect(lastProgress.percent == 100, "进度为 100%");
  bool allSettled = true;
  for (const mes::core::Step& step : lastProgress.steps) {
    if (step.state != mes::core::StepState::Done &&
        step.state != mes::core::StepState::Skipped)
      allSettled = false;
  }
  expect(allSettled, "所有步骤均已完成或跳过");
  expect(!mes::platform::dirExists(installDir), "demo 模式不写真实目录");
}

void testCancelDeployment() {
  section("部署引擎取消");
  const std::string installDir = uniqueTempPath("mes-coretest-cancel");
  mes::core::Options options;
  options.embedDemoPayload = true;
  options.port = 8898;
  options.installDir = installDir;
  options.openBrowser = false;

  std::atomic<bool> cancel{true};
  const mes::core::DeploymentResult cancelled =
      mes::core::runDeployment(options, mes::core::RunCallbacks{}, cancel);
  expect(cancelled.cancelled, "开始前取消会被识别");
  expect(!cancelled.ok, "取消时 ok=false");

  std::atomic<bool> lateCancel{false};
  std::thread canceller([&lateCancel]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(120));
    lateCancel.store(true);
  });
  const mes::core::DeploymentResult interrupted =
      mes::core::runDeployment(options, mes::core::RunCallbacks{}, lateCancel);
  canceller.join();
  expect(interrupted.cancelled, "运行中取消会被识别");
  expect(!interrupted.ok, "运行中取消时 ok=false");
  expect(!mes::platform::dirExists(installDir), "取消后不残留安装目录");
}

void testFailureFast() {
  section("部署引擎失败路径");
  const std::string installDir = uniqueTempPath("mes-coretest-fail");
  const bool runtimeSupported = mes::core::detectPlatform().appRuntimeSupported;
  mes::core::Options badPort;
  badPort.port = 70000;
  badPort.installDir = installDir;
  std::atomic<bool> cancel{false};
  const mes::core::DeploymentResult portResult =
      mes::core::runDeployment(badPort, mes::core::RunCallbacks{}, cancel);
  if (runtimeSupported) {
    expect(!portResult.ok && !portResult.cancelled, "非法端口导致失败");
    expect(portResult.error.find("端口") != std::string::npos,
           "失败信息包含中文原因", portResult.error);
  } else {
    expect(!portResult.ok, "32 位系统拒绝部署（符合预期）");
    expect(portResult.error.find("32 位") != std::string::npos,
           "32 位系统错误提示为中文", portResult.error);
  }

  mes::core::Options missingZip;
  missingZip.installDir = installDir;
  missingZip.payloadZip =
      mes::platform::joinPath(mes::platform::tempDir(), "mes-missing-payload.zip");
  const mes::core::DeploymentResult zipResult =
      mes::core::runDeployment(missingZip, mes::core::RunCallbacks{}, cancel);
  expect(!zipResult.ok, "缺失本地安装包导致失败");
  if (runtimeSupported) {
    expect(zipResult.error.find("找不到本地安装包") != std::string::npos,
           "缺失安装包错误为中文", zipResult.error);
  } else {
    expect(zipResult.error.find("32 位") != std::string::npos,
           "32 位系统错误提示为中文", zipResult.error);
  }
  expect(!mes::platform::dirExists(installDir), "失败后不残留安装目录");
}

void testOptionsAndTexts() {
  section("选项与文本");
  const std::string installDir =
      mes::platform::joinPath(mes::platform::tempDir(), "mes-coretest-home");
  mes::core::Options options;
  options.installDir = installDir;
  expect(mes::core::validateOptions(options).empty(), "默认本地版选项合法");

  mes::core::Options server = options;
  server.edition = mes::core::Edition::Server;
  server.port = 8787;
  server.lan = true;
  server.autostart = true;
  expect(mes::core::validateOptions(server).empty(), "服务器版选项合法");

  mes::core::Options same = options;
  same.dataDir = installDir;
  expect(!mes::core::validateOptions(same).empty(), "拒绝安装目录=数据目录");

  mes::core::Options relative = options;
  relative.installDir = "..\\evil";
  expect(!mes::core::validateOptions(relative).empty(), "拒绝相对/越界安装目录");

  mes::core::Options badPayload = options;
  badPayload.payloadDir = installDir;
  badPayload.payloadZip = installDir + ".zip";
  expect(!mes::core::validateOptions(badPayload).empty(), "拒绝同时指定两种本地包");

  expect(mes::core::defaultInstallDir(mes::core::Edition::Local).find(
             ".mes-homework") != std::string::npos,
         "本地版默认目录");
  expect(mes::core::defaultInstallDir(mes::core::Edition::Server).find(
             "mes-homework-server") != std::string::npos,
         "服务器版默认目录");
  expect(mes::core::healthUrl(server) == "http://127.0.0.1:8787/api/health",
         "健康检查地址");
  expect(!mes::core::serviceLabel().empty(), "服务标签非空");
  expect(mes::core::logFilePath(options).find("deployer.log") !=
             std::string::npos,
         "日志文件路径");
  const std::string env =
      mes::core::envFileContent(server, std::string(96, 'b'));
  expect(env.find("HOST=0.0.0.0") != std::string::npos, ".env HOST");
  expect(env.find("PORT=8787") != std::string::npos, ".env PORT");
  expect(env.find("APP_SECRET=") != std::string::npos, ".env APP_SECRET");

  const std::string upgraded = mes::core::envFileContent(server, std::string(96, 'b'),
      "MODEL_CONCURRENCY=7\nOAUTH_GEMINI_CLIENT_ID=fixture\nexport PORT=9\nAPP_SECRET=old\n# retained\n");
  expect(upgraded.find("MODEL_CONCURRENCY=7") != std::string::npos, "升级保留资源配置");
  expect(upgraded.find("OAUTH_GEMINI_CLIENT_ID=fixture") != std::string::npos, "升级保留 OAuth 配置");
  expect(upgraded.find("PORT=9") == std::string::npos && upgraded.find("APP_SECRET=old") == std::string::npos, "升级替换受管配置");
  const std::string startScript = mes::core::windowsStartScript(server);
  expect(startScript.find("tools\\ops\\supervise.mjs") != std::string::npos, "安装启动优先监督器");
  expect(startScript.find("cd /d") != std::string::npos,
         "启动脚本包含 cd /d");
  expect(startScript.find("runtime\\node.exe") != std::string::npos,
         "启动脚本包含 node 路径");
  expect(mes::core::windowsServerTaskCommand(server).find("schtasks") !=
             std::string::npos,
         "schtasks 命令");
  expect(mes::core::systemdUnit(server, "/opt/node").find("[Service]") !=
             std::string::npos,
         "systemd 单元");
  expect(mes::core::launchdPlist(server, "/opt/node", "MES-Homework")
                 .find("<plist") != std::string::npos,
         "launchd plist");
}

void testZipSlip() {
  section("ZIP 安全");
  if (!platformFileIoAvailable()) {
    std::printf("  skip 平台文件 IO 不可用\n");
    return;
  }
  const std::string base = uniqueTempPath("mes-coretest-zip");
  mes::platform::ensureDir(base);
  struct Cleanup {
    std::string path;
    ~Cleanup() { mes::platform::removeTree(path); }
  } cleanup{base};

  const std::vector<std::string> evilNames = {
      "../escape.txt",        "/abs/escape.txt",
      "C:\\Windows\\evil.txt", "app/../../escape.txt",
      "app/.. /escape.txt",   "app/COM1",
  };
  for (const std::string& name : evilNames) {
    const std::string zipPath =
        mes::platform::joinPath(base, "evil-" + mes::platform::randomHex(3) + ".zip");
    mz_zip_archive writer;
    std::memset(&writer, 0, sizeof(writer));
    if (!mz_zip_writer_init_file(&writer, zipPath.c_str(), 0)) continue;
    mz_zip_writer_add_mem(&writer, name.c_str(), "x", 1, MZ_DEFAULT_COMPRESSION);
    mz_zip_writer_finalize_archive(&writer);
    mz_zip_writer_end(&writer);
    std::string error;
    const bool extracted = mes::core::extractZip(
        zipPath, mes::platform::joinPath(base, "out"), error);
    expect(!extracted, "拒绝恶意条目：" + name);
    expect(!error.empty(), "恶意条目有中文错误说明");
  }
  // 正常 zip 应能解压。
  const std::string goodZip = mes::platform::joinPath(base, "good.zip");
  mz_zip_archive writer;
  std::memset(&writer, 0, sizeof(writer));
  if (mz_zip_writer_init_file(&writer, goodZip.c_str(), 0)) {
    const std::string content = "hello";
    mz_zip_writer_add_mem(&writer, "app/server/index.mjs", content.data(),
                          content.size(), MZ_DEFAULT_COMPRESSION);
    mz_zip_writer_finalize_archive(&writer);
    mz_zip_writer_end(&writer);
    const std::string dest = mes::platform::joinPath(base, "good-out");
    std::string error;
    expect(mes::core::extractZip(goodZip, dest, error), "正常 zip 解压成功", error);
    std::string readBack;
    expect(mes::platform::readFile(
               mes::platform::joinPath(dest, "app/server/index.mjs"), readBack) &&
               readBack == "hello",
           "正常 zip 内容正确");
  }
}

void testManifest() {
  section("Release 清单");
  const std::string json =
      "{\"version\":\"v9\",\"createdAt\":\"2026-01-01T00:00:00Z\","
      "\"entries\":[{\"platform\":\"windows\",\"arch\":\"x64\","
      "\"asset\":\"mes-homework-app-windows-x64.zip\",\"sha256\":\""
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      "\",\"size\":42,\"nodeVersion\":\"v24.0.0\"}]}";
  mes::core::Manifest manifest;
  std::string error;
  expect(mes::core::parseManifest(json, manifest, error), "解析清单", error);
  expect(manifest.entries.size() == 1, "清单条目数");
  mes::core::PlatformInfo platform = mes::core::detectPlatform();
  platform.os = "windows";
  platform.arch = "x64";
  const mes::core::ManifestEntry* entry =
      mes::core::findManifestEntry(manifest, platform);
  expect(entry != nullptr, "找到平台条目");
  if (entry != nullptr) {
    expect(entry->size == 42, "条目 size 解析");
    expect(entry->nodeVersion == "v24.0.0", "条目 nodeVersion 解析");
    expect(mes::core::manifestEntryUrl("v9", *entry).find("v9/") !=
               std::string::npos,
           "条目 URL 使用 release tag");
  }
  mes::core::Manifest broken;
  expect(!mes::core::parseManifest("", broken, error), "拒绝空清单");
  expect(!mes::core::parseManifest("[]", broken, error), "拒绝数组顶层");
  expect(!error.empty(), "清单错误信息非空");
}

}  // namespace

int main() {
  std::printf("校园作业分析 · 桌面部署器核心测试（%s / build %s）\n",
              mes::core::kVersion, mes::core::kBuild);
  testSelfTest();
  testFileSha256();
  testDemoDeployment();
  testCancelDeployment();
  testFailureFast();
  testOptionsAndTexts();
  testZipSlip();
  testManifest();
  std::printf("\n结果：%d 项失败\n", gFailures);
  return gFailures == 0 ? 0 : 1;
}
