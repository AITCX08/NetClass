/** tm-global-config.mjs — 读油猴全局配置（#config），找可能阻止执行的开关 */
const PORT = Number(process.argv[2] || 9225);
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes(TM));
if (!sw) { console.log('no sw'); process.exit(1); }

const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await new Promise(r => ws.addEventListener('open', r));
const send = (method, params = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')); } }, 20000); }); };

const r = await send('Runtime.evaluate', {
  expression: `(async function(){
    var st = await chrome.storage.local.get(null);
    var out = {};
    var cfg = st['!extdb.#config'];
    if (cfg) {
      var v = cfg.value !== undefined ? cfg.value : cfg;
      out.configType = typeof v;
      out.configKeys = Object.keys(v || {});
      // 只挑与执行相关的
      var keep = {};
      Object.keys(v || {}).forEach(function(k){
        if (/enabl|exec|run|mode|script|inject|dev|sandbox|security|level|advanced/i.test(k)) keep[k] = v[k];
      });
      out.relevant = keep;
    } else out.noConfig = true;
    out.schema = st['!extdb.#schema'] ? (st['!extdb.#schema'].value !== undefined ? st['!extdb.#schema'].value : st['!extdb.#schema']) : null;
    out.version = st['!extdb.#version'] ? (st['!extdb.#version'].value !== undefined ? st['!extdb.#version'].value : st['!extdb.#version']) : null;
    return JSON.stringify(out, null, 1).slice(0, 3000);
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
ws.close();
