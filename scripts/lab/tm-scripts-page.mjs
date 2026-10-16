/** tm-scripts-page.mjs — 读油猴「已安装脚本」页，看脚本开关状态与任何告警 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let page = list.find(t => t.type === 'page' && t.url.includes(TM_ID) && t.url.includes('options.html'));
if (!page) {
  page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM_ID}/options.html`)}`, { method: 'PUT' })).json();
  await sleep(8000);
}
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

// 切到脚本列表
await c.send('Runtime.evaluate', { expression: `location.hash = '#nav=scripts'; 'ok'`, returnByValue: true }).catch(() => { });
await sleep(5000);

const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var out = { url: location.href };
    var t = document.body.innerText || '';
    out.alerts = Array.from(document.querySelectorAll('.alert,[class*=notice],[class*=warn]')).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').slice(0,150); }).filter(Boolean).slice(0,8);
    // 脚本行
    var rows = Array.from(document.querySelectorAll('[class*=script_row],[class*=script-],#scripts_table tr,[class*=row]'));
    out.rows = rows.slice(0, 25).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').slice(0, 110); }).filter(function(s){ return s.length > 3; });
    out.hasNetClass = t.indexOf('NetClass') >= 0;
    out.mode = (t.match(/配置模式[^\\n]{0,30}/) || [''])[0];
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
