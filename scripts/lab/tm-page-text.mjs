/** tm-page-text.mjs — 打印油猴 options 页全文，确认脚本列表是否渲染 */
const PORT = Number(process.argv[2] || 9225);
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.url.includes(TM) && t.url.includes('options.html'));
if (!page) { console.log('no options page — 先跑 tm-dashboard.mjs'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await new Promise(r => ws.addEventListener('open', r));
const send = (method, params = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')); } }, 20000); }); };

const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 2000),
    rowCount: document.querySelectorAll('[class*=script_row], [class*=scriptrow]').length,
    anyName: Array.from(document.querySelectorAll('*')).filter(e => e.children.length === 0 && /NetClass|网课|万能|OCS/.test(e.textContent || '')).map(e => (e.textContent || '').trim().slice(0, 40)).slice(0, 8)
  })`, returnByValue: true
});
console.log(r.result.value);
ws.close();
