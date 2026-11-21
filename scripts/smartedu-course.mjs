#!/usr/bin/env node
/**
 * scripts/smartedu-course.mjs -- finish one 智慧中小学 course (all its resources).
 *
 * MECHANISM (measured, not assumed)
 * --------------------------------
 * The player is video.js over an MSE blob. Credit goes out as
 *   POST https://x-study-record-api.ykt.eduyun.cn/v1/study_details
 *   { user_id, resource_id, resource_name, resource_type:"t_course", progress, status, ext_info }
 * and the resume point as
 *   PUT  .../v1/resource_learning_positions/<resUuid>/<userId>   {"position": <sec>}
 *
 * Progress is POSITION-based, not watch-time-based: seeking to `duration - offset` and
 * letting it play the last few seconds produces status=1 and a full `position`.
 * Verified on 第十一讲 (1067 s): 15 s of playback -> progress=40 status=1.
 * This is the opposite of 华医网, where a seek-to-end recorded nothing because the
 * credit tick only fires while (played + window) >= total. Always measure per platform.
 *
 * Per course: one resource after another; the last segment carries the remainder of
 * the weighting, so all N must be done for the course to read 100%.
 *
 * Usage:
 *   node scripts/smartedu-course.mjs <port> <courseUrl> [--offset 15] [--max-wait 90]
 *                                     [--shot-dir <dir>] [--dry]
 */
const PORT = Number(process.argv[2] || 9260);
const COURSE_URL = process.argv[3];
if (!COURSE_URL) {
  console.error('usage: node scripts/smartedu-course.mjs <port> <courseUrl> [--offset 15] [--max-wait 90]');
  process.exit(1);
}
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes('--' + n);
const OFFSET = Number(arg('offset', 15));
const MAX_WAIT = Number(arg('max-wait', 90));
const SHOT_DIR = arg('shot-dir', '');
const DRY = has('dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- transport
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('smartedu')) || list.find((t) => t.type === 'page');
if (!page) { console.error('no page target on port ' + PORT); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
let events = [];
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method) events.push(m);
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws'))); });
const send = (method, params = {}, timeout = 30000) => {
  const id = ++seq;
  return new Promise((res, rej) => {
    pend.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, timeout);
  });
};
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};
const shot = async (name) => {
  if (!SHOT_DIR) return null;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const f = path.join(SHOT_DIR, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
};
const clickAt = async (x, y) => {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: 0 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
  await sleep(50);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(50);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};
const clickSel = async (sel) => {
  const box = await evalJs(`(function(){
    var el=document.querySelector(${JSON.stringify(sel)});
    if(!el) return null;
    el.scrollIntoView({block:'center'});
    var r=el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,txt:(el.textContent||'').trim().slice(0,40)};
  })()`);
  if (!box) return null;
  await clickAt(box.x, box.y);
  return box;
};
const clickIndex = async (sel, idx) => {
  const box = await evalJs(`(function(){
    var els=document.querySelectorAll(${JSON.stringify(sel)});
    var el=els[${idx}];
    if(!el) return null;
    el.scrollIntoView({block:'center'});
    var r=el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,txt:(el.textContent||'').trim().slice(0,50),n:els.length};
  })()`);
  if (!box) return null;
  await clickAt(box.x, box.y);
  return box;
};

async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v;
    try { v = await evalJs(expr); } catch { v = null; }
    if (v) return v;
    await sleep(700);
  }
  console.log('    ! timeout waiting for ' + (label || expr.slice(0, 60)));
  return null;
}

await send('Network.enable');
await send('Page.enable');

// ---------------------------------------------------------------- open course
console.log('== open course ==');
console.log('  ' + COURSE_URL.slice(0, 120));
await send('Page.navigate', { url: COURSE_URL });
await sleep(4000);

