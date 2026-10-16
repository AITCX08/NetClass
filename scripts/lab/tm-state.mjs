/** tm-state.mjs — 查油猴扩展内部的真实状态：userScripts 可用性 / devmode / 已注册脚本
 *  用法：node tm-state.mjs --port 9225
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

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

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = targets.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
const bg = targets.find(t => t.url.includes(TM_ID) && t.url.includes('background'));
const extPage = targets.find(t => t.url.includes(TM_ID) && t.type === 'page');
const target = sw || bg || extPage;
if (!target) { console.log('找不到油猴扩展 target'); process.exit(1); }
console.log('target: [' + target.type + '] ' + target.url.slice(0, 90));

const c = new Cdp(target.webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var out = {
      hasUserScripts: (typeof chrome !== 'undefined' && chrome.userScripts) ? true : false,
      hasScripting: (typeof chrome !== 'undefined' && chrome.scripting) ? true : false,
      hasOffscreen: (typeof chrome !== 'undefined' && chrome.offscreen) ? true : false,
      runtimeMode: null,
      err: null
    };
    try {
      if (chrome.userScripts) {
        out.userScriptsMethods = Object.keys(chrome.userScripts).slice(0, 8);
      }
    } catch (e) { out.err = String(e); }
    return JSON.stringify(out);
  })()`,
  returnByValue: true, awaitPromise: true
});
if (r.exceptionDetails) console.log('EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
else console.log('状态: ' + (r.result && r.result.value));
c.close();
