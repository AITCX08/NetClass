#!/usr/bin/env node
/**
 * scripts/huayi-watch.mjs —— 华医网直播回放看护 + 自动轮转
 *
 * 站点硬约束（2026-10-23 实测）
 * ---------------------------
 *   1. 只能 1x：playbackRate=2 → 「播放行为异常，视频已停止播放」
 *   2. 单账号单路：同账号第二个播放页 → 「您有其他课程正在播放」，并把该页 video 销毁
 *   → 所以并行只能靠「两个账号 = 两个 profile = 两个 CDP 端口」，一个端口一路。
 *
 * 这个脚本对每个端口做同样的事
 * --------------------------
 *   ① 找 CoursePlay 标签；没有就自己开（用页面内 LiveOpenVideoPlay 的开法走不通，
 *      必须真鼠标点条目，或者直接 json/new 到 CoursePlay URL —— 后者更稳）
 *   ② 视频播到 ended / 或 pct>=99.5 → 换下一个未学完的回放
 *   ③ 掉暂停就 play()；倍速被改就压回 1
 *   ④ 每端口维护自己的「已完成」集合，避免重复
 *
 * 用法
 * ----
 *   node scripts/huayi-watch.mjs --ports 9231,9250
 *   node scripts/huayi-watch.mjs --ports 9231,9250 --every 30
 *   node scripts/huayi-watch.mjs --ports 9231 --once
 */
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const PORTS = String(arg('ports', '9231')).split(',').map(s => Number(s.trim())).filter(Boolean);
const EVERY = Number(arg('every', 30)) * 1000;
const ONCE = !!arg('once', false);

// 两个回放（顺序无关，脚本按「未完成」挑）
const REPLAYS = [
  { id: '825ac6fd-1c77-449b-9abd-081c0d1e2e67', name: '10月11日' },
  { id: 'b65f246f-25df-44a7-84a1-bf791c520469', name: '10月10日' },
];
const playUrl = id => `https://jcpxkh.91huayi.com/exercise/ExerciseCourse/CoursePlay?courseware_id=${id}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (port, ...a) => console.log('[' + ts() + '][' + port + ']', ...a);

async function listPages(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) });
    const l = await r.json();
    return (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
  } catch { return null; }
}

async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (me, pa = {}, to = 25000) => new Promise(res => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method: me, params: pa }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
  });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { ws, send, ev };
}

const PROBE = `(function(){
  var v = document.querySelector('video');
  var dlg = /您有其他课程正在播放/.test(document.body.innerText||'');
  var err = /播放行为异常|已停止播放/.test(document.body.innerText||'');
  if (!v) return JSON.stringify({v:0, dlg:dlg, err:err, url:location.href});
  return JSON.stringify({
    v:1,
    t: Math.round(v.currentTime),
    d: Math.round(v.duration||0),
    r: v.playbackRate,
    pa: v.paused,
    ended: v.ended,
    pct: Math.round(v.currentTime/(v.duration||1)*1000)/10,
    cw: (location.search.match(/courseware_id=([0-9a-f-]+)/)||[null,null])[1],
    dlg: dlg, err: err
  });
})()`;

const state = new Map();   // port -> { done:Set, current:null }

async function ensurePlaying(port) {
  const st = state.get(port) || { done: new Set(), current: null };
  state.set(port, st);

  const pages = await listPages(port);
  if (!pages) { log(port, 'CDP 不可达'); return; }

  // 有没有播放器页
  let pl = pages.find(p => /CoursePlay/.test(p.url));
  if (!pl) {
    // 挑一个还没完成的回放开
    const next = REPLAYS.find(r => !st.done.has(r.id));
    if (!next) { log(port, '★ 两个回放都已完成'); return; }
    log(port, '没有播放器页 → 开 ' + next.name);
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(playUrl(next.id))}`, { method: 'PUT' }).catch(() => { });
    await sleep(12000);
    return;
  }

  const h = await attach(pl);
  try {
    await h.send('Runtime.enable');
    let s = {};
    try { s = JSON.parse(await h.ev(PROBE) || '{}'); } catch { }

    if (!s.v) {
      log(port, '无 video（dlg=' + s.dlg + ' err=' + s.err + '）—— 等页面加载');
      return;
    }

    // 记录当前是哪个回放
    if (s.cw) st.current = s.cw;

    // 互斥弹窗 → 说明同账号有别的路在跑，本路必须退让
    if (s.dlg) {
      log(port, '⚠ 检测到「您有其他课程正在播放」——本账号有其他播放页');
      return;
    }

    // 完成了 → 标记 + 换下一个
    if (s.ended || s.pct >= 99.5) {
      st.done.add(s.cw);
      log(port, '★★ ' + (REPLAYS.find(r => r.id === s.cw)?.name || s.cw) + ' 已播完 (' + s.pct + '%)');
      const next = REPLAYS.find(r => !st.done.has(r.id) && r.id !== s.cw);
      if (!next) { log(port, '★ 本账号两个回放全部完成'); return; }
      log(port, '→ 切到 ' + next.name);
      await h.send('Page.navigate', { url: playUrl(next.id) });
      await sleep(12000);
      return;
    }

    // 反作弊触发 → 重载该页
    if (s.err) {
      log(port, '⚠ 「播放行为异常」→ 重载');
      await h.send('Page.reload', { ignoreCache: false });
      await sleep(12000);
      return;
    }

    // 保活：RATE + play
    if (s.r !== RATE || s.pa) {
      await h.ev(`(function(){var v=document.querySelector('video');if(!v)return 0;try{v.playbackRate=${RATE};}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){});return 1})()`);
      await sleep(800);
      const s2 = JSON.parse(await h.ev(PROBE) || '{}');
      log(port, (s.pa ? '恢复播放' : '压回 ' + RATE + 'x') + ' → r=' + s2.r + ' pa=' + s2.pa + ' t=' + s2.t);
    } else {
      log(port, '播放中  t=' + s.t + '/' + s.d + '  ' + s.pct + '%  r=' + s.r);
    }
  } finally {
    try { h.ws.close(); } catch { }
  }
}

// ★ P3：保活倍速由决策器给（profile.rate，华医网 hardKill → 1）。plan 挂了兜底 1，不影响在跑的单子。
const RATE = await import('./plan.mjs').then(m => m.planFor('huayi').rate).catch(() => 1);
console.log('华医网看护启动  端口=' + PORTS.join(',') + '  每 ' + (EVERY / 1000) + 's');
console.log('回放: ' + REPLAYS.map(r => r.name + '(' + r.id.slice(0, 8) + ')').join('  '));

let round = 0;
for (;;) {
  round++;
  if (round > 1) console.log('--- 第 ' + round + ' 轮 ---');
  for (const p of PORTS) {
    try { await ensurePlaying(p); } catch (e) { log(p, '异常: ' + e.message); }
  }
  if (ONCE) break;
  await sleep(EVERY);
}
console.log('退出');
