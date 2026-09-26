/**
 * Rebuild the roadshow deck from ../index.html.
 *
 *   node build.mjs            # renders PNGs, then writes the .pptx and .pdf
 *   node build.mjs --png      # only re-render the slide images
 *
 * Requires a Chromium browser (Chrome or Edge) and `npm install` in this folder.
 * Nothing here touches the application source — it only reads ../index.html.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECK = path.resolve(HERE, '..');
const OUTDIR = path.join(HERE, '.build');
const HTML = path.join(DECK, 'index.html');
const SLIDES = path.join(OUTDIR, 'slides');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('No Chrome/Edge found — install one or edit CHROME in build.mjs.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Minimal Chrome DevTools Protocol client (no dependencies) ───────────── */
async function launch({ width = 1920, height = 1080, port = 9480 } = {}) {
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(os.tmpdir(), 'deck-build-' + Date.now())}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--font-render-hinting=none',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  let info = null;
  for (let i = 0; i < 100 && !info; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) info = await r.json();
    } catch {
      /* not up yet */
    }
    if (!info) await sleep(150);
  }
  if (!info) throw new Error('Chrome did not expose a debugging port');

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method && events.get(m.method)?.length) {
      events.get(m.method).shift()(m.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const once = (method) =>
    new Promise((resolve) => {
      if (!events.has(method)) events.set(method, []);
      events.get(method).push(resolve);
    });

  const client = {
    send,
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      proc.kill();
    },
    async goto(url) {
      const loaded = once('Page.loadEventFired');
      await send('Page.navigate', { url });
      await Promise.race([loaded, sleep(30000)]);
      await sleep(600);
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  return client;
}

/* ── 1. Render every slide to PNG ───────────────────────────────────────── */
async function renderSlides() {
  fs.rmSync(SLIDES, { recursive: true, force: true });
  fs.mkdirSync(SLIDES, { recursive: true });
  const fileUrl = 'file:///' + HTML.replace(/\\/g, '/');
  const chrome = await launch();
  try {
    await chrome.goto(`${fileUrl}?render=0`);
    await chrome.eval('document.fonts.ready');
    await sleep(2000);
    const total = await chrome.eval('document.querySelectorAll(".slide").length');
    for (let n = 0; n < total; n++) {
      await chrome.goto(`${fileUrl}?render=${n}`);
      await chrome.eval('document.fonts.ready');
      await sleep(600);
      await chrome.shot(path.join(SLIDES, `slide-${String(n + 1).padStart(2, '0')}.png`));
      process.stdout.write(`\r  rendered ${n + 1}/${total}`);
    }
    process.stdout.write('\n');
    return total;
  } finally {
    chrome.close();
  }
}

/* ── 2. PPTX: full-bleed slide image + native speaker notes ─────────────── */
async function buildPptx() {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const html = fs.readFileSync(HTML, 'utf8');
  const notes = [...html.matchAll(/data-notes="([^"]*)"/g)].map((m) => m[1]);
  const slides = fs
    .readdirSync(SLIDES)
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort();
  if (slides.length !== notes.length)
    throw new Error(`${slides.length} images vs ${notes.length} notes — check data-notes on every section`);

  const W = 13.3333,
    H = 7.5;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'DECK169', width: W, height: H });
  pptx.layout = 'DECK169';
  pptx.author = '梅沙黑客松B3组';
  pptx.company = '2026 梅沙青少年黑客松邀请赛';
  pptx.title = '校园作业分析器 · Smart Campus Homework Analyzer';
  pptx.subject = '路演 PPT · v0.2.0-rc1';
  slides.forEach((f, i) => {
    const s = pptx.addSlide();
    s.addImage({ path: path.join(SLIDES, f), x: 0, y: 0, w: W, h: H });
    s.addNotes(notes[i]);
  });
  const out = path.join(DECK, '校园作业分析器-路演.pptx');
  await pptx.writeFile({ fileName: out });
  console.log(`  ${path.basename(out)}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
}

/* ── 3. PDF: one 1920×1080 page per slide ───────────────────────────────── */
async function buildPdf() {
  const chrome = await launch({ port: 9481 });
  try {
    await chrome.goto('file:///' + HTML.replace(/\\/g, '/'));
    await chrome.eval('document.fonts.ready');
    await sleep(2500);
    const { data } = await chrome.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: 20,
      paperHeight: 11.25,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
    });
    const out = path.join(DECK, '校园作业分析器-路演.pdf');
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(`  ${path.basename(out)}  ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
  } finally {
    chrome.close();
  }
}

const total = await renderSlides();
console.log(`  ${total} PNG slides @3840×2160`);
if (!process.argv.includes('--png')) {
  await buildPptx();
  await buildPdf();
}
console.log('done.');
