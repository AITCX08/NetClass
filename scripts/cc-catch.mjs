/** cc-catch.mjs — 在 9228 上点「播放」后每 3 秒采样，玩家消失时截图并存 DOM
 *  node scripts/cc-catch.mjs --secs 120
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), SECS = Number(A.secs || 120);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const t = cand[Number(A.tab || 0)] || cand[0];
console.log('目标标签: ' + t.id.slice(0, 6));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, p = {}, ms = 20000) => new Promise(res => {
  const id = ++seq; const on = e => { let x; try { x = JSON.parse(e.data); } catch (_) { return } if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => res({ timeout: true }), ms);
});
const ev = async (e, ms = 15000) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, ms); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };

const ST = `(function(){
  function find(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=find(d);if(x)return x}}}catch(e){}return null}
  var v=find(document); var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  return JSON.stringify({v:v?{cur:Math.round(v.currentTime),dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused,ended:v.ended,rs:v.readyState,ns:v.networkState,err:v.error?v.error.code:null}:null, len:t.length, tail:t.slice(-160)});
})()`;

// 先点播放
const clicked = await ev(`(function(){
  var el = Array.from(document.querySelectorAll('button,div,span')).find(function(e){var x=(e.innerText||'').trim();return (x==='播放'||x==='继续')&&(e.offsetWidth||e.offsetHeight)});
  if(!el) return null; el.scrollIntoView({block:'center'}); var r=el.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:(el.innerText||'').trim()});
})()`);
console.log('播放按钮: ' + clicked);
if (clicked) {
  const b = JSON.parse(clicked);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
}

let hadVideo = false, goneAt = null, samples = [];
const t0 = Date.now();
for (let i = 0; i <= SECS / 3; i++) {
  const s = await ev(ST);
  const o = s ? JSON.parse(s) : null;
  samples.push({ t: Math.round((Date.now() - t0) / 1000), o: o });
  const tag = o && o.v ? 'V ' + o.v.cur + '/' + o.v.dur + ' rs' + o.v.rs + ' ns' + o.v.ns + (o.v.paused ? ' P' : ' R') + (o.v.err ? ' ERR' + o.v.err : '') : '—';
  console.log(String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's ' + tag + '  | ' + (o ? o.tail.slice(-90) : ''));
  if (o && o.v) hadVideo = true;
  if (hadVideo && (!o || !o.v) && !goneAt) {
    goneAt = Date.now();
    console.log('>>> 播放器消失，抓证据');
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r && r.result && r.result.data) {
      if (!existsSync('runs/shots')) mkdirSync('runs/shots', { recursive: true });
      writeFileSync('runs/shots/cc-player-gone.png', Buffer.from(r.result.data, 'base64'));
      console.log('    截图: runs/shots/cc-player-gone.png');
    }
    const dom = await ev(`JSON.stringify(Array.from(document.querySelectorAll('div')).filter(function(e){return (e.offsetWidth||e.offsetHeight)&&(e.innerText||'').trim().length>0}).slice(-12).map(function(e){return {cls:String(e.className).slice(0,50),txt:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80)}}))`);
    console.log('    DOM 尾部: ' + dom);
    break;
  }
  await new Promise(r => setTimeout(r, 3000));
}
if (!goneAt) console.log('（未捕捉到消失，或视频一直在）');
process.exit(0);
