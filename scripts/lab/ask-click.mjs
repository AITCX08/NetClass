/** ask-click.mjs — 模拟 OCS 的点击逻辑：在 ask.html 上点「安装」并验证结果 */
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ask = tabs.find(t => t.url.includes('ask.html'));
if (!ask) { console.log('no ask.html (安装对话框未出现)'); process.exit(1); }
console.log('找到安装对话框: ' + ask.url.slice(0, 100));

const c = new Cdp(ask.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

// 完全复刻 OCS 的点击逻辑
const clicked = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var btn = document.querySelector('[class*="primary"]') || document.querySelector('[type*="button"]');
    if (!btn) return 'no-button';
    var txt = ((btn.textContent) || (btn.getAttribute('value')) || '').trim();
    var keywords = ['更新','安装','添加','降级','install','update','add','downgrade'];
    var hit = keywords.some(function(k){ return txt.toLowerCase().indexOf(k.toLowerCase()) >= 0; });
    if (!hit) return 'no-keyword-match:' + txt;
    btn.click();
    return 'clicked:' + txt;
  })()`, returnByValue: true
});
console.log('点击结果: ' + (clicked.result && clicked.result.value));
await sleep(4000);

// 验证：脚本是否进入 TM 存储
const sw = tabs.find(t => t.type === 'service_worker' && t.url.includes('dhdgffkkebhmkfjojejmpbldmpobfkfo'));
if (sw) {
  const c2 = new Cdp(sw.webSocketDebuggerUrl);
  await c2.open();
  const r = await c2.send('Runtime.evaluate', {
    expression: `(async function(){
      var st = await chrome.storage.local.get(null);
      var names = Object.keys(st).filter(function(k){ return k.indexOf('!extdb.@uid#') === 0; }).map(function(k){ return st[k] && st[k].value; });
      var reg = await chrome.userScripts.getScripts();
      return JSON.stringify({ scripts: names, registered: reg.map(function(s){ return s.id; }).length });
    })()`, returnByValue: true, awaitPromise: true
  });
  console.log('TM 脚本列表: ' + (r.result && r.result.value));
  c2.close();
}
c.close();
