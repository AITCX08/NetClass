/**
 * ensure-devmode.mjs — 确保目标浏览器开启扩展开发者模式（油猴执行脚本的硬前提），并验证
 *   1) 检查 chrome.userScripts 是否可用
 *   2) 不可用 → 打开 chrome://extensions 点 #devMode + 重载扩展
 *   3) 重新检查 + 打开一个测试页确认脚本注入
 *
 * 用法：node ensure-devmode.mjs --port 9225 [--test https://...]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const TEST_URL = A.test || 'https://study.bjqiyang.com/agent/Goods/courses?goods_id=46789&store_id=1&dm=' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = async () => await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function apiState() {
  const sw = (await list()).find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
  if (!sw) return 'no-sw';
  const c = new Cdp(sw.webSocketDebuggerUrl);
  await c.open();
  const r = await c.send('Runtime.evaluate', {
    expression: `(function(){ try { return chrome.userScripts ? 'available' : 'null'; } catch (e) { return 'ERR: ' + e.message; } })()`,
    returnByValue: true
  });
  c.close();
  return r.result && r.result.value;
}

console.log('== 1) 初始状态 ==');
let st = await apiState();
console.log('  chrome.userScripts -> ' + st);

if (st !== 'available') {
  console.log('== 2) 打开 chrome://extensions 并开启开发者模式 ==');
  const ext = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions/')}`, { method: 'PUT' })).json();
  await sleep(3500);
  const c = new Cdp(ext.webSocketDebuggerUrl);
  await c.open();
  await c.send('Page.enable');
  const ev = async expr => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
    return r.err || (r.exceptionDetails ? 'EXC' : (r.result && r.result.value));
  };
  let toggled = 'not-found';
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    toggled = await ev(`(function(){
      var m = document.querySelector('extensions-manager');
      if (!m) return 'no-manager';
      var tb = m.shadowRoot.querySelector('extensions-toolbar');
      if (!tb) return 'no-toolbar';
      var dm = tb.shadowRoot.querySelector('#devMode');
      if (!dm) return 'no-toggle';
      var pressed = dm.getAttribute('aria-pressed');
      if (pressed === 'true') return 'already-on';
      dm.click();
      return 'clicked';
    })()`);
    if (toggled !== 'no-manager' && toggled !== 'no-toolbar' && toggled !== 'no-toggle') break;
  }
  console.log('  devmode toggle -> ' + toggled);
  await sleep(2000);
  // 重载扩展
  const reloaded = await ev(`(function(){
    var m = document.querySelector('extensions-manager');
    var list = m.shadowRoot.querySelector('extensions-item-list');
    if (!list) return 'no-list';
    var items = list.shadowRoot.querySelectorAll('extensions-item');
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      var b = items[i].shadowRoot.querySelector('#dev-reload-button');
      if (b) { b.click(); n++; }
    }
    return 'reloaded ' + n;
  })()`);
  console.log('  ' + reloaded);
  c.close();
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${ext.id}`); } catch { }
  await sleep(6000);

  console.log('== 3) 复查 ==');
  st = await apiState();
  console.log('  chrome.userScripts -> ' + st);
}

if (st === 'available') {
  console.log('== 4) 打开测试页验证脚本注入 ==');
  await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TEST_URL)}`, { method: 'PUT' })).json();
  await sleep(22000);
  const pages = (await list()).filter(t => t.type === 'page' && t.url.includes('dm='));
  if (!pages.length) { console.log('  测试页未找到'); }
  else {
    const pc = new Cdp(pages[0].webSocketDebuggerUrl);
    await pc.open();
    await pc.send('Runtime.enable');
    const r = await pc.send('Runtime.evaluate', { expression: 'JSON.stringify({module: !!window.NetClass, ver: window.NetClass ? window.NetClass.version : null})', returnByValue: true });
    console.log('  ' + (r.result && r.result.value));
    pc.close();
  }
} else {
  console.log('!! 开发者模式仍不可用，脚本不会执行');
}
