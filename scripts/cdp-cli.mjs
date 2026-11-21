#!/usr/bin/env node
/**
 * scripts/cdp-cli.mjs -- generic CDP driver over the SSH tunnel.
 *
 * The laptop's Chrome is launched with --remote-debugging-port=N and reached as
 * 127.0.0.1:N through `scripts/tunnel.ps1`. This CLI is the single entry point for
 * poking that browser: evaluate JS, real-mouse click, navigate, screenshot, dump
 * cookies/storage, capture network.
 *
 * Commands:
 *   node scripts/cdp-cli.mjs <port> targets
 *   node scripts/cdp-cli.mjs <port> eval "<js>"            [--target substr]
 *   node scripts/cdp-cli.mjs <port> nav  "<url>"           [--target substr]
 *   node scripts/cdp-cli.mjs <port> click "<css>"          [--target substr]
 *   node scripts/cdp-cli.mjs <port> type  "<css>" "<text>" [--target substr]
 *   node scripts/cdp-cli.mjs <port> shot  "<out.png>"      [--target substr] [--full]
 *   node scripts/cdp-cli.mjs <port> cookies
 *   node scripts/cdp-cli.mjs <port> storage
 *   node scripts/cdp-cli.mjs <port> net "<ms>"             [--target substr]
 *
 * Why real mouse events for click: several sites we work with ignore a synthetic
 * element.click() -- they listen on mousedown/mouseup at the document and also check
 * trusted-event geometry. Input.dispatchMouseEvent at the element's centre reproduces
 * a user click, including hover/focus side effects.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [portArg, cmd, a1, a2] = process.argv.slice(2);
const PORT = Number(portArg);
if (!PORT || !cmd) {
  console.error('usage: node scripts/cdp-cli.mjs <port> <command> [...]');
  process.exit(1);
}

const rest = process.argv.slice(4);
function opt(name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
const has = (name) => rest.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- transport
async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pend = new Map();
    const events = [];
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id);
        pend.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method) {
        events.push(m);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || ''))));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}, timeout = 25000) {
          const id = ++seq;
          return new Promise((res, rej) => {
            pend.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
              if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); }
            }, timeout);
          });
        },
        events,
        close() { try { ws.close(); } catch { } },
      });
    });
  });
}

async function pickPage(targetSubstr) {
  const list = (await targets()).filter((t) => t.type === 'page');
  if (!list.length) throw new Error('no page targets');
  let hit;
  if (targetSubstr) hit = list.find((t) => t.url.includes(targetSubstr) || (t.title || '').includes(targetSubstr));
  else hit = list[0];
  if (!hit) throw new Error('no target matching ' + targetSubstr + '  (have: ' + list.map((t) => t.url).join(' | ') + ')');
  return hit;
}

async function evalOn(page, expression) {
  const c = await connect(page.webSocketDebuggerUrl);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('JS exception: ' + (d.exception ? d.exception.description : d.text));
    }
    return r.result ? r.result.value : undefined;
  } finally { c.close(); }
}

// ---------------------------------------------------------------- commands
const targetSub = opt('--target');

if (cmd === 'targets') {
  const list = await targets();
  for (const t of list) {
    console.log(`${t.type.padEnd(10)} ${t.id.slice(0, 8)}  ${t.title ? t.title.slice(0, 50) : ''}  ${t.url.slice(0, 110)}`);
  }
  process.exit(0);
}

if (cmd === 'eval') {
  const page = await pickPage(targetSub);
  const out = await evalOn(page, a1);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  process.exit(0);
}

if (cmd === 'nav') {
  const page = await pickPage(targetSub);
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: a1 });
  await sleep(Number(opt('--wait') || 2500));
  const url = await evalOn(page, 'location.href + " || " + document.title');
  console.log(url);
  c.close();
  process.exit(0);
}

if (cmd === 'click') {
  const page = await pickPage(targetSub);
  const sel = a1;
  // Resolve geometry first, in-page. Fall back to text match if the selector misses.
  const box = await evalOn(page, `(function(){
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) {
      var all = Array.prototype.slice.call(document.querySelectorAll('a,button,div,span,li'));
      el = all.filter(function(e){ return (e.textContent||'').trim() === ${JSON.stringify(sel)}; })[0] || null;
    }
    if (!el) return null;
    el.scrollIntoView({block:'center'});
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height,
             tag: el.tagName, text: (el.textContent||'').trim().slice(0,60),
             vis: !!(el.offsetParent || el.getClientRects().length) };
  })()`);
  if (!box) { console.error('CLICK_MISS: no element for ' + sel); process.exit(2); }
  const c = await connect(page.webSocketDebuggerUrl);
  const base = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1, modifiers: 0 };
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  c.close();
  await sleep(Number(opt('--wait') || 1200));
  const after = await evalOn(page, 'location.href');
  console.log(JSON.stringify({ clicked: box.text, tag: box.tag, visible: box.vis, at: [Math.round(box.x), Math.round(box.y)], urlAfter: after }));
  process.exit(0);
}

if (cmd === 'type') {
  const page = await pickPage(targetSub);
  const sel = a1, text = a2 ?? '';
  const ok = await evalOn(page, `(function(){
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.focus();
    return true;
  })()`);
  if (!ok) { console.error('TYPE_MISS: ' + sel); process.exit(2); }
  const c = await connect(page.webSocketDebuggerUrl);
  // Input.insertText avoids the keyDown/char double-typing bug: passing the text on
  // BOTH keyDown and char makes every character land twice (Z8UV became ZZ88UUVV).
  await c.send('Input.insertText', { text });
  c.close();
  console.log('typed ' + text.length + ' chars into ' + sel);
  process.exit(0);
}

if (cmd === 'shot') {
  const page = await pickPage(targetSub);
  const out = a1;
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Page.enable');
  const r = await c.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !!has('--full'),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  const size = Buffer.from(r.data, 'base64').length;
  c.close();
  console.log('wrote ' + out + '  ' + size + ' B');
  process.exit(0);
}

if (cmd === 'cookies') {
  const page = await pickPage(targetSub);
  const c = await connect(page.webSocketDebuggerUrl);
  // Storage.getCookies needs no domain enable and returns httpOnly ones too.
  let all;
  try {
    const r = await c.send('Storage.getCookies', {});
    all = r.cookies || [];
  } catch {
    await c.send('Network.enable');
    const r = await c.send('Network.getAllCookies', {});
    all = r.cookies || [];
  }
  c.close();
  const rows = all.map((k) => ({
    name: k.name, domain: k.domain, path: k.path,
    expires: k.expires > 0 ? new Date(k.expires * 1000).toISOString() : 'session',
    httpOnly: !!k.httpOnly, secure: !!k.secure, sameSite: k.sameSite,
    valueLen: (k.value || '').length,
    value: (k.value || '').length <= 120 ? k.value : (k.value || '').slice(0, 40) + '...(' + k.value.length + ')',
  }));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (cmd === 'storage') {
  const page = await pickPage(targetSub);
  const out = await evalOn(page, `(function(){
    function dump(s){ var o={}; try{ for(var i=0;i<s.length;i++){var k=s.key(i); var v=s.getItem(k)||''; o[k]= v.length<=160 ? v : v.slice(0,80)+'...('+v.length+')';} }catch(e){o.__err=String(e);} return o; }
    return { url: location.href, localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (cmd === 'net') {
  const page = await pickPage(targetSub);
  const ms = Number(a1 || 8000);
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Network.enable');
  await sleep(ms);
  const reqs = c.events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => ({
    method: e.params.request.method, url: e.params.request.url.slice(0, 160),
    type: e.params.type,
    hasAuth: !!(e.params.request.headers.Authorization || e.params.request.headers.authorization),
  }));
  const resps = c.events.filter((e) => e.method === 'Network.responseReceived').map((e) => ({
    status: e.params.response.status, url: e.params.response.url.slice(0, 160),
  }));
  c.close();
  console.log(JSON.stringify({ requests: reqs, responses: resps }, null, 2));
  process.exit(0);
}

console.error('unknown command: ' + cmd);
process.exit(1);
