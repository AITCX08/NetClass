/**
 * cc-progress.mjs — 长春培训进度快照：把培训页的「已修 X / 达标 Y 学时 · 完成 Z 门」抓下来存盘
 *   node scripts/cc-progress.mjs --port 9228 [--watch 600 --every 300]
 * 输出：runs/cc-progress.jsonl（每行一条时间序列）
 */
import { listCcTabs, acquireTab, pageState, ensureTraining, expand, enumerate, sleep } from './cc-lib.mjs';
import { appendFileSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const WATCH = Number(A.watch || 0);        // 秒；>0 则循环
const EVERY = Number(A.every || 300);
const OUT = 'runs/cc-progress.jsonl';

const READ = `(function(){
  function txt(){ return (document.body.innerText||'').replace(/\\s+/g,' '); }
  function deep(sel, root, out){ root=root||document; out=out||[];
    try{ Array.prototype.slice.call(root.querySelectorAll(sel)).forEach(function(e){out.push(e)}); }catch(e){}
    var fs=[]; try{ fs=root.querySelectorAll('iframe'); }catch(e){}
    for(var i=0;i<fs.length;i++){ var d=null; try{d=fs[i].contentDocument}catch(e){} if(d) deep(sel,d,out); }
    return out; }
  var t = txt();
  if (/学习总进度/.test(t)) {
    var m = t.match(/已修\\s*(\\d+(?:\\.\\d+)?)\\s*\\/\\s*达标\\s*(\\d+)\\s*学时\\s*·\\s*完成\\s*(\\d+)\\s*门/);
    var cats = Array.from(document.querySelectorAll('h3.MuiAccordion-heading')).map(function(h){
      var x=(h.innerText||'').replace(/\\s+/g,' ');
      var mm=x.match(/(小初高公需|初中学段通识|专业课-初中数学)\\s*(\\d+)\\s*门课程\\s*已修\\s*(\\d+(?:\\.\\d+)?)\\s*\\/\\s*达标\\s*(\\d+)\\s*学时\\s*·\\s*完成\\s*(\\d+)\\s*门/);
      return mm ? {cat:mm[1], total:+mm[2], doneHours:+mm[3], needHours:+mm[4], doneCourses:+mm[5]} : null;
    }).filter(Boolean);
    return JSON.stringify({ page:'train', hours:m?+m[1]:null, need:m?+m[2]:null, courses:m?+m[3]:null, cats:cats });
  }
  var v = deep('video')[0];
  if (v) {
    var seg=(t.match(/([0-9]+-[0-9]+)\\s/)||[])[1]||null;
    var pct=(t.match(/(\\d{1,3})\\s*%/)||[])[1]||null;
    return JSON.stringify({ page:'player', cur:Math.round(v.currentTime*10)/10, dur:Math.round(v.duration||0), rate:v.playbackRate, paused:v.paused, pct:pct, seg:seg, title:(t.match(/课程：([^ ]{2,50}?)\\s/)||[])[1]||null });
  }
  if (/返回培训内容列表/.test(t)) return JSON.stringify({ page:'course', pend: deep('.MuiListItemButton-root').filter(function(e){return Array.from(e.querySelectorAll('button')).some(function(b){return /^(播放|继续|重播)$/.test((b.innerText||'').trim())})}).length, title:t.slice(0,50) });
  return JSON.stringify({ page:'other', head:t.slice(0, 60) });
})()`;

async function snap() {
  const tabs = await listCcTabs(PORT);
  if (!tabs || !tabs.length) return { t: Date.now(), err: 'no-tab' };
  const tab = new Tab(tabs[0], PORT);
  if (!await tab.connect()) return { t: Date.now(), err: 'no-conn' };
  const raw = await tab.ev(READ);
  tab.close();
  let o = {};
  try { o = JSON.parse(raw); } catch (_) { o = { parse: String(raw).slice(0, 80) }; }
  o.t = new Date().toTimeString().slice(0, 8);
  o.ts = Date.now();
  return o;
}

import { Tab } from './cc-lib.mjs';
if (WATCH > 0) {
  const end = Date.now() + WATCH * 1000;
  while (Date.now() < end) {
    const s = await snap();
    console.log(JSON.stringify(s));
    try { appendFileSync(OUT, JSON.stringify(s) + '\n'); } catch (_) { }
    await sleep(EVERY * 1000);
  }
} else {
  const s = await snap();
  console.log(JSON.stringify(s));
  try { appendFileSync(OUT, JSON.stringify(s) + '\n'); } catch (_) { }
}
process.exit(0);
