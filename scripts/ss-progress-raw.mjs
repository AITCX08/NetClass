/** 抓 shengsheng 的进度原始事实：课时清单（名称/状态/时长）、页面上的百分比、总量 */
const PORT = Number(process.argv[2] || 9224);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && String(t.url).includes('shengshengketang'));
const EXPR = `(function(){
  function txt(e){ return (e.innerText||'').replace(/\\s+/g,' ').trim(); }
  var out = { url: location.pathname.slice(0, 44), title: document.title.slice(0,26) };
  // 站点自带的百分比
  var body = (document.body.innerText||'').replace(/\\s+/g,' ');
  out.sitePct = (body.match(/(\\d{1,3})%/)||[])[1] || null;
  out.progressWords = (body.match(/已学\\s*\\d+|已完成\\s*\\d+|学习进度[^。]{0,20}|共\\s*\\d+\\s*课时|已看[^。]{0,12}/g)||[]).slice(0,6);
  // 课时清单：名称 + 状态 + 时长
  var items = Array.from(document.querySelectorAll('.lesson-item, .lesson-status-container, li[class*=lesson]'));
  out.lessonCount = items.length;
  out.lessons = items.slice(0, 40).map(function(e){
    var t = txt(e);
    var st = (t.match(/(已完成|学习中|未开始|已学完|待学习)/)||[])[1] || '';
    var dur = (t.match(/(\\d{1,2}:\\d{2}(:\\d{2})?)/)||[])[1] || '';
    return { n: t.replace(/^.*?(第\\d+[章节]|\\d+\\.)/,'$1').slice(0, 22), st: st, dur: dur, raw: t.slice(0, 60) };
  });
  // 统计
  var done = out.lessons.filter(function(l){ return /已完成|已学完/.test(l.st) }).length;
  out.doneCount = done;
  // 时长求和（把 mm:ss / hh:mm:ss 都转成秒）
  function toSec(s){ if(!s) return 0; var p = s.split(':').map(Number); return p.length===3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; }
  out.totalSec = out.lessons.reduce(function(a,l){ return a + toSec(l.dur); }, 0);
  out.remainSec = out.lessons.filter(function(l){ return !/已完成|已学完/.test(l.st) }).reduce(function(a,l){ return a + toSec(l.dur); }, 0);
  var v = document.querySelector('video');
  out.video = v ? { cur: Math.round(v.currentTime), dur: Math.round(v.duration||0), rate: v.playbackRate } : null;
  return JSON.stringify(out);
})()`;
for (const p of pages) {
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const r = await new Promise(res => {
    let done = false;
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === 1) { ws.removeEventListener('message', on); done = true; res(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }));
    setTimeout(() => { if (!done) res({ timeout: true }); }, 15000);
  });
  console.log('=== ' + p.id.slice(0, 8) + ' ===');
  console.log(String(r.timeout ? '超时' : (r.result && r.result.result && r.result.result.value)).slice(0, 1400));
  ws.close();
}
