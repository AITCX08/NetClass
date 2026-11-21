/**
 * enter-project-then-open.mjs —— 点「进入」到 ExerciseHome/index，再 json/new 开 CoursePlay
 * 用法: node runs/enter-project-then-open.mjs <port> <courseware_id> <shotPrefix>
 */
const PORT = Number(process.argv[2] || 9231);
const CW = process.argv[3] || 'b65f246f-25df-44a7-84a1-bf791c520469';
const PFX = process.argv[4] || 'e1';
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PLAY = `https://jcpxkh.91huayi.com/exercise/ExerciseCourse/CoursePlay?courseware_id=${CW}`;

async function pages() {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (me, pa = {}, to = 30000) => new Promise(res => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
  });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const snap = async (n) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result?.data) { fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.result.data, 'base64')); console.log('  📸 ' + n + '.png'); }
  };
  return { ws, send, ev, clickAt, snap, url: t.url };
}

// ① 只留 ProjectList
let list = await pages();
console.log('① 标签:');
list.forEach(p => console.log('   ' + p.url.slice(0, 90)));
for (const p of list) {
  if (!/ExerciseHome|ProjectList/.test(p.url)) {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${p.id}`).catch(() => { });
    console.log('   关掉 ' + p.url.slice(0, 60));
  }
}
await sleep(1800);
list = await pages();
let base = list.find(p => /ProjectList/.test(p.url)) || list.find(p => /ExerciseHome/.test(p.url));
if (!base) { console.log('❌ 没有 ProjectList'); process.exit(2); }

const h = await attach(base);
await h.send('Page.enable'); await h.send('Runtime.enable');
await sleep(1000);

// ② 如果还在 ProjectList，点「进入」
if (/ProjectList/.test(String(await h.ev('location.href')))) {
  console.log('\n② 点「进入」');
  const enter = JSON.parse(await h.ev(`(function(){
    var bs = Array.from(document.querySelectorAll('input,button,a,div')).filter(function(e){
      var t=(e.innerText||e.value||'').trim();
      return e.offsetParent && t === '进入';
    });
    if(!bs.length) return 'null';
    bs.sort(function(a,b){return a.querySelectorAll('*').length-b.querySelectorAll('*').length});
    var b=bs[0], r=b.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),tag:b.tagName});
  })()`) || 'null');
  console.log('   ' + JSON.stringify(enter));
  if (enter && enter.x) await h.clickAt(enter.x, enter.y);
  await sleep(8000);
  console.log('   url: ' + String(await h.ev('location.href')).slice(0, 95));
}
await h.snap(PFX + '-1-entered');
h.ws.close();

// ③ json/new 开 CoursePlay
console.log('\n③ 开 CoursePlay');
await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PLAY)}`, { method: 'PUT' });
await sleep(15000);

const l2 = await pages();
console.log('   标签:');
l2.forEach(p => console.log('     ' + p.url.slice(0, 92)));
const player = l2.find(p => /CoursePlay/.test(p.url));
if (!player) { console.log('❌ 没开成'); process.exit(1); }

const hp = await attach(player);
await hp.send('Page.enable'); await hp.send('Runtime.enable');
await sleep(4000);
console.log('\n④ 播放器: ' + String(await hp.ev(`JSON.stringify({
  nc: typeof window.NetClass,
  plat: (window.NetClass&&window.NetClass.state&&window.NetClass.state.platform)||null,
  v: (function(){var v=document.querySelector('video');return v?{t:Math.round(v.currentTime),d:Math.round(v.duration||0),r:v.playbackRate,pa:v.paused,pct:Math.round(v.currentTime/(v.duration||1)*1000)/10}:null})(),
  err: /播放行为异常|已停止播放/.test(document.body.innerText||'')
})`)));
await hp.ev(`(function(){var v=document.querySelector('video');if(!v)return 0;try{v.playbackRate=1;}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){});return 1})()`);
await sleep(2500);
console.log('   播放: ' + String(await hp.ev(`(function(){var v=document.querySelector('video');return v?JSON.stringify({t:Math.round(v.currentTime),d:Math.round(v.duration||0),r:v.playbackRate,pa:v.paused,pct:Math.round(v.currentTime/(v.duration||1)*1000)/10}):'no video'})()`)));
await hp.snap(PFX + '-2-playing');
hp.ws.close();
