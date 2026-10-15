/**
 * cc-seek.mjs — 测试"往前跳"是否被平台接受（能省下大量时间的关键实验）
 *   node scripts/cc-seek.mjs --port 9228 --to 2690 --secs 90
 * 只动一次 currentTime，然后观察：是否被打回、进度百分比/学时是否照记。
 */
import { Tab, listCcTabs, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const TO = Number(A.to || 0);
const SECS = Number(A.secs || 90);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();

const READ = `(function(){ var v=document.querySelector('video'); var t=(document.body.innerText||'').replace(/\\s+/g,' '); var m=t.match(/(\\d{1,3})\\s*%/); return JSON.stringify(v?{cur:Math.round(v.currentTime*10)/10,dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused,pct:m?m[1]:null,seg:(t.match(/(\\d-\\d)\\s/)||[])[1]||null}:null) })()`;

const s0 = JSON.parse(await tab.ev(READ) || 'null');
if (!s0) { log('没视频'); process.exit(0); }
log('跳前: ' + s0.cur + '/' + s0.dur + ' @' + s0.rate + ' pct=' + s0.pct);

const target = TO > 0 ? TO : Math.max(0, s0.dur - 40);
log('把 currentTime 设到 ' + target);
const r = await tab.ev(`(function(){ var v=document.querySelector('video'); if(!v) return 'novideo'; v.currentTime = ${target}; return 'set:' + Math.round(v.currentTime); })()`);
log('结果: ' + r);
await sleep(4000);

const t0 = Date.now();
for (let i = 0; i <= SECS / 10; i++) {
  const s = JSON.parse(await tab.ev(READ) || 'null');
  if (!s) { log('视频消失'); break; }
  const wall = Math.round((Date.now() - t0) / 1000);
  log('  +' + wall + 's  ' + s.cur + '/' + s.dur + ' @' + s.rate + (s.paused ? ' 暂停' : ' 播') + '  pct=' + s.pct + ' seg=' + s.seg);
  if (s.cur >= s.dur - 2) { log('  → 已到尾部'); }
  await sleep(10000);
}
process.exit(0);
