/**
 * enable-devmode.mjs — 复刻 OCS 的 openExtensionDeveloperMode：打开 chrome://extensions，必要时开启开发者模式并重载扩展
 * 用法：node enable-devmode.mjs --port 9225
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
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

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions/')}`, { method: 'PUT' })).json();
await sleep(3000);
const c = new Cdp(created.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

async function ev(expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  if (r.err) return 'EVAL-ERR ' + r.err;
  if (r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 200);
  return r.result && r.result.value;
}

console.log('页面: ' + await ev('location.href'));

// 等待 extensions-manager（shadow DOM 结构）
let state = null;
for (let i = 0; i < 10 && !state; i++) {
  await sleep(1500);
  state = await ev(`(function(){
    var m = document.querySelector('extensions-manager');
    if (!m) return null;
    var tb = m.shadowRoot.querySelector('extensions-toolbar');
    if (!tb) return null;
    var dm = tb.shadowRoot.querySelector('#devMode');
    if (!dm) return null;
    return { pressed: dm.getAttribute('aria-pressed'), checked: dm.checked };
  })()`);
  console.log(`[${i}] devmode state: ` + JSON.stringify(state));
}

if (state && (state.pressed === 'false' || state.checked === false)) {
  console.log('→ 点击开启开发者模式');
  console.log(await ev(`(function(){
    var m = document.querySelector('extensions-manager');
    var tb = m.shadowRoot.querySelector('extensions-toolbar');
    tb.shadowRoot.querySelector('#devMode').click();
    return 'clicked';
  })()`));
  await sleep(1500);
  // 重载扩展
  console.log(await ev(`(function(){
    var m = document.querySelector('extensions-manager');
    var list = m.shadowRoot.querySelector('extensions-item-list');
    if (!list) return 'no-list';
    var items = list.shadowRoot.querySelectorAll('extensions-item');
    var done = 0;
    for (var i = 0; i < items.length; i++) {
      var btn = items[i].shadowRoot.querySelector('#dev-reload-button');
      if (btn) { btn.click(); done++; }
    }
    return 'reloaded ' + done + ' extensions';
  })()`));
  await sleep(3000);
} else {
  console.log('开发者模式已是开启状态');
}

const after = await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var tb = m.shadowRoot.querySelector('extensions-toolbar');
  var dm = tb.shadowRoot.querySelector('#devMode');
  return JSON.stringify({ pressed: dm.getAttribute('aria-pressed'), checked: dm.checked });
})()`);
console.log('最终状态: ' + after);
c.close();
