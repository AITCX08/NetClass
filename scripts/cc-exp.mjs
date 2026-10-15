/** cc-exp.mjs — 双标签并行实验：两边各点「播放」，测 90 秒内两边的推进速率
 *  node scripts/cc-exp.mjs --secs 90 --every 10
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const SECS = Number(A.secs || 90), EVERY = Number(A.every || 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ST = `(function(){
  function find(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=find(d);if(x)return x}}}catch(e){}return null}
  var v=find(document); var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  var NC=window.NetClass;
  return JSON.stringify({
    onTrain:/学习总进度/.test(t), onCourse:/返回课程列表/.test(t),
    v:v?{cur:Math.round(v.currentTime*10)/10,dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused,ended:v.ended}:null,
    en: NC?NC.cfg.enabled:null, seen: NC?NC.state.video.seen:null, ended: NC?NC.state.video.ended:null,
    head:t.slice(0,40)
  });
})()`;

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
  const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
  return cand.map(t => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let seq = 0;
    const ready = new Promise(r => ws.addEventListener('open', r));
    const send = (m, p = {}, ms = 20000) => new Promise(res => {
      const id = ++seq; const on = e => { let x; try { x = JSON.parse(e.data); } catch (_) { return } if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
      ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => res({ timeout: true }), ms);
    });
    return { id: t.id, ws, ready, send, ev: async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); } };
  });
}

const tabs = await connect();
console.log('标签: ' + tabs.map(t => t.id.slice(0, 6)).join(', '));
for (const t of tabs) await t.ready;

// 1) 每个标签点一次“播放/继续”
for (const t of tabs) {
  const box = await t.ev(`(function(){
    var el = Array.from(document.querySelectorAll('button,div,span')).find(function(e){var x=(e.innerText||'').trim();return (x==='播放'||x==='继续')&&(e.offsetWidth||e.offsetHeight)});
    if(!el) return null; el.scrollIntoView({block:'center'}); el.click();
    return 'clicked';
  })()`);
  console.log('  ' + t.id.slice(0, 6) + ' → ' + box);
}
await sleep(8000);

// 2) 采样
const start = tabs.map(() => null);
for (let i = 0; i <= SECS / EVERY; i++) {
  const row = [];
  for (let k = 0; k < tabs.length; k++) {
    const s = await tabs[k].ev(ST);
    const o = s ? JSON.parse(s) : null;
    if (o && o.v) {
      if (!start[k]) start[k] = { cur: o.v.cur, at: Date.now() };
      const wall = (Date.now() - start[k].at) / 1000;
      const adv = o.v.cur - start[k].cur;
      row.push(tabs[k].id.slice(0, 6) + ' ' + o.v.cur + '/' + o.v.dur + '@' + o.v.rate + (o.v.paused ? 'P' : 'R') + ' spd=' + (wall > 0 ? Math.round(adv / wall * 100) / 100 : 0) + (o.onTrain ? ' [训练页]' : '') + (o.onCourse ? ' [课程页]' : '') + ' en=' + o.en);
    } else row.push(tabs[k].id.slice(0, 6) + ' 无视频/无页面');
  }
  console.log(new Date().toTimeString().slice(0, 8) + '  ' + row.join('   |   '));
  if (i < SECS / EVERY) await sleep(EVERY * 1000);
}
process.exit(0);
