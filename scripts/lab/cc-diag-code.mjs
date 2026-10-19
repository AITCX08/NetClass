/**
 * cc-diag-code.mjs — 按「课程编码」精确进课（验证 openCourse 的 16 字前缀撞车问题）
 *   node runs\cc-diag-code.mjs --port 9228 --target <id> --code C2601759 --cat 2
 */
import { Tab, listTabs, sleep, pageState, expand, enumerate, backToTraining } from '../scripts/cc-lib.mjs';

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
const CODE = String(A.code || '');
const CAT = A.cat === undefined ? 2 : Number(A.cat);
const WATCH = Number(A.watch || 30);

const hhmmss = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log('[' + hhmmss() + '] ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));

const DUMP = `(function(){
  var b=(document.body&&document.body.innerText)||'';
  var t=b.replace(/\\s+/g,' ');
  var li=Array.from(document.querySelectorAll('.MuiListItem-root,.MuiListItemButton-root'));
  var segs=li.map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60)}).filter(function(s){return s && !/编码[:：]/.test(s)});
  var bt=Array.from(new Set(Array.from(document.querySelectorAll('button')).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim()}).filter(Boolean)));
  return JSON.stringify({
    v:document.querySelectorAll('video').length,
    segs:segs.slice(0,20),
    play:bt.filter(function(x){return /播放|继续|重看|重播/.test(x)}),
    onCourse:/返回培训内容列表/.test(t),
    onTrain:/已修\\s*[\\d.]+\\s*\\/\\s*达标/.test(t),
    head:t.slice(0,300)
  });
})()`;

const cand = await listTabs(PORT);
let t = null;
if (SEL) t = cand.find(x => x.id === SEL) || cand.find(x => x.id.startsWith(SEL));
if (!t) t = cand[0];
const tab = new Tab(t, PORT);
await tab.connect();
log('tab=' + tab.targetId.slice(0, 8));

let s = await pageState(tab);
if (!s || !s.onTrain) { await backToTraining(tab, log); await sleep(3000); s = await pageState(tab); }
await expand(tab, CAT, log);

// 按编码精确找卡（编码唯一，不受同名前缀影响）
const box = await tab.ev(`(function(){
  var bs=Array.from(document.querySelectorAll('.MuiListItemButton-root'));
  var b=bs.find(function(e){return (e.innerText||'').indexOf(${JSON.stringify(CODE)})>=0});
  if(!b) return 'notfound'; b.scrollIntoView({block:'center'});
  var r=b.getBoundingClientRect(); if(r.width<1) return 'zero';
  return JSON.stringify({t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,90),x:Math.round(r.left+Math.min(48,r.width/2)),y:Math.round(r.top+r.height/2)});
})()`);
log('找卡结果: ' + box);
if (box && box.indexOf('{"t"') === 0) {
  const o = JSON.parse(box);
  log('卡片文字: ' + o.t);
  await tab.clickAt(o.x, o.y);
  for (let i = 0; i < WATCH / 2; i++) {
    await sleep(2000);
    log('  +' + (i + 1) * 2 + 's ' + await tab.ev(DUMP));
  }
} else {
  log('未找到该编码的卡片');
}
process.exit(0);
