/** ss-next-debug.mjs — 查 shengsheng 的「下一节」候选元素，找出为什么点了没反应 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);

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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    nextCandidates: Array.from(document.querySelectorAll('button,a,div[class*=next],span[class*=next]')).map(function(el){
      var t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 20) return null;
      if (!/下一节|下一章|下一课|下一讲|继续学习|下一个视频|下一个/.test(t)) return null;
      return {
        tag: el.tagName,
        cls: String(el.className).slice(0, 50),
        text: t,
        visible: !!(el.offsetWidth || el.offsetHeight),
        disabled: el.disabled === true || /disabled/.test(String(el.className))
      };
    }).filter(Boolean).slice(0, 12),
    // 播放器区域结构
    playerArea: (function(){
      var el = document.querySelector('.video-container, .video-player');
      if (!el) return null;
      return { cls: String(el.className).slice(0, 60), text: (el.innerText||'').replace(/\\s+/g,' ').slice(0, 200) };
    })(),
    // 视频结束后的提示
    endOverlay: Array.from(document.querySelectorAll('div')).filter(function(d){
      var t = (d.innerText || '');
      return t.length < 120 && /播放结束|已看完|下一集|继续播放/.test(t);
    }).map(function(d){ return { cls: String(d.className).slice(0,50), text: (d.innerText||'').replace(/\\s+/g,' ').slice(0,60), visible: !!(d.offsetWidth||d.offsetHeight) }; }).slice(0, 6),
    // xgplayer 的重播按钮
    replayBtn: !!document.querySelector('.xgplayer-replay, [class*=replay]')
  }, null, 1)`, returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
