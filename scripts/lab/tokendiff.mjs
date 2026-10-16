/** tokendiff.mjs — 对比页面自身请求与我们的 fetch，定位 getVideoPlayAuth 返回 1000 的原因 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  close() { try { this.ws.close(); } catch { } }
}
async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  if (r && r.err) return 'EVAL-ERR ' + r.err;
  if (r && r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 260);
  return r && r.result ? r.result.value : '(none)';
}

const HOOK = [
  '(function(){',
  '  if (window.__ncHdr) return "already";',
  '  window.__ncHdr = { req: [] };',
  '  var OX = window.XMLHttpRequest, so = OX.prototype.open, ss = OX.prototype.send, sh = OX.prototype.setRequestHeader;',
  '  OX.prototype.open = function (m, u) { this.__u = String(u); this.__h = {}; return so.apply(this, arguments); };',
  '  OX.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = String(v); } catch (e) {} return sh.apply(this, arguments); };',
  '  OX.prototype.send = function () {',
  '    var self = this;',
  '    this.addEventListener("load", function () {',
  '      try {',
  '        var rec = { url: self.__u.slice(0, 150), hdr: self.__h, status: self.status, body: String(self.responseText).slice(0, 260) };',
  '        window.__ncHdr.req.push(rec);',
  '        if (window.__ncHdr.req.length > 40) window.__ncHdr.req.shift();',
  '      } catch (e) {}',
  '    });',
  '    return ss.apply(this, arguments);',
  '  };',
  '  var of = window.fetch;',
  '  window.fetch = function (input, init) {',
  '    var u = typeof input === "string" ? input : (input && input.url) || "";',
  '    var h = {};',
  '    try { var ih = (init && init.headers) || (input && input.headers); if (ih) { if (typeof ih.forEach === "function") ih.forEach(function (v, k) { h[k] = v; }); else Object.keys(ih).forEach(function (k) { h[k] = ih[k]; }); } } catch (e) {}',
  '    var p = of.apply(this, arguments);',
  '    p.then(function (res) { try { window.__ncHdr.req.push({ url: String(u).slice(0, 150), hdr: h, status: res.status, via: "fetch" }); } catch (e) {} });',
  '    return p;',
  '  };',
  '  return "hooked";',
  '})()'
].join('\n');

const CLICK = [
  '(function(){',
  '  var items = Array.from(document.querySelectorAll(".lesson-item"));',
  '  var t = items.filter(function(e){ return /已观看\\s*0%/.test(e.innerText || ""); })[0] || items[0];',
  '  if (!t) return "none";',
  '  t.click();',
  '  return (t.innerText || "").replace(/\\s+/g, " ").slice(0, 40);',
  '})()'
].join('\n');

const REPRO = [
  '(async function(){',
  '  var url = "https://gateway.shengshengketang.com/api/course/vod/getVideoPlayAuth?videoId=b06575ee977e71f0bfc95420848d0102&currId=1955104870025424897";',
  '  try { var r = await fetch(url, { credentials: "include" }); var t = await r.text(); return "status=" + r.status + " body=" + t.slice(0, 200); }',
  '  catch (e) { return "ERR " + e.message; }',
  '})()'
].join('\n');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes('course/v2'));
if (!t) { console.log('没有课程页'); process.exit(1); }
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

console.log('A> 钩子: ' + await ev(c, HOOK));
console.log('B> 点课时: ' + await ev(c, CLICK));
await sleep(20000);
console.log('C> 页面真实请求(最近6条):');
console.log(await ev(c, 'JSON.stringify((window.__ncHdr && window.__ncHdr.req || []).slice(-6), null, 1)'));
console.log('D> 我们复现 getVideoPlayAuth: ' + await ev(c, REPRO));
console.log('E> 页面自己有没有调 getVideoPlayAuth:');
console.log(await ev(c, 'JSON.stringify((window.__ncHdr && window.__ncHdr.req || []).filter(function(x){return /getVideoPlayAuth|getPlayInfo/.test(x.url);}))'));
console.log('F> cookie: ' + await ev(c, 'document.cookie'));
console.log('G> storage keys: ' + await ev(c, 'JSON.stringify(Object.keys(localStorage))'));
c.close();
