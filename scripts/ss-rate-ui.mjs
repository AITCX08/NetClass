/** ss-rate-ui.mjs — 走真实 UI：点开播放器倍速菜单，看有哪些档位，逐个试哪个能生效 */
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

console.log('== 1) 点开倍速菜单 ==');
console.log(await ev(`(function(){
  var icon = document.querySelector('.xgplayer-playbackrate, [class*=playbackrate]');
  if (!icon) return 'no rate icon';
  icon.click();
  return 'clicked: ' + String(icon.className).slice(0, 60);
})()`));
await sleep(1200);

console.log('');
console.log('== 2) 菜单里的档位 ==');
console.log(await ev(`(function(){
  var menus = Array.from(document.querySelectorAll('[class*=playbackrate] li, [class*=playbackrate] [class*=option], [class*=rate] li, [class*=rate-list] *, [class*=options] li'));
  var opts = menus.map(function(e){
    return { text: (e.innerText || '').trim().slice(0, 12), cls: String(e.className).slice(0, 50), visible: !!(e.offsetWidth || e.offsetHeight), data: e.getAttribute('data-rate') || e.getAttribute('rate') || null };
  }).filter(function(o){ return o.text; });
  // 也 dump 一下菜单容器
  var box = document.querySelector('[class*=playbackrate] .xgplayer-options, .xgplayer-playbackrate ul, [class*=playbackrate] [class*=list]');
  return JSON.stringify({ options: opts.slice(0, 15), boxHtml: box ? box.outerHTML.slice(0, 500) : null }, null, 1);
})()`));

console.log('');
console.log('== 3) 逐个试档位（每个试 4 秒看是否被拽回）==');
const rates = ['1.25', '1.5', '2'];
for (const r of rates) {
  const set = await ev(`(function(){
    var items = Array.from(document.querySelectorAll('li, [class*=option], [class*=item]'));
    var target = items.filter(function(e){
      var t = (e.innerText || '').trim();
      return t === '${r}x' || t === '${r}' || t === '${r}.0x';
    });
    if (!target.length) return 'not-found:${r}';
    target[0].click();
    return 'clicked ${r}';
  })()`);
  await sleep(4000);
  const st = await ev(`JSON.stringify({ rate: (function(){ var v = document.querySelector('video'); return v ? v.playbackRate : null; })(), icon: (function(){ var e = document.querySelector('[class*=playbackrate]'); return e ? (e.innerText||'').trim().slice(0,6) : null; })() })`);
  console.log('  ' + r + 'x -> ' + set + ' | 4 秒后: ' + st);
}
c.close();
