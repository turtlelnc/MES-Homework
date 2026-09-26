// 校园作业分析 · 一键部署器 —— 内置 Web 部署控制台
// 复用主程序的 HTTP 客户端：这里只做“本机回环”上的简易服务端，
// 用于给浏览器提供一个可视化部署界面（含实时日志）。
#pragma once

#include <string>

#include "deploy.h"

namespace sc {

/// 在 127.0.0.1:port 上启动 Web 部署控制台，阻塞直到用户按 Ctrl+C 或调用 stop。
int runWebConsole(Deployer &deployer, int port, bool openBrowser);

}  // namespace sc
