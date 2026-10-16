/** ccinject.mjs — 直接向页面注入猎捕器（含 2x 倍速锁），不依赖驱动是否调用 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
console.log('ccjyxy 标签: ' + pages.length);
/** 直接引用共享库里的 HUNTER_JS —— ★ 单一来源，避免两份实现分叉
 *  （踩过的坑：本脚本曾自带一份旧版猎捕器，没有心跳自检，
 *    导致页面上装的是旧版、`beatAgo` 永远 none、倍速掉回 1x 也无人察觉） */
import { HUNTER_JS as HUNTER_FROM_LIB } from './cc-lib.mjs';
const HUNTER = HUNTER_FROM_LIB;
const _OLD_HUNTER_UNUSED = `(function(){
  try { if (!localStorage.getItem('ncCc:rate')) localStorage.setItem('ncCc:rate','2'); } catch(e){}
  if (window.__ccHunt) return 'already';
  window.__ccLog = [];
  window.__ccHunt = setInterval(function(){
    function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
    var v = f(document); if (!v) return;
    try { v.muted = true; } catch(e){}
    try {
      var R = parseFloat(localStorage.getItem('ncCc:rate') || '2');
      if (!v.__ccRateLock) {
        Object.defineProperty(v, 'playbackRate', {
          configurable: true,
          get: function(){ return R; },
          set: function(x){ if (Math.abs(x - R) < 0.01) { try { Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'playbackRate').set.call(v, x); } catch(e){} } }
        });
        v.__ccRateLock = 1;
      }
      try { Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'playbackRate').set.call(v, R); } catch(e){}
    } catch(e){}
    if (v.paused) { try { v.play().catch(function(){}); } catch(e){} }
    if (!v.__ccHooked) { v.__ccHooked = 1; v.addEventListener('playing', function(){ window.__ccLog.push('play@'+Math.round(v.currentTime)); }); }
  }, 300);
  return 'installed';
})()`;
for (const p of pages) {
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let i = 0;
  const send = (m, pr = {}, ms = 8000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  const r = await send('Runtime.evaluate', { expression: HUNTER, returnByValue: true, awaitPromise: true });
  const v = r && r.result && r.result.result ? r.result.result.value : '?';
  console.log('  ' + p.id.slice(0, 6) + ' → ' + v);
  ws.close();
}
