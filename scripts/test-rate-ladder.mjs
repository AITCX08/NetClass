/**
 * test-rate-ladder.mjs —— 逐档测试华医网直播回放允许的最高倍速
 *
 * 方法（每档都真实截图 + 真实计时）：
 *   1. 设置 playbackRate = N
 *   2. 观察 20 秒：记录 currentTime 推进量（墙钟对比算实际倍率）
 *   3. 同时检测页面上是否出现「播放行为异常 / 已停止播放」
 *   4. 记录 video 的 playbackRate 实际值（站点可能自己改回去）
 *
 * 判定：
 *   eff ≈ N（±0.1）且无异常  → 该档可用
 *   出现异常 / 视频暂停 / eff 远小于 N → 该档被拦
 *
 * 每档测完立刻压回 1x 继续，尽量少影响进度。
 *
 * 用法: node runs/test-rate-ladder.mjs --port 9250 [--rates 1,1.25,1.5,2] [--secs 20]
 */
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs';

const argv = process.argv.slice(2);
function arg(n, d) { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; }
const PORT = Number(arg('port', 9250));
const RATES = String(arg('rates', '1,1.25,1.5,1.75,2')).split(',').map(Number);
const SECS = Number(arg('secs', 20));

const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findPlayer() {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
  return pages.find(p => /CoursePlay/.test(p.url)) || null;
}

async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (me, pa = {}, to = 25000) => new Promise(res => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
  });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const snap = async (n) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result?.data) { writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.result.data, 'base64')); }
  };
  return { ws, send, ev, snap };
}

const PROBE = `(function(){
  var v = document.querySelector('video');
  var err = /播放行为异常|已停止播放/.test(document.body.innerText||'');
  if (!v) return JSON.stringify({v:0, err:err});
  return JSON.stringify({
    v:1,
    t: Math.round(v.currentTime*100)/100,
    d: Math.round(v.duration||0),
    r: v.playbackRate,
    pa: v.paused,
    rs: v.readyState,
    err: err,
    pct: Math.round(v.currentTime/(v.duration||1)*1000)/10
  });
})()`;

const t = await findPlayer();
if (!t) { console.log('端口 ' + PORT + ' 没有 CoursePlay 页'); process.exit(1); }
console.log('播放器: ' + t.url.match(/courseware_id=(\w{8})/)[1]);
console.log('测试档位: ' + RATES.join(' / ') + '   每档 ' + SECS + ' 秒\n');

const h = await attach(t);
await h.send('Page.enable'); await h.send('Runtime.enable');
await sleep(800);

const results = [];

for (const rate of RATES) {
  console.log('='.repeat(56));
  console.log('测试 ' + rate + 'x');

  // 确保先回到 1x + 播放，拿基准
  await h.ev(`(function(){var v=document.querySelector('video');if(!v)return 0;try{v.playbackRate=1;}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){});return 1})()`);
  await sleep(1500);
  const base = JSON.parse(await h.ev(PROBE) || '{}');
  if (!base.v) { console.log('  ❌ 没有 video'); break; }
  if (base.err) {
    console.log('  ⚠ 起点就有「播放行为异常」，先重载恢复');
    await h.send('Page.reload', { ignoreCache: false });
    await sleep(12000);
    continue;
  }

  // 设置目标倍速
  const setRes = await h.ev(`(function(){
    var v = document.querySelector('video');
    if (!v) return 'no video';
    try { v.playbackRate = ${rate}; } catch(e) { return 'set err: ' + e.message; }
    var p = v.play(); if (p && p.catch) p.catch(function(){});
    return 'set to ' + v.playbackRate;
  })()`);
  console.log('  ' + setRes);
  await sleep(600);

  // 采 3 个点
  const t0 = Date.now();
  const s0 = JSON.parse(await h.ev(PROBE) || '{}');
  const samples = [];
  for (let k = 1; k <= 3; k++) {
    await sleep(Math.max(3000, (SECS * 1000) / 3));
    const s = JSON.parse(await h.ev(PROBE) || '{}');
    samples.push(s);
  }
  const wall = (Date.now() - t0) / 1000;
  const sLast = samples[samples.length - 1];
  const adv = (sLast.t || 0) - (s0.t || 0);
  const eff = wall > 0 ? adv / wall : 0;
  const anyErr = samples.some(s => s.err);
  const anyPaused = samples.some(s => s.pa);

  console.log('  设置后 r=' + s0.r + ' → 采样中 r=' + samples.map(s => s.r).join('/'));
  console.log('  墙钟 ' + wall.toFixed(1) + 's  advance=' + adv.toFixed(1) + 's  实际倍率=' + eff.toFixed(2));
  console.log('  异常=' + anyErr + '  暂停过=' + anyPaused);

  let verdict;
  if (anyErr) verdict = '❌ 被拦（播放行为异常）';
  else if (anyPaused && adv < 1) verdict = '❌ 被拦（视频被暂停）';
  else if (eff < rate * 0.7) verdict = '⚠ 实际只跑到 ' + eff.toFixed(2) + 'x（未达目标）';
  else verdict = '✅ 可用（' + eff.toFixed(2) + 'x）';

  console.log('  判定: ' + verdict);

  results.push({ rate, eff: +eff.toFixed(2), err: anyErr, paused: anyPaused, verdict, rReported: samples.map(s => s.r) });

  // 每档测完压回 1x
  await h.ev(`(function(){var v=document.querySelector('video');if(!v)return 0;try{v.playbackRate=1;}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){});return 1})()`);
  await sleep(1500);

  // 若被拦，重载恢复
  if (anyErr || (anyPaused && adv < 1)) {
    console.log('  重载恢复...');
    await h.send('Page.reload', { ignoreCache: false });
    await sleep(13000);
    await h.ev(`(function(){var v=document.querySelector('video');if(!v)return 0;try{v.playbackRate=1;}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){});return 1})()`);
    await sleep(1500);
    const rec = JSON.parse(await h.ev(PROBE) || '{}');
    console.log('  恢复后: ' + JSON.stringify({t: rec.t, r: rec.r, pa: rec.pa, err: rec.err}));
  }
  console.log('');
}

await h.snap('rate-ladder-final');
h.ws.close();

// 汇总
console.log('\n' + '='.repeat(56));
console.log('汇总');
console.log('='.repeat(56));
for (const r of results) {
  console.log('  ' + String(r.rate).padStart(5) + 'x  →  实际 ' + String(r.eff).padStart(5) + 'x   ' + r.verdict);
}
const okRates = results.filter(r => r.verdict.startsWith('✅')).map(r => r.rate);
const maxOk = okRates.length ? Math.max(...okRates) : null;
console.log('\n  ★ 最高可用倍速: ' + (maxOk !== null ? maxOk + 'x' : '（本次全部被拦，需人工确认）'));
writeFileSync(`${OUT}/rate-ladder-result.json`, JSON.stringify({ port: PORT, secs: SECS, results, maxOk }, null, 2));
console.log('  结果已存: ' + OUT + '/rate-ladder-result.json');
