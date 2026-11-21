#!/usr/bin/env node
/**
 * scripts/smartedu-batch.mjs -- run several 智慧中小学 courses back to back.
 *
 * One course at a time, in the same browser tab, by spawning smartedu-course.mjs per
 * course. Sequential on purpose: the platform records progress per resource against
 * whichever course the player currently holds, so two parallel players in one profile
 * would interleave study_details reports.
 *
 * Between courses it re-checks the session (a dropped login would otherwise be recorded
 * as a silent 0% on every remaining course).
 *
 * Usage:
 *   node scripts/smartedu-batch.mjs <port> --set hot
 *   node scripts/smartedu-batch.mjs <port> --set core
 *   node scripts/smartedu-batch.mjs <port> --list <file.json>   # [{name,url}, ...]
 *   node scripts/smartedu-batch.mjs <port> --set hot --only 1,3,5-7
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const PORT = Number(process.argv[2] || 9260);
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const SET = arg('set', '');
const LIST_FILE = arg('list', '');
const ONLY = arg('only', '');
const SHOT_BASE = arg('shot-dir', 'runs/order-smartedu/evidence');
const OFFSET = arg('offset', '12');
const MAX_WAIT = arg('max-wait', '90');
const COURSES_JSON = arg('courses', 'runs/order-smartedu/courses.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- select courses -------------------------------------------------------
let items = [];
let label = '';
if (LIST_FILE) {
  items = JSON.parse(readFileSync(LIST_FILE, 'utf8'));
  label = LIST_FILE;
} else {
  const j = JSON.parse(readFileSync(COURSES_JSON, 'utf8'));
  if (SET === 'core') {
    items = j.core.map((c) => ({ name: c.name, url: c.url }));
    label = 'core';
  } else if (SET === 'hot') {
    items = j.hot.map((c) => ({ name: c.name, url: c.url }));
    label = 'hot';
  } else if (SET === 'key') {
    // 幼儿园教师: the recommended one, plus whatever was added to keyPicked
    const kindergarten = j.key.find((k) => /幼儿园/.test(k.group));
    items = [];
    if (kindergarten?.recommended?.url) items.push({ name: kindergarten.recommended.name, url: kindergarten.recommended.url });
    if (Array.isArray(j.keyPicked)) items = items.concat(j.keyPicked);
    label = 'key';
  } else {
    console.error('need --set core|hot|key or --list <file>');
    process.exit(1);
  }
}

// ---- --only filter (supports 1,3,5-7) ------------------------------------
if (ONLY) {
  const keep = new Set();
  for (const part of ONLY.split(',')) {
    const m = part.trim().match(/^(\d+)-(\d+)$/);
    if (m) { for (let i = +m[1]; i <= +m[2]; i++) keep.add(i); }
    else if (/^\d+$/.test(part.trim())) keep.add(+part.trim());
  }
  items = items.filter((_, i) => keep.has(i + 1));
}

if (!items.length) { console.error('no courses selected'); process.exit(1); }

console.log('batch set=' + label + '  count=' + items.length + '  port=' + PORT);
items.forEach((c, i) => console.log('  [' + (i + 1) + '] ' + c.name));

// ---- session probe -------------------------------------------------------
async function sessionOk() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.includes('smartedu')) || list.find((t) => t.type === 'page');
    if (!page) return { ok: false, why: 'no page target' };
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws'))); });
    let id = 0;
    const ask = (method, params) => new Promise((res, rej) => {
      const myId = ++id;
      const h = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id === myId) { ws.removeEventListener('message', h); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
      };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => rej(new Error('timeout')), 15000);
    });
    const r = await ask('Runtime.evaluate', {
      // Do NOT look for a 退出 link: on course pages it lives in a hover menu that
      // innerText cannot see, so the probe reported a lost session on a live one.
      // localStorage X-EDU-WEB-USER is written at login and survives navigation.
      expression: `(function(){
        try {
          var u = localStorage.getItem('X-EDU-WEB-USER');
          var o = u ? JSON.parse(u) : null;
          var tok = null;
          for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if (k.indexOf('&ncet-xedu&token')>=0) { tok = localStorage.getItem(k); break; } }
          var hasCookie = /UC_TOKEN-/.test(document.cookie);
          return JSON.stringify({ user: o, tokenLen: tok ? tok.length : 0, hasCookie: hasCookie, url: location.href.slice(0,80) });
        } catch (e) { return JSON.stringify({ err: String(e) }); }
      })()`,
      returnByValue: true,
    });
    ws.close();
    const v = JSON.parse(r.result.value);
    if (v.err) return { ok: false, why: 'js: ' + v.err };
    return { ok: !!(v.user && v.user.user_id) && v.tokenLen > 0, name: v.user ? v.user.real_name : null, userId: v.user ? v.user.user_id : null };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// ---- run -----------------------------------------------------------------
const results = [];
mkdirSync(SHOT_BASE, { recursive: true });

for (let i = 0; i < items.length; i++) {
  const c = items[i];
  const tag = String(i + 1).padStart(2, '0');
  const dir = join(SHOT_BASE, label + '-' + tag);

  console.log('');
  console.log('############ ' + (i + 1) + '/' + items.length + '  ' + c.name + ' ############');

  const sess = await sessionOk();
  if (!sess.ok) {
    console.log('  ! SESSION LOST (' + (sess.why || 'no logout link') + ') -- aborting batch');
    results.push({ i: i + 1, name: c.name, ok: false, why: 'session lost' });
    break;
  }
  if (sess.name) console.log('  session: ' + sess.name);

  const r = spawnSync(process.execPath, [
    'scripts/smartedu-course.mjs', String(PORT), c.url,
    '--offset', OFFSET, '--max-wait', MAX_WAIT, '--shot-dir', dir,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);

  const m = out.match(/RESULT (\{.*\})/s);
  let parsed = null;
  if (m) { try { parsed = JSON.parse(m[1]); } catch { } }
  const distinct = parsed ? parsed.distinct.map((d) => d.progress + '/' + d.status).join(' -> ') : '?';
  const reached100 = parsed ? parsed.distinct.some((d) => d.progress === 100) : false;

  results.push({
    i: i + 1, name: c.name, ok: reached100,
    resources: parsed?.resources ?? null,
    trail: distinct,
    shots: dir,
  });
  console.log('  ==> ' + (reached100 ? 'OK 100%' : 'NOT 100%') + '   trail: ' + distinct);

  writeFileSync(join(SHOT_BASE, 'batch-' + label + '.json'), JSON.stringify({ label, results }, null, 2), 'utf8');
  await sleep(1200);
}

// ---- summary -------------------------------------------------------------
console.log('');
console.log('================ SUMMARY ================');
let okCount = 0;
for (const r of results) {
  const mark = r.ok ? 'OK ' : 'XX ';
  if (r.ok) okCount++;
  console.log(mark + String(r.i).padStart(2) + '. ' + r.name + '   [' + (r.trail || r.why || '') + ']');
}
console.log('-----------------------------------------');
console.log('done ' + okCount + '/' + results.length);
writeFileSync(join(SHOT_BASE, 'batch-' + label + '.json'), JSON.stringify({ label, results }, null, 2), 'utf8');
console.log('-> ' + join(SHOT_BASE, 'batch-' + label + '.json'));
process.exit(okCount === items.length ? 0 : 1);
