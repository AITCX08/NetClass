/**
 * fill-survey2.mjs —— 最终版问卷填写（修正多选题打法）
 *
 * 问卷星结构（实测）：
 *   radio   ：input[type=radio] 可直接 .click()（已验证 radio 生效）
 *   checkbox：input 被 style="display:none"，真正可点的是 a.jqcheck（18x18）
 *             → 必须真鼠标点 span.jqcheckwrapper / a.jqcheck
 *   q3      ：select，relation="2,2" + display:none → q2 选 1 时跳过
 *   q12     ：textarea，原生 setter
 *
 * 用法: node runs/fill-survey2.mjs <port> [--dry]
 */
const PORT = Number(process.argv[2] || 9250);
const DRY = process.argv.includes('--dry');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
const t = pages.find(p => /dcwj\.91huayi\.com/.test(p.url));
if (!t) { console.log('❌ 没有问卷标签'); process.exit(1); }
console.log('问卷: ' + t.url.slice(0, 110));

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
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await sleep(280);
};
const snap = async (n) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) { fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.result.data, 'base64')); console.log('  📸 ' + n + '.png'); }
};

await send('Page.enable'); await send('Runtime.enable');
await sleep(700);

// ① 单选：每题点第一个 radio（JS click，已验证有效）
console.log('① 单选（radio）');
const radioReport = String(await ev(`(function(){
  var rep = [];
  for (var n = 1; n <= 12; n++) {
    var f = document.getElementById('div' + n);
    if (!f || f.style.display === 'none') continue;
    var rs = Array.from(f.querySelectorAll('input[type=radio]'));
    if (!rs.length) continue;
    var r = rs[0];
    r.click();
    if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); }
    rep.push({q: n, id: r.id, checked: r.checked});
  }
  return JSON.stringify(rep);
})()`));
console.log('  ' + radioReport);

// ② 多选：真鼠标点 a.jqcheck
console.log('\n② 多选（checkbox → 真鼠标点 a.jqcheck）');
for (const n of [6, 9, 10]) {
  const box = JSON.parse(await ev(`(function(){
    var f = document.getElementById('div${n}');
    if (!f) return 'null';
    if (f.style.display === 'none') return JSON.stringify({skip:'hidden'});
    var a = f.querySelector('a.jqcheck');
    if (!a) {
      // 兜底：任意 span.jqcheckwrapper
      var w = f.querySelector('span.jqcheckwrapper');
      if (!w) return JSON.stringify({skip:'no jqcheck'});
      a = w;
    }
    a.scrollIntoView({block:'center'});
    var r = a.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height)});
  })()`) || 'null');

  if (!box || box.skip) { console.log('  q' + n + ': ' + JSON.stringify(box)); continue; }
  await clickAt(box.x, box.y);
  const after = String(await ev(`(function(){
    var f = document.getElementById('div${n}');
    var ins = Array.from(f.querySelectorAll('input[type=checkbox]'));
    return JSON.stringify({total: ins.length, checked: ins.filter(function(x){return x.checked}).map(function(x){return x.id})});
  })()`));
  console.log('  q' + n + ': 点 (' + box.x + ',' + box.y + ') → ' + after);
}

// ③ q3（若可见）
console.log('\n③ q3');
console.log('  ' + String(await ev(`(function(){
  var f = document.getElementById('div3'), s = document.getElementById('q3');
  if (!f || !s) return 'no q3';
  if (f.style.display === 'none') return 'hidden -> skip';
  if (s.options.length > 1) { s.selectedIndex = 1; s.dispatchEvent(new Event('change', {bubbles:true})); }
  return 'selected: ' + (s.options[s.selectedIndex]||{}).text;
})()`)));

// ④ q12 textarea
const SUGGEST = '建议进一步丰富基层常见病、多发病的实操案例，增加线上互动答疑环节，并延长回放有效期，方便基层医务人员利用碎片时间反复学习。';
console.log('\n④ q12');
console.log('  ' + String(await ev(`(function(){
  var ta = document.getElementById('q12');
  if (!ta) return 'no q12';
  var set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  ta.focus(); set.call(ta, ${JSON.stringify(SUGGEST)});
  ta.dispatchEvent(new Event('input', {bubbles:true}));
  ta.dispatchEvent(new Event('change', {bubbles:true}));
  ta.dispatchEvent(new Event('blur', {bubbles:true}));
  return 'len=' + ta.value.length;
})()`)));

// ⑤ 汇总
console.log('\n⑤ 填写状态:');
console.log(String(await ev(`(function(){
  var out = [];
  for (var n = 1; n <= 12; n++) {
    var f = document.getElementById('div' + n);
    if (!f) continue;
    var vis = f.style.display !== 'none';
    var ins = Array.from(f.querySelectorAll('input[type=radio], input[type=checkbox]'));
    var checked = ins.filter(function(x){return x.checked}).map(function(x){return x.id});
    var ta = f.querySelector('textarea');
    out.push({q:n, vis:vis, total:ins.length, n:checked.length, checked:checked, ta: ta ? ta.value.length : null});
  }
  return JSON.stringify(out);
})()`)));

await snap('survey2-filled-' + PORT);

if (DRY) { console.log('\n--dry，不提交'); ws.close(); process.exit(0); }

// ⑥ 提交（真鼠标）
console.log('\n⑥ 提交');
const btn = JSON.parse(await ev(`(function(){
  var cands = Array.from(document.querySelectorAll('div')).filter(function(e){
    return (e.innerText||'').trim() === '提交' && e.getBoundingClientRect().width > 100;
  });
  if (!cands.length) return 'null';
  cands.sort(function(a,b){ return b.getBoundingClientRect().y - a.getBoundingClientRect().y; });
  var b = cands[0];
  b.scrollIntoView({block:'center'});
  var r = b.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});
})()`) || 'null');
console.log('  ' + JSON.stringify(btn));
await sleep(1200);
if (btn && btn.x) await clickAt(btn.x, btn.y);
await sleep(4000);

console.log('\n⑦ 结果:');
console.log(String(await ev(`JSON.stringify({
  url: location.href.slice(0, 120),
  body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 350),
  thanks: /提交成功|感谢您的参与|已完成|您已完成/.test(document.body.innerText||''),
  stillError: /请选择选项|请填写/.test(document.body.innerText||'')
}, null, 1)`)));
await snap('survey2-after-' + PORT);
ws.close();
