/** tm-bridge-obj.mjs — 深挖油猴桥接对象 tm_xxx 的内部状态 */
const PORT = Number(process.argv[2] || 9225);
const URL_ = process.argv[3] || 'https://study.bjqiyang.com/agent/Goods/courses?goods_id=46789&store_id=1&bo=' + Date.now();
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
        if (m.method === 'Runtime.exceptionThrown') this.events.push('[EXC] ' + String(m.params.exceptionDetails.text || '').slice(0, 300) + ' :: ' + String(((m.params.exceptionDetails.exception || {}).description) || '').slice(0, 300));
        if (m.method === 'Runtime.consoleAPICalled') this.events.push('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 250));
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

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const c = new Cdp(tab.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Page.navigate', { url: URL_ });
await sleep(14000);

const w = c.worlds[0];
if (!w) { console.log('no TM world'); process.exit(1); }

const ev = async expr => {
  const r = await c.send('Runtime.evaluate', { contextId: w.id, expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  return r.result && r.result.value;
};

console.log('== tm_* 对象 ==');
console.log(await ev(`(function(){
  var name = Object.getOwnPropertyNames(window).filter(function(k){ return /^tm_/.test(k); })[0];
  if (!name) return 'no tm_ global';
  var o = window[name];
  return JSON.stringify({ name: name, type: typeof o, keys: Object.keys(o), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(o) || {}), sample: String(o).slice(0, 100) }, null, 1);
})()`));

console.log('');
console.log('== 试着调用桥接（看它是否响应）==');
console.log(await ev(`(async function(){
  var name = Object.getOwnPropertyNames(window).filter(function(k){ return /^tm_/.test(k); })[0];
  if (!name) return 'no bridge';
  var o = window[name];
  var out = {};
  try {
    if (typeof o === 'function') { out.callResult = String(o()); }
    for (var k of Object.keys(o)) { if (typeof o[k] === 'function') out['fn_' + k] = 'function'; }
    if (o.postMessage) { try { o.postMessage({ __probe: 1 }); out.postMessage = 'sent'; } catch (e) { out.postMessage = 'ERR ' + e.message; } }
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out, null, 1);
})()`));

console.log('');
console.log('== 页面文档状态 ==');
console.log(await ev(`JSON.stringify({ rs: document.readyState, url: String(location.href).slice(0, 60), bodyChildren: document.body ? document.body.children.length : -1 })`));

console.log('');
console.log('== 桥接的异常 ==');
for (const e of c.events.slice(-15)) console.log('  ' + e);

// 关键：看 background 是否回复了 content script
console.log('');
console.log('== Chrome runtime 消息统计（SW 侧）==');
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes('dhdgffkkebhmkfjojejmpbldmpobfkfo'));
if (sw) {
  const c2 = new Cdp(sw.webSocketDebuggerUrl);
  await c2.open();
  await c2.send('Runtime.enable').catch(() => { });
  const r = await c2.send('Runtime.evaluate', {
    expression: `(async function(){
      var out = {};
      try { out.registered = (await chrome.userScripts.getScripts()).map(function(s){ return s.id; }); } catch (e) { out.regErr = String(e); }
      try {
        var tabs = await chrome.tabs.query({ active: true });
        out.tabs = tabs.length;
      } catch (e) { out.tabErr = String(e); }
      return JSON.stringify(out);
    })()`, returnByValue: true, awaitPromise: true
  });
  console.log('  ' + (r.result && r.result.value));
  c2.close();
}
c.close();
