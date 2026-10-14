/** 通用页面探针：按 URL 子串选中标签，打印标题/URL/正文/控件；超时可控 */
const PORT = Number(process.argv[2] || 9226);
const MATCH = process.argv[3] || 'learnspace';
const TIMEOUT = Number(process.argv[4] || 20000);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && String(t.url).includes(MATCH));
console.log('匹配标签数: ' + pages.length);
for (const p of pages) {
  console.log('--- ' + String(p.url).slice(0, 100));
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const send = (id, method, params = {}, ms = TIMEOUT) => new Promise(res => {
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res({ timeout: true }), ms);
  });
  const expr = `(function(){
    try {
      return JSON.stringify({
        title: document.title,
        url: location.href.slice(0, 110),
        ready: document.readyState,
        body: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 800),
        controls: Array.from(new Set(Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button')).map(function(b){return (b.value||b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,16)}).filter(Boolean))).slice(0, 25),
        inputs: Array.from(document.querySelectorAll('input[type=text],textarea,select')).filter(function(i){return i.offsetParent!==null}).map(function(i){return {tag:i.tagName,id:i.id||'',name:String(i.name||'').slice(0,26)}}).slice(0,10),
        iframes: Array.from(document.querySelectorAll('iframe')).map(function(f,i){var d=null;try{d=f.contentDocument}catch(e){}
          return {i:i, src:String(f.src||'').slice(0,70), ok:!!d, text: d ? (d.body.innerText||'').replace(/\\s+/g,' ').slice(0,200) : null}}).slice(0,6)
      });
    } catch (e) { return 'ERR ' + e.message; }
  })()`;
  const r = await send(1, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.timeout) { console.log('  求值超时（' + TIMEOUT + 'ms）：页面主线程忙或仍在加载'); }
  else console.log('  ' + JSON.stringify(r.result ? r.result.result.value : r).slice(0, 2000));
  ws.close();
}
