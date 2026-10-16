/**
 * ocs-install.mjs — 复刻 OCS 启动时的「打开脚本 URL → 点安装」流程，用于安装/更新用户脚本
 *
 * 流程（与 OCS worker 的 initScripts 一致）：
 *   1. 新开一个标签页，打开脚本 URL（file:// 或 http(s):// 均可）
 *   2. 油猴弹出安装确认页（chrome-extension://<id>/ask.html?...）
 *   3. 找页面里 [class*="primary"] 或 [type*="button"] 的按钮，文本含 安装/更新/添加/install/update → 点击
 *   4. 核对油猴存储里的脚本名
 *
 * 用法：
 *   node ocs-install.mjs --port 9225
 *   node ocs-install.mjs --port 9224 --url file:///C:/Users/WJX/AppData/Local/TaskMesh/netclass/netclass.user.js
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const SCRIPT_URL = A.url || 'file:///C:/Users/WJX/AppData/Local/TaskMesh/netclass/netclass.user.js';
const SCRIPT_NAME = A.name || 'NetClass';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TIMEOUT = Number(A.timeout || 60);

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

async function list() { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }

// 1) 关掉遗留的 ask/安装页
for (const t of (await list()).filter(x => x.url.includes('ask.html'))) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } catch { }
}
await sleep(800);

// 2) 打开脚本 URL
console.log('打开脚本: ' + SCRIPT_URL);
const opened = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(SCRIPT_URL)}`, { method: 'PUT' })).json();

// 3) 等 ask.html 出现
let ask = null;
for (let i = 0; i < TIMEOUT / 2 && !ask; i++) {
  await sleep(2000);
  ask = (await list()).find(x => x.url.includes('ask.html'));
  if (!ask) process.stdout.write('.');
}
console.log('');
if (!ask) { console.log('✗ 安装确认页没出现（检查油猴是否加载 / 开发者模式是否开启）'); process.exit(2); }
console.log('✓ 安装确认页: ' + ask.url.slice(0, 80));

// 4) 点击安装（完全复刻 OCS 的选择器与判定）
const c = new Cdp(ask.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const clicked = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var btn = document.querySelector('[class*="primary"]') || document.querySelector('[type*="button"]');
    if (!btn) return 'no-button';
    var txt = ((btn.textContent) || (btn.getAttribute('value')) || '').trim();
    var kw = ['更新','安装','添加','降级','install','update','add','downgrade'];
    var hit = kw.some(function(k){ return txt.toLowerCase().indexOf(k.toLowerCase()) >= 0; });
    if (!hit) return 'text-mismatch:' + txt;
    btn.click();
    return 'clicked:' + txt;
  })()`, returnByValue: true
});
console.log('点击: ' + (clicked.result && clicked.result.value));
await sleep(5000);
c.close();

// 5) 核对 TM 存储
const list2 = await list();
const sw = list2.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
if (sw) {
  const c2 = new Cdp(sw.webSocketDebuggerUrl);
  await c2.open();
  const r = await c2.send('Runtime.evaluate', {
    expression: `(async function(){
      var st = await chrome.storage.local.get(null);
      var names = Object.keys(st).filter(function(k){ return k.indexOf('!extdb.@uid#') === 0; }).map(function(k){ return st[k].value; });
      var hit = names.filter(function(n){ return String(n).indexOf('${SCRIPT_NAME}') >= 0; });
      return JSON.stringify({ installed: names, target: hit });
    })()`, returnByValue: true, awaitPromise: true
  });
  console.log('TM 脚本列表: ' + (r.result && r.result.value));
  c2.close();
}
// 关掉遗留的脚本标签页
for (const t of (await list()).filter(x => x.url === SCRIPT_URL || x.url.startsWith('chrome-error'))) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } catch { }
}
console.log('done');
