/** tm-row-html.mjs — 打印 NetClass 行的 HTML，找「已启用」控件 */
const PORT = Number(process.argv[2] || 9225);
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('options.html'));
if (!page) { console.log('no options page'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await new Promise(r => ws.addEventListener('open', r));
const send = (method, params = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')); } }, 20000); }); };

const expr = `(function(){
  var rows = document.querySelectorAll('tr.scripttr');
  for (var i = 0; i < rows.length; i++) {
    var nm = (rows[i].querySelector('.script_name') || {}).innerText || '';
    if (nm.indexOf('NetClass') < 0) continue;
    var tds = rows[i].querySelectorAll('td');
    return JSON.stringify({
      name: nm,
      cellCount: tds.length,
      cell0: tds[0] ? tds[0].outerHTML.slice(0, 500) : null,
      allInputs: Array.from(rows[i].querySelectorAll('input')).map(function(inp){ return { type: inp.type, cls: String(inp.className).slice(0,40), checked: inp.checked, id: inp.id||'' }; }),
      icons: Array.from(rows[i].querySelectorAll('img,i,span[class*=icon],div[class*=icon]')).slice(0,8).map(function(e){ return { tag: e.tagName, cls: String(e.className).slice(0,50), title: e.title||'' }; })
    }, null, 1);
  }
  return 'row not found';
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result.value);
ws.close();
