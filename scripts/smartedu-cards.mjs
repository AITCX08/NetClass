#!/usr/bin/env node
/**
 * scripts/smartedu-cards.mjs -- capture the one screenshot the customer actually needs.
 *
 * 附件2 defines the deliverable exactly: a crop of the course card showing the round
 *   "100% 已学习"
 * badge, with breadcrumb + title + 课程来源 visible. The docx examples are 1267x319.
 *
 * A full-viewport screenshot technically contains the badge but looks nothing like the
 * sample, so we clip to the card instead: find the badge, walk up to the widest ancestor
 * that is still a card (not the page), and capture that rect at 2x for legibility.
 *
 * Usage:
 *   node scripts/smartedu-cards.mjs <port> --list <file.json> --out <dir> [--scale 2]
 *   node scripts/smartedu-cards.mjs <port> --set core|hot|key --out <dir>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 9260);
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const LIST_FILE = arg('list', '');
const SET = arg('set', '');
const OUT = arg('out', 'runs/order-smartedu/artifacts');
const SCALE = Number(arg('scale', 2));
const COURSES_JSON = arg('courses', 'runs/order-smartedu/courses.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pick list -----------------------------------------------------------
let items = [];
if (LIST_FILE) {
  items = JSON.parse(readFileSync(LIST_FILE, 'utf8'));
} else {
  const j = JSON.parse(readFileSync(COURSES_JSON, 'utf8'));
  if (SET === 'core') items = j.core.map((c) => ({ name: c.name, url: c.url }));
  else if (SET === 'hot') items = j.hot.map((c) => ({ name: c.name, url: c.url }));
  else if (SET === 'key') {
    const kg = j.key.find((k) => /幼儿园/.test(k.group));
    if (kg?.recommended?.url) items.push({ name: kg.recommended.name, url: kg.recommended.url });
    if (Array.isArray(j.keyPicked)) items = items.concat(j.keyPicked);
  }
}
if (!items.length) { console.error('no courses'); process.exit(1); }

// ---- cdp -----------------------------------------------------------------
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
mkdirSync(OUT, { recursive: true });

const safe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 60);
const report = [];

for (let i = 0; i < items.length; i++) {
  const c = items[i];
  const tag = String(i + 1).padStart(2, '0');
  console.log('');
  console.log('[' + (i + 1) + '/' + items.length + '] ' + c.name);

  await send('Page.navigate', { url: c.url });
  await sleep(4200);

  // the badge may need a beat after the SPA resolves progress
  let box = null;
  for (let k = 0; k < 10; k++) {
    box = await evalJs(`(function(){
      var vw = window.innerWidth, vh = window.innerHeight;
      // Exclude SCRIPT/STYLE/NOSCRIPT/TEMPLATE: their textContent is source code, and
      // a first revision happily "found" a 24x24 badge made of bundled JS prose.
      //
      // Do NOT require children.length===0. The badge is
      //   div.course-action (295x208)  > div.course-progress (140x80) > div.progress-info (140x44)
      // and every level has element children, so a leaf-only rule matches nothing.
      // Instead take the SMALLEST rendered element whose short text mentions 已学习 --
      // that is the innermost badge info block.
      var SKIP = {SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, TITLE:1};
      var cands = Array.prototype.slice.call(document.querySelectorAll('*'))
        .filter(function(e){
          if (SKIP[e.tagName]) return false;
          if (!e.getClientRects().length) return false;
          if (e.offsetWidth < 20 || e.offsetHeight < 12) return false;
          var t = (e.textContent || '').trim();
          if (t.length > 24) return false;
          return /已学习/.test(t);
        })
        .map(function(e){ var r = e.getBoundingClientRect(); return { el: e, area: r.width * r.height }; })
        .sort(function(a, b){ return a.area - b.area; });
      var badge = cands.length ? cands[0].el : null;
      if (!badge) return null;
      // walk up until the ancestor is clearly a card block (wide but not the whole page)
      var el = badge, best = null;
      for (var up=0; up<10 && el; up++){
        var r = el.getBoundingClientRect();
        if (r.width > vw*0.45 && r.height > 120 && r.height < vh*0.95) { best = {el: el, r: r}; break; }
        el = el.parentElement;
      }
      if (!best) { var b=badge.getBoundingClientRect(); best={el:badge.parentElement,r:b}; }
      var r = best.r;
      // include the breadcrumb row above the card for context
      // Same trap as the badge: the breadcrumb is a container of per-level links, so a
      // leaf-only rule never matches it. Take the smallest rendered element whose text
      // starts at 首页 and contains a '>'.
      var crumbs = Array.prototype.slice.call(document.querySelectorAll('*'))
        .filter(function(e){
          if (SKIP[e.tagName]) return false;
          if (!e.getClientRects().length) return false;
          var t = (e.textContent || '').trim();
          if (t.length > 140) return false;
          return t.indexOf('首页') === 0 && t.indexOf('>') > 0;
        })
        .map(function(e){ var r = e.getBoundingClientRect(); return { el: e, area: r.width * r.height, r: r }; })
        .sort(function(a, b){ return a.area - b.area; });
      var crumb = crumbs.length ? crumbs[0].r : null;
      var top = r.top - 18;
      if (crumb && crumb.top < r.top) top = Math.max(0, crumb.top - 10);
      var left = Math.max(0, r.left - 24);
      var right = Math.min(vw, r.right + 24);
      var bottom = Math.min(vh, r.bottom + 24);
      return { x: Math.round(left), y: Math.round(Math.max(0, top)),
               w: Math.round(right-left), h: Math.round(bottom - Math.max(0, top)),
               badgeText: (badge.textContent||'').replace(/\\s+/g,' ').trim().slice(0,20),
               scrolled: Math.round(window.scrollY) };
    })()`);
    if (box && box.w > 200 && box.h > 100) break;
    await sleep(900);
  }

  if (!box) { console.log('  ! no badge found'); report.push({ i: i + 1, name: c.name, ok: false }); continue; }
  console.log('  badge="' + box.badgeText + '"  clip=' + box.w + 'x' + box.h + ' @' + box.x + ',' + box.y);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: SCALE },
    captureBeyondViewport: false,
  });
  const file = join(OUT, tag + '-' + safe(c.name) + '.png');
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('  -> ' + file);
  report.push({ i: i + 1, name: c.name, ok: /100/.test(box.badgeText), badge: box.badgeText, file });
  await sleep(600);
}

writeFileSync(join(OUT, 'cards-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('');
console.log('== summary ==');
for (const r of report) console.log((r.ok ? 'OK ' : 'XX ') + String(r.i).padStart(2) + '. ' + r.name + '  [' + (r.badge || '') + ']');
console.log('-> ' + join(OUT, 'cards-report.json'));
ws.close();
process.exit(report.every((r) => r.ok) ? 0 : 1);
