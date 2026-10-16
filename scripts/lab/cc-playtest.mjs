/** cc-playtest.mjs — 试三种点击方式让段起播
 *  node scripts/cc-playtest.mjs --tab 1
 */
import { Tab, listCcTabs, pageState, ensureTraining, expand, enumerate, openCourse, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 1);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[TAB] || tabs[0], PORT);
await tab.connect();
log('tab=' + tab.targetId.slice(0, 6));
if (!await ensureTraining(tab, log)) process.exit(1);
await expand(tab, null, log);
const cs = await enumerate(tab, null);
const target = cs.filter(c => c.undone)[0];
log('目标: ' + target.name.slice(0, 34));
if (!await openCourse(tab, target.name, log)) process.exit(1);
await sleep(9000);

let s = await pageState(tab);
log('可播段=' + (s.playable || []).length);

// 方式 1：DOM .click()
log('--- 方式1: DOM .click() ---');
await tab.ev(`(function(){
  var e=Array.from(document.querySelectorAll('.MuiListItem-root')).filter(function(x){return /播放|继续/.test(x.innerText||'')})[0];
  var b=e?Array.from(e.querySelectorAll('button')).find(function(x){return /^(播放|继续)$/.test((x.innerText||'').trim())}):null;
  if(b){b.click();return 'clicked'} return 'nobtn';
})()`);
for (let i = 0; i < 6; i++) { await sleep(3000); s = await pageState(tab); log('  +' + ((i + 1) * 3) + 's video=' + (s.video ? s.video.cur + '/' + s.video.dur : 'null') + ' 态=' + ['onCourse', 'onPlayer'].filter(k => s[k]).join(',')); if (s.video && s.video.dur) { log('✔ 方式1 成功'); process.exit(0); } }

// 方式 2：点条目行本身（左侧文字）
log('--- 方式2: 点条目行 ---');
const box2 = await tab.ev(`(function(){
  var e=Array.from(document.querySelectorAll('.MuiListItem-root')).filter(function(x){return /播放|继续/.test(x.innerText||'')})[0];
  if(!e) return 'noitem'; e.scrollIntoView({block:'center'}); var r=e.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.left+30),y:Math.round(r.top+r.height/2)});
})()`);
if (box2 && box2 !== 'noitem') { const b = JSON.parse(box2); await tab.clickAt(b.x, b.y); log('  点了 ' + JSON.stringify(b)); }
for (let i = 0; i < 6; i++) { await sleep(3000); s = await pageState(tab); log('  +' + ((i + 1) * 3) + 's video=' + (s.video ? s.video.cur + '/' + s.video.dur : 'null')); if (s.video && s.video.dur) { log('✔ 方式2 成功'); process.exit(0); } }

// 方式 3：点按钮中心的真实鼠标
log('--- 方式3: 真实鼠标点按钮中心 ---');
s = await pageState(tab);
if (s.playable && s.playable.length) { const p = s.playable[0]; await tab.clickAt(p.x, p.y); log('  点了 (' + p.x + ',' + p.y + ')'); }
for (let i = 0; i < 8; i++) { await sleep(3000); s = await pageState(tab); log('  +' + ((i + 1) * 3) + 's video=' + (s.video ? s.video.cur + '/' + s.video.dur : 'null') + ' | ' + s.tail.slice(0, 40)); if (s.video && s.video.dur) { log('✔ 方式3 成功'); process.exit(0); } }
log('✗ 三种方式都没起播');
await tab.shot('runs/shots/playtest-fail.png');
process.exit(0);
