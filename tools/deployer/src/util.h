// 校园作业分析 · 一键部署器 —— 基础设施层
// 只依赖 Win32 + C++17 标准库，不引入第三方库。
#pragma once

#include <string>
#include <vector>
#include <functional>
#include <cstdint>

namespace sc {

// ---------- UTF-8 / UTF-16 与控制台 ----------

std::wstring utf8ToWide(const std::string &text);
std::string wideToUtf8(const std::wstring &text);

/// 把控制台切到 UTF-8 代码页，保证中文输出不乱码。
void initConsole();

/// 彩色输出（自动判断是否支持 ANSI；老式控制台自动降级）。
enum class Color { Default, Dim, Red, Green, Yellow, Blue, Cyan, Bold };
void setColor(Color color);
void resetColor();

void logInfo(const std::string &message);
void logStep(const std::string &message);
void logOk(const std::string &message);
void logWarn(const std::string &message);
void logError(const std::string &message);
void logDetail(const std::string &message);

/// 全局日志回调：Web 控制台用它把日志推送到浏览器。
/// level 取值：info / step / ok / warn / error / detail
using LogSink = std::function<void(const std::string &level, const std::string &message)>;
void setLogSink(LogSink sink);

// ---------- 字符串工具 ----------

std::string trim(const std::string &text);
std::string toLower(std::string text);
bool startsWith(const std::string &text, const std::string &prefix);
bool endsWith(const std::string &text, const std::string &suffix);
bool contains(const std::string &text, const std::string &needle);
std::vector<std::string> splitLines(const std::string &text);
std::string replaceAll(std::string text, const std::string &from, const std::string &to);
std::string urlEncode(const std::string &text);
std::string jsonEscape(const std::string &text);
/// 生成 n 位十六进制随机串（用于 APP_SECRET）。
std::string randomHex(int bytes);

// ---------- 文件系统 ----------

bool pathExists(const std::string &utf8Path);
bool isDirectory(const std::string &utf8Path);
bool isFile(const std::string &utf8Path);
bool makeDirs(const std::string &utf8Path);
bool writeFileUtf8(const std::string &utf8Path, const std::string &content);
bool readFileUtf8(const std::string &utf8Path, std::string &out);
std::string joinPath(const std::string &a, const std::string &b);
std::string parentDir(const std::string &utf8Path);
std::string baseName(const std::string &utf8Path);
std::string currentDir();
std::string envVar(const std::string &name);
uint64_t fileSize(const std::string &utf8Path);
/// 递归复制目录（用于 --copy 模式准备部署副本）。
bool copyTree(const std::string &from, const std::string &to, std::string &error);

// ---------- 进程 ----------

struct ProcessResult {
  int exitCode = -1;
  std::string output;  // stdout + stderr 合并
  bool started = false;
};

/// 运行命令并把输出逐行回调；返回退出码。cb 可为空。
ProcessResult runProcess(const std::string &commandLine,
                         const std::string &workingDir,
                         const std::function<void(const std::string &line)> &onLine = nullptr);

/// 后台启动进程（不等待），返回进程句柄所有权；失败返回 nullptr。
void *startBackground(const std::string &commandLine, const std::string &workingDir,
                      unsigned long *outPid);
bool killProcess(void *handle);
bool isProcessRunning(void *handle);
void closeProcess(void *handle);
/// 终止本程序启动的全部后台进程（退出前清理）。
void killAllBackground();

/// 让 node 进程收到结束信号并等待退出。
bool stopProcessGracefully(void *handle, int waitMs);

/// 在资源管理器中打开路径/网址。
void openInShell(const std::string &target);

// ---------- HTTP ----------

struct HttpResponse {
  bool ok = false;
  long status = 0;
  std::string body;
  std::string error;
  bool started = false;  // curl 是否成功启动
};

/// 用系统 curl.exe 发起请求（Windows 10+ 自带），避免引入 OpenSSL 依赖。
HttpResponse httpRequest(const std::string &url, const std::string &method = "GET",
                         const std::vector<std::string> &headers = {},
                         const std::string &body = "");
HttpResponse httpGet(const std::string &url, const std::vector<std::string> &headers = {});
HttpResponse httpPostJson(const std::string &url, const std::string &json,
                          const std::vector<std::string> &extraHeaders = {});

/// 用 curl 下载文件到磁盘，onProgress 收到百分比（0-100，未知时为 -1）。
bool downloadFile(const std::string &url, const std::string &targetPath,
                  const std::function<void(int)> &onProgress = nullptr);

bool hasCommand(const std::string &command);

// ---------- 网络 ----------

/// 列出本机 IPv4 地址（排除回环与虚拟网卡常见网段）。
std::vector<std::string> localIPv4Addresses();

/// 判断端口是否已被占用。
bool portInUse(int port);

// ---------- 命令行 ----------

struct Args {
  std::vector<std::pair<std::string, std::string>> items;
  std::string mode;          // lan | tunnel | domain | ""
  std::string domain;        // 自定义域名
  std::string tunnelToken;   // 命名隧道连接器令牌
  std::string apiToken;      // Cloudflare API Token
  std::string dir;           // 部署目录（默认：exe 同级目录）
  std::string repo;          // 源码仓库地址
  int port = 8787;
  bool web = false;          // 打开 Web 部署控制台
  int webPort = 8899;
  bool yes = false;          // 跳过交互确认
  bool verbose = false;
  bool help = false;
  bool version = false;
  bool skipInstall = false;
  bool skipBuild = false;
  std::string tunnelId;
  std::string get(const std::string &key, const std::string &fallback = "") const;
};

/// 判断命令行开关是否开启（--flag 无取值时视为 true）。
bool isTrue(const std::string &value);

Args parseArgs(int argc, char **argv);

}  // namespace sc
