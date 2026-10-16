/**
 * cc-rate.mjs — 探站点自己的「倍速」控件：列出可选档位、点一下看真实速率
 *   node scripts/cc-rate.mjs --port 9228 [--set 2]
 */
import { Tab, listCcTabs, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const RATE_BTN = `(function(){
  var b = Array.from(document.querySelectorAll('button,div,span')).find(function(e){
    return /^倍速/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight) && !e.closest('#netclass-panel');
  });
  if (!b) return 'nobtn';
  var r = b.getBoundingClientRect();
  return JSON.stringify({txt:(b.innerText||'').trim(), x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)});
})()`;
log('倍速控件: ' + await tab.ev(RATE_BTN));
// 点开
const b = JSON.parse(await tab.ev(RATE_BTN));
await tab.clickAt(b.x, b.y);
await sleep(2500);
const menu = await tab.ev(`(function(){
  var items = Array.from(document.querySelectorAll('li,div[role=menuitem],div[role=option],span,button')).filter(function(e){
    var t=(e.innerText||'').trim();
    return /^(\\d+(\\.\\d+)?x|\\d+(\\.\\d+)?倍|正常|自动)$/.test(t) && (e.offsetWidth||e.offsetHeight) && !e.closest('#netclass-panel');
  }).map(function(e){ var r=e.getBoundingClientRect(); return {t:(e.innerText||'').trim(), x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)} });
  return JSON.stringify(items.slice(0,12));
})()`);
log('菜单项: ' + menu);
const items = JSON.parse(menu || '[]');
const want = A.set ? String(A.set) : null;
const pick = want ? (items.find(i => i.t.indexOf(want) >= 0) || items[0]) : items[items.length - 1];
if (!pick) { log('没有可点的档位'); process.exit(0); }
log('点档位: ' + pick.t);
await tab.clickAt(pick.x, pick.y);
await sleep(3000);

const READ = `(function(){ var v=document.querySelector('video'); return JSON.stringify(v?{cur:Math.round(v.currentTime*10)/10,dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused,buf:v.buffered.length?Math.round(v.buffered.end(0)):0}:null) })()`;
const s0raw = await tab.ev(READ); const s0 = JSON.parse(s0raw || 'null');
if (!s0) { log('没视频'); process.exit(0); }
const t0 = Date.now();
log('起始 ' + s0.cur + '/' + s0.dur + ' @' + s0.rate);
for (let i = 0; i < 6; i++) {
  await sleep(10000);
  const s = JSON.parse(await tab.ev(READ) || 'null');
  if (!s) break;
  const wall = (Date.now() - t0) / 1000;
  log('  +' + Math.round(wall) + 's  ' + s.cur + '/' + s.dur + ' @' + s.rate + 'x  实速=' + (Math.round((s.cur - s0.cur) / wall * 100) / 100));
}
process.exit(0);
