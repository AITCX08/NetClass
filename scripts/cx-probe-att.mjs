/** cx-probe-att.mjs — 走站内路径进任务点页，然后验证 OCS 依赖的 attachments 数据源是否存在 */
const PORT = 9227;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function conn() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const cand = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url));
  const p = cand.find(t => /studentstudy|studentcourse/.test(t.url)) || cand[0];
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let i = 0;
  const send = (m, params = {}, ms = 25000) => new Promise(res => { const id = ++i; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({ timeout: true }), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
  return { ws, send, ev };
}
let c = await conn();
console.log('起点: ' + String(await c.ev('location.href.slice(-40)')));

// 1) 走站内入口进课程
await c.ev(`location.href='https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=266554494&clazzid=153244493&cpi='`);
await sleep(16000);
c = await conn();
console.log('课程页: ' + String(await c.ev('JSON.stringify({url:location.href.slice(-38), enc:!!location.href.match(/enc=/)})')));

// 2) 真实鼠标点第一个任务点（用 /knowledge/cards 链接或 onclick 节点）
const box = await c.ev(`(function(){
  var el = Array.from(document.querySelectorAll('[onclick^="getTeacherAjax"]')).find(function(e){
    var t=(e.innerText||'').trim(); return /\\d\\.\\d/.test(t) && t.length < 40;
  });
  if (!el) { var a = document.querySelector('a[href*="/knowledge/cards"]'); el = a; }
  if (!el) return null;
  el.scrollIntoView({block:'center'});
  var r = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), t:(el.innerText||'').slice(0,24) });
})()`);
console.log('任务点: ' + box);
if (box) {
  const b = JSON.parse(box);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(16000);
  c = await conn();
}
console.log('落地: ' + String(await c.ev('location.href.slice(-42)')));

// 3) 探 attachments / iframe data
const probe = `(function(){
  var out = { pages: [] };
  function probe(w, tag, depth){
    if (depth > 4) return;
    try {
      var rec = { where: tag };
      try { rec.hasAttachments = !!w.attachments; if (w.attachments) { rec.len = w.attachments.length;
        rec.sample = w.attachments.slice(0,2).map(function(x){ return { jobid:x.jobid, isPassed:x.isPassed, hasJob:!!x.job, mid:x.property&&x.property.mid, name:String((x.property&&x.property.name)||'').slice(0,18) }; }); } } catch(e){ rec.err = String(e).slice(0,30); }
      try { rec.videojs = typeof w.videojs; } catch(e){}
      try { rec.currentMedia = typeof w.currentMedia; } catch(e){}
      if (rec.hasAttachments || rec.videojs === 'function' || rec.currentMedia !== 'undefined') out.pages.push(rec);
      Array.from(w.document.querySelectorAll('iframe')).forEach(function(f,i){
        var d = f.getAttribute && f.getAttribute('data');
        if (d) out.pages.push({ where: tag + '>f' + i, iframeData: d.slice(0,120) });
        try { if (f.contentWindow) probe(f.contentWindow, tag + '>f' + i, depth+1); } catch(e){}
      });
    } catch(e){}
  }
  probe(window, 'top', 0);
  return JSON.stringify(out).slice(0, 1200);
})()`;
console.log('探测结果: ' + String(await c.ev(probe)).slice(0, 1200));
c.ws.close();
