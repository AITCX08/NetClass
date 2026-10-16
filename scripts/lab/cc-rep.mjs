/**
 * cc-rep.mjs — 起播一段，抓 video-progress/report 的完整响应，看"完播"是怎么判定的
 *   node scripts/cc-rep.mjs --port 9228 --secs 90
 */
import { Tab, listCcTabs, pageState, playFirstSegment, sleep, killUserscript, pageState as ps } from './cc-lib.mjs';
import { readFileSync } from 'node:fs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), SECS = Number(A.secs || 90);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();
await killUserscript(tab);
await tab.ev(readFileSync('runs/cc-hook3.js', 'utf8'));
log('钩子已装');

let s = await ps(tab);
if (s.onCourse) {
  const v0 = await playFirstSegment(tab, log);
  log('起播: ' + JSON.stringify(v0));
}
const t0 = Date.now();
while (Date.now() - t0 < SECS * 1000) {
  await sleep(8000);
  const st = await ps(tab);
  const reps = await tab.ev(`JSON.stringify((window.__ccRep||[]).slice(-3))`);
  let arr = []; try { arr = JSON.parse(reps || '[]'); } catch (_) { }
  log((st && st.video ? (Math.round(st.video.cur) + '/' + Math.round(st.video.dur) + '@' + st.video.rate + ' pct=' + st.pct) : '无视频') + '  上报数=' + (arr.length));
  arr.forEach(r => log('    RES ' + JSON.stringify(r.res).slice(0, 420)));
}
process.exit(0);
