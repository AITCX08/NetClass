/**
 * home-read2.mjs —— 先点「首页」导航，再读四项进度（两个端口）
 */
const PORTS = [9231, 9250];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });

for (const port of PORTS) {
  console.log('\n================ ' + port + ' ================');
  let l;
  try { l = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json(); }
  catch { console.log('  ❌ CDP 不通'); continue; }

  const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
  const t = pages.find(p => /ExerciseHome/.test(p.url));
  if (!t) { console.log('  ❌ 没有 ExerciseHome'); continue; }

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
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(400);
  };

  await send('Page.enable'); await send('Runtime.enable');
  await sleep(600);

  // 点首页
  const h = JSON.parse(await ev(`(function(){
    var b = Array.from(document.querySelectorAll('div')).filter(function(e){
      return e.offsetParent && (e.innerText||'').trim()==='首页' && /navItem/.test(e.className||'');
    })[0];
    if(!b) return 'null';
    var r = b.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});
  })()`) || 'null');
  console.log('  点首页 ' + JSON.stringify(h));
  if (h && h.x) await clickAt(h.x, h.y);
  await sleep(6000);

  // 读四项
  const txt = String(await ev(`(document.body.innerText||'').replace(/\\s+/g,' ')`));
  const m1 = txt.match(/综合进度\s*([0-9.]+\/\d+)\s*学时[,，]\s*直播进度\s*([0-9.]+\/\d+)\s*学时/);
  const m2 = txt.match(/共\s*([0-9.]+)\s*学时[,，]\s*已学\s*([0-9.]+)\s*学时/);
  const m3 = txt.match(/共\s*(\d+)\s*个问卷[,，]\s*已完成\s*(\d+)\s*个?问卷/);
  console.log('  直播课程: ' + (m1 ? '综合 ' + m1[1] + '，直播 ' + m1[2] : '(未匹配)'));
  console.log('  课程学习: ' + (m2 ? '共 ' + m2[1] + '，已学 ' + m2[2] : '(未匹配)'));
  console.log('  调查问卷: ' + (m3 ? m3[2] + '/' + m3[1] : '(未匹配)'));
  console.log('  原文片段: ' + txt.slice(0, 400));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) {
    fs.writeFileSync(`${OUT}/home2-${port}.png`, Buffer.from(s.result.data, 'base64'));
    console.log('  📸 home2-' + port + '.png');
  }
  ws.close();
}
