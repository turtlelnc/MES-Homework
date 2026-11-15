import fs from "node:fs";
import { APP_VERSION, VERSION_LABEL } from "./version.mjs";

const DAY = 86400000;
const HISTORY_DAYS = 14;

// 公开状态页：不登录即可查看，只暴露「服务是否正常」，不返回任何账号或学生数据。
export function registerStatusPage(app, { db, dataDir }) {
  const startedAt = Date.now();
  const storageOk = () => {
    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
      return true;
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
  // 过去的事件来自真实记录：识别任务的失败会按天汇总成一条事件。
  const incidents = () => {
    try {
      const rows = db
        .prepare(
          "SELECT substr(updated_at,1,10) day, COUNT(*) total, MAX(updated_at) at, MAX(error) reason FROM recognition_jobs WHERE status='failed' AND updated_at>=? GROUP BY day ORDER BY day DESC",
        )
        .all(
          new Date(Date.now() - HISTORY_DAYS * DAY).toISOString().slice(0, 10),
        );
      return rows.map((row) => ({
        day: row.day,
        at: row.at,
        component: "AI 识别与批改",
        componentEn: "AI recognition",
        title: `${row.total} 次识别未完成`,
        titleEn: `${row.total} recognition attempt(s) failed`,
        detail: row.reason || "",
        state: "degraded",
      }));
    } catch {
      return [];
    }
  };
  const history = (failedDays) => {
    const today = new Date();
    return Array.from({ length: HISTORY_DAYS }, (_, index) => {
      const date = new Date(today.getTime() - (HISTORY_DAYS - 1 - index) * DAY);
      const day = date.toISOString().slice(0, 10);
      const state = failedDays.has(day)
        ? "degraded"
        : date.getTime() >= new Date(startedAt).setHours(0, 0, 0, 0)
          ? "operational"
          : "unknown";
      return { day, state };
    });
  };

  const snapshot = () => {
    const database = databaseOk();
    const storage = storageOk();
    const model = modelConfigured();
    const events = incidents();
    const failedDays = new Set(events.map((event) => event.day));
    const components = [
      {
        id: "web",
        group: "核心服务",
        groupEn: "Core",
        name: "网页应用",
        nameEn: "Web app",
        detail: "页面加载、登录与工作台",
        detailEn: "Pages, sign-in and workspaces",
        ok: true,
      },
      {
        id: "database",
        group: "核心服务",
        groupEn: "Core",
        name: "数据存储",
        nameEn: "Database",
        detail: "学校、账号与作业数据",
        detailEn: "Schools, accounts and assignments",
        ok: database,
      },
      {
        id: "files",
        group: "核心服务",
        groupEn: "Core",
        name: "文件存储",
        nameEn: "File storage",
        detail: "作业原件与导出文件",
        detailEn: "Uploaded originals and exports",
        ok: storage,
      },
      {
        id: "model",
        group: "AI 能力",
        groupEn: "AI",
        name: "AI 识别与批改",
        nameEn: "AI recognition",
        detail: model ? "模型凭证已配置" : "尚未配置模型凭证",
        detailEn: model
          ? "Model credentials configured"
          : "No model credentials yet",
        ok: model,
      },
    ];
    const rows = history(failedDays);
    return {
      ok: components.every((component) => component.ok),
      version: APP_VERSION,
      label: VERSION_LABEL,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      components: components.map((component) => ({
        ...component,
        history: rows,
      })),
      incidents: events,
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
<title>校园作业分析 服务状态</title>
<style>
:root{--text:#1f2933;--muted:#64748b;--line:#e2e8f0;--bg:#fff;--ok:#15803d;--okbg:#ecfdf3;--warn:#b45309;--warnbg:#fffbeb;--unknown:#cbd5e1}
@media (prefers-color-scheme:dark){:root{--text:#e6edf3;--muted:#94a3b8;--line:#243044;--bg:#0b1220;--ok:#4ade80;--okbg:#12261a;--warn:#fbbf24;--warnbg:#2a2113;--unknown:#334155}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:960px;margin:0 auto;padding:36px 24px 72px}
.top{display:flex;align-items:center;gap:12px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.brand{font-weight:650;font-size:17px;letter-spacing:-.01em}
.top a{margin-left:auto;color:var(--muted);text-decoration:none;font-size:14px}
.top a:hover{color:var(--text)}
.switch{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13px}
.switch button{all:unset;padding:4px 10px;cursor:pointer;color:var(--muted)}
.switch button.active{background:var(--text);color:var(--bg)}
h1{font-size:32px;line-height:1.25;margin:28px 0 22px;font-weight:650;letter-spacing:-.02em}
.banner{display:flex;align-items:center;gap:12px;padding:22px 26px;border-radius:10px;font-size:19px;font-weight:600;margin-bottom:40px}
.banner.ok{background:var(--okbg);color:var(--ok)}
.banner.warn{background:var(--warnbg);color:var(--warn)}
.dot{width:12px;height:12px;border-radius:50%;background:currentColor;flex:0 0 auto}
h2{font-size:20px;font-weight:650;margin:0 0 14px}
.group{margin:0 0 34px}
.group-title{font-size:13px;font-weight:600;color:var(--muted);letter-spacing:.04em;margin:0 0 8px}
.card{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:flex;align-items:center;gap:14px;padding:16px 20px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .name{font-weight:550}
.row .detail{color:var(--muted);font-size:13px}
.row .state{margin-left:auto;font-size:13px;font-weight:600}
.ok-text{color:var(--ok)}.warn-text{color:var(--warn)}
.bars{display:flex;gap:2px;margin-top:10px}
.bars i{display:block;height:30px;flex:1;border-radius:2px;background:var(--ok)}
.bars i.warn{background:var(--warn)}
.bars i.unknown{background:var(--unknown)}
.legend{display:flex;gap:18px;color:var(--muted);font-size:12px;margin-top:10px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend b{width:14px;height:8px;border-radius:2px;background:var(--ok);display:inline-block}
.legend b.warn{background:var(--warn)}.legend b.unknown{background:var(--unknown)}
.incident{border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin-bottom:10px}
.incident h3{font-size:15px;margin:0 0 4px;font-weight:600}
.incident .when{color:var(--muted);font-size:13px}
.incident p{margin:8px 0 0;color:var(--muted);font-size:13px}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:18px 20px}
footer{margin-top:44px;color:var(--muted);font-size:13px}
</style></head><body><main>
<div class="top">
  <span class="brand" data-zh="校园作业分析 服务状态" data-en="Smart Campus status">校园作业分析 服务状态</span>
  <div class="switch"><button id="zh" class="active">中文</button><button id="en">EN</button></div>
  <a href="/" data-zh="返回应用" data-en="Back to app">返回应用</a>
</div>
<h1 data-zh="当前状态" data-en="Current status">当前状态</h1>
<div class="banner" id="banner"><span class="dot"></span><span id="bannerText">…</span></div>
<div class="group"><h2 data-zh="系统组件" data-en="System components">系统组件</h2><div class="card" id="components"></div>
<div class="legend"><span><b></b><em data-zh="正常" data-en="Operational">正常</em></span><span><b class="warn"></b><em data-zh="有异常" data-en="Degraded">有异常</em></span><span><b class="unknown"></b><em data-zh="无数据" data-en="No data">无数据</em></span></div></div>
<div class="group"><h2 data-zh="过去的事件" data-en="Past incidents">过去的事件</h2><div id="incidents"></div></div>
<footer data-zh="页面每 30 秒自动刷新。本页只显示服务状态，不包含任何账号或学生数据。" data-en="Refreshes every 30 seconds. This page shows service status only, never account or student data.">页面每 30 秒自动刷新。本页只显示服务状态，不包含任何账号或学生数据。</footer>
</main>
<script>
var lang = localStorage.getItem('status-lang') || 'zh';
var t = {
  zh: { ok: '所有系统运行正常', warn: '部分组件异常', op: '运行正常', down: '异常', noIncident: '最近 14 天没有报告事件', none: '暂无数据', updated: '最近更新', started: '已运行', ver: '版本' },
  en: { ok: 'All systems operational', warn: 'Some systems are degraded', op: 'Operational', down: 'Degraded', noIncident: 'No incidents reported in the last 14 days', none: 'No data', updated: 'Updated', started: 'Uptime', ver: 'Version' }
};
function apply() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.getElementById('zh').classList.toggle('active', lang === 'zh');
  document.getElementById('en').classList.toggle('active', lang === 'en');
  document.querySelectorAll('[data-zh]').forEach(function (el) {
    el.textContent = lang === 'en' ? el.dataset.en : el.dataset.zh;
  });
}
function dur(s) { var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return lang === 'en' ? (d ? d + 'd ' : '') + h + 'h ' + m + 'm' : (d ? d + ' 天 ' : '') + h + ' 小时 ' + m + ' 分钟'; }
function bar(row) {
  return '<div class="bars">' + row.history.map(function (d) {
    var cls = d.state === 'degraded' ? 'warn' : d.state === 'unknown' ? 'unknown' : '';
    return '<i class="' + cls + '" title="' + d.day + '"></i>';
  }).join('') + '</div>';
}
function render(data) {
  document.getElementById('banner').className = 'banner ' + (data.ok ? 'ok' : 'warn');
  document.getElementById('bannerText').textContent = data.ok ? t[lang].ok : t[lang].warn;
  document.getElementById('components').innerHTML = data.components.map(function (c) {
    return '<div class="row"><div><div class="name">' + (lang === 'en' ? c.nameEn : c.name) + '</div><div class="detail">' + (lang === 'en' ? c.detailEn : c.detail) + '</div>' + bar(c) + '</div><span class="state ' + (c.ok ? 'ok-text' : 'warn-text') + '">' + (c.ok ? t[lang].op : t[lang].down) + '</span></div>';
  }).join('');
  var list = data.incidents || [];
  document.getElementById('incidents').innerHTML = list.length
    ? list.map(function (i) {
        return '<div class="incident"><h3>' + (lang === 'en' ? i.titleEn : i.title) + '</h3><div class="when">' + i.day + ' · ' + (lang === 'en' ? i.componentEn : i.component) + '</div>' + (i.detail ? '<p>' + i.detail + '</p>' : '') + '</div>';
      }).join('')
    : '<div class="empty">' + t[lang].noIncident + '</div>';
  document.getElementById('bannerText').title = t[lang].started + '：' + dur(data.uptimeSeconds) + ' · ' + t[lang].ver + '：' + data.label;
}
function load() { fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(render).catch(function () { document.getElementById('bannerText').textContent = t[lang].warn; }); }
document.getElementById('zh').onclick = function () { lang = 'zh'; localStorage.setItem('status-lang', lang); apply(); load(); };
document.getElementById('en').onclick = function () { lang = 'en'; localStorage.setItem('status-lang', lang); apply(); load(); };
apply(); load(); setInterval(load, 30000);
</script></body></html>`;
}
