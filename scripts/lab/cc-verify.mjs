/**
 * cc-verify.mjs — 回课程列表/培训页核对记账：段是否"已完成"、课程是否"已学习"、学时是否涨
 *   node scripts/cc-verify.mjs --port 9228
 * 注意：会短暂离开播放器页（会打断当前播放），只在需要核对时手动跑。
 */
import { Tab, listCcTabs, pageState, ensureTraining, expand, enumerate, sleep, backToTraining } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();
let s = await pageState(tab);
log('当前页态: ' + (s.onPlayer ? '播放器' : s.onCourse ? '课程详情' : s.onTrain ? '培训页' : s.onMyTraining ? '我的培训' : '其它'));

await tab.clickText('返回课程列表');
await sleep(7000);
const seg = await tab.ev(`JSON.stringify(Array.from(document.querySelectorAll('li, .MuiListItem-root, .MuiListItemButton-root')).map(function(e){
  var t=(e.innerText||'').replace(/\\s+/g,' ').trim();
  if(!t || /编码[:：]/.test(t)) return null;
  var b=Array.from(e.querySelectorAll('button')).map(function(x){return (x.innerText||'').trim()}).filter(Boolean);
  return {txt:t.slice(0,54), btns:b};
}).filter(Boolean))`);
log('课程页段列表:');
try { JSON.parse(seg || '[]').forEach(r => log('    ' + r.txt + '   [' + r.btns.join('/') + ']')); } catch (_) { log('    ' + seg); }

const courseTitle = await tab.ev(`(function(){var t=(document.body.innerText||'').replace(/\\s+/g,' ');var m=t.match(/返回培训内容列表\\s*([^]{2,60}?)\\s*C\\d/);return m?m[1]:null})()`);
log('课程名: ' + courseTitle);

await backToTraining(tab, log);
await expand(tab, null, log);
const cs = await enumerate(tab, null);
log('培训页枚举 ' + cs.length + ' 门，未完成 ' + cs.filter(c => c.undone).length);
if (courseTitle) {
  const hit = cs.find(c => c.name.indexOf(String(courseTitle).slice(0, 12)) >= 0);
  log('本课在列表里: ' + (hit ? (hit.undone ? '仍未完成 ⚠' : '已完成 ✓') : '找不到'));
}
const prog = await tab.ev(`(function(){var t=(document.body.innerText||'');var m=t.match(/已修[^。]{0,28}/);return m?m[0]:null})()`);
log('页面进度: ' + prog);
const cats = await tab.ev(`JSON.stringify(Array.from(document.querySelectorAll('h3.MuiAccordion-heading')).map(function(h){return (h.innerText||'').replace(/\\s+/g,' ').slice(0,46)}))`);
try { JSON.parse(cats || '[]').forEach(c => log('    分类: ' + c)); } catch (_) { }
process.exit(0);
