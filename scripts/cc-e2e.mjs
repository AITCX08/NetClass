/** cc-e2e.mjs — 端到端：一门课从 T→C→P→播完→回 T 全流程，带每步截图
 *  node scripts/cc-e2e.mjs --tab 1 --course "<名字片段>" --maxSegs 2
 */
import { Tab, listCcTabs, pageState, ensureTraining, expand, enumerate, openCourse, backToTraining, sleep } from './cc-lib.mjs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 1);
const WANT = A.course ? String(A.course) : null;
const MAXSEG = Number(A.maxSegs || 2);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));
const flag = s => ['T', 'C', 'P', 'M'].filter((k, i) => s && s[['onTrain', 'onCourse', 'onPlayer', 'onMyTraining'][i]]).join(',') || 'NONE';

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[TAB] || tabs[0], PORT);
await tab.connect();
log('tab=' + tab.targetId.slice(0, 6));

log('--- 1) 进培训页 ---');
let s = await pageState(tab);
log('  当前: ' + flag(s) + ' | ' + (s.tail || ''));
if (!await ensureTraining(tab, log)) { log('✗ 进不了培训页'); process.exit(1); }
await tab.shot('runs/shots/e2e-1-training.png');

log('--- 2) 展开 + 枚举 ---');
await expand(tab, null, log);
const courses = await enumerate(tab, null);
const per = [0, 1, 2].map(i => courses.filter(c => c.cat === i).length);
log('  枚举 ' + courses.length + ' 门  分类分布=' + JSON.stringify(per) + '  未完成=' + courses.filter(c => c.undone).length);
if (!courses.length) { log('✗ 枚举 0 门'); process.exit(1); }
const target = WANT ? (courses.find(c => c.name.indexOf(WANT) >= 0) || courses.filter(c => c.undone)[0]) : courses.filter(c => c.undone)[0];
log('  目标: ' + target.name + ' cat=' + target.cat);

log('--- 3) 进课程 ---');
if (!await openCourse(tab, target.name, log)) { log('✗ 进课失败'); process.exit(1); }
await sleep(3000);
s = await pageState(tab);
log('  课程页状态: ' + flag(s) + ' 待播段=' + (s.playable || []).length + ' 段条目=' + (s.playable || []).map(p => p.label + ':' + p.seg.slice(0, 22)).join(' / '));
await tab.shot('runs/shots/e2e-2-course.png');

log('--- 4) 播段 ---');
for (let i = 1; i <= MAXSEG; i++) {
  s = await pageState(tab);
  if (!s || !s.onCourse) { log('  不在课程页(' + flag(s) + ')'); break; }
  const list = (s.playable || []);
  if (!list.length) { log('  没有可播段 → 停'); break; }
  const p = list[0];
  await tab.clickAt(p.x, p.y);
  log('  段' + i + ': 点[' + p.label + '] ' + p.seg.slice(0, 26));
  let v0 = null;
  for (let w = 0; w < 20; w++) {
    await sleep(2000);
    const st = await pageState(tab);
    if (st && st.video && st.video.dur) { v0 = st.video; break; }
  }
  if (!v0) { log('  段' + i + ': 未起播，页面=' + flag(await pageState(tab))); await tab.shot('runs/shots/e2e-4-nostart.png'); break; }
  log('  段' + i + ' 起播 ' + v0.cur + '/' + v0.dur + ' @' + v0.rate + 'x 率=' + (await pageState(tab)).nc?.rate);
  await tab.shot('runs/shots/e2e-3-playing.png');
  const t0 = Date.now();
  let last = v0.cur, lastMove = Date.now();
  for (let g = 0; g < 900; g++) {
    await sleep(5000);
    const st = await pageState(tab);
    if (!st) continue;
    if (!st.video) { log('  段' + i + ': 播放器消失（页面=' + flag(st) + '）'); break; }
    if (st.video.dur && st.video.cur >= st.video.dur - 1.5) {
      log('  ✔ 段' + i + ' 播完 ' + st.video.cur + '/' + st.video.dur + ' 墙钟=' + Math.round((Date.now() - t0) / 1000) + 's 实速=' + (Math.round((st.video.cur - v0.cur) / ((Date.now() - t0) / 1000) * 100) / 100));
      break;
    }
    if (Math.abs(st.video.cur - last) > 0.4) { last = st.video.cur; lastMove = Date.now(); }
    if (g % 6 === 0) log('    …' + st.video.cur + '/' + st.video.dur + ' @' + st.video.rate + 'x ' + (st.video.paused ? 'P' : 'R') + ' pct=' + (st.pct || '-'));
    if (st.video.paused && Date.now() - lastMove > 12000) {
      await tab.ev(`(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play()}catch(e){}}})()`);
      log('    → 恢复播放');
      lastMove = Date.now();
    }
    if (Date.now() - lastMove > 50000) { log('    停滞过久，放弃本段'); break; }
  }
  await sleep(4000);
}
s = await pageState(tab);
log('--- 5) 播后状态: ' + flag(s) + ' 剩待播段=' + (s.playable || []).length + ' | ' + (s.tail || '').slice(0, 80));
await tab.shot('runs/shots/e2e-5-after.png');

log('--- 6) 回培训页核对 ---');
await backToTraining(tab, log);
s = await pageState(tab);
log('  到培训页: ' + (s && s.onTrain));
await expand(tab, null, log);
const after = await enumerate(tab, null);
const t2 = after.find(x => x.name === target.name);
log('  该课状态: ' + (t2 ? (t2.undone ? '仍未完成 ⚠' : '已完成 ✓') : '枚举不到'));
const prog = await tab.ev(`(function(){var t=(document.body.innerText||'');var m=t.match(/已修[^·]{0,20}·\\s*完成\\s*\\d+\\s*门/);return m?m[0]:null})()`);
log('  页面进度: ' + prog);
await tab.shot('runs/shots/e2e-6-final.png');
process.exit(0);
