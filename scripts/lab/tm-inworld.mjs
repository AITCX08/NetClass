/** tm-inworld.mjs — 进入油猴的 isolated world，看桥接脚本执行到哪一步、报了什麼错 */
const PORT = Number(process.argv[2] || 9225);
const URL_ = process.argv[3] || 'https://study.bjqiyang.com/agent/Goods/courses?goods_id=46789&store_id=1&iw=' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.worlds = []; this.events = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Runtime.executionContextCreated') {
          const ctx = m.params.context;
          if (/篡改|Tamper/.test(ctx.name)) this.worlds.push({ id: ctx.id, name: ctx.name });
        }
        if (m.method === 'Runtime.exceptionThrown') this.events.push('[EXC] ' + String(m.params.exceptionDetails.text || '').slice(0, 220));
        if (m.method === 'Runtime.consoleAPICalled') this.events.push('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 220));
        if (m.method === 'Log.entryAdded') this.events.push('[' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 220));
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

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const c = new Cdp(tab.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Log.enable').catch(() => { });

await c.send('Page.navigate', { url: URL_ });
await sleep(14000);

console.log('== 油猴 world ==');
console.log(JSON.stringify(c.worlds));

for (const w of c.worlds.slice(0, 2)) {
  console.log('');
  console.log('== 在 world ' + w.id + ' 里求值 ==');
  const r = await c.send('Runtime.evaluate', {
    contextId: w.id,
    expression: `JSON.stringify({
      keys: Object.keys(window).filter(function(k){ return /tamper|tm|TM/i.test(k); }).slice(0, 20),
      hasBridge: typeof window.__tm_bridge__ !== 'undefined',
      chromeRT: typeof chrome !== 'undefined' && chrome.runtime ? 'yes' : 'no',
      location: String(location.href).slice(0, 60),
      anyGlobal: Object.getOwnPropertyNames(window).filter(function(k){ return /^_|^tm|^TM/.test(k); }).slice(0, 25)
    })`, returnByValue: true
  }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  console.log('  ' + (r.result && r.result.value));
}

console.log('');
console.log('== 事件 ==');
for (const e of c.events.slice(-25)) console.log('  ' + e);
c.close();
