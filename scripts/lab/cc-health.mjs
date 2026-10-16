/**
 * cc-health.mjs — 健康巡检：驱动是否活着、播放是否在推进、学时进度、有没有卡 0 秒/423
 *   node scripts/cc-health.mjs --port 9228 [--secs 3600 --every 300]
 * 每轮输出一行 JSON 到 stdout 并追加到 runs/cc-health.jsonl
 */
import { listCcTabs, Tab, sleep } from './cc-lib.mjs';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), SECS = Number(A.secs || 600), EVERY = Number(A.every || 120);

const READ = `(function(){
  function deep(sel){ var out=[]; try{ Array.prototype.slice.call(document.querySelectorAll(sel)).forEach(function(e){out.push(e)}); }catch(e){} return out; }
  var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  var v=deep('video')[0];
  var prog=(t.match(/已修\\s*(\\d+(?:\\.\\d+)?)\\s*\\/\\s*达标\\s*(\\d+)\\s*学时\\s*·\\s*完成\\s*(\\d+)\\s*门/)||[]);
  var NC=window.NetClass;
  return JSON.stringify({
    page: /学习总进度/.test(t) ? 'train' : (/返回课程内容列表|返回培训内容列表/.test(t) ? 'course' : (v ? 'player' : (t.indexOf('项培训')>=0?'mytrain':'other'))),
    hours: prog[1]!==undefined ? +prog[1] : null, need: prog[2]!==undefined ? +prog[2] : null, courses: prog[3]!==undefined ? +prog[3] : null,
    v: v ? { cur: Math.round(v.currentTime), dur: Math.round(v.duration||0), rate: v.playbackRate, paused: v.paused, rs: v.readyState, buf: (function(){try{return v.buffered.length?Math.round(v.buffered.end(0)):0}catch(e){return 0}})() } : null,
    pct: (t.match(/(\\d{1,3})\\s*%/)||[])[1] || null,
    title: (t.match(/课程：([^ ]{2,50}?)\\s/)||[])[1] || null,
    nc: NC ? { en: NC.cfg.enabled, next: NC.cfg.autoNext } : null,
    err423: /423|已锁定|Locked/.test(t)
  });
})()`;

function driverCount() {
  try {
    const ps = require('node:child_process');
  } catch (_) { }
  return null;
}

const t0 = Date.now();
let prev = null;
while (Date.now() - t0 < SECS * 1000) {
  let rec = { t: new Date().toTimeString().slice(0, 8), ts: Date.now() };
  try {
    const tabs = await listCcTabs(PORT);
    if (!tabs || !tabs.length) { rec.err = 'no-tab'; }
    else {
      const tab = new Tab(tabs[0], PORT);
      if (!(await tab.connect())) rec.err = 'no-conn';
      else {
        const raw = await tab.ev(READ);
        const o = JSON.parse(raw || 'null');
        if (o) Object.assign(rec, o);
        tab.close();
      }
    }
  } catch (e) { rec.err = String(e && e.message).slice(0, 60); }
  if (prev && rec.v && prev.v) {
    rec.adv = rec.v.cur - prev.v.cur;
    if (rec.v.dur && prev.v.dur && rec.v.dur !== prev.v.dur) rec.segChanged = true;
  }
  prev = rec;
  const line = JSON.stringify(rec);
  console.log(line);
  try { appendFileSync('runs/cc-health.jsonl', line + '\n'); } catch (_) { }
  await sleep(EVERY * 1000);
}
process.exit(0);
