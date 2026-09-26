// 校园作业分析 · 一键部署器
// 自动检测并安装依赖 → 准备源码 → 构建 → 启动服务 → 按选择开放局域网或公网访问。
//
// 用法示例：
//   campus-deploy.exe                     交互式菜单
//   campus-deploy.exe --web               打开浏览器可视化部署控制台
//   campus-deploy.exe --mode lan          局域网部署
//   campus-deploy.exe --mode tunnel       临时公网隧道
//   campus-deploy.exe --mode domain --domain homework.example.com --api-token xxx
#include <windows.h>

#include <iostream>
#include <string>
#include <vector>

#include "deploy.h"
#include "util.h"
#include "webconsole.h"

using namespace sc;

namespace {

const char *kVersion = "1.0.0";

void printBanner() {
  setColor(Color::Bold);
  std::cout << "\n  校园作业分析 · 一键部署器  v" << kVersion << "\n";
  resetColor();
  setColor(Color::Dim);
  std::cout << "  Smart Campus Homework Analyzer · One-click Deployer\n";
  resetColor();
  std::cout << "  ──────────────────────────────────────────────────────\n";
}

void printHelp() {
  printBanner();
  std::cout << R"(
用法：campus-deploy.exe [选项]

部署方式
  --mode lan              局域网访问（同一 WiFi / 办公室网络，推荐课堂使用）
  --mode tunnel           Cloudflare 临时公网隧道，自动获得 https 地址
  --mode domain           绑定自己的域名（需要 Cloudflare 账号与域名）

选项
  --domain <域名>         自定义域名，例如 homework.example.com
  --api-token <令牌>      Cloudflare API Token（写 DNS 记录，需 Zone:DNS:Edit 权限）
  --tunnel-token <令牌>   命名隧道的连接器令牌（已有隧道时使用）
  --tunnel-id <ID>        已有隧道 ID（可选，与凭证文件配合）
  --port <端口>           服务端口，默认 8787
  --dir <目录>            指定源码目录；缺省时自动探测，找不到就从 GitHub 下载
  --repo <地址>           源码仓库，默认 https://github.com/turtlelnc/MES-Homework.git
  --web                   打开浏览器可视化部署控制台
  --web-port <端口>       Web 控制台端口，默认 8899
  --skip-install          跳过 npm install
  --skip-build            跳过 npm run build
  --yes                   不询问，直接执行
  --verbose               输出完整构建日志
  --help                  显示本帮助
  --version               显示版本

示例
  campus-deploy.exe --web
  campus-deploy.exe --mode lan --port 8080
  campus-deploy.exe --mode domain --domain hw.example.com --api-token cf_xxx
)";
}

std::string askText(const std::string &question, const std::string &defaultValue = "") {
  std::cout << "  " << question;
  if (!defaultValue.empty()) std::cout << "（默认 " << defaultValue << "）";
  std::cout << "：";
  std::string answer;
  std::getline(std::cin, answer);
  answer = trim(answer);
  return answer.empty() ? defaultValue : answer;
}

void printDependencies(const std::vector<Dependency> &dependencies) {
  std::cout << "\n  环境检测\n";
  for (const Dependency &dependency : dependencies) {
    const bool ok = dependency.available;
    setColor(ok ? Color::Green : (dependency.required ? Color::Red : Color::Dim));
    std::cout << (ok ? "  ✔ " : (dependency.required ? "  ✘ " : "  – "));
    resetColor();
    std::cout << dependency.title;
    if (!dependency.version.empty()) std::cout << "  " << dependency.version;
    else if (!dependency.note.empty()) std::cout << "  " << dependency.note;
    std::cout << "\n";
  }
}

Mode askMode() {
  std::cout << "\n  选择部署方式\n"
               "    1) 局域网（内网）访问 —— 同一网络内的设备都能打开，适合课堂\n"
               "    2) Cloudflare 临时公网隧道 —— 自动生成 https 地址，关掉即失效\n"
               "    3) 绑定自己的域名 —— 需要域名已托管在 Cloudflare\n";
  const std::string choice = askText("请输入序号", "1");
  if (choice == "2") return Mode::QuickTunnel;
  if (choice == "3") return Mode::CustomDomain;
  return Mode::Lan;
}

void printResult(const std::vector<std::string> &urls, const std::string &secret,
                 Mode mode) {
  std::cout << "\n";
  setColor(Color::Green);
  std::cout << "  ✔ 部署完成\n";
  resetColor();
  std::cout << "  ──────────────────────────────────────────────────────\n";
  std::cout << "  访问地址\n";
  for (const std::string &url : urls) {
    setColor(Color::Cyan);
    std::cout << "    " << url << "\n";
    resetColor();
  }
  if (mode == Mode::Lan) {
    std::cout << "\n  提示：若局域网内其它设备打不开，请允许 Node.js 通过 Windows 防火墙，\n"
                 "        或执行（需管理员权限）：\n";
    setColor(Color::Dim);
    std::cout << "        netsh advfirewall firewall add rule name=\"Campus Homework\" "
                 "dir=in action=allow protocol=TCP localport=8787\n";
    resetColor();
  }
  if (mode == Mode::QuickTunnel) {
    std::cout << "\n  提示：临时地址在程序关闭后失效；需要长期可用请改用自定义域名模式。\n";
  }
  std::cout << "\n  密钥 APP_SECRET 已写入源码目录的 .env，请勿外传，也勿提交到 git。\n";
  (void)secret;
  std::cout << "  按 Ctrl+C 可停止服务并退出。\n\n";
}

