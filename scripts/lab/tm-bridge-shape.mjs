/** tm-bridge-shape.mjs — 打印 TM 桥接脚本的 js 源（是 code 还是 file？） */
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
    try {
      var reg = await chrome.userScripts.getScripts();
      return JSON.stringify(reg.map(function(s){
        return {
          id: s.id,
          world: s.world,
          runAt: s.runAt,
          allFrames: s.allFrames,
          matches: s.matches,
          sources: (s.js || []).map(function(x){
            return { keys: Object.keys(x), file: x.file || null, codeLen: x.code ? String(x.code).length : 0, codeHead: x.code ? String(x.code).slice(0, 120) : null };
          })
        };
      }), null, 1);
    } catch (e) { return 'ERR ' + String(e); }
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
ws.close();
