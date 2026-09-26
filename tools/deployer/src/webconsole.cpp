// 校园作业分析 · 一键部署器 —— 内置 Web 部署控制台实现
// 一个只监听 127.0.0.1 的极简 HTTP 服务：提供可视化部署界面 + 实时日志轮询接口。
#include "webconsole.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <atomic>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

#include "cloudflare.h"
#include "util.h"

namespace sc {

namespace {

struct LogEntry {
  std::string level;
  std::string message;
  std::string time;
};

std::mutex g_mutex;
std::vector<LogEntry> g_logs;
std::atomic<bool> g_busy{false};
std::atomic<bool> g_running{true};
std::string g_phase = "idle";        // idle | deploy | stop | install
std::string g_result;                // 部署结果 url 列表（JSON 数组字符串）
std::string g_error;
std::atomic<int> g_percent{0};
std::string g_stepsJson = "[]";
Deployer *g_deployer = nullptr;
std::thread g_worker;

std::string nowTime() {
  SYSTEMTIME time{};
  GetLocalTime(&time);
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d", time.wHour, time.wMinute,
                time.wSecond);
  return buffer;
}

void pushLog(const std::string &level, const std::string &message) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_logs.push_back(LogEntry{level, message, nowTime()});
  if (g_logs.size() > 600) g_logs.erase(g_logs.begin(), g_logs.begin() + 200);
}

std::string stepsToJson(const std::vector<Step> &steps) {
  std::ostringstream out;
  out << "[";
  for (size_t i = 0; i < steps.size(); ++i) {
    if (i) out << ",";
    const char *state = "pending";
    switch (steps[i].state) {
      case StepState::Running: state = "running"; break;
      case StepState::Done: state = "done"; break;
      case StepState::Failed: state = "failed"; break;
      case StepState::Skipped: state = "skipped"; break;
      default: state = "pending"; break;
    }
    out << "{\"title\":\"" << jsonEscape(steps[i].title) << "\",\"state\":\"" << state
        << "\",\"detail\":\"" << jsonEscape(steps[i].detail) << "\"}";
  }
  out << "]";
  return out.str();
}

std::string logsToJson(size_t from) {
  std::lock_guard<std::mutex> lock(g_mutex);
  std::ostringstream out;
  out << "[";
  size_t begin = from < g_logs.size() ? from : g_logs.size();
  for (size_t i = begin; i < g_logs.size(); ++i) {
    if (i != begin) out << ",";
    out << "{\"level\":\"" << jsonEscape(g_logs[i].level) << "\",\"message\":\""
        << jsonEscape(g_logs[i].message) << "\",\"time\":\"" << g_logs[i].time << "\"}";
  }
  out << "]";
  return out.str();
}

// ------------------------------ 请求解析 ------------------------------

struct Request {
  std::string method;
  std::string path;
  std::string body;
};

std::string readRequest(SOCKET client, Request &request) {
  std::string data;
  char buffer[4096];
  size_t headerEnd = std::string::npos;
  for (;;) {
    int received = recv(client, buffer, sizeof(buffer), 0);
    if (received <= 0) break;
    data.append(buffer, received);
    headerEnd = data.find("\r\n\r\n");
    if (headerEnd != std::string::npos) break;
    if (data.size() > 65536) break;
  }
  if (headerEnd == std::string::npos) return "";
  std::string header = data.substr(0, headerEnd);
  std::istringstream stream(header);
  std::string line;
  std::getline(stream, line);
  std::istringstream first(trim(line));
  first >> request.method >> request.path;
  size_t contentLength = 0;
  while (std::getline(stream, line)) {
    std::string text = trim(line);
    std::string lower = toLower(text);
    if (startsWith(lower, "content-length:")) {
      try {
        contentLength = (size_t)std::stoul(trim(text.substr(15)));
      } catch (...) {
      }
    }
  }
  std::string body = data.substr(headerEnd + 4);
  while (body.size() < contentLength) {
    int received = recv(client, buffer, sizeof(buffer), 0);
    if (received <= 0) break;
    body.append(buffer, received);
  }
  request.body = body.substr(0, contentLength ? contentLength : body.size());
  return request.path;
}

