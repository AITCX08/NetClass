/**
 * cxsubmit.mjs — 在学习通章测试页点「提交」并处理确认弹窗
 *
 * 难点：提交按钮在**第 3 层嵌套 iframe** 里，且页面很长（y≈2644）→ 必须
 *  ① 在按钮自己的 document 里 scrollIntoView
 *  ② 逐层累加 iframe 的 rect + 每层父文档的滚动偏移
 *  ③ 得到顶层视口坐标后再派 CDP 真实鼠标事件（React/jQuery 页面不吃 el.click()）
 *  ④ 提交后找确认弹窗（确认/确定/提交）继续点
 */
const P = 9227;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url))[0];
if (!p) { console.log('无标签'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, pr = {}, ms = 15000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 定位「提交」按钮：在嵌套 iframe 里找，滚动到可见，算出顶层绝对坐标
const FIND = `(function(){
  function walk(root, path){
    var out = null;
    try {
      var fs = Array.from(root.querySelectorAll('iframe'));
      for (var i = 0; i < fs.length; i++) {
        var d = null; try { d = fs[i].contentDocument; } catch(e){}
        if (!d) continue;
        var cands = Array.from(d.querySelectorAll('a,button,span,div')).filter(function(e){
          var tx = (e.innerText||'').trim();
          return /^(提交|交卷|提交答案)$/.test(tx) && (e.offsetWidth||e.offsetHeight);
        });
        if (cands.length) {
          var b = cands[0];
          b.scrollIntoView({block:'center'});
          return { el: b, path: path.concat([i]), doc: d };
        }
        var r = walk(d, path.concat([i]));
        if (r) return r;
      }
    } catch(e){}
    return out;
  }
  var hit = walk(document, []);
  if (!hit) return 'no-submit-btn';
  // 逐层累加：iframe rect + 该层父文档的滚动偏移
  var w = window, offX = 0, offY = 0, node = hit.el, chain = [];
  for (var k = 0; k < hit.path.length; k++) {
    var f = w.document.querySelectorAll('iframe')[hit.path[k]];
    var fr = f.getBoundingClientRect();
    offX += fr.left - (w.document.documentElement.scrollLeft || w.document.body.scrollLeft || 0) * 0;
    offY += fr.top;
    chain.push(Math.round(fr.top));
    w = f.contentWindow;
  }
  // hit.el 的 rect 是相对它所在文档视口的；加上祖先 iframe 的位置即可（各层不滚动外层）
  var r = hit.el.getBoundingClientRect();
  var sc = hit.doc.documentElement.scrollTop || hit.doc.body.scrollTop || 0;
  return JSON.stringify({ x: Math.round(offX + r.left + r.width/2), y: Math.round(offY + r.top + r.height/2),
                          depth: hit.path.length, chainTops: chain, docScroll: sc, rectTop: Math.round(r.top),
                          label: (hit.el.innerText||'').trim() });
})()`;

const box = await ev(FIND);
console.log('提交按钮: ' + String(box).slice(0, 200));
if (box && box !== 'no-submit-btn') {
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  console.log('已点击「提交」于 (' + b.x + ',' + b.y + ')');
  await sleep(2500);

  // 处理确认弹窗（可能出现在任意层）
  const DIALOG = `(function(){
    function hits(root){
      var out = [];
      try {
        out = out.concat(Array.from(root.querySelectorAll('a,button,span,div')).filter(function(e){
          var tx = (e.innerText||'').trim();
          return /^(确定|确认|提交|是)$/.test(tx) && (e.offsetWidth||e.offsetHeight) && /确定|确认|提交/.test(tx);
        }).map(function(e){ var r=e.getBoundingClientRect(); return {t:(e.innerText||'').trim(), x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; }));
        Array.from(root.querySelectorAll('iframe')).forEach(function(f){
          var d=null; try{ d=f.contentDocument; }catch(e){}
          if (d) out = out.concat(hits(d));
        });
      } catch(e){}
      return out;
    }
    var h = hits(document);
    return JSON.stringify(h.slice(0, 4));
  })()`;
  const dl = await ev(DIALOG);
  console.log('确认弹窗候选: ' + String(dl).slice(0, 300));
  try {
    const arr = JSON.parse(dl || '[]');
    for (const d of arr.slice(0, 2)) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: d.x, y: d.y, button: 'none' });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: d.x, y: d.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: d.x, y: d.y, button: 'left', clickCount: 1 });
      console.log('  已点确认: ' + d.t);
      await sleep(2000);
    }
  } catch (_) { }
}
await sleep(4000);
console.log('提交后状态: ' + String(await ev(`(function(){
  function deep(root, d){ var out=[]; if(d>3) return out;
    try { Array.from(root.querySelectorAll('iframe')).forEach(function(f){
      var dd=null; try{ dd=f.contentDocument; }catch(e){}
      if(!dd) return;
      var t=(dd.body?dd.body.innerText:'').replace(/\\s+/g,' ');
      if(t.length>10) out.push({ len:t.length, pending:/待完成/.test(t), checked:dd.querySelectorAll('input:checked').length, head:t.slice(0,50) });
      out=out.concat(deep(dd, d+1));
    }); } catch(e){}
    return out; }
  return JSON.stringify(deep(document,1)).slice(0,700);
})()`)));
ws.close();
