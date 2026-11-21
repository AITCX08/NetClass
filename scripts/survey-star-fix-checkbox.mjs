/**
 * fix-q6.mjs —— 专门搞定 q6（8 个多选项，必填）
 * 用 elementFromPoint 先验证坐标命中什么元素，再点；点完验证 checked，不行换下一个可选
 */
const PORT = Number(process.argv[2] || 9250);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
const t = pages.find(p => /dcwj\.91huayi\.com/.test(p.url));
if (!t) { console.log('❌ 没有问卷'); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
let id = 0; const pend = new Map();
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (me, pa = {}, to = 30000) => new Promise(res => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(500);
};
const snap = async (n) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) { fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.result.data, 'base64')); console.log('  📸 ' + n + '.png'); }
};

await send('Page.enable'); await send('Runtime.enable');
await sleep(600);

console.log('=== ① q6 当前状态 ===');
console.log(String(await ev(`(function(){
  var f = document.getElementById('div6');
  if (!f) return 'no div6';
  var ins = Array.from(f.querySelectorAll('input[type=checkbox]'));
  var as = Array.from(f.querySelectorAll('a.jqcheck'));
  return JSON.stringify({
    vis: f.style.display !== 'none',
    border: f.style.border,
    total: ins.length,
    checked: ins.filter(function(x){return x.checked}).map(function(x){return x.id}),
    jqchecks: as.length,
    aCls: as.slice(0,3).map(function(a){ return (a.className||'').toString() + ' | ' + (a.parentElement?(a.parentElement.className||''):'') }),
    aStyle: as.slice(0,2).map(function(a){ return (a.getAttribute('style')||'').slice(0,80) })
  }, null, 1);
})()`)));

console.log('\n=== ② 逐个试 q6 的 8 个选项（elementFromPoint 校验 + 真鼠标） ===');
for (let i = 0; i < 8; i++) {
  const info = JSON.parse(await ev(`(function(){
    var f = document.getElementById('div6');
    var as = Array.from(f.querySelectorAll('a.jqcheck'));
    if (${i} >= as.length) return 'null';
    var a = as[${i}];
    a.scrollIntoView({block:'center'});
    var r = a.getBoundingClientRect();
    var cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + r.height/2);
    var hit = document.elementFromPoint(cx, cy);
    return JSON.stringify({
      i: ${i},
      x: cx, y: cy,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      inView: r.y >= 0 && r.y < innerHeight,
      hitTag: hit ? hit.tagName : null,
      hitCls: hit ? (hit.className||'').toString().slice(0,30) : null,
      isSelf: hit === a || (hit && a.contains(hit)) || (hit && hit.contains(a))
    });
  })()`) || 'null');

  if (!info) break;
  console.log('  [' + i + '] rect=' + JSON.stringify(info.rect) + ' hit=' + info.hitTag + '.' + info.hitCls + ' isSelf=' + info.isSelf);

  if (!info.isSelf || !info.inView) { console.log('       → 坐标无效，跳过'); continue; }

  await clickAt(info.x, info.y);

  const st = String(await ev(`(function(){
    var f = document.getElementById('div6');
    var ins = Array.from(f.querySelectorAll('input[type=checkbox]'));
    return JSON.stringify({checked: ins.filter(function(x){return x.checked}).map(function(x){return x.id})});
  })()`));
  console.log('       点后: ' + st);
  if (!/"checked":\[\]/.test(st)) { console.log('       ✅ q6 已勾选'); break; }
}

console.log('\n=== ③ 最终 q6 ===');
console.log(String(await ev(`(function(){
  var f = document.getElementById('div6');
  var ins = Array.from(f.querySelectorAll('input[type=checkbox]'));
  return JSON.stringify({checked: ins.filter(function(x){return x.checked}).map(function(x){return x.id}), border: f.style.border});
})()`)));

await snap('q6-fixed-' + PORT);

console.log('\n=== ④ 顺便检查所有必填（div.field[req=1] 且可见） ===');
console.log(String(await ev(`(function(){
  var out = [];
  for (var n = 1; n <= 12; n++) {
    var f = document.getElementById('div' + n);
    if (!f) continue;
    var req = f.getAttribute('req');
    var vis = f.style.display !== 'none';
    if (!vis) continue;
    var ins = Array.from(f.querySelectorAll('input[type=radio], input[type=checkbox]'));
    var checked = ins.filter(function(x){return x.checked}).length;
    var ta = f.querySelector('textarea');
    var sel = f.querySelector('select');
    var ok = true, how = [];
    if (ins.length) { how.push('radio/cb ' + checked + '/' + ins.length); if (checked === 0) ok = false; }
    if (ta) { how.push('ta len=' + ta.value.length); if (ta.value.length === 0) ok = false; }
    if (sel) { how.push('sel idx=' + sel.selectedIndex); if (sel.selectedIndex <= 0) ok = false; }
    out.push({q: n, req: req, ok: ok, how: how.join(' | '), border: f.style.border});
  }
  return JSON.stringify(out, null, 1);
})()`)));

ws.close();
