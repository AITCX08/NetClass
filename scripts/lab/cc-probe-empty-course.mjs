// 一次性诊断：进一门"无待播段"的课，把里面到底有什么打印出来
import { pageState, ensureTraining } from './cc-lib.mjs';
import { conn } from './cdp.mjs';

const PORT = 9228;
const TAB = 0;

function log(...a) { console.log(...a); }

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = tabs.filter(t => t.type === 'page')[TAB] || tabs.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id; pend.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); res({}); } }, 15000);
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r && r.result && r.result.result ? r.result.result.value : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const st = { ev, send, close: () => ws.close(), log: () => {} };

// 1) 确保在培训页
log('=== 步骤1: 回到培训页 ===');
await ensureTraining(st, log);
await sleep(2000);
log('  当前: ' + String(await ev('(document.body.innerText||"").replace(/\\s+/g," ").slice(0,80)'));

// 2) 点「进入」进培训
log('=== 步骤2: 点「进入」 ===');
await ev(`(function(){
  var bs=Array.from(document.querySelectorAll('button,a,div[class*=btn]'));
  var b=bs.find(function(e){return (e.innerText||'').trim()==='进入'});
  if(b){ b.click(); return 'clicked'; }
  return 'not-found';
})()`);
await sleep(7000);
log('  当前: ' + String(await ev('(document.body.innerText||"").replace(/\\s+/g," ").slice(0,100)'));

// 3) 找目标课程并点进去
log('=== 步骤3: 找课程「运算能力」并点进去 ===');
const clicked = await ev(`(function(){
  var all=Array.from(document.querySelectorAll('a,button,div,span,li,tr'));
  var hit=all.filter(function(e){
    var t=(e.innerText||'').trim();
    return t.indexOf('运算能力')>=0 && t.length<45;
  });
  if(!hit.length) return 'not-found';
  var e=hit[hit.length-1];   // 取最内层
  var r=e.getBoundingClientRect();
  return JSON.stringify({tag:e.tagName, text:e.innerText.trim().slice(0,40), x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)});
})()`);
log('  ' + clicked);
let pos = null;
try { pos = JSON.parse(clicked); } catch (_) { }
if (pos && pos.x) {
  // 真实鼠标点击（MUI 不响应合成 click）
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  log('  已真实点击 (' + pos.x + ',' + pos.y + ')');
}
await sleep(6000);

// 4) 打印课程页里到底有什么
log('=== 步骤4: 课程页内容 ===');
const dump = await ev(`(function(){
  var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  var videos=document.querySelectorAll('video').length;
  var btns=Array.from(document.querySelectorAll('button,a,[class*=btn],[class*=tab],[class*=item]'))
    .map(function(e){return (e.innerText||'').trim()}).filter(function(s){return s && s.length<20});
  var iframes=document.querySelectorAll('iframe').length;
  return JSON.stringify({
    页面文字: t.slice(0,400),
    视频数: videos,
    iframe数: iframes,
    可点元素: Array.from(new Set(btns)).slice(0,25)
  });
})()`);
log('  ' + dump);
ws.close();
process.exit(0);
