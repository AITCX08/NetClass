/**
 * cx-login.mjs — 学习通（超星）登录：填手机号+密码 → 勾协议 → 点登录 → 报告结果
 *   node scripts/cx-login.mjs --port 9227 --user 1783xxxx --pass xxxx
 * 若出现滑块/图形验证码 → 停手报卡点（人工闸门）
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const USER = String(A.user || '');
const PASS = String(A.pass || '');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url)) || list.find(t => t.type === 'page' && !/tampermonkey/.test(t.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 30000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('页面: ' + String(p.url).slice(0, 80));
console.log('填表: ' + await ev(`(function(){
  function put(sel, v){ var e = document.querySelector(sel); if (!e) return sel + ':missing'; e.focus(); e.value = v;
    try { e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); } catch(x){} return sel + '=ok(' + e.value.length + ')'; }
  var r = [put('#phone', ${JSON.stringify(USER)}), put('#pwd', ${JSON.stringify(PASS)})];
  // 勾协议（常见是 span/div 带 agree 类，或密码框下方的一段文字）
  var agree = document.querySelector('#agree,[class*=agree],[class*=protocol] input[type=checkbox]');
  if (agree) { try { agree.click(); r.push('agree:clicked'); } catch(e){ r.push('agree:err'); } } else { r.push('agree:none'); }
  return JSON.stringify(r);
})()`));
await sleep(800);

console.log('登录: ' + await ev(`(function(){
  var b = document.querySelector('#loginBtn') || Array.from(document.querySelectorAll('a,button,input[type=submit],div')).find(function(x){ return /^\\s*登录\\s*$/.test((x.innerText||x.value||'').trim()) && (x.offsetWidth||x.offsetHeight); });
  if (!b) return 'no-login-button';
  b.click(); return 'clicked:' + b.tagName;
})()`));

for (let i = 1; i <= 8; i++) {
  await sleep(4000);
  const st = await ev(`JSON.stringify({
    url: location.href.slice(0, 90),
    title: document.title.slice(0, 26),
    body: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0, 130),
    captcha: !!document.querySelector('[class*=slider],[class*=verify-mask],#captcha,[class*=captcha-box]')
  })`);
  console.log('  ' + i + ') ' + String(st).slice(0, 260));
  const o = JSON.parse(String(st));
  if (/i\.chaoxing|space|mycourse|visit/.test(o.url) || /我的课程|空间|首页/.test(o.body)) { console.log('✅ 已登录'); break; }
  if (o.captcha) { console.log('⚠ 出现验证码/滑块 —— 人工闸门，停手'); break; }
}
ws.close();