void sendResponse(SOCKET client, int status, const std::string &contentType,
                  const std::string &body) {
  std::ostringstream head;
  head << "HTTP/1.1 " << status << (status == 200 ? " OK" : " Error") << "\r\n";
  head << "content-type: " << contentType << "\r\n";
  head << "content-length: " << body.size() << "\r\n";
  head << "cache-control: no-store\r\n";
  head << "connection: close\r\n\r\n";
  std::string response = head.str() + body;
  send(client, response.c_str(), (int)response.size(), 0);
}

// ------------------------------ 页面 ------------------------------

const char *kPage = R"HTML(<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>校园作业分析 · 一键部署控制台</title>
<style>
  :root{
    --blue:#0969cf; --ink:#202938; --muted:#8792a2; --line:#e5e9ef;
    --bg:#f6f8fb; --card:#fff; --good:#2f8758; --warn:#a56b25; --bad:#b4594c;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Consolas,"Liberation Mono",monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    font-size:14px;line-height:1.6}
  header{height:72px;background:#fff;border-bottom:1px solid var(--line);display:flex;
    align-items:center;gap:12px;padding:0 28px;position:sticky;top:0;z-index:10}
  .logo{width:40px;height:40px;border-radius:11px;background:var(--blue);color:#fff;
    display:grid;place-items:center;font-weight:700;font-size:18px}
  .brand b{font-size:17px;display:block}
  .brand small{color:#98a2b2;letter-spacing:1.4px;font-size:10px}
  .head-right{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--good)}
  .wrap{max-width:1080px;margin:0 auto;padding:26px 22px 60px}
  h1{font-size:25px;margin:0 0 6px}
  .sub{color:var(--muted);margin-bottom:22px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:20px;
    box-shadow:0 2px 5px #22334c08}
  .card h2{font-size:15px;margin:0 0 14px;display:flex;align-items:center;gap:8px}
  .dep{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #eef1f6}
  .dep:last-child{border-bottom:0}
  .dep .mark{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:12px;flex-shrink:0}
  .dep .mark.ok{background:#eaf8f0;color:var(--good)}
  .dep .mark.bad{background:#fdf0ed;color:var(--bad)}
  .dep .mark.opt{background:#f4f6f9;color:#8792a2}
  .dep .info{flex:1;min-width:0}
  .dep .info b{display:block;font-size:13px;font-weight:600}
  .dep .info small{color:var(--muted);display:block;overflow-wrap:anywhere}
  .dep .tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
  .dep .tag.req{color:var(--warn);border-color:#f0e2c6;background:#fffaf0}
  .modes{display:grid;gap:12px}
  .mode{border:1px solid var(--line);border-radius:11px;padding:15px;cursor:pointer;
    display:flex;gap:12px;align-items:flex-start;transition:border-color .18s,background .18s}
  .mode:hover{border-color:#c6dbf5}
  .mode.sel{border-color:#8fb4e3;background:#f7fbff;box-shadow:0 0 0 3px #0969cf12}
  .mode input{margin-top:4px;accent-color:var(--blue)}
  .mode b{display:block;font-size:14px}
  .mode small{color:var(--muted);display:block;margin-top:3px}
  .fields{display:grid;gap:10px;margin-top:14px}
  .fields label{display:grid;gap:6px;color:#657287;font-size:13px}
  input[type=text],input[type=password],input[type=number]{width:100%;padding:10px 12px;
    border:1px solid #dfe5ed;border-radius:8px;font:inherit;color:#26364d;background:#fff}
  input:focus{outline:2px solid #8bbaf5;outline-offset:1px}
  .hint{color:var(--muted);font-size:12px;margin-top:2px}
  .actions{display:flex;gap:10px;align-items:center;margin-top:6px;flex-wrap:wrap}
  button{font:inherit;border-radius:9px;padding:11px 20px;border:1px solid transparent;
    background:var(--blue);color:#fff;cursor:pointer;font-weight:550}
  button.ghost{background:#fff;color:#5f6b7c;border-color:#e1e6ed}
  button:disabled{opacity:.6;cursor:not-allowed}
  .steps{display:grid;gap:2px}
  .step{display:flex;gap:11px;align-items:flex-start;padding:9px 0}
  .step .bullet{width:22px;height:22px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;
    font-size:11px;background:#f1f4f8;color:#8792a2}
  .step.done .bullet{background:#eaf8f0;color:var(--good)}
  .step.running .bullet{background:#eaf2ff;color:var(--blue);animation:pulse 1.2s infinite}
  .step.failed .bullet{background:#fdf0ed;color:var(--bad)}
  .step .txt b{font-size:13px;font-weight:550}
  .step .txt small{display:block;color:var(--muted);overflow-wrap:anywhere}
  @keyframes pulse{50%{opacity:.45}}
  .bar{height:7px;border-radius:5px;background:#eef2f7;overflow:hidden;margin:16px 0 6px}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,#4b8bd6,#0969cf);
    width:0;transition:width .35s ease}
  .bar-label{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}
  .urls{margin-top:14px;padding:14px 16px;border:1px solid #dbe7f8;border-radius:11px;
    background:linear-gradient(112deg,#eef5ff,#f9fbff)}
  .urls b{color:#33557f}
  .urls a{display:block;color:var(--blue);font-family:var(--mono);font-size:13px;
    margin-top:7px;overflow-wrap:anywhere;text-decoration:none}
  .urls a:hover{text-decoration:underline}
  .log{background:#0f1b2d;color:#cfe0f5;border-radius:12px;padding:15px 17px;
    font-family:var(--mono);font-size:12.5px;line-height:1.75;height:320px;overflow:auto;
    white-space:pre-wrap;overflow-wrap:anywhere}
  .log .l-error{color:#ff9b8a}
  .log .l-warn{color:#ffd08a}
  .log .l-ok{color:#8ee0b0}
  .log .l-detail{color:#8ba3c0}
  .log .l-step{color:#8fc4ff;font-weight:600}
  .log .t{color:#5c7characters}
  .log .t{color:#5c7a9c}
  .note{border:1px solid #f0dfae;background:#fffbf0;color:#8a6d2c;border-radius:11px;
    padding:14px 16px;margin-bottom:18px;font-size:13px}
  .note b{display:block;margin-bottom:4px}
  .err{border:1px solid #f3d5cf;background:#fdf3f1;color:var(--bad);border-radius:11px;
    padding:14px 16px;margin-top:14px;font-size:13px}
  @media(max-width:820px){.grid{grid-template-columns:1fr}.wrap{padding:18px 14px 40px}}
</style>
</head>
<body>
<header>
  <div class="logo">SC</div>
  <div class="brand"><b>校园作业分析 · 一键部署</b><small>SMART CAMPUS DEPLOYER</small></div>
  <div class="head-right"><span class="dot" id="dot"></span><span id="stateText">就绪</span></div>
</header>
<div class="wrap">
  <h1>把这个网站部署到本机</h1>
  <p class="sub">程序会自动检测并安装缺失依赖（Node.js / cloudflared），准备好源码后一键启动服务。</p>

  <div class="grid">
    <div class="card">
      <h2>环境检测 <button class="ghost" style="margin-left:auto;padding:6px 12px;font-size:12px" onclick="loadState(true)">重新检测</button></h2>
      <div id="deps"></div>
      <div class="actions" style="margin-top:14px">
        <button class="ghost" id="installBtn" onclick="installDeps()">安装缺失依赖</button>
      </div>
    </div>

    <div class="card">
      <h2>部署方式</h2>
      <div class="modes" id="modes">
        <label class="mode sel" data-mode="lan">
          <input type="radio" name="mode" value="lan" checked />
          <span><b>局域网（内网）访问</b><small>同一 WiFi / 办公室网络内的电脑、平板、手机都能打开。适合课堂现场使用。</small></span>
        </label>
        <label class="mode" data-mode="tunnel">
          <input type="radio" name="mode" value="tunnel" />
          <span><b>Cloudflare 临时公网隧道</b><small>自动生成一个 https://xxx.trycloudflare.com 地址，任何地方都能访问，关掉程序即失效，无需域名。</small></span>
        </label>
        <label class="mode" data-mode="domain">
          <input type="radio" name="mode" value="domain" />
          <span><b>绑定自己的域名</b><small>用 Cloudflare 命名隧道把域名指向本机，长期稳定。需要域名已托管在 Cloudflare。</small></span>
        </label>
      </div>
      <div class="fields">
        <label>服务端口<input type="number" id="port" value="8787" min="1" max="65535" /></label>
        <div id="domainFields" style="display:none">
          <label>自定义域名<input type="text" id="domain" placeholder="homework.example.com" /></label>
          <label>Cloudflare API Token<input type="password" id="apiToken" placeholder="需要 Zone:DNS:Edit 权限" /></label>
          <label>隧道连接器令牌（可选）<input type="password" id="tunnelToken" placeholder="Cloudflare Zero Trust 里复制的令牌" /></label>
          <div class="hint">域名需已托管在 Cloudflare。若只填 API Token，程序会自动创建命名隧道；若已有隧道，请填连接器令牌。</div>
        </div>
      </div>
      <div class="actions">
        <button id="deployBtn" onclick="deploy()">一键部署</button>
        <button class="ghost" id="stopBtn" onclick="stopAll()">停止服务</button>
      </div>
      <div id="errorBox"></div>
      <div id="urlBox"></div>
    </div>
  </div>

  <div class="card" style="margin-bottom:18px">
    <h2>部署进度</h2>
    <div class="bar"><i id="barFill"></i></div>
    <div class="bar-label"><span id="barText">等待开始</span><span id="barPercent">0%</span></div>
    <div class="steps" id="steps" style="margin-top:14px"></div>
  </div>

  <div class="card">
    <h2>运行日志 <button class="ghost" style="margin-left:auto;padding:6px 12px;font-size:12px" onclick="clearLogView()">清屏</button></h2>
    <div class="log" id="log"></div>
  </div>
</div>
<script>
let from = 0, timer = null;
const $ = (id) => document.getElementById(id);

document.querySelectorAll('.mode').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel');
    el.querySelector('input').checked = true;
    $('domainFields').style.display = el.dataset.mode === 'domain' ? 'block' : 'none';
  });
});

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function renderDeps(deps) {
  $('deps').innerHTML = deps.map((d) => {
    const cls = d.available ? 'ok' : (d.required ? 'bad' : 'opt');
    const mark = d.available ? '✔' : (d.required ? '!' : '–');
    return `<div class="dep">
      <span class="mark ${cls}">${mark}</span>
      <span class="info"><b>${esc(d.title)}</b><small>${esc(d.version || d.note)}</small></span>
      <span class="tag ${d.required && !d.available ? 'req' : ''}">${d.required ? (d.available ? '就绪' : '缺失') : '可选'}</span>
    </div>`;
  }).join('');
  const missing = deps.filter((d) => d.required && !d.available).length;
  $('installBtn').textContent = missing ? `安装缺失依赖（${missing}）` : '依赖已齐全';
  $('installBtn').disabled = missing === 0;
}

function renderSteps(steps) {
  const icon = { done: '✔', running: '●', failed: '✘', skipped: '–', pending: '○' };
  $('steps').innerHTML = steps.map((s) => `
    <div class="step ${s.state}">
      <span class="bullet">${icon[s.state] || '○'}</span>
      <span class="txt"><b>${esc(s.title)}</b>${s.detail ? `<small>${esc(s.detail)}</small>` : ''}</span>
    </div>`).join('');
}

function appendLogs(entries) {
  if (!entries.length) return;
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  for (const e of entries) {
    const line = document.createElement('div');
    line.className = 'l-' + e.level;
    line.textContent = `[${e.time}] ${e.message}`;
    box.appendChild(line);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function clearLogView() { $('log').innerHTML = ''; }

async function loadState(refreshDeps) {
  try {
    const res = await fetch('/api/status' + (refreshDeps ? '?deps=1' : ''));
    const data = await res.json();
    if (data.deps) renderDeps(data.deps);
    renderSteps(data.steps || []);
    $('barFill').style.width = (data.percent || 0) + '%';
    $('barPercent').textContent = (data.percent || 0) + '%';
    $('barText').textContent = data.busy
      ? (data.phase === 'install' ? '正在安装依赖…' : '正在部署…')
      : (data.percent >= 100 ? '部署完成' : '等待开始');
    const busy = !!data.busy;
    $('deployBtn').disabled = busy;
    $('installBtn').disabled = busy || $('installBtn').disabled;
    $('dot').style.background = busy ? '#e0ad64' : (data.error ? '#d9836f' : '#2f8758');
    $('stateText').textContent = busy ? '执行中' : (data.error ? '有错误' : '就绪');
    if (data.error) $('errorBox').innerHTML = `<div class="err">${esc(data.error)}</div>`;
    else $('errorBox').innerHTML = '';
    if (data.urls && data.urls.length) {
      $('urlBox').innerHTML = `<div class="urls"><b>访问地址</b>${data.urls.map((u) => `<a href="${esc(u)}" target="_blank">${esc(u)}</a>`).join('')}</div>`;
    }
    appendLogs(data.logs || []);
    from = data.total || from;
  } catch (e) { /* 忽略瞬时错误 */ }
}

async function installDeps() {
  $('installBtn').disabled = true;
  await fetch('/api/install', { method: 'POST' });
  startPolling();
}

async function deploy() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const payload = {
    mode,
    port: Number($('port').value) || 8787,
    domain: $('domain').value.trim(),
    apiToken: $('apiToken').value.trim(),
    tunnelToken: $('tunnelToken').value.trim(),
  };
  if (mode === 'domain' && !payload.domain) {
    $('errorBox').innerHTML = '<div class="err">绑定域名需要填写域名</div>';
    return;
  }
  $('errorBox').innerHTML = '';
  $('urlBox').innerHTML = '';
  $('deployBtn').disabled = true;
  await fetch('/api/deploy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  startPolling();
}

async function stopAll() {
  await fetch('/api/stop', { method: 'POST' });
  $('urlBox').innerHTML = '';
  startPolling();
}

function startPolling() {
  if (timer) return;
  timer = setInterval(async () => {
    await loadState(false);
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.busy && timer) { clearInterval(timer); timer = null; loadState(true); }
  }, 700);
}

loadState(true);
</script>
</body>
</html>)HTML";

// ------------------------------ 接口 ------------------------------

void handleDeploy(SOCKET client, const std::string &body) {
  if (g_busy.exchange(true)) {
    sendResponse(client, 409, "application/json; charset=utf-8",
                 "{\"error\":\"已有任务在执行\"}");
    return;
  }
  Json payload;
  std::string parseError;
  if (!Json::parse(body, payload, &parseError)) {
    g_busy = false;
    sendResponse(client, 400, "application/json; charset=utf-8",
                 "{\"error\":\"请求内容无法解析\"}");
    return;
  }
  const std::string mode = payload["mode"].toStringOr("lan");
  Options &options = g_deployer->options();
  options.mode = mode == "tunnel" ? Mode::QuickTunnel
                                   : (mode == "domain" ? Mode::CustomDomain : Mode::Lan);
  const Json &portNode = payload["port"];
  if (portNode.isNumber() && portNode.asNumber() > 0 && portNode.asNumber() < 65536)
    options.port = (int)portNode.asNumber();
  options.domain = trim(payload["domain"].toStringOr(""));
  options.apiToken = trim(payload["apiToken"].toStringOr(""));
  options.tunnelToken = trim(payload["tunnelToken"].toStringOr(""));

  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_error.clear();
    g_result.clear();
    g_phase = "deploy";
    g_percent = 0;
  }
  if (g_worker.joinable()) g_worker.join();
  g_worker = std::thread([]() {
    std::vector<std::string> urls;
    bool ok = g_deployer->deploy(urls);
    std::lock_guard<std::mutex> lock(g_mutex);
    if (ok) {
      std::ostringstream out;
      out << "[";
      for (size_t i = 0; i < urls.size(); ++i) {
        if (i) out << ",";
        out << "\"" << jsonEscape(urls[i]) << "\"";
      }
      out << "]";
      g_result = out.str();
      g_error.clear();
    } else {
      g_error = "部署未完成，请查看运行日志中的错误信息";
    }
    g_phase = "idle";
  });
  sendResponse(client, 200, "application/json; charset=utf-8", "{\"ok\":true}");
}

void handleInstall(SOCKET client) {
  if (g_busy.exchange(true)) {
    sendResponse(client, 409, "application/json; charset=utf-8",
                 "{\"error\":\"已有任务在执行\"}");
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_error.clear();
    g_phase = "install";
  }
  if (g_worker.joinable()) g_worker.join();
  g_worker = std::thread([]() {
    std::vector<Dependency> deps = g_deployer->inspect();
    bool ok = g_deployer->installDependencies(deps);
    std::lock_guard<std::mutex> lock(g_mutex);
    g_phase = "idle";
    if (!ok) g_error = "部分依赖安装失败，请查看日志";
  });
  sendResponse(client, 200, "application/json; charset=utf-8", "{\"ok\":true}");
}

void handleStatus(SOCKET client, bool refreshDeps) {
  std::string steps, logs, phase, result, error;
  int percent = 0;
  size_t total = 0;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    steps = g_stepsJson;
    phase = g_phase;
    result = g_result;
    error = g_error;
    percent = g_percent;
    total = g_logs.size();
  }
  logs = logsToJson(0);
  std::ostringstream out;
  out << "{\"busy\":" << (g_busy ? "true" : "false") << ",\"phase\":\"" << jsonEscape(phase)
      << "\",\"percent\":" << percent << ",\"total\":" << total << ",\"steps\":" << steps
      << ",\"logs\":" << logs << ",\"urls\":" << (result.empty() ? "[]" : result)
      << ",\"error\":\"" << jsonEscape(error) << "\"";
  if (refreshDeps) {
    std::vector<Dependency> deps = g_deployer->inspect();
    out << ",\"deps\":[";
    for (size_t i = 0; i < deps.size(); ++i) {
      if (i) out << ",";
      out << "{\"id\":\"" << jsonEscape(deps[i].id) << "\",\"title\":\"" << jsonEscape(deps[i].title)
          << "\",\"required\":" << (deps[i].required ? "true" : "false")
          << ",\"available\":" << (deps[i].available ? "true" : "false")
          << ",\"version\":\"" << jsonEscape(deps[i].version) << "\",\"note\":\""
          << jsonEscape(deps[i].note) << "\"}";
    }
    out << "]";
  }
  out << "}";
  sendResponse(client, 200, "application/json; charset=utf-8", out.str());
}

}  // namespace

int runWebConsole(Deployer &deployer, int port, bool openBrowser) {
  g_deployer = &deployer;
  // 日志级别已由 util 层统一为 info/step/ok/warn/error/detail，直接透传
  deployer.setLogSink([](const std::string &level, const std::string &message) {
    pushLog(level, message);
  });
  deployer.setProgressSink([](const std::vector<Step> &steps, int percent) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_stepsJson = stepsToJson(steps);
    g_percent = percent;
  });

  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
    logError("无法初始化网络库，Web 控制台不可用");
    return 1;
  }
  SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (server == INVALID_SOCKET) {
    logError("无法创建监听套接字");
    return 1;
  }
  BOOL reuse = TRUE;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons((u_short)port);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  if (bind(server, (sockaddr *)&address, sizeof(address)) != 0) {
    logError("Web 控制台端口 " + std::to_string(port) + " 已被占用，请用 --web-port 换一个端口");
    closesocket(server);
    return 1;
  }
  listen(server, 16);

  const std::string url = "http://127.0.0.1:" + std::to_string(port);
  logOk("Web 部署控制台已启动：" + url);
  logInfo("在浏览器里选择部署方式并点击「一键部署」。按 Ctrl+C 停止本程序。");
  if (openBrowser) openInShell(url);

  while (g_running) {
    // 用 select 带超时等待，保证 Ctrl+C 能被及时响应
    fd_set readable;
    FD_ZERO(&readable);
    FD_SET(server, &readable);
    timeval timeout{0, 250000};
    int ready = select(0, &readable, nullptr, nullptr, &timeout);
    if (ready <= 0) continue;
    SOCKET client = accept(server, nullptr, nullptr);
    if (client == INVALID_SOCKET) continue;
    Request request;
    std::string path = readRequest(client, request);
    if (path.empty()) {
      closesocket(client);
      continue;
    }
    const std::string route = request.path.substr(0, request.path.find('?'));
    const bool withDeps = request.path.find("deps=1") != std::string::npos;
    if (route == "/" || route == "/index.html") {
      sendResponse(client, 200, "text/html; charset=utf-8", kPage);
    } else if (route == "/api/status") {
      handleStatus(client, withDeps);
    } else if (route == "/api/deploy" && request.method == "POST") {
      handleDeploy(client, request.body);
    } else if (route == "/api/install" && request.method == "POST") {
      handleInstall(client);
    } else if (route == "/api/stop" && request.method == "POST") {
      logStep("正在停止服务与隧道…");
      deployer.stop();
      {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_result.clear();
      }
      logOk("已停止");
      sendResponse(client, 200, "application/json; charset=utf-8", "{\"ok\":true}");
    } else if (route == "/api/quit" && request.method == "POST") {
      sendResponse(client, 200, "application/json; charset=utf-8", "{\"ok\":true}");
      g_running = false;
    } else {
      sendResponse(client, 404, "application/json; charset=utf-8", "{\"error\":\"not found\"}");
    }
    shutdown(client, SD_SEND);
    closesocket(client);
  }

  if (g_worker.joinable()) g_worker.join();
  closesocket(server);
  WSACleanup();
  return 0;
}

}  // namespace sc
