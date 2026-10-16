/**
 * webtrn-nav.mjs — webtrn 通用页面操作器（点开/导航/取控件/按文字点击）
 *
 *   node scripts/webtrn-nav.mjs --port 9226 --dump                     # 打印当前页：正文摘要 + 可点控件 + 表单
 *   node scripts/webtrn-nav.mjs --port 9226 --go <path或完整URL> [--wait 4000] [--dump]
 *   node scripts/webtrn-nav.mjs --port 9226 --click "<文字>" [--nth 0] [--wait 3000] [--dump]
 *   node scripts/webtrn-nav.mjs --port 9226 --frames                   # 逐个 iframe 摘要（站点大量用 iframe）
 *   node scripts/webtrn-nav.mjs --port 9226 --do "<任意JS>"             # 逃生口：直接在页面里求值
 *
 * 说明：webtrn 是 JSP + 大量 iframe + javascript: 跳转（leftTogo/loadFile/openNavigationMenu）。
 * 直接改 location.href 到相对路径可用；点击按 innerText/value 精确匹配优先、包含匹配兜底。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9226);
const WAIT = Number(A.wait || 3500);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const MATCH = String(A.match || 'webtrn.cn');
const page = list.find(t => t.type === 'page' && String(t.url).includes(MATCH));
if (!page) { console.log('没找到匹配页面: ' + MATCH + '（当前有 ' + list.filter(t => t.type === 'page').length + ' 个标签）'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 30000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DUMP = `(function(){
  function ctl(root){
    return Array.from(root.querySelectorAll('a,input[type=button],input[type=submit],button'))
      .map(function(b){ return (b.value || b.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 18); })
      .filter(Boolean);
  }
  function txt(root, n){ return (root.innerText || root.textContent || '').replace(/\\s+/g,' ').trim().slice(0, n || 400); }
  var out = {
    url: location.href.slice(0, 110),
    title: document.title,
    body: txt(document.body, 700),
    controls: Array.from(new Set(ctl(document))).slice(0, 26),
    inputs: Array.from(document.querySelectorAll('input[type=text],input[type=password],textarea,select'))
      .filter(function(i){ return i.offsetParent !== null; })
      .map(function(i){ return { tag: i.tagName, id: i.id || '', name: String(i.name || '').slice(0, 30), val: String(i.value || '').slice(0, 24) }; }).slice(0, 14),
    fileInputs: document.querySelectorAll('input[type=file]').length,
    iframes: Array.from(document.querySelectorAll('iframe')).map(function(f, i){
      var d = null; try { d = f.contentDocument; } catch (e) { }
      return { i: i, src: String(f.src || '').slice(0, 70), ok: !!d, hint: d ? txt(d, 150) : null };
    }).slice(0, 8)
  };
  return JSON.stringify(out);
})()`;

if (A.frames) {
  console.log(await ev(`(function(){
    return JSON.stringify(Array.from(document.querySelectorAll('iframe')).map(function(f,i){
      var d=null; try{d=f.contentDocument}catch(e){}
      return { i:i, src:String(f.src||'').slice(0,80), ok:!!d, text: d ? (d.body.innerText||'').replace(/\\s+/g,' ').slice(0,220) : null,
               links: d ? Array.from(d.querySelectorAll('a')).map(function(a){return (a.innerText||'').trim().slice(0,12)}).filter(Boolean).slice(0,10) : [] };
    }));
  })()`));
  ws.close(); process.exit(0);
}

if (A.do) { console.log(String(await ev(A.do)).slice(0, 3000)); if (A.dump) console.log('\n' + await ev(DUMP)); ws.close(); process.exit(0); }

if (A.go) {
  const url = String(A.go).startsWith('http') ? String(A.go) : location0(page.url) + String(A.go);
  console.log('go -> ' + url.slice(0, 110));
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(WAIT);
}
function location0(u) { const m = String(u).match(/^https?:\/\/[^/]+/); return m ? m[0] : 'https://tea.webtrn.cn'; }

if (A.click) {
  const nth = Number(A.nth || 0);
  const r = await ev(`(function(){
    var want = ${JSON.stringify(String(A.click))};
    var all = Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button,li,span'));
    var hits = all.filter(function(e){ var t=(e.value||e.innerText||'').replace(/\\s+/g,' ').trim(); return t === want; });
    if (!hits.length) hits = all.filter(function(e){ var t=(e.value||e.innerText||'').replace(/\\s+/g,' ').trim(); return t.indexOf(want) >= 0 && t.length < 40; });
    if (!hits.length) return 'NOT-FOUND';
    var el = hits[${nth}] || hits[0];
    var info = { tag: el.tagName, cls: String(el.className||'').slice(0,30), onclick: (el.getAttribute('onclick')||'').slice(0,90), href: (el.getAttribute('href')||'').slice(0,60) };
    setTimeout(function(){ try { el.click(); } catch (e) { } }, 30);
    return JSON.stringify({ clicked: info, candidates: hits.length });
  })()`);
  console.log('click -> ' + r);
  await sleep(WAIT);
}

if (A.dump || (!A.click && !A.go && !A.do && !A.frames)) {
  const d = JSON.parse(await ev(DUMP));
  console.log('URL   : ' + d.url);
  console.log('标题  : ' + d.title);
  console.log('正文  : ' + d.body);
  console.log('控件  : ' + d.controls.join(' | '));
  if (d.inputs.length) console.log('输入  : ' + JSON.stringify(d.inputs));
  if (d.fileInputs) console.log('附件位: ' + d.fileInputs);
  if (d.iframes.length) for (const f of d.iframes) console.log('iframe[' + f.i + '] ' + (f.ok ? '' : '(跨域)') + ' ' + f.src + (f.hint ? '\n         ' + f.hint : ''));
}
ws.close();
