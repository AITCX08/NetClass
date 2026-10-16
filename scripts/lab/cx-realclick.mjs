/**
 * cx-realclick.mjs — 用 CDP 真实鼠标事件点选项，验证站点到底认哪种点击
 *
 * 背景：学习通章测试的选项是 `<li class="clearfix" role="option">`（**没有 input**），
 *   合成事件（li.click() / dispatchEvent(MouseEvent)）全部无效。
 *   本脚本用 Input.dispatchMouseEvent 产生**可信事件**（isTrusted:true）——
 *   如果这个能生效，说明站点在过滤合成事件，答案链路必须换成 CDP 点击。
 *
 * ⚠️ 坐标要**累加 iframe 偏移**（元素 rect 是相对自己 iframe 的，CDP 用的是顶层视口坐标）。
 *
 * 用法：node scripts\cx-realclick.mjs --port 9227 [--qi 0] [--oi 1]
 */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] || d) : d; };
const P = Number(arg('port', 9227));
const QI = Number(arg('qi', 0));     // 第几题（0 起）
const OI = Number(arg('oi', 1));     // 第几个选项（0 起）

const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url))[0];
if (!p) { console.log('无标签'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, pr = {}, ms = 20000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 取第 QI 题第 OI 个选项的**顶层视口坐标**（累加 iframe 偏移）
const expr = `(function(){
  function find(r, d, ox, oy){
    if (d > 4) return null;
    try {
      if (r.querySelector && r.querySelector('.TiMu')) {
        var qs = Array.from(r.querySelectorAll('.TiMu'));
        var q = qs[${QI}]; if (!q) return { err: 'no-question' };
        var li = Array.from(q.querySelectorAll('li'))[${OI}]; if (!li) return { err: 'no-option' };
        var rc = li.getBoundingClientRect();
        return { x: Math.round(ox + rc.left + rc.width/2), y: Math.round(oy + rc.top + rc.height/2),
                 w: Math.round(rc.width), h: Math.round(rc.height),
                 cls: String(li.className), txt: (li.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30) };
      }
      var fs = Array.from(r.querySelectorAll('iframe'));
      for (var k = 0; k < fs.length; k++) {
        var dd = null; try { dd = fs[k].contentDocument } catch(e){}
        if (!dd) continue;
        var fr = fs[k].getBoundingClientRect();
        var r2 = find(dd, d+1, ox + fr.left, oy + fr.top);
        if (r2 && !r2.err) return r2;
      }
    } catch(e){}
    return null;
  }
  return JSON.stringify(find(document, 0, 0, 0));
})()`;

const pt = await ev(expr);
console.log('目标选项: ' + String(pt).slice(0, 200));
let o; try { o = JSON.parse(pt); } catch (_) { o = null; }
if (!o || o.err) { console.log('❌ 没定位到选项'); ws.close(); process.exit(1); }

console.log('=== 点前状态 ===');
console.log('  ' + await ev(`(function(){var f=null;(function w(r,d){try{if(r.querySelector&&r.querySelector('.TiMu')){f=r;return}if(d>4)return;Array.from(r.querySelectorAll('iframe')).forEach(function(x){var y=null;try{y=x.contentDocument}catch(e){}if(y&&!f)w(y,d+1)})}catch(e){}})(document,0);if(!f)return null;var q=f.querySelectorAll('.TiMu')[${QI}];return JSON.stringify(Array.from(q.querySelectorAll('li')).map(function(l){return /check_answer/.test(l.className)?'YES':'-'}).join('|'))})()`));

// ★ 真实鼠标事件三连
for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  const pr = { type: t, x: o.x, y: o.y, button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1 };
  if (t === 'mouseMoved') delete pr.button;
  await send('Input.dispatchMouseEvent', pr);
  await sleep(60);
}
await sleep(600);

console.log('=== 点后状态（check_answer 是站点记录选中的标志）===');
const after = await ev(`(function(){var f=null;(function w(r,d){try{if(r.querySelector&&r.querySelector('.TiMu')){f=r;return}if(d>4)return;Array.from(r.querySelectorAll('iframe')).forEach(function(x){var y=null;try{y=x.contentDocument}catch(e){}if(y&&!f)w(y,d+1)})}catch(e){}})(document,0);if(!f)return null;var q=f.querySelectorAll('.TiMu')[${QI}];return JSON.stringify({选项:Array.from(q.querySelectorAll('li')).map(function(l){return /check_answer/.test(l.className)?'YES':'-'}).join('|'), 题面:Array.from(q.querySelectorAll('li')).map(function(l){return (l.innerText||'').replace(/\\s+/g,' ').trim().slice(0,14)})})})()`);
console.log('  ' + String(after).slice(0, 400));
ws.close();
