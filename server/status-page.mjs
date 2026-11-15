import fs from "node:fs";
import { APP_VERSION, VERSION_LABEL } from "./version.mjs";

// 公开的状态页：不登录即可查看，只暴露「服务是否正常」，不返回任何账号或数据。
export function registerStatusPage(app, { db, dataDir }) {
  const startedAt = Date.now();
  const storageOk = () => {
    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
      return fs.existsSync(dataDir);
    } catch {
      return false;
    }
  };
  const databaseOk = () => {
    try {
      return db.prepare("PRAGMA quick_check").get()?.quick_check === "ok";
    } catch {
      return false;
    }
  };
  const modelConfigured = () => {
    try {
      return Boolean(
        db.prepare("SELECT 1 FROM provider_settings LIMIT 1").get(),
      );
    } catch {
      return false;
    }
  };
  const snapshot = () => {
    const database = databaseOk();
    const storage = storageOk();
    const model = modelConfigured();
    const components = [
      {
        id: "web",
        name: "网页应用",
        nameEn: "Web app",
        detail: "页面加载、登录与工作台",
        detailEn: "Pages, sign-in and workspaces",
        ok: true,
      },
      {
        id: "database",
        name: "数据存储",
        nameEn: "Database",
        detail: "学校、账号与作业数据",
        detailEn: "Schools, accounts and assignments",
        ok: database,
      },
      {
        id: "files",
        name: "文件存储",
        nameEn: "File storage",
        detail: "作业原件与导出文件",
        detailEn: "Uploaded originals and exports",
        ok: storage,
      },
      {
        id: "model",
        name: "AI 识别与批改",
        nameEn: "AI recognition",
        detail: model ? "模型凭证已配置" : "尚未配置模型凭证",
        detailEn: model
          ? "Model credentials configured"
          : "No model credentials yet",
        ok: model,
      },
    ];
    return {
      ok: components.every((component) => component.ok),
      version: APP_VERSION,
      label: VERSION_LABEL,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      components,
    };
  };

  app.get("/api/status", (_req, res) => {
    res.set("cache-control", "no-store");
    res.json(snapshot());
  });
  app.get("/status", (_req, res) => {
    res.set("cache-control", "no-store");
    res.type("html").send(page());
  });
}

function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>服务状态 · 校园作业分析</title>
<style>
:root{--bg:#fff;--text:#1f2328;--muted:#656d76;--line:#e6e8eb;--ok:#1a7f4b;--okbg:#e8f5ee;--warn:#9a6700;--warnbg:#fff8e5}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--text:#e6edf3;--muted:#8b949e;--line:#21262d;--ok:#3fb950;--okbg:#12261a;--warn:#d29922;--warnbg:#2a2113}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:780px;margin:0 auto;padding:56px 24px 72px}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:36px}
h1{font-size:26px;font-weight:650;letter-spacing:-.01em;margin:0}
header a{margin-left:auto;color:var(--muted);text-decoration:none;font-size:14px}
header a:hover{color:var(--text)}
.switch{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13px}
.switch button{all:unset;padding:4px 10px;cursor:pointer;color:var(--muted)}
.switch button.active{background:var(--text);color:var(--bg)}
.banner{display:flex;align-items:center;gap:12px;padding:18px 22px;border-radius:12px;font-size:17px;font-weight:600;margin-bottom:34px}
.banner.ok{background:var(--okbg);color:var(--ok)}
.banner.warn{background:var(--warnbg);color:var(--warn)}
.dot{width:10px;height:10px;border-radius:50%;background:currentColor;flex:0 0 auto}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px;font-weight:600}
ul{list-style:none;margin:0 0 34px;padding:0;border:1px solid var(--line);border-radius:12px;overflow:hidden}
li{display:flex;align-items:center;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}
li .name{font-weight:550}
li .detail{color:var(--muted);font-size:13px}
li .state{margin-left:auto;font-size:13px;font-weight:600}
.ok-text{color:var(--ok)}.warn-text{color:var(--warn)}
.meta{color:var(--muted);font-size:13px;line-height:2}
footer{margin-top:44px;color:var(--muted);font-size:13px}
</style></head><body><main>
<header>
  <h1 data-zh="服务状态" data-en="Service status">服务状态</h1>
  <div class="switch"><button id="zh" class="active">中文</button><button id="en">EN</button></div>
  <a href="/">返回应用</a>
</header>
<div class="banner" id="banner"><span class="dot"></span><span id="bannerText">正在读取状态…</span></div>
<h2 data-zh="各组件" data-en="Components">各组件</h2>
<ul id="components"></ul>
<div class="meta" id="meta"></div>
<footer data-zh="页面每 30 秒自动刷新；本页不显示任何账号或学生数据。" data-en="This page refreshes every 30 seconds and never shows account or student data.">页面每 30 秒自动刷新；本页不显示任何账号或学生数据。</footer>
</main>
<script>
var lang = localStorage.getItem('status-lang') || 'zh';
var t = {
  zh: { ok: '所有系统运行正常', warn: '部分组件异常', op: '运行正常', down: '异常', updated: '最近更新', started: '服务已运行', ver: '版本' },
  en: { ok: 'All systems operational', warn: 'Some components are degraded', op: 'Operational', down: 'Degraded', updated: 'Updated', started: 'Uptime', ver: 'Version' }
};
function apply() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.getElementById('zh').classList.toggle('active', lang === 'zh');
  document.getElementById('en').classList.toggle('active', lang === 'en');
  document.querySelectorAll('[data-zh]').forEach(function (el) {
    el.textContent = lang === 'en' ? el.dataset.en : el.dataset.zh;
  });
}
function duration(seconds) {
  var d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
  if (lang === 'en') return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
  return (d ? d + ' 天 ' : '') + h + ' 小时 ' + m + ' 分钟';
}
function render(data) {
  var banner = document.getElementById('banner');
  banner.className = 'banner ' + (data.ok ? 'ok' : 'warn');
  document.getElementById('bannerText').textContent = data.ok ? t[lang].ok : t[lang].warn;
  document.getElementById('components').innerHTML = data.components.map(function (c) {
    return '<li><span class="dot ' + (c.ok ? 'ok-text' : 'warn-text') + '"></span><div><div class="name">' + (lang === 'en' ? c.nameEn : c.name) + '</div><div class="detail">' + (lang === 'en' ? c.detailEn : c.detail) + '</div></div><span class="state ' + (c.ok ? 'ok-text' : 'warn-text') + '">' + (c.ok ? t[lang].op : t[lang].down) + '</span></li>';
  }).join('');
  document.getElementById('meta').innerHTML =
    t[lang].started + '：' + duration(data.uptimeSeconds) + '<br/>' +
    t[lang].ver + '：' + data.label + '<br/>' +
    t[lang].updated + '：' + new Date(data.updatedAt).toLocaleString();
}
function load() { fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(render).catch(function () { document.getElementById('bannerText').textContent = t[lang].warn; }); }
document.getElementById('zh').onclick = function () { lang = 'zh'; localStorage.setItem('status-lang', lang); apply(); load(); };
document.getElementById('en').onclick = function () { lang = 'en'; localStorage.setItem('status-lang', lang); apply(); load(); };
apply(); load(); setInterval(load, 30000);
</script></body></html>`;
}
