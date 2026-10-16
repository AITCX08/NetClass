/** webtrn-login.mjs — 登录教师培训平台（只用给的账密；若出现验证码则停下来交人工） */
const PORT = Number(process.argv[2] || 9226);
const USER = process.argv[3] || process.env.NC_USER || '';   // ★ 开源：账号从参数/环境变量读，不再硬编码
const PASS = process.argv[4] || '341157';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.logs = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) this.logs.push('NAV ' + String(m.params.frame.url).slice(0, 90));
        if (m.method === 'Runtime.consoleAPICalled') { const t = (m.params.args || []).map(a => String(a.value !== undefined ? a.value : '')).join(' '); if (t.trim()) this.logs.push('CON ' + t.slice(0, 120)); }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, { res }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => res({ result: { value: 'timeout' } }), 15000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('loginSmall'));
if (!page) { console.log('没找到登录页'); process.exit(1); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });

// 1) 检查验证码是否可见
const cap = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var img = document.querySelector('img[src*=authimg], img[id*=authCode], img[src*=authCode]');
    var inp = document.querySelector('#authCode');
    function vis(e){ return !!e && !!(e.offsetWidth || e.offsetHeight); }
    return JSON.stringify({ imgVisible: vis(img), inputVisible: vis(inp), imgW: img ? img.offsetWidth : null });
  })()`, returnByValue: true
});
const capState = JSON.parse(cap.result.value);
console.log('验证码状态: ' + JSON.stringify(capState));
if (capState.inputVisible || capState.imgVisible) {
  console.log('');
  console.log('⚠️ 登录需要验证码 —— 这一步交给你人工完成（脚本不碰验证码）。');
  console.log('   请在浏览器窗口里输入验证码并点登录；登录完成后告诉我，我接着处理研修内容。');
  c.close();
  process.exit(2);
}

// 2) 填账密并提交
console.log('填入账密并提交...');
const fill = await c.send('Runtime.evaluate', {
  expression: `(function(){
    function setVal(el, v) {
      if (!el) return false;
      var proto = Object.getPrototypeOf(el);
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    var u = document.querySelector('#loginId');
    var p = document.querySelector('#passwd');
    var okU = setVal(u, ${JSON.stringify(USER)});
    var okP = setVal(p, ${JSON.stringify(PASS)});
    return JSON.stringify({ okU: okU, okP: okP, uVal: u ? u.value.slice(0, 6) + '***' : null, pLen: p ? p.value.length : 0 });
  })()`, returnByValue: true
});
console.log('  填充: ' + fill.result.value);
await sleep(800);

const click = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var btns = Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],.tbr-btn'));
    var login = btns.find(function(b){ return /登\\s*录/.test((b.innerText || b.value || '')); });
    if (!login) return 'no-login-button';
    login.click();
    return 'clicked: ' + (login.innerText || login.value || '').trim();
  })()`, returnByValue: true
});
console.log('  提交: ' + click.result.value);

await sleep(8000);
const after = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({ url: location.href, title: document.title, body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 260) })`, returnByValue: true
});
console.log('');
console.log('提交后: ' + after.result.value);
console.log('导航记录:');
for (const l of c.logs.slice(-8)) console.log('  ' + l);
c.close();
