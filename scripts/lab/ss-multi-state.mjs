/** 列出 9224 上所有 shengsheng 课程页的实时状态（多标签并行时看冲突/进度） */
const PORT = Number(process.argv[2] || 9224);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && String(t.url).includes('shengshengketang'));
console.log('shengsheng 页面数: ' + pages.length);
const EXPR = `(function(){
  try {
    var v = document.querySelector('video');
    var st = (window.NetClass && NetClass.state) ? NetClass.state : null;
    return JSON.stringify({
      url: location.href.replace(/^https?:\\/\\/[^/]+/, '').slice(0, 70),
      title: document.title.slice(0, 30),
      module: window.NetClass ? NetClass.version : null,
      enabled: (window.NetClass && NetClass.cfg) ? NetClass.cfg.enabled : null,
      video: st ? st.video : null,
      quiz: st ? st.quiz : null,
      allDone: st ? st.allDone : null,
      media: v ? { cur: Math.round(v.currentTime), dur: Math.round(v.duration || 0), rate: v.playbackRate, paused: v.paused, muted: v.muted, ready: v.readyState } : null,
      lists: {
        cards: document.querySelectorAll('.classify-card').length,
        lessons: document.querySelectorAll('.lesson-item').length,
        subs: document.querySelectorAll('span.state-tag').length
      }
    });
  } catch (e) { return 'ERR ' + e.message; }
})()`;
for (const p of pages) {
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const r = await new Promise(res => {
    const id = 1; let done = false;
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); done = true; res(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }));
    setTimeout(() => { if (!done) res({ timeout: true }); }, 12000);
  });
  console.log('--- ' + p.id.slice(0, 8));
  console.log('    ' + String(r.timeout ? '求值超时' : (r.result && r.result.result && r.result.result.value)).slice(0, 500));
  ws.close();
}
