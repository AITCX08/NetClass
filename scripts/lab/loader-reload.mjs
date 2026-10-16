/** loader-reload.mjs — 在 chrome://extensions 里点加载器扩展的「重新加载」，强制从磁盘重读 background.js */
const PORT = Number(process.argv[2] || 9224);
const LOADER = 'ebikemhgdinpnfeanicfkahlehcojjmn';
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const sleepMs = Number(process.argv[3] || 0);
if (sleepMs) { console.log('等待 ' + (sleepMs / 1000) + 's 让加载器 SW 冷掉...'); await sleep(sleepMs); }

const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions')}`, { method: 'PUT' })).json();
await sleep(4000);
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const ev = async expr => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  return r.err || (r.exceptionDetails ? 'EXC' : (r.result && r.result.value));
};

// 等扩展列表渲染
for (let i = 0; i < 8; i++) {
  await sleep(1300);
  const ok = await ev(`(function(){
    var m = document.querySelector('extensions-manager'); if (!m) return 'x';
    var list = m.shadowRoot.querySelector('extensions-item-list'); if (!list) return 'x';
    return 'items=' + list.shadowRoot.querySelectorAll('extensions-item').length;
  })()`);
  if (ok.startsWith('items=')) { console.log(ok); break; }
}

console.log('点击重新加载: ' + await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var list = m.shadowRoot.querySelector('extensions-item-list');
  var items = list.shadowRoot.querySelectorAll('extensions-item');
  for (var i = 0; i < items.length; i++) {
    if ((items[i].getAttribute('id') || '').indexOf('${LOADER}') >= 0) {
      var btn = items[i].shadowRoot.querySelector('#dev-reload-button');
      if (!btn) return 'no reload button';
      btn.click();
      return 'clicked reload for NetClass Loader';
    }
  }
  return 'not found';
})()`));

await sleep(6000);
// 若详情视图打开了，也点一次它的重新加载
console.log('详情页 reload: ' + await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  if (!dp) return 'no detail view';
  var btn = dp.shadowRoot.querySelector('#dev-reload-button, [id*=reload]');
  if (btn) { btn.click(); return 'clicked'; }
  return 'no button in detail';
})()`));
await sleep(4000);
c.close();
try { await fetch(`http://127.0.0.1:${PORT}/json/close/${p.id}`); } catch { }
console.log('完成');
