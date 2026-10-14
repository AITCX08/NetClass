/** 读研讨区帖子的「作者 + 正文片段」（供生成对口回帖）+ 查上传项状态 */
const PORT = Number(process.argv[2] || 9226);
const FRAME = Number(process.argv[3] || 1);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes('activity_view'));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 25000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const expr = `(function(){
  try {
    var f = NetClass.webtrn.frames()[${FRAME}];
    var d = f.contentDocument;
    var out = { posts: [] };
    Array.from(d.querySelectorAll('textarea[id^=replyContent_]')).slice(0, 6).forEach(function(ta){
      var id = ta.id.replace('replyContent_','');
      var node = ta.parentElement, best = null, len = 0;
      for (var i = 0; i < 4 && node; i++) { var L = (node.innerText||'').length; if (L > len && L < 2000) { len = L; best = node; } node = node.parentElement; }
      var t = best ? best.innerText.replace(/\\s+/g,' ').trim() : '';
      out.posts.push({ postId: id, head: t.slice(0, 110) });
    });
    var up = Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a,i){ return i + ':' + (a.innerText||'').replace(/\\s+/g,' ').slice(0, 46); }).filter(function(t){ return /已有/.test(t); });
    out.uploads = up;
    var steps = Array.from(document.querySelectorAll('a[onclick*=setTab],li[onclick*=setTab]')).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26); });
    out.steps = steps;
    return JSON.stringify(out);
  } catch (e) { return 'ERR ' + e.message; }
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(String((r.result && r.result.result && r.result.result.value) || r.timeout).slice(0, 1800));
ws.close();
