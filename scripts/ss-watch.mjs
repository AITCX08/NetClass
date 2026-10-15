/**
 * ss-watch.mjs — shengsheng（9224）流卡死自愈看门狗
 *
 * 背景（2026-10-15 实测）：这个平台的视频是 **MSE blob 流**，
 * 流源会失效：表现为 `readyState=1`（只有元数据）+ `networkState=2`（一直加载但拿不到数据）
 * + `paused=true`，**currentTime 停住不动**。页面不报错、面板还显示"自动处理中"，
 * 所以会静默卡住很久（实测卡了 20 分钟没人管）。
 *
 * ★ 关键教训：**不要用 `video.load()` 去唤醒它**！
 *   实测 `load()` 之后 `networkState` 变成 3（NETWORK_NO_SOURCE）、`duration=0`、
 *   页面直接报"不支持的音频/视频格式" —— 因为 load() 把 MSE 的 SourceBuffer 一起清掉了。
 *   **正确修法是 `Page.reload`**：播放器重建流，平台从"已观看位置"续播（不丢进度，实测 1197→1260 接着播）。
 *
 * 用法：node scripts\ss-watch.mjs [--stall 3] [--interval 30]
 *   --stall     连续多少次采样不推进判定为卡死（默认 3）
 *   --interval  采样间隔秒（默认 30）
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

async function withTab(fn) {
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${P}/json/list`, { signal: AbortSignal.timeout(8000) })).json(); }
  catch (e) { return null; }
  const p = list.filter(t => t.type === 'page' && /shengshengketang/.test(t.url))[0];
  if (!p) return null;
  let ws;
  try {
    ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 8000); });
  } catch (e) { return null; }
  let i = 0;
  const send = (m, pr = {}, ms = 12000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
  try { return await fn(ev, send, p); } finally { try { ws.close(); } catch (_) { } }
}

const PROBE = `(function(){
  function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
  var v = f(document); var t = (document.body.innerText||'').replace(/\\s+/g,' ');
  var p = document.getElementById('netclass-panel');
  return JSON.stringify({
    cur: v ? Math.round(v.currentTime) : null, dur: v ? Math.round(v.duration||0) : null,
    rate: v ? v.playbackRate : null, paused: v ? v.paused : null,
    ready: v ? v.readyState : null, net: v ? v.networkState : null,
    errToast: /不支持的音频|请试试刷新/.test(t),
    panel: p ? p.innerText.replace(/\\s+/g,'|').slice(0, 60) : null
  });
})()`;

log('=== shengsheng 看门狗启动（间隔 ' + INTERVAL + 's，卡死阈值 ' + STALL + ' 次）===');
let lastCur = null, stallCount = 0, reloads = 0;

for (;;) {
  const raw = await withTab(ev => ev(PROBE));
  if (!raw) { log('CDP 不可达 / 无标签，等 ' + INTERVAL + 's'); await new Promise(r => setTimeout(r, INTERVAL * 1000)); continue; }
  let d; try { d = JSON.parse(raw); } catch (_) { d = null; }
  if (!d || d.cur === null) {
    log('无视频元素（' + (d && d.panel ? d.panel : '?') + '）');
  } else {
    const moving = lastCur !== null && d.cur > lastCur + 1;
    if (moving) stallCount = 0; else stallCount++;
    const isStuck = !moving && (d.paused || d.ready !== 4 || d.net === 2 || d.errToast);
    log('cur=' + d.cur + '/' + d.dur + ' @' + d.rate + (d.paused ? ' 停' : ' 播') + ' rdy' + d.ready + ' net' + d.net +
      (d.errToast ? ' ⚠播放器报错' : '') + ' | 未推进 ' + stallCount + '/' + STALL + ' | 已自愈 ' + reloads + ' 次');
    if (stallCount >= STALL && isStuck) {
      log('🔧 判定流卡死 → Page.reload 重建流（★ 不用 load()，那会清掉 MSE SourceBuffer）');
      const ok = await withTab(async (ev, send) => { await send('Page.enable'); await send('Page.reload'); return true; });
      reloads++;
      lastCur = null; stallCount = 0;
      log('   已下发刷新' + (ok ? '' : '（失败）') + '，等 25s 让播放器重建');
      await new Promise(r => setTimeout(r, 25000));
      const after = await withTab(ev => ev(PROBE));
      log('   刷新后: ' + String(after).slice(0, 150));
      continue;
    }
    lastCur = d.cur;
  }
  await new Promise(r => setTimeout(r, INTERVAL * 1000));
}
