/**
 * submit-survey.mjs —— 最后一步：点击「提交」并读结果
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
const reqs = [];
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    const ty = m.params.type || '';
    if (ty === 'XHR' || ty === 'Fetch' || ty === 'Document') {
      reqs.push({ m: r.method, u: r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 100), b: String(r.postData || '').slice(0, 300) });
    }
  }
});
const send = (me, pa = {}, to = 30000) => new Promise(res => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(90);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(600);
};
const snap = async (n) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) { fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.result.data, 'base64')); console.log('  📸 ' + n + '.png'); }
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await sleep(600);

// 清掉可能存在的红框（防止吃点击）
console.log('① 清红框: ' + String(await ev(`(function(){
  var k = 0;
  for (var n = 1; n <= 12; n++) {
    var f = document.getElementById('div' + n);
    if (f && /rgb\\(255, 64, 64\\)|dashed/.test(f.style.border || '')) { f.style.border = ''; k++; }
  }
  return 'cleared ' + k;
})()`)));

// 找提交按钮
const btn = JSON.parse(await ev(`(function(){
  var cands = Array.from(document.querySelectorAll('div')).filter(function(e){
    return (e.innerText||'').trim() === '提交' && e.getBoundingClientRect().width > 100;
  });
  if (!cands.length) return 'null';
  cands.sort(function(a,b){ return b.getBoundingClientRect().y - a.getBoundingClientRect().y; });
  var b = cands[0];
  b.scrollIntoView({block:'center'});
  var r = b.getBoundingClientRect();
  var cx = Math.round(r.x+r.width/2), cy = Math.round(r.y+r.height/2);
  var hit = document.elementFromPoint(cx, cy);
  return JSON.stringify({x:cx, y:cy, hitTag: hit?hit.tagName:null, hitTxt: hit?(hit.innerText||'').trim().slice(0,10):null, isSelf: hit===b || (hit&&b.contains(hit))});
})()`) || 'null');
console.log('② 提交按钮: ' + JSON.stringify(btn));

if (!btn || !btn.x) { console.log('❌ 找不到提交按钮'); ws.close(); process.exit(1); }

await sleep(800);
console.log('③ 点击');
await clickAt(btn.x, btn.y);
await sleep(5000);

console.log('\n④ 结果:');
console.log(String(await ev(`JSON.stringify({
  url: location.href.slice(0, 130),
  body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 500),
  thanks: /提交成功|感谢您的参与|已完成|您已完成|答卷已提交/.test(document.body.innerText||''),
  err: /请选择选项|请填写|必填/.test(document.body.innerText||'')
}, null, 1)`)));

console.log('\n⑤ 请求（' + reqs.length + '）:');
reqs.slice(-8).forEach(r => {
  console.log('  ' + r.m + ' ' + r.u);
  if (r.b) console.log('     ' + r.b.slice(0, 240));
});

await snap('survey-submitted-' + PORT);
ws.close();
