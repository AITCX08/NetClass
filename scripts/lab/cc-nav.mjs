/** cc-nav.mjs — 逐步跟踪：打印状态 + 截图 + 点击，找导航卡点
 *  node scripts/cc-nav.mjs --tab 0 --steps 8
 */
import { Tab, listCcTabs, pageState, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 0), STEPS = Number(A.steps || 8);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[TAB] || tabs[0], PORT);
await tab.connect();
log('tab=' + tab.targetId.slice(0, 6));

for (let i = 1; i <= STEPS; i++) {
  const s = await pageState(tab);
  if (!s) { log(i + ': pageState=null'); await sleep(4000); continue; }
  const flags = ['onTrain', 'onCourse', 'onPlayer', 'onMyTraining'].filter(k => s[k]).join(',') || 'NONE';
  log(i + ': [' + flags + '] segs=' + s.nSegs + ' items=' + s.nItems + ' video=' + JSON.stringify(s.video) + ' | ' + s.tail.slice(0, 50));
  await tab.shot('runs/shots/nav-' + i + '-' + tab.targetId.slice(0, 4) + '.png');
  // 依次尝试：课程页→返回培训内容列表；播放器页→返回课程列表；我的培训页→进入；训练页→点第一个「播放/继续」
  let acted = '';
  if (s.onCourse) { acted = '返回培训内容列表: ' + (await tab.clickText('返回培训内容列表')); }
  else if (s.onPlayer) { acted = '返回课程列表: ' + (await tab.clickText('返回课程列表')); }
  else if (s.onMyTraining) { acted = '进入: ' + (await tab.clickText('进入')); }
  else if (s.onTrain && s.playable && s.playable.length) {
    const p = s.playable[0];
    await tab.clickAt(p.x, p.y); acted = '点播放(' + p.label + ')';
  } else acted = '无动作';
  log('   → ' + acted);
  await sleep(6000);
}
process.exit(0);
