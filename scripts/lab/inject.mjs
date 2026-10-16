/**
 * inject.mjs — 用 CDP 把 NetClass 脚本直接注入到目标页（不依赖 Tampermonkey，用于验证与兜底）
 * 用法：
 *   node inject.mjs --port 9224 --url https://edu.shengshengketang.com/ [--timeout 60] [--keep]
 * 说明：
 *   - 对页面目标调用 Page.addScriptToEvaluateOnNewDocument 注入「壳 + 模块」
 *   - 然后导航到 --url，等待脚本自报状态并打印
 *   - --keep 时不关闭连接（脚本继续在该标签页生效），默认注入后保留（连接断开不影响已注入脚本运行）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const URL = A.url || 'https://edu.shengshengketang.com/';
const WAIT = Number(A.timeout || 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const shell = readFileSync(join(REPO, 'userscript', 'netclass.shell.user.js'), 'utf8');
const app = readFileSync(join(REPO, 'userscript', 'App.js'), 'utf8');

// 注入版：把模块内容内联进壳（避免依赖本机服务器）
const inline = shell.replace(
  "const BASE = 'http://127.0.0.1:17800/';",
  "const BASE = 'http://127.0.0.1:17800/'; const INLINE_MODULE = true;"
).replace(
  "    get(BASE + MODULE + '?t=' + Date.now(), (text, status) => {",
  `    if (INLINE_MODULE) { inject(${JSON.stringify(app)}, 'inline-App.js'); say('内联模块已注入'); return; }
    get(BASE + MODULE + '?t=' + Date.now(), (text, status) => {`
);

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws err')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

// 选一个可用的页面目标（优先已开课程页，其次 about:blank / newtab）
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page');
console.log('--- 现有页面 ---');
pages.forEach(t => console.log('  ' + t.url.slice(0, 110)));
let target = pages.find(t => /shengshengketang|bjqiyang/.test(t.url))
  || pages.find(t => /about:blank|newtab/.test(t.url))
  || pages[0];
if (!target) { console.error('没有可用页面'); process.exit(1); }
console.log('注入目标: ' + target.url);

const c = new Cdp(target.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: inline });
console.log('已注册注入脚本（' + inline.length + ' bytes）');

await c.send('Page.navigate', { url: URL });
console.log('导航到 ' + URL + '，等待脚本自报…');

let last = '';
for (let i = 0; i < WAIT / 5; i++) {
  await sleep(5000);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        url: location.href, title: document.title,
        shell: !!window.__NETCLASS_SHELL__, module: !!window.NetClass,
        version: window.NetClass ? window.NetClass.version : null,
        videos: document.querySelectorAll('video').length,
        panel: !!document.getElementById('netclass-panel'),
        quiz: window.NetClass ? window.NetClass.state.quiz : null,
        video: window.NetClass ? window.NetClass.state.video : null
      })`, returnByValue: true
    });
    const v = r.result && r.result.value;
    if (v !== last) { console.log(`[${i * 5}s] ` + v); last = v; }
    const o = JSON.parse(v || '{}');
    if (o.module && o.videos > 0 && o.video && o.video.seen > 0) {
      console.log('✔ 脚本已生效并接管视频');
      break;
    }
  } catch (e) { console.log(`[${i * 5}s] eval err: ` + e.message); }
}

// 打印一次详细状态
try {
  const det = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify(window.NetClass ? { cfg: window.NetClass.cfg, state: window.NetClass.state, apis: window.NetClass.apis().slice(-10) } : { note: 'no module' })`,
    returnByValue: true
  });
  console.log('--- 详细 ---');
  console.log(det.result && det.result.value);
} catch { }

if (!A.keep) c.close();
else console.log('（保持连接；Ctrl+C 结束）');
