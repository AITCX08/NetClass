/**
 * nc-login.mjs — 通用登录（按输入框类型/占位符自动定位，适用于任何新平台）
 *   node scripts/nc-login.mjs --port 9228 --user <账号> --pass <密码> [--btn 登录]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port);
const USER = String(A.user || '');
const PASS = String(A.pass || '');
const BTN = String(A.btn || '登录');
if (!PORT || !USER) { console.log('用法: --port <端口> --user <账号> --pass <密码>'); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && !/tampermonkey|devtools/.test(t.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 30000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({ timeout: true }), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('页面: ' + String(await ev('document.title + " | " + location.href.slice(0,50)')));
console.log('填表: ' + await ev(`(function(){
  function vis(e){ return e && (e.offsetWidth||e.offsetHeight); }
  // ★ React/Vue 受控组件：直接赋 .value 框架拿不到，必须走 native value setter + 派发 input 事件
  function setVal(el, v){
    try {
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;
    } catch (e) { el.value = v; }
    ['input','change','blur'].forEach(function(k){ try { el.dispatchEvent(new Event(k, { bubbles: true })); } catch (e) {} });
  }
  var texts = Array.from(document.querySelectorAll('input')).filter(function(i){ return vis(i) && !/password|hidden|checkbox|radio|submit|button/.test(i.type); });
  var pwds = Array.from(document.querySelectorAll('input[type=password]')).filter(vis);
  var t = texts[0], pw = pwds[0];
  if (!t) return 'no-text-input';
  t.focus(); setVal(t, ${JSON.stringify(USER)});
  if (pw) { pw.focus(); setVal(pw, ${JSON.stringify(PASS)}); }
  return 'text=' + (t.placeholder||t.id||'').slice(0,14) + ' val=' + t.value.length + ' | pwd=' + (pw ? (pw.placeholder||pw.id||'ok').slice(0,10) + ' val=' + pw.value.length : 'NONE');
})()`));
await sleep(600);
// 勾协议（若有）
await ev(`(function(){ var c = document.querySelector('.agreement input[type=checkbox], [class*=agree] input[type=checkbox], input[type=checkbox]'); if (c && !c.checked) { try { c.click(); } catch(e){} } return 'ok'; })()`);
await sleep(400);
console.log('点登录: ' + await ev(`(function(){
  var b = Array.from(document.querySelectorAll('button,a,div,span,input[type=submit]')).find(function(e){
    var t = (e.innerText||e.value||'').replace(/\\s+/g,'').trim();
    return (t === ${JSON.stringify(BTN)} || /^登\\s*录$/.test(t) || /^登\\s*陆$/.test(t)) && (e.offsetWidth||e.offsetHeight);
  });
  if (!b) return 'no-btn';
  b.click(); return 'clicked:' + b.tagName;
})()`));
for (let i = 1; i <= 8; i++) {
  await sleep(4000);
  const st = await ev(`JSON.stringify({ url: location.href.slice(0,70), title: document.title.slice(0,26), body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,140) })`);
  console.log('  ' + i + ') ' + String(st).slice(0, 230));
  const o = JSON.parse(String(st));
  if (!/login|登\s*录/.test(o.url) && !/密码/.test(o.body)) { console.log('✅ 看起来已登录'); break; }
}
ws.close();
