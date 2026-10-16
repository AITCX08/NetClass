/**
 * ss-progress.mjs — shengsheng 整体进度与 ETA
 *   node scripts/ss-progress.mjs --port 9224 [--rate 1.5] [--parallel 2] [--open-home]
 * 输出：每个已打开课程页的（总节数/已完成/剩余时长）+ 汇总百分比 + 预估剩余墙钟时间
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const RATE = Number(A.rate || 1.5);
const PARALLEL = Number(A.parallel || 2);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && String(t.url).includes('shengshengketang'));

const EXPR = `(function(){
  function toSec(s){ if(!s) return 0; var p = s.split(':').map(Number); return p.length===3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; }
  var items = Array.from(document.querySelectorAll('.lesson-item'));       // 只取课时行，避免把状态块重复算
  if (!items.length) items = Array.from(document.querySelectorAll('li[class*=lesson]')).filter(function(e){ return !/lesson-status/.test(String(e.className)); });
  var rows = items.map(function(e){
    var t = (e.innerText||'').replace(/\\s+/g,' ').trim();
    var st = (t.match(/(已完成|已学完|学习中|未开始|待学习)/)||[])[1] || '';
    var durs = t.match(/(\\d{1,2}:\\d{2}:\\d{2}|\\d{1,2}:\\d{2})/g) || [];
    var name = t.replace(/(已完成|已学完|学习中|未开始|待学习)/,'').replace(/(\\d{1,2}:\\d{2}(:\\d{2})?)/g,'').trim().slice(0,20);
    return { name: name, status: st, dur: durs[durs.length-1] || '', sec: toSec(durs[durs.length-1] || '') };
  });
  var done = rows.filter(function(r){ return /已完成|已学完/.test(r.status); });
  var todo = rows.filter(function(r){ return !/已完成|已学完/.test(r.status); });
  var v = document.querySelector('video');
  return JSON.stringify({
    url: location.pathname.slice(0,40),
    total: rows.length, done: done.length, todo: todo.length,
    totalSec: rows.reduce(function(a,r){return a+r.sec},0),
    doneSec: done.reduce(function(a,r){return a+r.sec},0),
    remainSec: todo.reduce(function(a,r){return a+r.sec},0),
    noDur: rows.filter(function(r){return !r.sec}).length,
    cur: v ? { cur: Math.round(v.currentTime), dur: Math.round(v.duration||0), rate: v.playbackRate, paused: v.paused } : null,
    sample: todo.slice(0,6).map(function(r){ return r.name + '|' + r.status + '|' + r.dur })
  });
})()`;

let sumTot = 0, sumDone = 0, sumRemainSec = 0, sumTotalSec = 0;
const rows = [];
for (const p of pages) {
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const r = await new Promise(res => {
    let done = false;
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === 1) { ws.removeEventListener('message', on); done = true; res(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }));
    setTimeout(() => { if (!done) res({ timeout: true }); }, 15000);
  });
  ws.close();
  if (r.timeout) { console.log('  (有页面超时)'); continue; }
  const d = JSON.parse(r.result.result.value);
  rows.push(d);
  sumTot += d.total; sumDone += d.done; sumRemainSec += d.remainSec; sumTotalSec += d.totalSec;
  const pct = d.total ? (d.done / d.total * 100).toFixed(0) : '?';
  console.log('· ' + d.url + '  课时 ' + d.done + '/' + d.total + ' (' + pct + '%)  剩余媒体时长 ' + (d.remainSec/60).toFixed(0) + ' 分钟' + (d.noDur ? '  [有 ' + d.noDur + ' 节取不到时长]' : ''));
  if (d.sample.length) console.log('   待处理样例: ' + d.sample.join(' / '));
  if (d.cur) console.log('   当前播放: ' + d.cur.cur + '/' + d.cur.dur + 's @' + d.cur.rate + 'x paused=' + d.cur.paused);
}

const pctAll = sumTot ? (sumDone / sumTot * 100) : 0;
const remainWallSec = (sumRemainSec / RATE) / Math.max(1, PARALLEL);
console.log('\n=== 汇总（已打开 ' + rows.length + ' 个课程页）===');
console.log('课时完成: ' + sumDone + '/' + sumTot + '  → ' + pctAll.toFixed(1) + '%');
console.log('课程总时长: ' + (sumTotalSec/3600).toFixed(1) + ' 小时；剩余媒体时长: ' + (sumRemainSec/3600).toFixed(2) + ' 小时');
console.log('预估剩余墙钟: ' + (remainWallSec/3600).toFixed(2) + ' 小时（' + RATE + 'x × ' + PARALLEL + ' 路并行，未含切页/等待开销）');
console.log('按 +15% 开销估: ' + (remainWallSec*1.15/3600).toFixed(2) + ' 小时');
