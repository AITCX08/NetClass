/**
 * cx-drive.mjs — 学习通自动驱动（真实鼠标事件版）
 *   node scripts/cx-drive.mjs --port 9227 [--step enter|play|loop]
 * 为什么用 Input.dispatchMouseEvent：该平台的点击处理器不吃 el.click()（同 webtrn 确认框那次教训）。
 * 本脚本在页面里找目标元素 → 取视口坐标 → 派发 mousePressed/mouseReleased。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const STEP = String(A.step || 'enter');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url));
if (!p) { console.log('没有 chaoxing 页面'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 40000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error).slice(0, 140))) : res(x.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => rej(new Error('timeout ' + m)), ms);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 找元素 → 算中心坐标 → 真实鼠标点击 */
async function realClick(finderExpr) {
  const box = await ev(`(function(){
    var el = (${finderExpr});
    if (!el) return null;
    el.scrollIntoView({block:'center', inline:'center'});
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName, txt: (el.innerText||'').replace(/\\s+/g,' ').slice(0,26) });
  })()`);
  if (!box) return null;
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  return b;
}

// ---- step: enter —— 个人空间 → 课程 → 目标课程 ----
if (STEP === 'enter') {
  console.log('起点: ' + String(await ev('location.href.slice(0,55)')).slice(0, 55));
  if (!/i\.chaoxing\.com\/base/.test(String(await ev('location.href')))) {
    await send('Page.navigate', { url: 'https://i.chaoxing.com/base' });
    await sleep(9000);
  }
  let r = await realClick(`Array.from(document.querySelectorAll('div,a,span,li')).find(function(x){return (x.innerText||'').trim()==='课程';})`);
  console.log('点「课程」: ' + JSON.stringify(r));
  await sleep(9000);

  r = await realClick(`Array.from(document.querySelectorAll('a,div,li')).filter(function(x){var t=(x.innerText||'').replace(/\\s+/g,' ').trim(); return t.indexOf('形势与政策')>=0 && t.length<60;}).pop()`);
  console.log('点课程卡片: ' + JSON.stringify(r));
  await sleep(13000);

  console.log('落地: ' + String(await ev(`JSON.stringify({url:location.href.slice(0,80),title:document.title.slice(0,20),invalid:/无效的参数/.test(document.body.innerText||''),body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,180)})`)).slice(0, 500));
}

// ---- step: play —— 在任务点页播视频（静音 + 倍速到底）----
if (STEP === 'play') {
  console.log('播放: ' + await ev(`(function(){
    var v = document.querySelector('video');
    if (!v) return 'no-video';
    v.muted = true;
    var rates = [2, 1.75, 1.5, 1.25, 1];
    var picked = 1;
    for (var i = 0; i < rates.length; i++) { try { v.playbackRate = rates[i]; } catch(e){} if (Math.abs(v.playbackRate - rates[i]) < 0.01) { picked = rates[i]; break; } }
    if (v.paused) v.play();
    return JSON.stringify({ dur: Math.round(v.duration||0), cur: Math.round(v.currentTime||0), rate: v.playbackRate, picked: picked, paused: v.paused });
  })()`));
}
ws.close();
