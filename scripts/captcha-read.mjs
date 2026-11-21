/**
 * refresh-canvas.mjs —— 真鼠标点图刷新 → 等新图加载 → canvas 导出（原始 + 6x）
 * 一次拿一张，避免多次取图不一致。
 * 用法: node runs/refresh-canvas.mjs <port> <name>
 */
const PORT = Number(process.argv[2] || 9231);
const NAME = process.argv[3] || 'cap-r';
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
const t = pages.find(p => /jcpxkh|91huayi/.test(p.url)) || pages[0];
if (!t) { console.log('没有页面'); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
let id = 0; const pend = new Map();
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (me, pa = {}, to = 25000) => new Promise(res => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};

await send('Page.enable'); await send('Runtime.enable');
await sleep(500);

// 点图刷新
const box = JSON.parse(await ev(`(function(){
  var i=document.getElementById('user_yzm'); if(!i) return 'null';
  var r=i.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),vis:!!i.offsetParent});
})()`) || 'null');
const before = String(await ev(`(function(){var i=document.getElementById('user_yzm');return i?i.src:'none'})()`));
if (box && box.vis) await clickAt(box.x, box.y);
await sleep(2600);
const after = String(await ev(`(function(){var i=document.getElementById('user_yzm');return i?i.src:'none'})()`));
console.log('刷新: ' + (before !== after ? '✅ src 变了' : '⚠ src 没变'));

// 等加载
for (let k = 0; k < 20; k++) {
  if (await ev(`(function(){var i=document.getElementById('user_yzm');return !!(i&&i.complete&&i.naturalWidth>0)})()`) === true) break;
  await sleep(300);
}

// 导出原始
const b64 = await ev(`(function(){
  var i=document.getElementById('user_yzm');
  if(!i||!i.complete||!i.naturalWidth) return null;
  var c=document.createElement('canvas');
  c.width=i.naturalWidth; c.height=i.naturalHeight;
  var x=c.getContext('2d'); x.imageSmoothingEnabled=false;
  x.drawImage(i,0,0);
  return c.toDataURL('image/png').split(',')[1];
})()`);
if (!b64) { console.log('❌ 导出失败'); process.exit(1); }
fs.writeFileSync(`${OUT}/${NAME}.png`, Buffer.from(b64, 'base64'));

// 导出 6x
const b64x = await ev(`(function(){
  var i=document.getElementById('user_yzm');
  if(!i||!i.complete||!i.naturalWidth) return null;
  var S=6;
  var c=document.createElement('canvas');
  c.width=i.naturalWidth*S; c.height=i.naturalHeight*S;
  var x=c.getContext('2d'); x.imageSmoothingEnabled=false;
  x.drawImage(i,0,0,c.width,c.height);
  return c.toDataURL('image/png').split(',')[1];
})()`);
if (b64x) fs.writeFileSync(`${OUT}/${NAME}-6x.png`, Buffer.from(b64x, 'base64'));

console.log('📸 ' + NAME + '.png / ' + NAME + '-6x.png');
console.log('src: ' + after.replace(/^https?:\/\/[^/]+/, ''));
ws.close();
