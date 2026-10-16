/**
 * cc-speed.mjs — 实测当前播放的真实速率（视频秒 / 墙钟秒），并观察倍速是否被打回
 *   node scripts/cc-speed.mjs --port 9228 --secs 180 --every 15
 */
import { Tab, listCcTabs, sleep } from './cc-lib.mjs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), SECS = Number(A.secs || 180), EVERY = Number(A.every || 15);

const tabs = await listCcTabs(PORT);
if (!tabs || !tabs.length) { console.log('没有 ccjyxy 标签'); process.exit(1); }
const tab = new Tab(tabs[0], PORT);
await tab.connect();
const READ = `(function(){ var v=document.querySelector('video'); var t=(document.body.innerText||''); var m=t.match(/(\\d{1,3})\\s*%/); return JSON.stringify(v?{cur:v.currentTime,dur:v.duration,rate:v.playbackRate,paused:v.paused,pct:m?m[1]:null,tail:t.replace(/\\s+/g,' ').slice(0,34)}:null) })()`;

let first = null, last = null;
const t0 = Date.now();
for (let i = 0; i <= SECS / EVERY; i++) {
  const raw = await tab.ev(READ);
  let o = null; try { o = JSON.parse(raw); } catch (_) { }
  if (o) {
    const wall = (Date.now() - t0) / 1000;
    const adv = first ? (o.cur - first.cur) : 0;
    console.log(String(Math.round(wall)).padStart(3) + 's  ' + Math.round(o.cur) + '/' + Math.round(o.dur) + ' @' + o.rate + 'x' + (o.paused ? ' 暂停' : ' 播') + '  累计实速=' + (wall > 1 ? Math.round(adv / wall * 100) / 100 : '-') + '  pct=' + (o.pct || '-') + ' | ' + o.tail);
    if (!first) first = { cur: o.cur, at: Date.now(), rate: o.rate };
    last = { cur: o.cur, rate: o.rate };
  } else console.log(String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's  无视频（页态可能已变）');
  if (i < SECS / EVERY) await sleep(EVERY * 1000);
}
if (first && last) {
  const wall = (Date.now() - t0) / 1000;
  console.log('==> 总结: 墙钟 ' + Math.round(wall) + 's，视频推进 ' + Math.round(last.cur - first.cur) + 's，平均实速 ' + (Math.round((last.cur - first.cur) / wall * 100) / 100) + 'x（playbackRate 报告 ' + last.rate + '）');
}
process.exit(0);
