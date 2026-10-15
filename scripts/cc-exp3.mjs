/**
 * cc-exp3.mjs — 修展开：滚动到 summary、按中心点击、点击后校验 expanded 并重试
 *   node scripts/cc-exp3.mjs --port 9228
 */
import { Tab, listCcTabs, ensureTraining, enumerate, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' '));

const tabs = await listCcTabs(PORT);
const tab = new Tab(tabs[0], PORT);
await tab.connect();
if (!await ensureTraining(tab, log)) { log('不在培训页'); process.exit(1); }
await sleep(3000);

const state = () => tab.ev(`JSON.stringify(Array.from(document.querySelectorAll('.MuiAccordion-root')).map(function(a){var h=a.querySelector('h3');return (h?(h.innerText||'').replace(/\\s+/g,' ').slice(0,14):'?')+(a.className.indexOf('Mui-expanded')>=0?'[开]':'[关]')}))`);
log('初始: ' + await state());

for (const nm of ['小初高公需', '专业课-初中数学']) {
  let ok = false;
  for (let k = 0; k < 6 && !ok; k++) {
    const info = await tab.ev(`(function(){
      var accs = Array.from(document.querySelectorAll('.MuiAccordion-root'));
      var a = accs.find(function(x){ var h=x.querySelector('h3'); return h && (h.innerText||'').indexOf(${JSON.stringify(nm)})>=0; });
      if (!a) return 'noacc';
      if (a.className.indexOf('Mui-expanded') >= 0) return 'open';
      var s = a.querySelector('.MuiAccordionSummary-root');
      s.scrollIntoView({block:'center'});
      var q = s.getBoundingClientRect();
      var vh = window.innerHeight;
      if (q.top < 80 || q.bottom > vh - 80) window.scrollBy(0, Math.round(q.top - vh/2));
      var r = s.getBoundingClientRect();
      // 点右侧文字区（避开 expandIcon svg —— MUI 会忽略 svg 上的点击）
      return JSON.stringify({
        x: Math.round(r.left + Math.min(r.width - 60, r.width * 0.55)),
        y: Math.round(r.top + r.height / 2),
        top: Math.round(r.top), h: Math.round(r.height), vh: vh
      });
    })()`);
    if (info === 'open') { ok = true; log('  「' + nm + '」已经是展开的'); break; }
    if (info === 'noacc' || !info) { log('  找不到「' + nm + '」'); break; }
    const b = JSON.parse(info);
    if (b.top < 0 || b.top > b.vh) { log('  滚动后位置仍异常 ' + b.top + '/' + b.vh + ' 重试'); await sleep(1200); continue; }
    await tab.clickAt(b.x, b.y);
    await sleep(1800);
    const chk = await tab.ev(`(function(){
      var accs = Array.from(document.querySelectorAll('.MuiAccordion-root'));
      var a = accs.find(function(x){ var h=x.querySelector('h3'); return h && (h.innerText||'').indexOf(${JSON.stringify(nm)})>=0; });
      return a && a.className.indexOf('Mui-expanded')>=0 ? 'open':'closed';
    })()`);
    log('  第' + (k + 1) + '次点 (' + b.x + ',' + b.y + ') → ' + chk);
    if (chk === 'open') ok = true;
  }
  if (!ok) log('  ⚠ 「' + nm + '」展开失败');
}
log('展开后: ' + await state());
const cs = await enumerate(tab, null);
log('枚举: ' + cs.length + ' 门 / 未完成 ' + cs.filter(c => c.undone).length);
log('分类分布: ' + JSON.stringify([0, 1, 2].map(i => cs.filter(c => c.cat === i).length)));
process.exit(0);