// courseIndex shows "开始学习"; after any progress it becomes "继续学习".
// courseDetail already has the player.
//
// This must POLL, not look once. The SPA renders a category skeleton first, and the
// course entry button appears a beat later; a single check at t+4s found no button for
// 王育人 科学、技术与人的选择 and the run died on "no video on this page" even though
// the course opens fine a few seconds later.
let entered = false;
let entryLabel = '';
for (let k = 0; k < 16; k++) {
  const st = await evalJs(`(function(){
    var v = document.querySelector('video');
    if (v && v.duration > 1) return {kind:'video', dur: Math.round(v.duration)};
    var want=['开始学习','继续学习','继续观看','继续学习本课'];
    var a=Array.from(document.querySelectorAll('a,button')).filter(function(e){return want.indexOf((e.textContent||'').trim())>=0});
    // A course already at 100% offers 复习回顾 instead of 开始学习. Without this branch
    // the runner declares "no video on this page" for courses that are in fact finished
    // -- which is exactly what happened to 巧娃难为无水之炊 and 好玩的影子游戏, both of
    // which were already complete before this order touched them.
    var done=Array.from(document.querySelectorAll('a,button')).filter(function(e){return (e.textContent||'').trim()==='复习回顾'});
    if (done.length && !a.length) {
      var t=(document.body.innerText||'');
      return {kind:'already', already: /100\\s*%/.test(t) };
    }
    if (a.length) { var r=a[0].getBoundingClientRect();
      return {kind:'btn', x:r.left+r.width/2, y:r.top+r.height/2, label:(a[0].textContent||'').trim()}; }
    return {kind:'none', text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,60)};
  })()`);
  if (st && st.kind === 'video') { entered = true; entryLabel = '(already on player)'; break; }
  if (st && st.kind === 'already') {
    console.log('  ALREADY_COMPLETE  (button reads 复习回顾)');
    console.log('RESULT ' + JSON.stringify({ title: null, resources: 0, results: [], distinct: [{ progress: 100, status: 2, note: 'pre-existing' }], alreadyComplete: true }));
    ws.close();
    process.exit(0);
  }
  if (st && st.kind === 'btn') {
    entryLabel = st.label;
    console.log('  entry button: ' + st.label + '  (attempt ' + (k + 1) + ')');
    await clickAt(st.x, st.y);
    await sleep(3200);
    const nowVideo = await evalJs(`(function(){ var v=document.querySelector('video'); return v && v.duration>1 ? Math.round(v.duration) : null; })()`);
    if (nowVideo) { entered = true; break; }
    continue;
  }
  if (k === 0) console.log('  waiting for course entry…  (' + (st ? st.text : '') + ')');
  await sleep(1200);
}
console.log('  entered=' + entered + '  via=' + entryLabel);

const title = await evalJs(`(function(){
  var el=document.querySelector('[class*=course-name],[class*=courseName],h1');
  if (el && el.innerText && el.innerText.trim()) return el.innerText.replace(/\\s+/g,' ').trim().slice(0,80);
  var lines = document.body.innerText.split('\\n');
  var bc = lines.filter(function(s){ return s.indexOf('首页>')===0; })[0] || '';
  var parts = bc.split('>');
  return (parts[parts.length-1] || document.title).replace(/\\s+/g,' ').trim().slice(0,80);
})()`);
console.log('  title: ' + title);

const hasVideo = await waitFor(`(function(){ var v=document.querySelector('video'); return v && v.duration>0 ? Math.round(v.duration) : null; })()`, 25000, 'video duration');
if (!hasVideo) { console.error('no video on this page'); ws.close(); process.exit(2); }

// ---------------------------------------------------------------- catalog
const cat = await evalJs(`(function(){
  var els=Array.from(document.querySelectorAll('[class*=resource-item]'));
  return { n: els.length, names: els.map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50);}) };
})()`);
console.log('  catalog: ' + cat.n + ' resource(s)');
cat.names.forEach((t, i) => console.log('    [' + i + '] ' + t));

if (DRY) { ws.close(); process.exit(0); }