/// 命令行直通模式：不进入菜单，执行完保持运行。
int runDirect(Deployer &deployer, const Args &args) {
  const Mode mode = deployer.options().mode;
  std::cout << "\n  部署方式：" << modeName(mode) << "\n";

  std::vector<Dependency> dependencies = deployer.inspect();
  std::vector<Dependency> missing;
  for (const Dependency &dependency : dependencies)
    if (dependency.required && !dependency.available) missing.push_back(dependency);

  if (!missing.empty()) {
    printDependencies(dependencies);
    logStep("检测到缺失依赖，开始自动安装…");
    if (!deployer.installDependencies(dependencies)) {
      logError("依赖安装未全部完成，请处理后重试");
      return 1;
    }
  }

  std::vector<std::string> urls;
  if (!deployer.deploy(urls)) {
    logError("部署失败");
    return 1;
  }
  printResult(urls, deployer.appSecret(), mode);

  // 保持进程存活，随 Ctrl+C 一起收尾
  while (deployer.serviceRunning()) Sleep(500);
  logWarn("服务进程已退出");
  return 0;
}

/// 交互式菜单模式；返回 kSwitchToWeb 表示用户要求切到 Web 控制台。
const int kSwitchToWeb = -2;

int runInteractive(Deployer &deployer, int webPort) {
  for (;;) {
    printBanner();
    Options &options = deployer.options();
    std::vector<Dependency> dependencies = deployer.inspect();
    printDependencies(dependencies);

    bool missing = false;
    for (const Dependency &dependency : dependencies)
      if (dependency.required && !dependency.available) missing = true;

    std::cout << "\n  当前设置：端口 " << options.port << "，部署方式 "
              << (options.mode == Mode::Lan
                      ? "局域网（内网）"
                      : (options.mode == Mode::QuickTunnel ? "Cloudflare 临时公网隧道"
                                                          : "自定义域名"))
              << "\n";
    std::cout << "\n  请选择操作\n"
                 "    1) 一键部署（自动安装缺失依赖并启动）\n"
                 "    2) 只安装缺失依赖\n"
                 "    3) 修改设置（端口 / 部署方式 / 源码目录）\n"
                 "    4) 打开浏览器可视化控制台\n"
                 "    0) 退出\n";
    const std::string choice = askText("请输入序号", "1");

    if (choice == "0") return 0;
    if (choice == "2") {
      if (!missing) {
        logOk("依赖已齐全，无需安装");
        continue;
      }
      deployer.installDependencies(dependencies);
      continue;
    }
    if (choice == "3") {
      const std::string port = askText("服务端口", std::to_string(options.port));
      try {
        int value = std::stoi(port);
        if (value > 0 && value < 65536) options.port = value;
      } catch (...) {
      }
      options.mode = askMode();
      if (options.mode == Mode::CustomDomain) {
        options.domain = askText("自定义域名（例如 hw.example.com）");
        options.apiToken = askText("Cloudflare API Token（可留空，稍后手动配置 DNS）");
        options.tunnelToken = askText("隧道连接器令牌（已有隧道时填写，可留空）");
      }
      const std::string dir = askText("源码目录（留空自动探测/下载）", options.projectDir);
      options.projectDir = dir;
      continue;
    }
    if (choice == "4") return kSwitchToWeb;

    // 一键部署
    if (missing) {
      logStep("检测到缺失依赖，先自动安装…");
      if (!deployer.installDependencies(dependencies)) {
        logError("依赖安装未全部完成，请查看上方提示后重试");
        continue;
      }
    }
    std::vector<std::string> urls;
    if (!deployer.deploy(urls)) {
      logError("部署失败，可查看上方日志后重试");
      std::cout << "\n";
      system("pause");
      continue;
    }
    printResult(urls, deployer.appSecret(), options.mode);
    // 部署成功后保持运行，让服务继续对外提供
    while (deployer.serviceRunning()) Sleep(1000);
    logWarn("服务已停止，返回菜单");
  }
}

}  // namespace

int main(int argc, char **argv) {
  initConsole();
  Args args = parseArgs(argc, argv);

  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.version) {
    setColor(Color::Bold);
    std::cout << "campus-deploy " << kVersion << "\n";
    resetColor();
    return 0;
  }

  Deployer deployer;
  Options &options = deployer.options();
  options.port = args.port;
  options.projectDir = args.dir;
  if (!args.repo.empty()) options.repo = args.repo;
  options.domain = args.domain;
  options.apiToken = args.apiToken;
  options.tunnelToken = args.tunnelToken;
  options.tunnelId = args.tunnelId;
  options.skipInstall = args.skipInstall;
  options.skipBuild = args.skipBuild;
  options.verbose = args.verbose;
  if (args.mode == "lan") options.mode = Mode::Lan;
  else if (args.mode == "tunnel") options.mode = Mode::QuickTunnel;
  else if (args.mode == "domain") options.mode = Mode::CustomDomain;

  // Web 控制台模式
  if (args.web) {
    printBanner();
    return runWebConsole(deployer, args.webPort, true);
  }

  // 有 --mode 时直接执行，否则进入交互菜单
  if (!args.mode.empty()) return runDirect(deployer, args);

  printBanner();
  int result = runInteractive(deployer, args.webPort);
  if (result == kSwitchToWeb) {
    // 用户选择进入可视化控制台
    return runWebConsole(deployer, args.webPort, true);
  }
  deployer.stop();
  return result;
}
