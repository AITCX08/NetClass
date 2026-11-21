#!/usr/bin/env node
/**
 * scripts/smartedu-session.mjs -- capture the 智慧中小学 session bundle.
 *
 * The manual login in the visible browser produces a UC SSO session spread over three
 * places; all three are needed to reuse the session headlessly:
 *   1. cookie  UC_TOKEN-<appid>-ncet-xedu   (JWT, ~1.1 KB, 7-day TTL)
 *   2. cookie  UC_SSO_TGC-<appid>-product   (SSO ticket grant cookie)
 *   3. localStorage ND_UC_AUTH-<appid>&ncet-xedu&token  -> {access_token, ...}
 * plus X-EDU-WEB-USER (real_name / user_id) and X-EDU-WEB-ROLE.
 *
 * Writes evidence/session.json (full values) and prints a redacted summary.
 *
 * Usage:
 *   node scripts/smartedu-session.mjs 9260 [--out <dir>]
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || process.env.CDP_PORT || 9260);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : 'runs/order-smartedu/evidence';

async function pickPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  const hit = pages.find((t) => t.url.includes('basic.smartedu.cn')) || pages[0];
  if (!hit) throw new Error('no page target');
  return hit;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        return new Promise((res, rej) => {
          pend.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
          setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
        });
      },
      close() { try { ws.close(); } catch { } },
    }));
  });
}

const page = await pickPage();
const c = await connect(page.webSocketDebuggerUrl);

const evalJs = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

// ---- cookies (full values) ----
let cookies = [];
try {
  const r = await c.send('Storage.getCookies', {});
  cookies = r.cookies || [];
} catch {
  await c.send('Network.enable');
  const r = await c.send('Network.getAllCookies', {});
  cookies = r.cookies || [];
}

// ---- localStorage of interest ----
const ls = await evalJs(`(function(){
  function find(sub){ for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if (k.indexOf(sub)>=0) return localStorage.getItem(k); } return null; }
  return {
    token: find('&ncet-xedu&token'),
    user: find('X-EDU-WEB-USER'),
    role: find('X-EDU-WEB-ROLE'),
    siteCode: (function(){ for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if (k.indexOf('new_area_site_code_user_')===0) return localStorage.getItem(k); } return null; })(),
    deviceId: find('ND_UC_DEVICE_ID'),
    href: location.href
  };
})()`);

// ---- sessionStorage ----
const ss = await evalJs(`(function(){
  function find(sub){ for (var i=0;i<sessionStorage.length;i++){ var k=sessionStorage.key(i); if (k.indexOf(sub)>=0) return sessionStorage.getItem(k); } return null; }
  return { session: find('&ncet-xedu&session') };
})()`);

// ---- /uc 身份信息 ----
const me = await evalJs(`fetch('/uc/user/getUserInfo', {credentials:'include'})
  .then(r => r.ok ? r.text() : 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)`);

c.close();

function parseJsonLoose(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { }
  const m = v.match(/\{.*\}/s);
  if (m) { try { return JSON.parse(m[0]); } catch { } }
  return null;
}

let accessToken = null;
const tokWrapper = parseJsonLoose(ls.token);
if (tokWrapper && tokWrapper.value) {
  const inner = parseJsonLoose(tokWrapper.value);
  if (inner && inner.access_token) accessToken = inner.access_token;
}
const user = parseJsonLoose(ls.user);
const role = parseJsonLoose(ls.role);
const site = parseJsonLoose(ls.siteCode);

const ucToken = cookies.find((k) => k.name.startsWith('UC_TOKEN-'));
const tgc = cookies.find((k) => k.name.startsWith('UC_SSO_TGC-'));

const bundle = {
  captured_at: new Date().toISOString(),
  page: ls.href,
  user: user ? { user_id: user.user_id, real_name: user.real_name, avatar: user.avatar } : null,
  role: role ? { id: Object.keys(role).find((k) => k !== 'allRoles'), roles: role.allRoles } : null,
  site_code: site ? site.value : null,
  access_token: accessToken,
  uc_token_cookie: ucToken ? { name: ucToken.name, value: ucToken.value, expires: ucToken.expires } : null,
  tgc_cookie: tgc ? { name: tgc.name, value: tgc.value, expires: tgc.expires } : null,
  session_storage: ss,
  all_cookies: cookies.map((k) => ({
    name: k.name, domain: k.domain, path: k.path, expires: k.expires,
    httpOnly: !!k.httpOnly, secure: !!k.secure, value: k.value,
  })),
  uc_userinfo_raw: me,
};

mkdirSync(OUT, { recursive: true });
const file = join(OUT, 'session.json');
writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');

// ---- redacted summary ----
const red = (s, n = 12) => (s ? s.slice(0, n) + '…(' + s.length + ')' : '(none)');
console.log('captured_at      ' + bundle.captured_at);
console.log('user_id          ' + (bundle.user?.user_id ?? '?'));
console.log('real_name        ' + (bundle.user?.real_name ?? '?'));
console.log('roles            ' + JSON.stringify(bundle.role?.roles ?? []));
console.log('site_code        ' + (bundle.site_code ?? '?'));
console.log('access_token     ' + red(bundle.access_token));
console.log('UC_TOKEN cookie  ' + red(bundle.uc_token_cookie?.value, 20));
console.log('TGC cookie       ' + red(bundle.tgc_cookie?.value, 20));
console.log('cookies total    ' + bundle.all_cookies.length);
console.log('sessionStorage   ' + red(ss.session, 40));
console.log('uc_userinfo      ' + String(me).slice(0, 200));
console.log('-> ' + file);
