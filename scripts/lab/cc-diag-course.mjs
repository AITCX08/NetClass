/**
 * cc-diag-course.mjs — 一次性诊断：进一门「无待播段」的课，长时间观察页面到底有什么
 *
 * 用法：
 *   node runs\cc-diag-course.mjs --port 9228 --target <targetId或子串> --course "初中数学新课标解读：核心素养的主要表现——运算能力"
 *
 * 只读为主：只在需要时点击「课程卡」进课，不做任何播放/提交。
 */
import { Tab, listTabs, sleep, pageState, expand, enumerate, openCourse, backToTraining } from '../scripts/cc-lib.mjs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  A[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
}
const PORT = Number(A.port || 9228);
const SEL = A.target ? String(A.target) : null;
const COURSE = A.course ? String(A.course) : null;
const WATCH = Number(A.watch || 40);      // 观察秒数
const CAT = A.cat === undefined ? 2 : Number(A.cat);

const hhmmss = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log('[' + hhmmss() + '] ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));

const DUMP = `(function(){
  var b=(document.body&&document.body.innerText)||'';
  var t=b.replace(/\\s+/g,' ');
  var li=Array.from(document.querySelectorAll('.MuiListItem-root,.MuiListItemButton-root'));
  var btns=Array.from(document.querySelectorAll('button')).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim()}).filter(Boolean);
  var segs=li.map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60)}).filter(function(s){return s && !/编码[:：]/.test(s)});
  return JSON.stringify({
    at:new Date().toTimeString().slice(0,8),
    v:document.querySelectorAll('video').length,
    f:document.querySelectorAll('iframe').length,
    liAll:li.length,
    liBtn:document.querySelectorAll('.MuiListItemButton-root').length,
    segs:segs.slice(0,30),
    btns:Array.from(new Set(btns)).slice(0,26),
    onCourse:/返回培训内容列表/.test(t),
    onPlayer:/返回课程列表/.test(t),
    onTrain:/已修\\s*[\\d.]+\\s*\\/\\s*达标/.test(t),
    hasVideoTitle:/视频课程/.test(t),
    hasDoc:/文档课程|课件|作业|考试|测验/.test(t),
    load:/加载中|请稍候|loading/i.test(t),
    empty:/暂无|无数据|没有内容/.test(t),
    len:b.length,
    txt:t.slice(0,700)
  });
})()`;

const PERF = `(function(){
  try{
    var es=performance.getEntriesByType('resource').map(function(e){return e.name});
    var hit=es.filter(function(n){return /api|course|resource|section|video|study|play/i.test(n)});
    return JSON.stringify(hit.slice(-40));
  }catch(e){ return '[]' }
})()`;

async function findTab() {
  const cand = await listTabs(PORT);
  if (!cand || !cand.length) throw new Error('no ccjyxy tab');
  let t = null;
  if (SEL) t = cand.find(x => x.id === SEL) || cand.find(x => x.id.startsWith(SEL));
  if (!t) t = cand[0];
  const tab = new Tab(t, PORT);
  if (!await tab.connect()) throw new Error('connect fail');
  return tab;
}

const tab = await findTab();
log('连上 tab=' + tab.targetId.slice(0, 8));
let s = await pageState(tab);
log('起始页态 onTrain=' + (s && s.onTrain) + ' onCourse=' + (s && s.onCourse) + ' onPlayer=' + (s && s.onPlayer));

// 回到培训页
if (!s || !s.onTrain) {
  log('不在培训页 → 回退');
  await backToTraining(tab, log);
  await sleep(3000);
  s = await pageState(tab);
  log('回退后 onTrain=' + (s && s.onTrain));
}

await expand(tab, CAT, log);
const list = await enumerate(tab, CAT);
const undone = list.filter(c => c.undone);
log('分类' + CAT + ' 枚举 ' + list.length + ' 门 / 未完成 ' + undone.length + ' 门');
log('未完成清单：' + undone.map(c => c.name.slice(0, 30)).join(' | '));

const target = COURSE ? (list.find(c => c.name.indexOf(COURSE) >= 0) || { name: COURSE }) : undone[0];
if (!target) { log('没有目标课，退出'); process.exit(0); }
log('⇒ 进入：' + target.name);

const ok = await openCourse(tab, target.name, log, CAT);
log('openCourse = ' + ok);

// 长时间观察
const t0 = Date.now();
let lastPerf = null;
for (let i = 0; Date.now() - t0 < WATCH * 1000; i++) {
  await sleep(2000);
  const d = await tab.ev(DUMP);
  log('  +' + Math.round((Date.now() - t0) / 1000) + 's ' + d);
  if (i === 0 || i === 4 || i === 14) {
    const p = await tab.ev(PERF);
    if (p && p !== lastPerf) { log('  perf: ' + String(p).slice(0, 1200)); lastPerf = p; }
  }
  if (d && d.indexOf('"onPlayer":true') >= 0 && d.indexOf('"v":1') >= 0) { log('  ★ 出现 video！停止观察'); break; }
}

// 末尾：把进入课程后请求到的接口列出来，便于判断内容接口有没有返回空
const p2 = await tab.ev(PERF);
log('最终 perf: ' + String(p2).slice(0, 2000));
process.exit(0);
