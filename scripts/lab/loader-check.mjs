/** loader-check.mjs — 查加载器扩展注册的脚本版本（拿到的 code 长度/来源/时间） */
const PORT = Number(process.argv[2] || 9224);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
console.log('== 所有 extension 目标 ==');
for (const t of list.filter(x => x.url && x.url.startsWith('chrome-extension://'))) {
  console.log('  [' + t.type + '] ' + t.url.slice(0, 110));
}

// 找加载器的 SW（按 storage 里的 lastSource 字段找）
let found = null;
for (const t of list.filter(x => x.type === 'service_worker')) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error('e')) : p.res(m.result); } });
  await new Promise(r => ws.addEventListener('open', r).valueOf?.() || r);
  const send = (mm, pp = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: mm, params: pp })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t')); } }, 10000); }); };
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(async function(){
        var out = { url: location.href.slice(0, 80) };
        try {
          var st = await chrome.storage.local.get(null);
          out.storage = st;
        } catch (e) { out.err = String(e); }
        try {
          if (chrome.userScripts) {
            var reg = await chrome.userScripts.getScripts();
            out.registered = reg.map(function(s){ return { id: s.id, codeLen: (s.js||[]).map(function(x){ return x.code ? String(x.code).length : (x.file ? 'file:' + x.file : '?'); }) }; });
          }
        } catch (e2) { out.regErr = String(e2); }
        return JSON.stringify(out);
      })()`, returnByValue: true, awaitPromise: true
    });
    const val = r.result && r.result.value;
    if (val && val.indexOf('netclass') >= 0) { console.log(''); console.log('== 加载器状态 =='); console.log('  ' + val); found = true; }
  } catch (e) { }
  ws.close();
}
if (!found) console.log('\n(没找到加载器 SW —— 可能它当前没运行)');
