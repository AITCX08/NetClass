/** ss-rate-apply.mjs — 正确走 UI：开菜单 -> 点 1.5x -> 观察是否保持 */
const PORT = Number(process.argv[2] || 9224);
const TARGET = process.argv[3] || '1.5';
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

console.log('== 开菜单（鼠标事件 + 去掉 hide）==');
console.log(await ev(`(function(){
  var icon = document.querySelector('.xgplayer-playbackrate');
  if (icon) {
    ['mouseenter','mouseover','mousemove','click'].forEach(function(t){
      try { icon.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (e) {}
    });
  }
  var listEl = document.querySelector('.xg-options-list');
  if (listEl) listEl.classList.remove('hide');
  return JSON.stringify({ iconFound: !!icon, menuVisible: listEl ? !!(listEl.offsetWidth || listEl.offsetHeight) : null, menuCls: listEl ? String(listEl.className) : null });
})()`));
await sleep(1500);

console.log('');
console.log('== 点 ' + TARGET + 'x ==');
console.log(await ev(`(function(){
  var li = document.querySelector('li.option-item[rate="${TARGET}"]');
  if (!li) return 'no such li';
  li.click();
  return 'clicked ' + li.getAttribute('showtext');
})()`));

for (const wait of [1500, 4000, 8000, 15000]) {
  await sleep(wait === 1500 ? 1500 : wait - 1500);
  console.log('  ' + (wait / 1000) + 's: ' + await ev(`JSON.stringify({
    rate: (function(){ var v = document.querySelector('video'); return v ? v.playbackRate : null; })(),
    paused: (function(){ var v = document.querySelector('video'); return v ? v.paused : null; })(),
    iconText: (function(){ var e = document.querySelector('.xgplayer-playbackrate'); return e ? (e.innerText||'').trim().slice(0,6) : null; })(),
    selected: (function(){ var e = document.querySelector('li.option-item.selected'); return e ? e.getAttribute('showtext') : null; })()
  })`));
}

console.log('');
console.log('== 实测推进速度（12 秒）==');
const t0 = await ev('document.querySelector("video").currentTime');
const w0 = Date.now();
await sleep(12000);
const t1 = await ev('document.querySelector("video").currentTime');
const st = await ev('JSON.stringify({rate: document.querySelector("video").playbackRate})');
const dt = (Date.now() - w0) / 1000;
console.log('  真实 ' + dt.toFixed(1) + 's / 媒体 ' + (t1 - t0).toFixed(1) + 's → ' + ((t1 - t0) / dt).toFixed(2) + 'x  ' + st);
c.close();
