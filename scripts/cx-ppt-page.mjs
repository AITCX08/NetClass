/**
 * cx-ppt-page.mjs — 把 PPT 类任务点「逐页翻完」（超星 PPT 的完成机制是看完/停留）
 *
 * 结构（实测 1.2.3 PPT）：第 3 层嵌套 iframe 里是 34~52 张 <img> + 页码导航（"1 2 3 ... 36"）
 *   没有「下一页」按钮 → 直接点页码。
 *
 * 用法：node scripts\cx-ppt-page.mjs [--dwell=1200] [--max=60]
 */
const P = 9227;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1] || d) : d; };
const DWELL = arg('dwell', 1200);
const MAX = arg('max', 60);

const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url))[0];
if (!p) { console.log('无标签'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, pr = {}, ms = 20000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 找到 PPT 帧并返回页码元素数量 */
const SCAN = `(function(){
  function deep(root, d, path){
    if (d > 4) return null;
    var fs; try { fs = Array.from(root.querySelectorAll('iframe')); } catch(e){ return null; }
    for (var i=0;i<fs.length;i++){
      var dd=null; try{dd=fs[i].contentDocument}catch(e){}
      if(!dd) continue;
      var imgs = dd.querySelectorAll('img').length;
      var nums = Array.from(dd.querySelectorAll('a,li,div,span')).filter(function(e){ return /^\\d+$/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); });
      if (imgs >= 3 && nums.length >= 3) return { n: nums.length, imgs: imgs, path: path+'/'+i };
      var r = deep(dd, d+1, path+'/'+i); if (r) return r;
    }
    return null;
  }
  return JSON.stringify(deep(document,1,''));
})()`;

/** 点第 k 个页码（0-based） */
const CLICK_NTH = (k) => `(function(){
  function deep(root, d){
    if (d > 4) return 'no-frame';
    var fs; try { fs = Array.from(root.querySelectorAll('iframe')); } catch(e){ return 'no-frame'; }
    for (var i=0;i<fs.length;i++){
      var dd=null; try{dd=fs[i].contentDocument}catch(e){}
      if(!dd) continue;
      var imgs = dd.querySelectorAll('img').length;
      var nums = Array.from(dd.querySelectorAll('a,li,div,span')).filter(function(e){ return /^\\d+$/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); });
      if (imgs >= 3 && nums.length >= 3) {
        var el = nums[${k}];
        if (!el) return 'out-of-range:' + nums.length;
        try { el.scrollIntoView({block:'center'}); } catch(e){}
        try { el.click(); } catch(e){}
        return 'clicked:' + (el.innerText||'').trim();
      }
      var r = deep(dd, d+1); if (r && r !== 'no-frame') return r;
    }
    return 'no-frame';
  }
  return deep(document,1);
})()`;

const info = await ev(SCAN);
console.log('PPT 帧: ' + String(info).slice(0, 140));
if (!info || info === 'null') { console.log('❌ 没找到 PPT 帧（可能不在 PPT 页）'); ws.close(); process.exit(1); }
const meta = JSON.parse(info);
const total = Math.min(meta.n, MAX);
console.log('将逐页点击 ' + total + ' 页（每页停 ' + DWELL + 'ms）…');
let last = '';
for (let k = 0; k < total; k++) {
  const r = await ev(CLICK_NTH(k));
  last = String(r);
  if (k % 6 === 0 || k === total - 1) console.log('  第 ' + (k + 1) + '/' + total + ' 页 → ' + last);
  await sleep(DWELL);
}
// 最后一页多停一会儿（有些实现要在末页停留才算完成）
await sleep(4000);
console.log('翻页结束（最后一页: ' + last + '）');
console.log('末页后再停 6 秒…');
await sleep(6000);
const after = await ev(`(function(){
  function deep(root, d){
    if (d > 4) return null;
    var fs; try { fs = Array.from(root.querySelectorAll('iframe')); } catch(e){ return null; }
    for (var i=0;i<fs.length;i++){
      var dd=null; try{dd=fs[i].contentDocument}catch(e){}
      if(!dd) continue;
      var t=(dd.body?dd.body.innerText:'').replace(/\\s+/g,' ');
      if (dd.querySelectorAll('img').length >= 3) return t.slice(0, 120);
      var r = deep(dd, d+1); if (r) return r;
    }
    return null;
  }
  return deep(document,1);
})()`);
console.log('末页文本: ' + String(after).slice(0, 160));
ws.close();
