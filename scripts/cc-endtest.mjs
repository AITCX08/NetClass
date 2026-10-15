/**
 * cc-endtest.mjs — 让当前视频干净地走到结尾，观察平台怎么记账
 *   node scripts/cc-endtest.mjs --port 9228 [--to <秒>] [--secs 120]
 * 关键问题：平台是否在"整段完播"时上报 → 段变已完成 → 课程完成 → 学时入账
 */
import { Tab, listCcTabs, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), SECS = Number(A.secs || 150), TO = Number(A.to || 0);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();

const READ = `(function(){
  var v=document.querySelector('video');
  var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  var btn=function(x){return Array.from(document.querySelectorAll('button,div,span')).some(function(e){return (e.innerText||'').trim()===x&&(e.offsetWidth||e.offsetHeight)})};
  return JSON.stringify({
    v: v?{cur:Math.round(v.currentTime*10)/10,dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused,ended:v.ended,rs:v.readyState,src:String(v.currentSrc||'').slice(-18)}:null,
    pct:(t.match(/(\\d{1,3})%/)||[])[1]||null,
    onCourse: btn('返回培训内容列表'), onPlayer: btn('返回课程列表'), onTrain: /学习总进度/.test(t),
    afterVideo: (function(){var i=t.indexOf('视频课程');return i>=0?t.slice(i,i+140):''})(),
    panel: (function(){var e=document.getElementById('netclass-panel');return e?e.innerText.replace(/\\s+/g,' ').slice(0,110):null})()
  });
})()`;

let last = null;
const t0 = Date.now();
for (let i = 0; i <= SECS / 8; i++) {
  const raw = await tab.ev(READ);
  let o = null; try { o = JSON.parse(raw); } catch (_) { }
  if (!o) { log('探针失败'); break; }
  const wall = Math.round((Date.now() - t0) / 1000);
  if (i === 1 && TO > 0 && o.v) {
    log('把 currentTime 设到 ' + TO + '（当前 ' + o.v.cur + '/' + o.v.dur + '）');
    await tab.ev(`(function(){var v=document.querySelector('video');if(v)v.currentTime=${TO};return 1})()`);
  }
  log(String(wall).padStart(3) + 's ' + (o.v ? (o.v.cur + '/' + o.v.dur + ' @' + o.v.rate + (o.v.paused ? ' 暂停' : ' 播') + (o.v.ended ? ' ended' : '') + ' src..' + o.v.src) : '无视频') + '  pct=' + o.pct + '  ' + (o.onPlayer ? 'P' : o.onCourse ? 'C' : o.onTrain ? 'T' : '?'));
  if (i % 3 === 0) {
    log('    面板: ' + String(o.panel).slice(0, 100));
    if (o.afterVideo) log('    课程列表: ' + o.afterVideo.slice(0, 120));
  }
  if (o.v && o.v.ended) { log('==> 视频 ended！再看它会不会自动续播/回列表'); }
  if (!o.v && (o.onCourse || o.onTrain)) { log('==> 已经离开播放器（页面=' + (o.onCourse ? '课程页' : '培训页') + '）'); }
  last = o;
  await sleep(8000);
}
process.exit(0);
