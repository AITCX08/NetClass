/** player-click.mjs — 找到并点击播放器中央的播放按钮，观察视频是否起播 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  close() { try { this.ws.close(); } catch { } }
}
async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  if (r && r.err) return 'EVAL-ERR ' + r.err;
  if (r && r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300);
  return r && r.result ? r.result.value : '(none)';
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes('course/v2'));
if (!t) { console.log('没有课程页'); process.exit(1); }
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

console.log('1> 播放器区域 DOM 概览');
console.log(await ev(c, [
  'JSON.stringify((function(){',
  '  var pc = document.querySelector(".video-player") || document.querySelector(".video-container");',
  '  if (!pc) return { none: true };',
  '  var btns = Array.from(pc.querySelectorAll("div,span,button,i,xg-icon,xg-start")).filter(function(e){ return /xgplayer|xg-/.test(e.className || ""); }).slice(0, 18).map(function(e){ return { cls: String(e.className).slice(0, 60), text: (e.innerText || "").trim().slice(0, 16), vis: !!(e.offsetWidth || e.offsetHeight) }; });',
  '  var v = pc.querySelector("video");',
  '  return { btns: btns, videoCls: v ? String(v.className).slice(0, 40) : null, videoVisible: v ? (v.offsetWidth + "x" + v.offsetHeight) : null, poster: pc.querySelector(".xgplayer-poster") ? true : false };',
  '})(), null, 1)'
].join('\n')));

console.log('2> 尝试点播放按钮');
console.log(await ev(c, [
  '(function(){',
  '  var cands = [".xgplayer-start", ".xgplayer-play", ".xgplayer-play-btn", ".xgplayer-center", ".xgplayer-poster", "xg-start"];',
  '  for (var i = 0; i < cands.length; i++) {',
  '    var el = document.querySelector(cands[i]);',
  '    if (el && (el.offsetWidth || el.offsetHeight)) { el.click(); return "clicked " + cands[i]; }',
  '  }',
  '  var pc = document.querySelector(".video-container");',
  '  if (pc) { var r = pc.getBoundingClientRect(); return "no-button; container " + Math.round(r.width) + "x" + Math.round(r.height); }',
  '  return "no-console";',
  '})()'
].join('\n')));

await sleep(18000);
console.log('3> 起播后状态');
console.log(await ev(c, 'JSON.stringify(window.NetClass ? window.NetClass.videoInfo() : null)'));
console.log('4> vod 相关接口:');
console.log(await ev(c, 'JSON.stringify((window.NetClass ? window.NetClass.apis() : []).filter(function(a){return /vod|viewing/.test(a.url);}).slice(-6))'));
c.close();
