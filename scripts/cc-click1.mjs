/** cc-click1.mjs — 点一个按钮并观察 15 秒（截图+状态）
 *  node scripts/cc-click1.mjs --tab 1 --text "进入"
 */
import { Tab, listCcTabs, pageState, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 0), TEXT = String(A.text || '进入');
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[TAB] || tabs[0], PORT);
await tab.connect();
const before = await pageState(tab);
log('click 前: ' + (before ? ['onTrain', 'onCourse', 'onPlayer', 'onMyTraining'].filter(k => before[k]).join(',') || 'NONE' : 'null'));

const box = await tab.ev(`(function(){
  var el=Array.from(document.querySelectorAll('button,a,[role=button]')).find(function(e){
    return (e.offsetWidth||e.offsetHeight) && (e.innerText||'').trim()===${JSON.stringify(TEXT)}; });
  if(!el) return null; el.scrollIntoView({block:'center'}); var r=el.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), cls:String(el.className).slice(0,50)});
})()`);
log('按钮: ' + box);
if (box && box.__err !== 1) {
  const b = JSON.parse(box);
  await tab.clickAt(b.x, b.y);
  log('已发 CDP 鼠标点击 @' + b.x + ',' + b.y);
}
for (let i = 0; i < 5; i++) {
  await sleep(3000);
  const s = await pageState(tab);
  log(i + ': ' + (s ? ['onTrain', 'onCourse', 'onPlayer', 'onMyTraining'].filter(k => s[k]).join(',') || 'NONE' : 'null') + ' | ' + (s ? s.tail.slice(0, 60) : ''));
  await tab.shot('runs/shots/click-' + i + '.png');
}
const html = await tab.ev(`(function(){
  var el=Array.from(document.querySelectorAll('button,a,[role=button]')).find(function(e){return (e.textContent||'').trim()===${JSON.stringify(TEXT)};});
  if(!el) return 'gone';
  var out=[], p=el;
  for(var i=0;i<4&&p;i++){ out.push(p.tagName+' cls='+String(p.className).slice(0,40)+' attrs='+Array.from(p.attributes||[]).map(function(a){return a.name+'='+String(a.value).slice(0,30)}).join(',')); p=p.parentElement; }
  return out.join(' || ');
})()`);
log('元素链: ' + html);
process.exit(0);
