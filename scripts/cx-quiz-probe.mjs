/**
 * cx-quiz-probe.mjs — 打开一个「章测试」任务点并抓测验页结构（含 iframe 内）
 *   node scripts/cx-quiz-probe.mjs --port 9227
 */
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=9227').split('=')[1]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function conn() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find(t => t.type === 'page' && /mooc1\.chaoxing/.test(t.url) && !/tampermonkey/.test(t.url));
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (m, params = {}, ms = 30000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({ timeout: true }), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
  return { ws, send, ev, url: p.url };
}
async function realClick(c, finder) {
  const box = await c.ev(`(function(){ var el = (${finder}); if(!el) return null; el.scrollIntoView({block:'center'}); var r=el.getBoundingClientRect(); if(r.width<1) return null; return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),txt:(el.innerText||'').replace(/\\s+/g,' ').slice(0,26)}); })()`);
  if (!box) return null;
  const b = JSON.parse(box);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  return b;
}

let c = await conn();
console.log('页: ' + String(c.url).slice(0, 70));

// 若当前不在课程树页，先回课程页
if (!/studentcourse/.test(c.url)) {
  await c.ev(`location.href='https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=266554494&clazzid=153244493&cpi='`);
  await sleep(12000);
  c = await conn();
}
console.log('课程页: ' + String(c.url).slice(0, 60));

// 找「章测试」节点（优先 1.1.4 这类）
const hit = await realClick(c, `Array.from(document.querySelectorAll('*')).filter(function(e){ if(e.children.length>1) return false; var t=(e.innerText||'').replace(/\\s+/g,' ').trim(); return /章测试/.test(t) && t.length<40; })[0]`);
console.log('点章测试: ' + JSON.stringify(hit));
await sleep(14000);

// 重新连（可能开了新标签）
c = await conn();
console.log('落地: ' + String(c.url).slice(0, 80));

// 抓测验结构（含 iframe）
const dump = await c.ev(`(function(){
  function scan(root, depth){
    var out = { depth: depth, title: (document.title||'').slice(0,20), url: location.href.slice(0,60), questions: [], options: [], buttons: [], inputs: [], iframes: [] };
    try {
      var t = (root.body ? root.body.innerText : '').replace(/\\s+/g,' ');
      out.text = t.slice(0, 400);
      var qEls = root.querySelectorAll ? root.querySelectorAll('[class*=TiMu],[class*=question],[class*=subject],[class*=stem],.Zy_TItle') : [];
      out.questions = Array.from(qEls).slice(0,3).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').slice(0,120); });
      var optEls = root.querySelectorAll ? root.querySelectorAll('[class*=option],[class*=Option],label,.Zy_ulTop li,li[onclick]') : [];
      out.options = Array.from(optEls).slice(0,8).map(function(e){ return { tag:e.tagName, cls:String(e.className||'').slice(0,26), t:(e.innerText||'').replace(/\\s+/g,' ').slice(0,40) }; });
      out.inputs = Array.from((root.querySelectorAll ? root.querySelectorAll('input[type=radio],input[type=checkbox],textarea,input[type=text]') : [])).slice(0,8).map(function(i){ return { type:i.type, name:String(i.name||'').slice(0,20), val:String(i.value||'').slice(0,14) }; });
      out.buttons = Array.from((root.querySelectorAll ? root.querySelectorAll('a,button,input[type=button],input[type=submit]') : [])).filter(function(b){ return /提交|保存|下一题|确定|开始/.test(b.innerText||b.value||''); }).slice(0,6).map(function(b){ return (b.innerText||b.value||'').replace(/\\s+/g,' ').slice(0,16); });
      var fs = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
      for (var i=0;i<fs.length;i++){ var d=null; try{ d=fs[i].contentDocument; }catch(e){} if (d && depth < 3) out.iframes.push(scan(d, depth+1)); }
    } catch (e) { out.err = String(e.message).slice(0,60); }
    return out;
  }
  return JSON.stringify(scan(document, 0));
})()`);
console.log(String(dump).slice(0, 1800));
c.ws.close();
