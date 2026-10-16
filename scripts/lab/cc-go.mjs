/**
 * cc-go.mjs — 可靠地回到培训页：优先点击，点不到就整页导航重进
 *   node scripts/cc-go.mjs --port 9228
 */
import { Tab, listCcTabs, pageState, ensureTraining, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));
const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();

let s = await pageState(tab);
log('当前: ' + JSON.stringify({ train: s.onTrain, course: s.onCourse, player: s.onPlayer, my: s.onMyTraining }));

if (!s.onTrain) {
  // 先试点击（含「我的培训」→「进入」）
  await ensureTraining(tab, log);
  s = await pageState(tab);
}
if (!s.onTrain) {
  log('点击路径失败 → 整页导航到首页重进');
  await tab.navigate('https://col.ccjyxy.cn');
  await sleep(12000);
  s = await pageState(tab);
  log('  重载后: ' + JSON.stringify({ my: s && s.onMyTraining, train: s && s.onTrain }));
  if (s && s.onMyTraining) {
    // 用真实鼠标点
    const clicked = await tab.clickText('进入');
    log('  点「进入」: ' + clicked);
    await sleep(6000);
    s = await pageState(tab);
  }
  if (!(s && s.onTrain)) {
    log('  仍未到培训页 → 直接再导航一次 + 点「我的培训」');
    await tab.clickText('我的培训');
    await sleep(4000);
    await tab.clickText('进入');
    await sleep(8000);
    s = await pageState(tab);
  }
}
log('结果: ' + (s && s.onTrain ? '✔ 已在培训页' : '✗ 还是没到（现在: ' + JSON.stringify({ my: s && s.onMyTraining, course: s && s.onCourse }) + '）'));
if (s && s.onTrain) {
  const prog = await tab.ev(`(function(){var t=(document.body.innerText||'');var m=t.match(/已修[^。]{0,30}/);return m?m[0]:null})()`);
  log('学时: ' + prog);
}
process.exit(0);
