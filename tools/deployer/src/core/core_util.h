// 校园作业分析 · 桌面部署器 —— core 内部共享小工具
// 仅供 core/ 内部与单元测试使用；对外契约仍是 core/core.h。
#pragma once

#include "core/core.h"

#include <string>

namespace mes::core {

// 解析后的安装目录 / 数据目录（空选项回退到默认值）。
std::string installDirOf(const Options& options);
std::string dataDirOf(const Options& options);

// 跨平台判断绝对路径：Windows 盘符、UNC、POSIX 根。
bool isAbsolutePath(const std::string& path);

// 把反斜杠统一成斜杠（写 .env / 日志展示时使用，Node 在 Windows 上同样识别 /）。
std::string normalizeSlashes(const std::string& path);

// 生成 Node.js --env-file 可安全读取的 .env 值（必要时加双引号）。
// 路径值会先把反斜杠转成 /，避免 Node 把 "\\n" 当成换行转义。
std::string envValue(const std::string& value, bool isPathLike);

// Windows 命令/批处理字符串转义：整体加双引号，并处理 % 变量展开。
// 返回值可直接放进 cmd 的 `set "X=..."`、`cd /d "..."` 或 /TR 参数里。
std::string cmdQuote(const std::string& value);

// 去掉首尾空白。
std::string trimText(const std::string& text);

// 日志/错误文案里隐藏敏感值（APP_SECRET 等）。
std::string maskSecret(const std::string& secret);

// 安装状态 JSON 序列化 / 反序列化（readState/writeState 的底层实现，便于单测）。
std::string installStateToJson(const InstallState& state);
bool installStateFromJson(const std::string& json, InstallState& out);

// ---------------------------------------------------------------- 服务文本（内部）
// POSIX 启动脚本（start.sh）：从 .env 加载环境变量后 exec Node。
std::string posixStartScript(const Options& options);

// Windows 计划任务 XML（用于 schtasks /Create /XML，可设置无限运行时长等）。
// 返回 UTF-8 文本；写入磁盘前需经 utf16LeWithBom() 转成 UTF-16LE（schtasks 要求）。
std::string windowsTaskXml(const Options& options);

// UTF-8 → 带 BOM 的 UTF-16LE 字节串（schtasks /XML 必须为 Unicode 编码）。
std::string utf16LeWithBom(const std::string& utf8);

// XML 文本转义。
std::string xmlEscape(const std::string& text);

// ---------------------------------------------------------------- 路径推导
// 与 windowsStartScript/systemdUnit 等生成的服务文本保持一致。
std::string hostOf(const Options& options);       // lan ? 0.0.0.0 : 127.0.0.1
std::string nodeEnvOf(const Options& options);    // production / development
std::string appDirOf(const Options& options);     // <install>/app
std::string launchEntryOf(const Options& options);
std::string serverEntryOf(const Options& options);  // <install>/app/server/index.mjs
std::string logsDirOf(const Options& options);    // <install>/logs
std::string serverLogOf(const Options& options);  // <install>/logs/server.log
std::string envFileOf(const Options& options);    // <install>/.env
// 自带 Node 运行时：Windows 为 runtime/node.exe，其余为 runtime/node。
std::string platformNodeOf(const Options& options);
// 启动脚本：Windows start.cmd，其余 start.sh。
std::string startScriptPathOf(const Options& options);
// 服务定义文件：Windows 任务 XML / systemd unit / launchd plist。
std::string serviceDefinitionPathOf(const Options& options);
// 本地直启进程的 pid 文件。
std::string instancePidPathOf(const Options& options);
// 提权子进程回写执行结果的中转文件。
std::string elevatedResultPathOf(const Options& options);

}  // namespace mes::core
