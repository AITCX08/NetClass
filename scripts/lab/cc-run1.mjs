/** cc-run1.mjs — 单实例闭环验证（用 cc-lib）：培训页→开课→逐段播完→回列表
 *  node scripts/cc-run1.mjs --tab 0 --maxSecs 600 --maxSegs 2
 */
import { Tab, listCcTabs, pageState, ensureTraining, expand, enumerate, openCourse, playFirstSegment, pendingSegments, sleep } from './cc-lib.mjs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 0);
const MAXSEGS = Number(A.maxSegs || 2), MAXSECS = Number(A.maxSecs || 900);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
if (!tabs || !tabs.length) { log('没有 ccjyxy 标签'); process.exit(1); }
const t = tabs[TAB] || tabs[0];
const tab = new Tab(t, PORT);
if (!await tab.connect()) { log('连不上'); process.exit(1); }
log('tab=' + tab.targetId.slice(0, 6));

if (!await ensureTraining(tab, log)) { log('进不了培训页'); process.exit(1); }
await expand(tab, null, log);
const courses = await enumerate(tab, null);
log('枚举 ' + courses.length + ' 门，未完成 ' + courses.filter(c => c.undone).length);
const target = courses.filter(c => c.undone)[0];
if (!target) { log('没有未完成课程'); process.exit(0); }
log('目标: ' + target.name.slice(0, 30) + ' cat=' + target.cat);

if (!await openCourse(tab, target.name, log)) process.exit(1);
await sleep(3000);

const hardDeadline = Date.now() + MAXSECS * 1000;
let segs = 0;
while (segs < MAXSEGS && Date.now() < hardDeadline) {
  const pend = await pendingSegments(tab);
  const st = await pageState(tab);
  log('可播段=' + pend + '  状态=' + (st ? JSON.stringify({ onCourse: st.onCourse, onPlayer: st.onPlayer, video: st.video, pct: st.pct }) : 'null'));
  if (!pend) { log('课程页没有可播段 → 本课完成'); break; }
  const v0 = await playFirstSegment(tab, log);
  if (!v0) { log('段未起播'); await sleep(5000); continue; }
  segs++;
  log('  段' + segs + ' 起播: ' + v0.cur + '/' + v0.dur + ' @' + v0.rate);
  // 播完循环
  let last = v0.cur, lastMove = Date.now(), t0 = Date.now();
  for (let g = 0; g < 600; g++) {
    await sleep(6000);
    const s = await pageState(tab);
    if (!s) continue;
    if (s.video) {
      const left = s.video.dur - s.video.cur;
      if (g % 5 === 0) {
        const wall = (Date.now() - t0) / 1000;
        log('    ' + s.video.cur + '/' + s.video.dur + ' @' + s.video.rate + (s.video.paused ? ' 暂停' : ' 播') + '  实际倍速=' + (Math.round((s.video.cur - v0.cur) / wall * 100) / 100));
      }
      if (Math.abs(s.video.cur - last) > 0.4) { last = s.video.cur; lastMove = Date.now(); }
      if (s.video.dur && left <= 2) { log('  ✔ 段' + segs + ' 播完 ' + s.video.cur + '/' + s.video.dur); break; }
      if (Date.now() - lastMove > 40000) {
        log('    ⚠ 停滞 → 恢复');
        await tab.ev(`(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play()}catch(e){}}})()`);
        lastMove = Date.now();
      }
    } else {
      log('    视频消失（页面态: ' + (s.onCourse ? '课程页' : s.onPlayer ? '播放器页' : s.onTrain ? '训练页' : '?') + '）');
      break;
    }
  }
  await sleep(4000);
}
log('本次点了 ' + segs + ' 段');
process.exit(0);
