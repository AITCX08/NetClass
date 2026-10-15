/**
 * ss-watch.mjs — shengsheng（9224）流卡死自愈看门狗【多标签版】
 *
 * 背景（2026-10-15 实测）：这个平台的视频是 **MSE blob 流**，流源会失效：
 *   `readyState=1`（只有元数据）+ `networkState=2`（一直加载但拿不到数据）+ `paused=true`，
 *   **currentTime 停住不动**；页面不报错、面板还显示"自动处理中" → 静默卡很久。
 *   另一种表现是页面直接显示 **"不支持的音频/视频格式 请试试刷新"**、`video 0/0`。
 *
 * ★ 绝对不要用 `video.load()`（会把 MSE SourceBuffer 清掉，播放器再也建不回来）。
 *   **正确修法 = `Page.reload`**：播放器重建流，平台从"已观看位置"续播。
 *
 * ★★ 第 27 轮修正：shengsheng 上**同时开着多个标签**（实测 2 个，各自一门课），
 *   旧版只盯"第一个标签"→ 第二个标签坏了一直没人管。现改为**遍历所有 shengsheng 标签**，
 *   逐标签独立计数与自愈。
 *
 * 用法：node scripts\ss-watch.mjs [--stall=3] [--interval=30]
 */
const P = 9224;
const argv = process.argv.slice(2);
const getArg = (k, d) => { const m = argv.find(a => a.startsWith('--' + k)); return m ? Number(m.split('=')[1] || m.split(' ')[1]) : d; };
const STALL = getArg('stall', 3);
const INTERVAL = getArg('interval', 30);

const { appendFileSync, mkdirSync } = await import('node:fs');
mkdirSync('runs', { recursive: true });
const log = (m) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + m;
  console.log(line);
  try { appendFileSync('runs/ss-watch.log', line + '\n'); } catch (_) { }
};

const PROBE = `(function(){
  function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
  var v = f(document); var t = (document.body.innerText||'').replace(/\\s+/g,' ');
  var p = document.getElementById('netclass-panel');
  return JSON.stringify({
    cur: v ? Math.round(v.currentTime) : null, dur: v ? Math.round(v.duration||0) : null,
    rate: v ? v.playbackRate : null, paused: v ? v.paused : null,
    ready: v ? v.readyState : null, net: v ? v.networkState : null,
    errToast: /不支持的音频|请试试刷新/.test(t),
    title: t.slice(0, 26),
    panel: p ? p.innerText.replace(/\\s+/g,'|').slice(0, 50) : null
  });
})()`;

async function tabs() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${P}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
    return list.filter(t => t.type === 'page' && /shengshengketang/.test(t.url));
  } catch (e) { return []; }
}
async function conn(p) {
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 8000); });
  let i = 0;
  const send = (m, pr = {}, ms = 12000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
  return { send, ev, close: () => { try { ws.close(); } catch (_) { } } };
}

log('=== shengsheng 看门狗（多标签版）启动：间隔 ' + INTERVAL + 's，卡死阈值 ' + STALL + ' 次 ===');
const state = {};   // targetId → { lastCur, stall }
let round = 0;

for (;;) {
  round++;
  const ts = await tabs();
  if (!ts.length) { log('无 shengsheng 标签'); }
  for (const p of ts) {
    const key = p.id.slice(0, 6);
    const st = state[p.id] || (state[p.id] = { lastCur: null, stall: 0, reloads: 0 });
    let d = null, c = null;
    try { c = await conn(p); const raw = await c.ev(PROBE); d = raw ? JSON.parse(raw) : null; } catch (_) { }
    try { if (c) c.close(); } catch (_) { }
    if (!d || d.cur === null) {
      log(key + ' [' + (d ? d.title : '?') + '] 无视频元素' + (d && d.errToast ? ' ⚠页面报错' : ''));
      if (d && d.errToast) { st.stall++; } else { st.stall = 0; }
    } else {
      const moving = st.lastCur !== null && d.cur > st.lastCur + 1;
      const atEnd = d.dur > 0 && d.cur >= d.dur - 2;
      if (moving || atEnd) st.stall = 0; else st.stall++;
      const stuck = !moving && !atEnd && (d.paused || d.ready !== 4 || d.errToast);
      log(key + ' [' + (d.title || '?').slice(0, 18) + '] cur=' + d.cur + '/' + d.dur + ' @' + d.rate + (d.paused ? ' 停' : ' 播') +
        ' rdy' + d.ready + ' net' + d.net + (d.errToast ? ' ⚠报错' : '') + ' | 未推进 ' + st.stall + '/' + STALL + ' | 已自愈 ' + st.reloads);
      if (st.stall >= STALL && stuck) {
        log('🔧 ' + key + ' 判定流卡死 → Page.reload（★ 不用 load()）');
        try {
          const c2 = await conn(p);
          await c2.send('Page.enable');
          await c2.send('Page.reload');
          c2.close();
        } catch (_) { }
        st.reloads++; st.lastCur = null; st.stall = 0;
        await new Promise(r => setTimeout(r, 25000));
        try {
          const c3 = await conn(p);
          const after = await c3.ev(PROBE); c3.close();
          log('   ' + key + ' 刷新后: ' + String(after).slice(0, 130));
        } catch (_) { }
        continue;
      }
      st.lastCur = d.cur;
    }
  }
  await new Promise(r => setTimeout(r, INTERVAL * 1000));
}
