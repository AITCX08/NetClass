/** ss-rate-isolate.mjs — 隔离测试：停掉本脚本后，站点自己是否允许 1.5x */
const PORT = Number(process.argv[2] || 9224);
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
const ev = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  return r.result && r.result.value;
};

console.log('== 1) 停掉本脚本（dispose）==');
console.log(await ev(`(function(){
  try { if (window.NetClass && window.NetClass.dispose) { window.NetClass.dispose(); return 'disposed'; } } catch (e) { return 'err ' + e.message; }
  return 'no NetClass';
})()`));
await sleep(2000);
console.log('  NetClass 还在吗: ' + await ev('!!window.NetClass'));

console.log('');
console.log('== 2) 纯站点路径：点 1.5x ==');
await ev(`(function(){
  var icon = document.querySelector('.xgplayer-playbackrate');
  if (icon) ['mouseenter','click'].forEach(function(t){ try { icon.dispatchEvent(new MouseEvent(t,{bubbles:true})); } catch(e){} });
  var listEl = document.querySelector('.xg-options-list'); if (listEl) listEl.classList.remove('hide');
  return 'menu open';
})()`);
await sleep(1000);
console.log('  ' + await ev(`(function(){
  var li = document.querySelector('li.option-item[rate="1.5"]');
  if (!li) return 'no 1.5x item';
  li.click(); return 'clicked 1.5x';
})()`));

for (const w of [1000, 3000, 6000, 12000]) {
  await sleep(w === 1000 ? 1000 : 2000);
  console.log('  ~' + (w / 1000) + 's: ' + await ev(`JSON.stringify({ rate: document.querySelector('video').playbackRate, selected: (function(){var e=document.querySelector('li.option-item.selected'); return e?e.getAttribute('showtext'):null;})(), paused: document.querySelector('video').paused })`));
}

console.log('');
console.log('== 3) 直接设 2x（无脚本干扰）==');
console.log(await ev(`(function(){ var v=document.querySelector('video'); v.playbackRate=2; return 'set 2 -> ' + v.playbackRate; })()`));
await sleep(6000);
console.log('  6s 后: ' + await ev(`JSON.stringify({ rate: document.querySelector('video').playbackRate, paused: document.querySelector('video').paused })`));

console.log('');
console.log('== 4) 实测推进（10 秒）==');
const t0 = await ev('document.querySelector("video").currentTime');
const w0 = Date.now();
await sleep(10000);
const t1 = await ev('document.querySelector("video").currentTime');
const dt = (Date.now() - w0) / 1000;
console.log('  真实 ' + dt.toFixed(1) + 's / 媒体 ' + (t1 - t0).toFixed(1) + 's → ' + ((t1 - t0) / dt).toFixed(2) + 'x');
c.close();
