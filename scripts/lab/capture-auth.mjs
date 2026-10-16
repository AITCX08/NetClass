/**
 * capture-auth.mjs — 在课程页里抓「页面自身请求」的头部，定位 getVideoPlayAuth 的鉴权方式
 * 用法：node capture-auth.mjs --port 9224 [--wait 25]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const WAIT = Number(A.wait || 25);
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
        if (m.id && this.pending.has(m.id)) { const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && t.url.includes('shengshengketang'));
console.log('课程相关页面: ' + pages.length);

let picked = null, c = null;
for (const t of pages) {
  const cc = new Cdp(t.webSocketDebuggerUrl);
  try { await cc.open(); } catch { continue; }
  const r = await cc.send('Runtime.evaluate', { expression: '!!window.NetClass', returnByValue: true }).catch(() => null);
  const ok = r && r.result && r.result.value;
  console.log('  ' + (ok ? '[有脚本]' : '[无脚本]') + ' ' + t.url.slice(0, 80));
  if (ok && !picked) { picked = t; c = cc; } else cc.close();
}
if (!picked) { console.log('没有带脚本的课程页'); process.exit(1); }
console.log('用这个页面: ' + picked.url);

// 1) 记录点击前的状态（带异常信息）
async function ev(cc, expr) {
  const r = await cc.send('Runtime.evaluate', { expression: expr, returnByValue: true }).catch(e => ({ err: String(e) }));
  if (r && r.err) return 'EVAL-ERR ' + r.err;
  if (r && r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300);
  return r && r.result ? r.result.value : '(none)';
}

console.log('探测 NetClass: ' + await ev(c, `JSON.stringify({
  hasNetClass: !!window.NetClass,
  keys: window.NetClass ? Object.keys(window.NetClass) : null,
  version: window.NetClass ? window.NetClass.version : null
})`));

console.log('点击前: ' + await ev(c, `JSON.stringify({ headers: (window.NetClass.headers ? window.NetClass.headers().length : -1), apis: (window.NetClass.apis ? window.NetClass.apis().length : -1) })`));

// 2) 点开一个未完成课时
console.log('点击: ' + await ev(c, `(() => {
    const items = Array.from(document.querySelectorAll('.lesson-item'));
    const t = items.find(e => /已观看\\s*0%/.test(e.innerText || '')) || items.find(e => !/已完成/.test(e.innerText || ''));
    if (t) { t.click(); return (t.innerText || '').replace(/\\s+/g, ' ').slice(0, 40); }
    return 'none';
  })()`));

// 3) 等页面自己发请求
await sleep(WAIT * 1000);

console.log('=== 结果 ===');
console.log('headers: ' + await ev(c, `JSON.stringify((window.NetClass.headers ? window.NetClass.headers() : []).slice(-8))`));
console.log('vod: ' + await ev(c, `JSON.stringify((window.NetClass.headers ? window.NetClass.headers('vod') : []))`));
console.log('apis: ' + await ev(c, `JSON.stringify((window.NetClass.apis ? window.NetClass.apis() : []).slice(-10))`));
console.log('video: ' + await ev(c, `JSON.stringify(window.NetClass.videoInfo ? window.NetClass.videoInfo() : null)`));
c.close();
