/** tm-info-probe.mjs — 检查主世界里的 _t.tm_info（桥接拿到的脚本清单） */
const PORT = Number(process.argv[2] || 9225);
const URL_ = process.argv[3] || 'https://study.bjqiyang.com/agent/Goods/courses?goods_id=46789&store_id=1&ti=' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.worlds = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Runtime.executionContextCreated') {
          const ctx = m.params.context;
          this.worlds.push({ id: ctx.id, name: ctx.name, isDefault: !!(ctx.auxData && ctx.auxData.isDefault), type: ctx.auxData && ctx.auxData.type });
        }
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

console.log('== worlds ==');
for (const w of c.worlds) console.log('  id=' + w.id + ' name="' + w.name + '" default=' + w.isDefault + ' type=' + w.type);

const evMain = async expr => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  return r.result && r.result.value;
};

console.log('');
console.log('== 主世界里的 tm 线索 ==');
console.log('  ' + await evMain(`(function(){
  var names = Object.getOwnPropertyNames(window).filter(function(k){ return /^_|tm|TM/i.test(k); });
  var out = { candidates: names.slice(0, 40), tmInfo: null };
  for (var i = 0; i < names.length; i++) {
    try { var v = window[names[i]]; if (v && typeof v === 'object' && v.tm_info) { out.tmInfo = { from: names[i], keys: Object.keys(v.tm_info), contentMode: v.tm_info.contentMode, scripts: v.tm_info.scripts ? Object.keys(v.tm_info.scripts).length : null, nonce: v.tm_info.nonce }; } } catch (e) {}
  }
  return JSON.stringify(out);
})()`));

console.log('');
console.log('== content 桥接是否拿到 info（看 USER_SCRIPT world）==');
const uw = c.worlds.find(w => /篡改|Tamper/.test(w.name));
if (uw) {
  const r = await c.send('Runtime.evaluate', {
    contextId: uw.id,
    expression: `(function(){
      var names = Object.getOwnPropertyNames(window);
      var out = { tmFlag: names.filter(function(k){ return /^tm_/.test(k); }), hasInfo: typeof _t !== 'undefined' && _t ? !!_t.tm_info : 'no _t' };
      try { if (typeof _t !== 'undefined' && _t && _t.tm_info) { out.tmInfo = { keys: Object.keys(_t.tm_info), contentMode: _t.tm_info.contentMode, scriptKeys: _t.tm_info.scripts ? Object.keys(_t.tm_info.scripts) : null }; } } catch (e) { out.infoErr = String(e); }
      return JSON.stringify(out);
    })()`, returnByValue: true
  }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  console.log('  ' + (r.result && r.result.value));
}
c.close();