// ---------------------------------------------------------------- per resource
const results = [];
for (let i = 0; i < cat.n; i++) {
  console.log('');
  console.log('== resource ' + (i + 1) + '/' + cat.n + ' : ' + cat.names[i] + ' ==');

  // activate
  const clicked = await clickIndex('[class*=resource-item]', i);
  if (!clicked) { console.log('  ! could not click catalog item'); results.push({ i, ok: false, why: 'no item' }); continue; }
  await sleep(2200);

  // wait for a usable duration
  const dur = await waitFor(`(function(){ var v=document.querySelector('video'); return (v && v.duration>1) ? Math.round(v.duration) : null; })()`, 25000, 'duration');
  if (!dur) { results.push({ i, ok: false, why: 'no duration' }); continue; }

  const st = await evalJs(`(function(){ var v=document.querySelector('video');
    var sk=[]; for(var k=0;k<v.seekable.length;k++) sk.push([Math.round(v.seekable.start(k)),Math.round(v.seekable.end(k))]);
    return { t: Math.round(v.currentTime||0), dur: Math.round(v.duration), seekable: sk }; })()`);
  console.log('  state: t=' + st.t + ' dur=' + st.dur + ' seekable=' + JSON.stringify(st.seekable));

  // if it already sits at the end, treat as done (the platform still re-reports)
  if (st.t >= st.dur - 2) {
    console.log('  already at end -> replay the tail anyway to force a status report');
  }

  const target = Math.max(0, dur - OFFSET);
  await evalJs(`(function(){ var v=document.querySelector('video'); v.muted=true; v.currentTime=${target}; v.play(); })()`);
  console.log('  seek -> ' + target + 's, playing tail');

  // watch it to the end
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < MAX_WAIT * 1000) {
    await sleep(2000);
    const s = await evalJs(`(function(){ var v=document.querySelector('video');
      return { t: Math.round(v.currentTime||0), ended: v.ended, paused: v.paused, dur: Math.round(v.duration||0) }; })()`);
    const pct = Math.round((s.t / (s.dur || dur)) * 100);
    process.stdout.write('    ' + s.t + '/' + s.dur + ' (' + pct + '%)' + (s.ended ? ' ENDED' : '') + '\r');
    if (s.ended || s.t >= (s.dur || dur) - 1) { done = true; break; }
  }
  process.stdout.write('\n');
  console.log('  ended=' + done + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');

  // give the reporter a moment, then read what it sent
  await sleep(3500);
  const posts = events
    .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('study_details'))
    .map((e) => { try { return JSON.parse(e.params.request.postData); } catch { return null; } })
    .filter(Boolean);
  const last = posts.at(-1);
  if (last) {
    console.log('  study_details -> progress=' + last.progress + ' status=' + last.status + ' resource_id=' + String(last.resource_id).slice(0, 8));
  }
  results.push({ i, name: cat.names[i], dur, done, progress: last?.progress, status: last?.status });

  if (SHOT_DIR) {
    const f = await shot('res-' + (i + 1) + '.png');
    if (f) console.log('  shot: ' + f);
  }
}

// ---------------------------------------------------------------- verify
console.log('');
console.log('== after all resources ==');
const finalPosts = events
  .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('study_details'))
  .map((e) => { try { return JSON.parse(e.params.request.postData); } catch { return null; } })
  .filter(Boolean);
const uniq = [];
for (const p of finalPosts) {
  const k = p.progress + '|' + p.status;
  if (!uniq.some((u) => u.k === k)) uniq.push({ k, progress: p.progress, status: p.status });
}
console.log('  distinct progress/status pairs seen: ' + JSON.stringify(uniq.map((u) => u.progress + '/' + u.status)));

// re-read the courseIndex badge
console.log('  navigating back to courseIndex to read the badge...');
await send('Page.navigate', { url: COURSE_URL });
await sleep(4500);
const badge = await evalJs(`(function(){
  var t=document.body.innerText;
  var m=t.match(/(未学习|已学习|学习中|已完成|\\d+%\\s*已学习)/g);
  return { hits: m ? m.slice(0,8) : [], snippet: t.slice(0,400).replace(/\\n+/g,' | ') };
})()`);
console.log('  badge hits: ' + JSON.stringify(badge.hits));

if (SHOT_DIR) { const f = await shot('course-final.png'); if (f) console.log('  shot: ' + f); }

console.log('');
console.log('RESULT ' + JSON.stringify({ title, resources: cat.n, results, distinct: uniq }));
ws.close();
process.exit(0);
