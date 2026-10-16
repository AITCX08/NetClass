/** order-guard-watch.mjs — 观察课时切换：是否还会出现「请按顺序观看视频」 */
const PORT = Number(process.argv[2] || 9224);
const MINS = Number(process.argv[3] || 15);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.toasts = []; this.logs = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Runtime.consoleAPICalled') {
          const t = (m.params.args || []).map(a => String(a.value !== undefined ? a.value : '')).join(' ');
          if (/NetClass/.test(t)) this.logs.push(new Date().toISOString().slice(11, 19) + ' ' + t.slice(0, 140));
        }
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
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
if (!page) { console.log('no page'); process.exit(1); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });
console.log('观察 ' + MINS + ' 分钟...');

let orderBlockSeen = 0;
const end = Date.now() + MINS * 60000;
let lastLesson = '';
while (Date.now() < end) {
  await sleep(15000);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        t: (function(){ var v = document.querySelector('video'); return v ? Math.round(v.currentTime) : null; })(),
        dur: (function(){ var v = document.querySelector('video'); return v ? Math.round(v.duration) : null; })(),
        paused: (function(){ var v = document.querySelector('video'); return v ? v.paused : null; })(),
        rate: (function(){ var v = document.querySelector('video'); return v ? v.playbackRate : null; })(),
        lesson: (function(){ var a = document.querySelector('.lesson-item.active-lesson,.lesson-item.active'); return a ? (a.innerText||'').replace(/\\s+/g,' ').slice(0,32) : null; })(),
        done: Array.from(document.querySelectorAll('.lesson-item')).filter(function(e){ return /已完成/.test(e.innerText||''); }).length,
        toast: (function(){ var e = document.querySelector('.van-toast__text'); return e ? (e.innerText||'').trim() : ''; })(),
        next: window.NetClass ? window.NetClass.state.next : null
      })`, returnByValue: true
    });
    const s = JSON.parse(r.result.value);
    if (/按顺序/.test(s.toast || '')) { orderBlockSeen++; }
    const when = new Date().toISOString().slice(11, 19);
    console.log('[' + when + '] ' + (s.t + '/' + s.dur) + (s.paused ? ' 暂停' : ' 播放') + ' x' + s.rate +
      ' | 已完成 ' + s.done + ' | ' + (s.lesson || '') +
      ' | 跳转 ' + (s.next ? s.next.clicks : '?') + '/' + (s.next ? s.next.misses : '?') +
      (s.toast ? (' | ⚠️ toast: ' + s.toast.slice(0, 20)) : ''));
  } catch (e) { console.log('ERR ' + e.message); }
}
console.log('');
console.log('观察期内出现「请按顺序观看视频」次数: ' + orderBlockSeen);
console.log('');
console.log('=== NetClass 日志 ===');
for (const l of c.logs.slice(-25)) console.log('  ' + l);
c.close();
