/**
 * cx-click-play.mjs — 用 CDP 真实鼠标点视频播放按钮（跨 iframe 算顶层坐标 + 命中复核 + 逐层滚动）
 *   node scripts/cx-click-play.mjs --port 9227 [--verify 8]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const VERIFY = Number(A.verify || 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url));
if (!p) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 20000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };

/** 逐层滚动 + 算顶层坐标 + elementFromPoint 复核 */
const GEO = `(function(){
  function walk(r, path, sel){
    try { var e = r.querySelector(sel); if (e) return { el: e, path: path };
      var fs = Array.from(r.querySelectorAll('iframe'));
      for (var i=0;i<fs.length;i++){ var d=null; try{d=fs[i].contentDocument}catch(x){} if (d){ var q=walk(d, path.concat([i]), sel); if (q) return q; } } } catch(x){}
    return null;
  }
  var res = walk(document, [], '.vjs-play-control');
  var vidRes = walk(document, [], 'video');
  if (!res && !vidRes) return JSON.stringify({ err: 'no-play-control' });
  var path = (res || vidRes).path;
  // 逐层滚动，把目标滚进各层视口
  var w = window, chain = [];
  for (var k=0;k<path.length;k++){ var f=w.document.querySelectorAll('iframe')[path[k]]; if(!f) return JSON.stringify({err:'noframe'}); chain.push(f); w=f.contentWindow; }
  var targetEl = res ? res.el : null;
  if (targetEl) {
    try { var er = targetEl.getBoundingClientRect(); var need = er.top - w.innerHeight/2 + er.height/2; if (Math.abs(need) > w.innerHeight/4) w.scrollBy(0, Math.max(-w.innerHeight*0.9, Math.min(w.innerHeight*0.9, need))); } catch(e){}
  }
  for (var j=chain.length-1;j>=0;j--){
    var f2 = chain[j], doc = f2.ownerDocument, win = doc.defaultView;
    var fr = f2.getBoundingClientRect(); var need2 = fr.top - win.innerHeight/2 + fr.height/2;
    if (Math.abs(need2) > win.innerHeight/4) { try { win.scrollBy(0, Math.max(-win.innerHeight*0.9, Math.min(win.innerHeight*0.9, need2))); } catch(e){} }
  }
  // 重算坐标
  var w2 = window, offX = 0, offY = 0;
  for (var k2=0;k2<path.length;k2++){ var ff = w2.document.querySelectorAll('iframe')[path[k2]]; var rr = ff.getBoundingClientRect(); offX += rr.left; offY += rr.top; w2 = ff.contentWindow; }
  var el = targetEl || (vidRes ? vidRes.el : null);
  var rect = el.getBoundingClientRect();
  var x = Math.round(offX + rect.left + rect.width/2), y = Math.round(offY + rect.top + rect.height/2);
  var hitEl = null; try { hitEl = document.elementFromPoint(x, y); } catch(e){}
  return JSON.stringify({
    path: path.join('.'),
    coords: { x: x, y: y, w: Math.round(rect.width), h: Math.round(rect.height) },
    inVp: (x>=0 && y>=0 && x<=innerWidth && y<=innerHeight),
    hit: hitEl ? (hitEl.tagName + '.' + String(hitEl.className||'').slice(0,26)) : null,
    cls: targetEl ? String(targetEl.className).slice(0,50) : 'VIDEO',
    vjsState: targetEl ? String(targetEl.className).match(/vjs-(playing|paused)/) : null,
    video: vidRes ? { cur: Math.round(vidRes.el.currentTime*10)/10, dur: vidRes.el.duration, ready: vidRes.el.readyState, paused: vidRes.el.paused } : null,
    win: innerWidth + 'x' + innerHeight
  });
})()`;

const g = await ev(GEO);
console.log('几何: ' + g);
const o = JSON.parse(g || '{}');
if (o.coords) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: o.coords.x, y: o.coords.y, button: 'none' });
  await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: o.coords.x, y: o.coords.y, button: 'left', clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: o.coords.x, y: o.coords.y, button: 'left', clickCount: 1 });
  console.log('已点 (' + o.coords.x + ',' + o.coords.y + ')  hit=' + o.hit);
}
await sleep(VERIFY * 1000);
const g2 = await ev(GEO);
console.log('复检: ' + g2);
ws.close();
