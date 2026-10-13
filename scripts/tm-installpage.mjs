/** tm-installpage.mjs — 排查油猴安装页为什么不弹安装对话框
 *  用法：node tm-installpage.mjs --port 9225
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.events = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method) this.events.push(m.method);
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify(p)); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

// 1) 浏览器级：所有 target（含 extension 页面、window）
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const bc = new Cdp(ver.webSocketDebuggerUrl);
await bc.open();
const targets = await bc.send('Target.getTargets');
console.log('=== 所有 targets ===');
for (const t of targets.targetInfos) {
  console.log(`  [${t.type}] ${t.url.slice(0, 120)}`);
}

// 2) 找脚本安装页，查它引用的脚本 & 是否有错误
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const inst = tabs.find(t => t.url.includes('script_installation'));
if (inst) {
  const c = new Cdp(inst.webSocketDebuggerUrl);
  await c.open();
  await c.send('Page.enable');
  await c.send('Runtime.enable').catch(() => { });
  await c.send('Log.enable').catch(() => { });

  const info = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      href: location.href, hash: location.hash,
      scripts: Array.from(document.querySelectorAll('script')).map(s => String(s.src || '').slice(0, 90)).filter(Boolean),
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => String(f.src || '').slice(0, 90)),
      bodyLen: (document.body.innerText || '').length
    })`, returnByValue: true
  });
  console.log('');
  console.log('=== 安装页信息 ===');
  console.log(info.result && info.result.value);

  // 再等几秒，看 dialog 是否出现
  await sleep(6000);
  const again = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      tmDialog: !!document.querySelector('[class*=tm-install], #tm-install, [id*=install]'),
      anyModal: Array.from(document.querySelectorAll('div')).filter(d => /安装|Install/i.test(d.innerText || '') && (d.innerText || '').length < 200).map(d => String(d.className).slice(0, 40)).slice(0, 6),
      events: 'see console'
    })`, returnByValue: true
  });
  console.log('=== 等待后 ===');
  console.log(again.result && again.result.value);
  console.log('事件: ' + [...new Set(c.events)].slice(0, 15).join(', '));
  c.close();
}
bc.close();
