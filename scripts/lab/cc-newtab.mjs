/**
 * cc-newtab.mjs — 开新标签（先试 /json/new，失败则用 CDP Target.createTarget）
 */
const PORT = 9228;
const list = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
let l = await list();
const before = new Set(l.filter(t => t.type === 'page').map(t => t.id));
const bver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
console.log('浏览器: ' + String(bver.Browser).slice(0, 60));

// 1) /json/new PUT
let ok = false;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://col.ccjyxy.cn')}`, { method: 'PUT' });
  console.log('/json/new PUT → ' + r.status);
  ok = r.ok;
} catch (e) { console.log('/json/new PUT 异常: ' + e.message); }
await new Promise(r => setTimeout(r, 6000));
l = await list();
let cc = l.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
if (cc.length > before.size || cc.some(t => !before.has(t.id))) { console.log('✔ /json/new 成功'); cc.forEach(t => console.log('  ' + t.id.slice(0, 8) + (before.has(t.id) ? ' [旧]' : ' [新]'))); process.exit(0); }

// 2) CDP Target.createTarget
console.log('改用 CDP Target.createTarget…');
const bws = new WebSocket(bver.webSocketDebuggerUrl);
await new Promise(r => bws.addEventListener('open', r));
const res = await new Promise(r => {
  bws.addEventListener('message', e => { const x = JSON.parse(e.data); if (x.id === 1) r(x); });
  bws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://col.ccjyxy.cn' } }));
  setTimeout(() => r({ timeout: true }), 15000);
});
console.log('createTarget: ' + JSON.stringify(res).slice(0, 200));
bws.close();
await new Promise(r => setTimeout(r, 8000));
l = await list();
cc = l.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
console.log('ccjyxy 标签数: ' + cc.length);
cc.forEach(t => console.log('  ' + t.id.slice(0, 8) + (before.has(t.id) ? ' [旧]' : ' [新]') + ' ' + t.url.slice(0, 40)));
