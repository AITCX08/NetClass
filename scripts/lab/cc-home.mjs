/**
 * cc-home.mjs — 把当前标签导航到培训页，并核对学时（不点播放，安全）
 *   node scripts/cc-home.mjs --port 9228
 */
import { Tab, listCcTabs, ensureTraining, expand, enumerate, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();
const ok = await ensureTraining(tab, log);
log('到达培训页: ' + ok);
if (!ok) process.exit(1);

// 等渲染
for (let i = 0; i < 10; i++) {
  const n = await tab.ev(`document.querySelectorAll('.MuiAccordion-root').length`);
  if (n >= 3) { log('分类容器: ' + n); break; }
  await sleep(2000);
}
const cats0 = await tab.ev(`JSON.stringify(Array.from(document.querySelectorAll('.MuiAccordion-root')).map(function(a){var h=a.querySelector('h3');return {t:h?(h.innerText||'').replace(/\\s+/g,' ').slice(0,26):'?',exp:a.className.indexOf('Mui-expanded')>=0}}))`);
log('展开前分类: ' + cats0);

// 逐个展开（点 Summary 左侧）
await expand(tab, null, log);
await sleep(3000);
const cats1 = await tab.ev(`JSON.stringify(Array.from(document.querySelectorAll('.MuiAccordion-root')).map(function(a){var h=a.querySelector('h3');return {t:h?(h.innerText||'').replace(/\\s+/g,' ').slice(0,26):'?',exp:a.className.indexOf('Mui-expanded')>=0}}))`);
log('展开后分类: ' + cats1);

const prog = await tab.ev(`(function(){var t=(document.body.innerText||'');var m=t.match(/已修[^。]{0,30}/);return m?m[0]:null})()`);
log('进度: ' + prog);
const cs = await enumerate(tab, null);
log('枚举课程: ' + cs.length + ' 门 / 未完成 ' + cs.filter(c => c.undone).length);
const per = [0, 1, 2].map(i => cs.filter(c => c.cat === i).length);
log('分类分布: ' + JSON.stringify(per));
const doneOnes = cs.filter(c => !c.undone).map(c => c.name.slice(0, 24));
if (doneOnes.length) log('已完成的课: ' + JSON.stringify(doneOnes.slice(0, 8)));
process.exit(0);
