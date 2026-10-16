/** cc-state.mjs — 周期性打印 9228 上各 ccjyxy 标签的状态（看是否有东西在乱跳）
 *  node scripts/cc-state.mjs --secs 60 --every 5
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const SECS = Number(A.secs || 60), EVERY = Number(A.every || 5);

const JS = `(function(){
  function find(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=find(d);if(x)return x}}}catch(e){}return null}
  var v=find(document); var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  return JSON.stringify({
    onTrain:/学习总进度/.test(t), onCourse:/返回课程列表/.test(t),
    v: v?(Math.round(v.currentTime)+'/'+Math.round(v.duration||0)+'@'+v.playbackRate+(v.paused?'P':'R')):null,
    head:t.slice(0,42)
  });
})()`;
const end = Date.now() + SECS * 1000;
while (Date.now() < end) {
  const out = [];
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
    for (const t of cand) {
      const v = await new Promise(r => {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: JS, returnByValue: true } })));
        ws.addEventListener('message', e => { const x = JSON.parse(e.data); if (x.id === 1) { r(x.result.result.value); ws.close(); } });
        setTimeout(() => { r('?'); try { ws.close(); } catch (_) { } }, 6000);
      });
      out.push(t.id.slice(0, 6) + ':' + v);
    }
  } catch (e) { out.push('ERR ' + e.message); }
  console.log(new Date().toTimeString().slice(0, 8) + '  ' + out.join('   |   '));
  await new Promise(r => setTimeout(r, EVERY * 1000));
}
