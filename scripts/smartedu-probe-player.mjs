#!/usr/bin/env node
/**
 * scripts/smartedu-probe-player.mjs -- work out how 智慧中小学 records watched progress.
 *
 * What we need to know before writing any automation:
 *   - which endpoint carries the progress heartbeat, and what it expects
 *   - whether progress is time-based (sum of watched seconds) or position-based (max
 *     currentTime reached), because that decides between "seek to the end" and "let it
 *     play through"
 *   - whether the player reports a whole course at once or per-resource
 *   - whether a playing video is enough, or a visible/foreground window is required
 *
 * Approach: enable Network, drive the <video> element directly, sample its state, and
 * dump every request/response whose URL or body looks progress-related.
 *
 * Usage:
 *   node scripts/smartedu-probe-player.mjs 9260 [--play 25] [--rate 1]
 */
const PORT = Number(process.argv[2] || 9260);
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const PLAY_SEC = Number(arg('play', 25));
const RATE = Number(arg('rate', 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('smartedu')) || list.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

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
const send = (method, params = {}, timeout = 25000) => {
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
const shot = async (out) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.mkdirSync((await import('node:path')).dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  return out;
};

await send('Network.enable');
await send('Page.enable');

console.log('== page ==');
console.log(await evalJs('location.href'));

// ---- baseline video state -------------------------------------------------
const before = await evalJs(`(function(){
  var v = document.querySelector('video');
  if (!v) return null;
  return { dur: Math.round(v.duration||0), t: Math.round(v.currentTime||0), paused: v.paused,
           rate: v.playbackRate, muted: v.muted, readyState: v.readyState,
           srcLen: (v.currentSrc||'').length, tagCls: String(v.className) };
})()`);
console.log('== video before ==');
console.log(JSON.stringify(before));

if (!before) { console.error('no <video> on page'); ws.close(); process.exit(2); }

// ---- start playback ------------------------------------------------------
console.log(`== playing ${PLAY_SEC}s at rate ${RATE} ==`);
await evalJs(`(function(){
  var v = document.querySelector('video');
  v.muted = true;
  v.playbackRate = ${RATE};
  v.play();
  return v.paused;
})()`);

// ---- sample --------------------------------------------------------------
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < PLAY_SEC * 1000) {
  await sleep(2000);
  const s = await evalJs(`(function(){
    var v = document.querySelector('video');
    if (!v) return null;
    return { t: Math.round(v.currentTime||0), paused: v.paused, rate: v.playbackRate,
             rs: v.readyState, buf: v.buffered.length ? Math.round(v.buffered.end(v.buffered.length-1)) : 0 };
  })()`);
  samples.push({ wall: ((Date.now() - t0) / 1000).toFixed(1), ...s });
  console.log('  wall=' + samples.at(-1).wall + 's  video=' + s?.t + 's  paused=' + s?.paused + '  rate=' + s?.rate + '  rs=' + s?.rs);
}

await evalJs('(function(){ var v=document.querySelector("video"); if(v){v.pause();v.playbackRate=1;} })()');
const after = await evalJs(`(function(){ var v=document.querySelector('video');
  return { t: Math.round(v.currentTime||0), paused: v.paused, dur: Math.round(v.duration||0),
           pct: Math.round((v.currentTime/(v.duration||1))*100) }; })()`);
console.log('== video after ==');
console.log(JSON.stringify(after));

// ---- network analysis ----------------------------------------------------
const PROGRESS_RE = /progress|learn|study|watch|duration|play|record|log|heartbeat|trace|stat|behavior|time/i;
const reqs = events.filter((e) => e.method === 'Network.requestWillBeSent');
const resps = events.filter((e) => e.method === 'Network.responseReceived');

const rows = [];
for (const r of reqs) {
  const u = r.params.request.url;
  const interesting = PROGRESS_RE.test(u);
  const body = r.params.request.postData;
  if (!interesting && !body) continue;
  rows.push({
    method: r.params.request.method,
    url: u.slice(0, 200),
    type: r.params.type,
    postData: body ? body.slice(0, 300) : null,
  });
}

console.log('');
console.log('== requests (progress-ish, first 60) ==');
for (const row of rows.slice(0, 60)) {
  console.log(`${row.method} ${row.url}`);
  if (row.postData) console.log('     body: ' + row.postData);
}

console.log('');
console.log('== responses (2xx on progress-ish urls) ==');
const okResps = resps
  .filter((e) => PROGRESS_RE.test(e.params.response.url) && e.params.response.status < 400)
  .slice(0, 40);
for (const e of okResps) {
  console.log(`${e.params.response.status} ${e.params.response.mimeType || ''} ${e.params.response.url.slice(0, 180)}`);
}

console.log('');
console.log('summary: requests=' + reqs.length + ' responses=' + resps.length + ' interesting=' + rows.length);

ws.close();
process.exit(0);
