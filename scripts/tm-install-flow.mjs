/** tm-install-flow.mjs — 干净地复现「打开 .user.js → 油猴安装」流程，观察全过程
 *  用法：node tm-install-flow.mjs --port 9225 --url http://127.0.0.1:17800/netclass.user.js
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const URL_ = A.url || 'http://127.0.0.1:17800/netclass.user.js';
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
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify(p)); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

// 先关掉遗留的安装/错误页
const tabs0 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
for (const t of tabs0.filter(x => x.url.includes('script_installation') || x.url.startsWith('chrome-error'))) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); console.log('closed: ' + t.url.slice(0, 70)); } catch { }
}
await sleep(1500);

// 打开脚本 URL，并在同一 target 上订阅事件
const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
console.log('opened: ' + created.url + '  id=' + created.id);

const c = new Cdp(created.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });
await c.send('Log.enable').catch(() => { });
c.ws.addEventListener('message', ev => {
  try {
    const m = JSON.parse(ev.data);
    if (m.method === 'Log.entryAdded') console.log('  [log] ' + (m.params.entry.text || '').slice(0, 160));
    if (m.method === 'Runtime.consoleAPICalled') console.log('  [console] ' + (m.params.args || []).map(a => String(a.value || a.description || '').slice(0, 120)).join(' '));
  } catch { }
});

for (let i = 0; i < 8; i++) {
  await sleep(2000);
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const interesting = tabs.filter(t => /script_installation|options\.html|extension:\/\/|chrome-error|netclass/.test(t.url));
  console.log(`[${i * 2}s] 相关页面:`);
  for (const t of interesting) console.log('    [' + t.type + '] ' + t.url.slice(0, 110));
  const st = await c.send('Runtime.evaluate', { expression: 'location.href + " | " + document.title', returnByValue: true }).catch(() => null);
  if (st && st.result) console.log('    主页面: ' + st.result.value);
}
c.close();
