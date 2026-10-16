/** tm-worlds.mjs — 监听页面创建的 execution context（world），看 TM 的桥接是否真的执行 */
const PORT = Number(process.argv[2] || 9225);
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const URL_ = process.argv[3] || 'https://study.bjqiyang.com/agent/Goods/courses?goods_id=46789&store_id=1&w=' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.events = []; this.worlds = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Runtime.executionContextCreated') {
          const ctx = m.params.context;
          this.worlds.push({ id: ctx.id, name: ctx.name, origin: String(ctx.origin || '').slice(0, 60), aux: ctx.auxData ? JSON.stringify(ctx.auxData).slice(0, 80) : null });
        }
        if (m.method === 'Runtime.exceptionThrown') this.events.push('[EXC] ' + String(m.params.exceptionDetails.text || '').slice(0, 200));
        if (m.method === 'Log.entryAdded') this.events.push('[' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 200));
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

// 先创建一个空页，附加监听，再导航过去 —— 这样能抓到 document_start 的 world 创建
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const c = new Cdp(tab.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Log.enable').catch(() => { });

console.log('== 导航到目标页 ==');
await c.send('Page.navigate', { url: URL_ });
await sleep(15000);

console.log('== 页面里创建的 worlds ==');
for (const w of c.worlds) console.log('  id=' + w.id + ' name="' + w.name + '" origin=' + w.origin + ' aux=' + w.aux);

console.log('== 事件 ==');
for (const e of c.events.slice(-20)) console.log('  ' + e);

console.log('== 主世界检查 ==');
const r = await c.send('Runtime.evaluate', { expression: 'JSON.stringify({netclass: !!window.NetClass, ext: typeof window.external!=="undefined" && !!window.external.Tampermonkey, tmGlobal: typeof window.__tampermonkey__ !== "undefined"})', returnByValue: true });
console.log('  ' + (r.result && r.result.value));
c.close();
