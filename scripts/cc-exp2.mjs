/**
 * cc-exp2.mjs — 决定性实验：跳到视频尾部 → 播完 → 回课程列表 → 看学时是否入账
 *   node scripts/cc-exp2.mjs --port 9228 [--pre 40]
 * 结论要回答：平台记账是按"真实观看秒数"还是按"完播标记"
 */
import { Tab, listCcTabs, pageState, expand, enumerate, sleep, backToTraining, killUserscript } from './cc-lib.mjs';
import { readFileSync } from 'node:fs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), PRE = Number(A.pre || 40);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();

// 装网络钩子（记录 progress/report 请求）
try { await tab.ev(readFileSync('runs/cc-hook2.js', 'utf8')); log('网络钩子已装'); } catch (e) { log('钩子失败 ' + e.message); }

let s = await pageState(tab);
log('起始页态: ' + (s.onPlayer ? '播放器' : s.onCourse ? '课程页' : s.onTrain ? '培训页' : '?'));

const READ = `(function(){var v=document.querySelector('video');var t=(document.body.innerText||'').replace(/\\s+/g,' ');return JSON.stringify(v?{cur:Math.round(v.currentTime*10)/10,dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused,ended:v.ended,pct:(t.match(/(\\d{1,3})%/)||[])[1]||null}:null)})()`;

let v = JSON.parse(await tab.ev(READ) || 'null');
if (!v) { log('当前没在播放，先把当前课程的第一段点起来'); const box = await tab.ev(`(function(){
  var items = Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root')).filter(function(e){return /播放|继续/.test(e.innerText||'')&&!/编码/.test(e.innerText||'')});
  for (var i=0;i<items.length;i++){var b=Array.from(items[i].querySelectorAll('button')).find(function(x){return /^(播放|继续)$/.test((x.innerText||'').trim())});if(b){b.click();return 'clicked'}}
  return 'none';})()`);
  log('  点段: ' + box);
  await sleep(15000); v = JSON.parse(await tab.ev(READ) || 'null');
}
if (!v) { log('没有视频，退出'); process.exit(1); }
log('视频: ' + v.cur + '/' + v.dur + ' @' + v.rate + ' pct=' + v.pct);

// 跳到距结尾 PRE 秒处
const target = Math.max(0, v.dur - PRE);
log('跳到 ' + target + '（距结尾 ' + PRE + 's）');
await tab.ev(`(function(){var v=document.querySelector('video');if(v){v.currentTime=${target};return 1}return 0})()`);
await sleep(5000);
v = JSON.parse(await tab.ev(READ) || 'null');
log('跳后: ' + (v ? v.cur + '/' + v.dur + ' pct=' + v.pct : 'null'));

// 等它播完（最多等 PRE/1x + 60 秒）
const deadline = Date.now() + (PRE * 2 + 90) * 1000;
while (Date.now() < deadline) {
  await sleep(6000);
  const x = JSON.parse(await tab.ev(READ) || 'null');
  if (!x) { log('  视频消失（可能自动续播）'); break; }
  log('  ' + x.cur + '/' + x.dur + ' @' + x.rate + (x.ended ? ' ended' : '') + ' pct=' + x.pct);
  if (x.cur >= x.dur - 2 || x.ended) { log('  → 到尾部'); break; }
}
await sleep(6000);
const title = await tab.ev(`(function(){var t=(document.body.innerText||'').replace(/\\s+/g,' ');return JSON.stringify({mark:(t.match(/视频已看完|已观看完成/g)||[]).slice(0,3),head:t.slice(0,70)})})()`);
log('完成标记: ' + title);

// 抓网络里的进度上报
const net = await tab.ev(`JSON.stringify((window.__ccNet2||[]).filter(function(r){return /progress|report|media\\/play|study|record/i.test(r.u)}).slice(-14))`);
try { JSON.parse(net || '[]').forEach(r => log('   NET ' + r.m + ' ' + r.s + ' ' + r.u.slice(0, 90) + (r.req ? '  req=' + r.req.slice(0, 100) : '') + (r.res ? '  res=' + r.res.slice(0, 80) : ''))); } catch (_) { }

// 回培训页核对
log('--- 回培训页核对 ---');
await tab.clickText('返回课程列表'); await sleep(6000);
const segs = await tab.ev(`JSON.stringify(Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root')).map(function(e){var t=(e.innerText||'').replace(/\\s+/g,' ').trim();return /编码/.test(t)?null:t.slice(0,52)}).filter(Boolean))`);
log('课程页段: ' + segs);
await backToTraining(tab, log);
await expand(tab, null, log);
const cs = await enumerate(tab, null);
const prog = await tab.ev(`(function(){var t=(document.body.innerText||'');var m=t.match(/已修[^。]{0,28}/);return m?m[0]:null})()`);
const cats = await tab.ev(`JSON.stringify(Array.from(document.querySelectorAll('h3.MuiAccordion-heading')).map(function(h){return (h.innerText||'').replace(/\\s+/g,' ').slice(0,50)}))`);
log('培训页: 枚举 ' + cs.length + ' 门 / 未完成 ' + cs.filter(c => c.undone).length + ' / 进度:' + prog);
try { JSON.parse(cats || '[]').forEach(c => log('    ' + c)); } catch (_) { }
process.exit(0);
