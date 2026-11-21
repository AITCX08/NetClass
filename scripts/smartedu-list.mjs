#!/usr/bin/env node
/**
 * scripts/smartedu-list.mjs -- list the courses on a 智慧中小学 teacherTraining page.
 *
 * Needed for two things in this order:
 *   1. pick the 2 extra 幼儿园 courses (只有 1 门是附件点名的，另外 2 门要自选)
 *   2. verify whether 第十讲 still exists -- 附件3 写的是第十讲，但它的 courseId 现在
 *      指向第十一讲，所以要确认是附件过期还是课程被替换
 *
 * The list is an infinite-scroll grid, so it scrolls to the bottom repeatedly until the
 * card count stops growing, then reads every card's title + href.
 *
 * Usage:
 *   node scripts/smartedu-list.mjs <port> "<listUrl>" [--max-scroll 12] [--filter 幼教]
 */
const PORT = Number(process.argv[2] || 9260);
const LIST_URL = process.argv[3];
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const MAX_SCROLL = Number(arg('max-scroll', 12));
const FILTER = arg('filter', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!LIST_URL) { console.error('usage: node scripts/smartedu-list.mjs <port> "<url>"'); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('smartedu')) || list.find((t) => t.type === 'page');
if (!page) { console.error('no page'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
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

await send('Page.enable');
console.log('== navigate ==');
console.log('  ' + LIST_URL.slice(0, 130));
await send('Page.navigate', { url: LIST_URL });
await sleep(5000);

// ---- scroll until the card count stabilises ------------------------------
let last = -1;
let stable = 0;
for (let i = 0; i < MAX_SCROLL; i++) {
  const n = await evalJs(`document.querySelectorAll('a[href*="courseIndex"]').length`);
  console.log('  scroll ' + (i + 1) + ': cards=' + n);
  if (n === last) { stable++; if (stable >= 2) break; } else { stable = 0; }
  last = n;
  await evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(1600);
}

// ---- collect -------------------------------------------------------------
const cards = await evalJs(`(function(){
  var out=[];
  var seen={};
  Array.from(document.querySelectorAll('a[href*="courseIndex"]')).forEach(function(a){
    var href=a.href;
    var id=(href.match(/courseId=([^&]+)/)||[])[1]||href;
    if (seen[id]) return;
    seen[id]=1;
    var box=a.closest('[class*=card],[class*=item],li,div');
    var t='';
    for (var k=0;k<4 && box;k++){ t=(box.innerText||'').replace(/\\s+/g,' ').trim(); if(t.length>6) break; box=box.parentElement; }
    out.push({ id:id.slice(0,40), title:t.slice(0,90), href:href });
  });
  return out;
})()`);

console.log('');
console.log('== cards (' + cards.length + ') ==');
const shown = FILTER ? cards.filter((c) => new RegExp(FILTER).test(c.title) || true) : cards;
shown.forEach((c, i) => {
  console.log('  [' + (i + 1) + '] ' + c.title);
  console.log('        ' + c.href.slice(0, 130));
});

console.log('');
const totalText = await evalJs(`(function(){
  var t=document.body.innerText;
  var m=t.match(/共\\s*\\d+\\s*(门|个|条)/g);
  return { pagination: m?m.slice(0,3):[], head: t.split('\\n').slice(0,6).join(' | ') };
})()`);
console.log('pagination hints: ' + JSON.stringify(totalText));

ws.close();
process.exit(0);
