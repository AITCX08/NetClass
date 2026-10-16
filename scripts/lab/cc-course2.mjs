/** cc-course2.mjs — 停在课程详情页，采样各列表项与文本，看段是怎么渲染的
 *  node scripts/cc-course2.mjs --tab 1 --secs 40
 */
import { Tab, listCcTabs, pageState, ensureTraining, expand, enumerate, openCourse, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 1), SECS = Number(A.secs || 40);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[TAB] || tabs[0], PORT);
await tab.connect();
log('tab=' + tab.targetId.slice(0, 6));

const DUMP = `(function(){
  var lis = Array.from(document.querySelectorAll('li, .MuiListItem-root, .MuiListItemButton-root'));
  var rows = lis.map(function(e,i){
    var t=(e.innerText||'').replace(/\\s+/g,' ').trim();
    var btns = Array.from(e.querySelectorAll('button')).map(function(b){return (b.innerText||'').trim()});
    return {i:i, cls:String(e.className).slice(0,36), t:t.slice(0,46), btns:btns};
  }).filter(function(r){ return r.t.length>0; });
  var txt = (document.body.innerText||'').replace(/\\s+/g,' ');
  var i = txt.indexOf('视频课程');
  return JSON.stringify({ n:rows.length, rows: rows.slice(0,14), afterVideo: txt.slice(i, i+220), hasPlayer: !!document.querySelector('video') });
})()`;

if (!await ensureTraining(tab, log)) { log('不在培训页'); process.exit(1); }
await expand(tab, null, log);
const cs = await enumerate(tab, null);
const target = cs.filter(c => c.undone)[0];
log('目标: ' + target.name.slice(0, 30));
if (!await openCourse(tab, target.name, log)) { log('进课失败'); process.exit(1); }

for (let i = 0; i <= SECS / 8; i++) {
  const s = await pageState(tab);
  const d = await tab.ev(DUMP);
  const o = d && !d.__err ? JSON.parse(d) : null;
  log((i * 8) + 's 状态=' + ['onCourse', 'onPlayer', 'onTrain'].filter(k => s && s[k]).join(',') + ' 可播=' + ((s && s.playable) || []).length + ' lis=' + (o ? o.n : '?'));
  if (o) {
    o.rows.slice(0, 6).forEach(r => log('    [' + r.cls.slice(0, 22) + '] ' + r.t + ' btns=' + JSON.stringify(r.btns)));
    log('    afterVideo: ' + o.afterVideo.slice(0, 120));
  }
  await sleep(8000);
}
process.exit(0);
