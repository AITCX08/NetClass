/**
 * cx-loop.mjs — 学习通自动循环驱动（控制器侧，跨页面刷新也能续）
 *   node scripts/cx-loop.mjs --port 9227 [--rounds 200] [--secs 12]
 * 每轮：跨 iframe 找 video →
 *   在播 → 记录进度
 *   暂停且未播完 → 静音 + 2x + 起播
 *   已播完 → 真实鼠标点「下一节」（站点不吃 el.click()）
 *   无视频（文档/PPT/测验页）→ 尝试点「下一节」跳过；章测试页则打印题目待接 DS
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const ROUNDS = Number(A.rounds || 200);
const SECS = Number(A.secs || 12);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const FIND_VIDEO = `(function(){function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}return f(document)})()`;

async function conn() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find(t => t.type === 'page' && /mooc1\.chaoxing/.test(t.url) && !/tampermonkey/.test(t.url));
  if (!p) return null;
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (m, params = {}, ms = 20000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({ timeout: true }), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
  return { ws, send, ev, url: p.url };
}

async function clickNext(c) {
  const box = await c.ev(`(function(){
    var el = Array.from(document.querySelectorAll('a,span,div,button')).find(function(e){ return (e.innerText||'').trim()==='下一节' && (e.offsetWidth||e.offsetHeight); });
    if (!el) return null; el.scrollIntoView({block:'center'});
    var r = el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)});
  })()`);
  if (!box) return 'no-next';
  const b = JSON.parse(box);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  return 'clicked';
}

let c = await conn();
if (!c) { console.log('没有课程页'); process.exit(1); }
console.log('[' + new Date().toTimeString().slice(0, 8) + '] 循环驱动启动 on ' + c.url.slice(0, 70));
let lastLesson = '';
for (let n = 1; n <= ROUNDS; n++) {
  try {
    if (!c || c.ws.readyState !== 1) { c = await conn(); if (!c) { await sleep(5000); continue; } }
    // 0) 先清掉挡路的平台弹窗（「当前章节还有任务点未完成，是否去完成？」→ 点绿色的「下一节」）
    const dlg = await c.ev(`(function(){
      var d = Array.from(document.querySelectorAll('div,section')).find(function(e){ var t=(e.innerText||''); return /还有任务点未完成|是否去完成/.test(t) && t.length < 200 && (e.offsetWidth||e.offsetHeight); });
      if (!d) return null;
      var b = Array.from(d.querySelectorAll('a,button,span,div')).filter(function(x){ return /^(下一节|去学习)$/.test((x.innerText||'').trim()) && (x.offsetWidth||x.offsetHeight); });
      var t = b.find(function(x){ return /下一节/.test(x.innerText); }) || b[0];
      if (!t) return null;
      var r = t.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt: t.innerText.trim() });
    })()`);
    if (dlg) {
      const d = JSON.parse(dlg);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: d.x, y: d.y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: d.x, y: d.y, button: 'left', clickCount: 1 });
      console.log('[' + n + '] 关掉弹窗「' + d.txt + '」');
      await sleep(7000);
    }

    const st = await c.ev(`(function(){
      var v = ${FIND_VIDEO};
      var t = (document.body.innerText||'').replace(/\\s+/g,' ');
      var lesson = (t.match(/[\\u4e00-\\u9fa5“”.]{4,24}[⑴⑵⑶⑷⑸]?/) || [])[0] || '';
      var quiz = !!document.querySelector('[class*=question],[class*=quizItem],[class*=TiMu],[class*=answer]');
      if (!v) return JSON.stringify({ noVideo: true, lesson: lesson.slice(0,20), quiz: quiz, url: location.href.match(/chapterId=(\\d+)/) ? location.href.match(/chapterId=(\\d+)/)[1] : '' });
      var out = { cur: Math.round(v.currentTime), dur: Math.round(v.duration||0), rate: v.playbackRate, paused: v.paused, lesson: lesson.slice(0,20), quiz: quiz };
      if (v.paused && !(out.dur && out.cur >= out.dur - 1)) { v.muted = true; [2,1.75,1.5].forEach(function(r){ try{ v.playbackRate = r; }catch(e){} }); try { v.play(); } catch(e){} out.action = 'play'; }
      out.paused = v.paused; out.rate = v.playbackRate;
      return JSON.stringify(out);
    })()`);
    const s = st ? JSON.parse(st) : {};
    const tag = s.lesson && s.lesson !== lastLesson ? (' ★' + s.lesson) : '';
    if (s.lesson) lastLesson = s.lesson;
    if (s.noVideo) {
      if (s.quiz) console.log('[' + n + '] ⚠ 测验/文档页（未接 DS）' + tag + ' chapter=' + s.url);
      const r = await clickNext(c);
      console.log('[' + n + '] 无视频 → 跳过' + tag + ' → ' + r);
      await sleep(10000); continue;
    }
    const done = s.dur && s.cur >= s.dur - 1;
    console.log('[' + n + '] ' + (s.cur + '/' + s.dur + 's') + ' @' + s.rate + 'x ' + (s.paused ? '暂停' : '播放') + (done ? ' [播完]' : '') + tag);
    if (done || (s.dur === 0 && s.cur > 0 && s.paused)) {
      const r = await clickNext(c);
      console.log('[' + n + '] 播完 → 下一节 → ' + r);
      await sleep(9000);
      continue;
    }
    await sleep(SECS * 1000);
  } catch (e) {
    console.log('[' + n + '] 异常: ' + String(e.message).slice(0, 60));
    await sleep(6000);
    c = await conn();
  }
}
console.log('循环结束');
