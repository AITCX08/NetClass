#!/usr/bin/env node
/**
 * scripts/smartedu-seek-test.mjs -- decide whether progress is position-based or
 * watch-time-based, and what the credit endpoint actually receives.
 *
 * The 华医网 order taught the expensive lesson: seeking straight to `duration` looked
 * finished but recorded nothing, because the credit code only fired inside a player
 * tick while `(played + window) >= total`. So never assume -- measure.
 *
 * What this prints:
 *   - seekable ranges (a blob/MSE source may not allow seeking past what is buffered)
 *   - every POST to /v1/study_details with its `progress` / `status` fields
 *   - whether the resource item in the catalog list gains a "finished" marker
 *
 * Usage:
 *   node scripts/smartedu-seek-test.mjs 9260 [--offset 15] [--wait 60]
 */
const PORT = Number(process.argv[2] || 9260);
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const OFFSET = Number(arg('offset', 15));
const WAIT_SEC = Number(arg('wait', 60));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('smartedu')) || list.find((t) => t.type === 'page');
if (!page) { console.error('no page'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
const events = [];
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

await send('Network.enable');

// ---- seekable + duration --------------------------------------------------
const info = await evalJs(`(function(){
  var v = document.querySelector('video');
  if (!v) return null;
  var sk = [];
  for (var i=0;i<v.seekable.length;i++) sk.push([Math.round(v.seekable.start(i)), Math.round(v.seekable.end(i))]);
  return { dur: Math.round(v.duration||0), t: Math.round(v.currentTime||0), seekable: sk,
           buffered: (function(){var b=[];for(var i=0;i<v.buffered.length;i++)b.push([Math.round(v.buffered.start(i)),Math.round(v.buffered.end(i))]);return b})() };
})()`);
console.log('== video ==');
console.log(JSON.stringify(info));
if (!info) { ws.close(); process.exit(2); }

const target = Math.max(0, info.dur - OFFSET);
console.log(`\n== seek to ${target}s (dur ${info.dur}, offset ${OFFSET}) ==`);
const seekRes = await evalJs(`(function(){
  var v = document.querySelector('video');
  v.currentTime = ${target};
  return { t: Math.round(v.currentTime), paused: v.paused };
})()`);
console.log(JSON.stringify(seekRes));
await sleep(1500);

const afterSeek = await evalJs(`(function(){
  var v=document.querySelector('video');
  return { t: Math.round(v.currentTime), paused: v.paused, rs: v.readyState };
})()`);
console.log('after seek: ' + JSON.stringify(afterSeek));

// ---- play through to the end ---------------------------------------------
console.log(`\n== playing to end, max ${WAIT_SEC}s ==`);
await evalJs(`(function(){ var v=document.querySelector('video'); v.muted=true; v.play(); })()`);

const t0 = Date.now();
let ended = false;
while (Date.now() - t0 < WAIT_SEC * 1000) {
  await sleep(2000);
  const s = await evalJs(`(function(){ var v=document.querySelector('video');
    return { t: Math.round(v.currentTime||0), ended: v.ended, paused: v.paused }; })()`);
  console.log('  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's  video=' + s.t + '/' + info.dur + '  ended=' + s.ended + '  paused=' + s.paused);
  if (s.ended || s.t >= info.dur - 1) { ended = true; break; }
}

// let any trailing heartbeat flush
await sleep(4000);

// ---- study_details traffic ----------------------------------------------
const fin = events.filter((e) =>
  e.method === 'Network.requestWillBeSent' &&
  e.params.request.url.includes('study_details'));
const posUpd = events.filter((e) =>
  e.method === 'Network.requestWillBeSent' &&
  e.params.request.url.includes('resource_learning_positions'));

console.log('\n== study_details POSTs (' + fin.length + ') ==');
for (const r of fin) {
  let body = r.params.request.postData || '';
  try {
    const j = JSON.parse(body);
    console.log(`  progress=${j.progress} status=${j.status} resource=${(j.resource_name || '').slice(0, 30)} type=${j.resource_type}`);
    if (j.ext_info) console.log('     ext=' + String(j.ext_info).slice(0, 220));
  } catch {
    console.log('  raw: ' + body.slice(0, 200));
  }
}

console.log('\n== position PUTs (' + posUpd.length + ') ==');
for (const r of posUpd.slice(-5)) {
  console.log('  ' + r.params.request.url.split('/v1/')[1] + '  body=' + (r.params.request.postData || '').slice(0, 80));
}

// ---- catalog markers -----------------------------------------------------
const markers = await evalJs(`(function(){
  var items = Array.from(document.querySelectorAll('[class*=resource-item]'));
  return items.map(function(e){
    var cls = String(e.className);
    return { txt: (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40),
             active: /active/.test(cls),
             finished: /finish|done|complete|already|studied/i.test(cls),
             cls: cls.slice(0, 90) };
  });
})()`);
console.log('\n== catalog items ==');
console.log(JSON.stringify(markers, null, 1));

console.log('\nended=' + ended);
ws.close();
process.exit(0);
