/** cc-try.mjs — 在课程详情页点第 N 段开始播放，并持续观察
 *  node scripts/cc-try.mjs --tab 0 --seg 0 --secs 90
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), SECS = Number(A.secs || 90), SEG = Number(A.seg || 0);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const t = cand[Number(A.tab || 0)] || cand[0];
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, p = {}, ms = 20000) => new Promise(res => {
  const id = ++seq; const on = e => { let x; try { x = JSON.parse(e.data); } catch (_) { return } if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => res({ timeout: true }), ms);
});
const ev = async (e, ms = 15000) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, ms); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

console.log('标签: ' + t.id.slice(0, 6) + '  seg=' + SEG);
// 找第 SEG 个课程条目（MuiListItemButton-root 且含「播放/继续」）
const box = await ev(`(function(){
  var items = Array.from(document.querySelectorAll('.MuiListItemButton-root')).filter(function(e){
    return /播放|继续|已完成|未学习/.test(e.innerText||'') && (e.offsetWidth||e.offsetHeight);
  });
  if (!items.length) return JSON.stringify({err:'noitems'});
  var el = items[${SEG}] || items[0];
  el.scrollIntoView({block:'center'});
  var r = el.getBoundingClientRect();
  return JSON.stringify({n:items.length, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), txt:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60)});
})()`);
console.log('条目: ' + box);
const b = JSON.parse(box);
if (b.err) { console.log('没有课程条目'); process.exit(1); }
// 先点条目本身
await clickAt(b.x, b.y);
await new Promise(r => setTimeout(r, 4000));

const ST = `(function(){
  function find(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=find(d);if(x)return x}}}catch(e){}return null}
  var v=find(document); var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  return JSON.stringify({v:v?{cur:Math.round(v.currentTime),dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused,rs:v.readyState,ns:v.networkState,src:String(v.currentSrc||'').slice(0,50)}:null, pct:(t.match(/\d{1,3}\s*%/)||[null])[0], pctAll:(t.match(/\d{1,3}\s*%/g)||[]).slice(0,4), head:t.slice(0,70)});
})()`;

let flag = false;
const t0 = Date.now();
for (let i = 0; i <= SECS / 3; i++) {
  const s = await ev(ST); const o = s ? JSON.parse(s) : null;
  console.log(String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's ' + (o && o.v ? ('V ' + o.v.cur + '/' + o.v.dur + ' rs' + o.v.rs + ' ns' + o.v.ns + (o.v.paused ? ' P' : ' R') + ' ' + o.v.src) : '—') + '  pct=' + (o ? o.pct : '') + ' | ' + (o ? o.head : ''));
  if (o && o.v && !flag) { flag = true; }
  await new Promise(r => setTimeout(r, 3000));
}
process.exit(0);
