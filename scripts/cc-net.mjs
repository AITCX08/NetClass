/** cc-net.mjs — 播放一段短视频，抓接口（进度上报/完播），验证完播是否入库
 *  node scripts/cc-net.mjs --tab 1 --secs 200
 */
import { Tab, listCcTabs, pageState, ensureTraining, expand, enumerate, openCourse, backToTraining, sleep } from './cc-lib.mjs';
import { writeFileSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 1), SECS = Number(A.secs || 200);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[TAB] || tabs[0], PORT);
await tab.connect();
log('tab=' + tab.targetId.slice(0, 6));

const hook = await (await import('node:fs')).readFileSync('runs/cc-nethook.js', 'utf8');
await tab.ev(hook);
log('网络钩子已装');

if (!await ensureTraining(tab, log)) { log('不在培训页'); process.exit(1); }
await expand(tab, null, log);
const courses = await enumerate(tab, null);
log('课程 ' + courses.length + ' 门，未完成 ' + courses.filter(c => c.undone).length);
const target = courses.filter(c => c.undone).sort((a, b) => a.name.length - b.name.length)[0];
if (!target) { log('没有未完成课程'); process.exit(0); }
log('挑最短名字的未完成课: ' + target.name);

if (!await openCourse(tab, target.name, log)) process.exit(1);
await sleep(3000);

const s = await pageState(tab);
log('课程页: 待播段=' + (s.playable || []).length);
if (s.playable && s.playable.length) {
  const p = s.playable[0];
  log('段: ' + JSON.stringify(p).slice(0, 120));
  await tab.clickAt(p.x, p.y);
}
// 观察
const t0 = Date.now();
let last = null;
while ((Date.now() - t0) / 1000 < SECS) {
  await sleep(15000);
  const st = await pageState(tab);
  if (st && st.video) {
    if (!last) last = { cur: st.video.cur, at: Date.now() };
    const wall = (Date.now() - last.at) / 1000;
    log(`V ${st.video.cur}/${st.video.dur} @${st.video.rate}${st.video.paused ? ' P' : ' R'}  实速=${Math.round((st.video.cur - last.cur) / wall * 100) / 100}  pct=${st.pct || '-'}`);
  } else log('无视频 | ' + JSON.stringify({ onCourse: st && st.onCourse, onPlayer: st && st.onPlayer, tail: st && st.tail.slice(0, 40) }));
}
// 网络记录
const nets = await tab.ev(`JSON.stringify((window.__ccNet||[]).map(function(x){return (x.m+' '+x.u+' | '+x.b).slice(0,190)}))`);
try { writeFileSync('runs/logs/cc-net-' + tab.targetId.slice(0, 6) + '.json', nets || '[]'); } catch (_) { }
const arr = nets ? JSON.parse(nets) : [];
const interesting = arr.filter(u => /progress|study|record|play|video|log|heart|report|finish|complete|course/i.test(u));
log('总请求 ' + arr.length + '，相关 ' + interesting.length);
interesting.slice(-40).forEach(u => log('  ' + u));
process.exit(0);
