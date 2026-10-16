/**
 * cx-probe-quiz.mjs — 诊断"章测试提交后成绩为 0"的根因
 *
 * 做法：对当前测验页**每道题都勾第一个选项**，然后提交，再读结果页的"我的答案"。
 *   · 如果结果页显示"我的答案：A" → 勾选+提交链路正常，0 分是因为答案本身错
 *   · 如果结果页"我的答案："是空的 → **答案没被提交**，问题在勾选/提交链路
 *
 * 用法：node scripts\cx-probe-quiz.mjs --port 9227 [--dry]
 */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] || d) : d; };
const P = Number(arg('port', 9227));
const DRY = argv.includes('--dry');

const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url))[0];
if (!p) { console.log('无标签'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, pr = {}, ms = 25000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEEP = `function deep(r,d){ if(d>4) return null; try{ if(r.querySelector&&r.querySelector('.TiMu')) return r; var fs=Array.from(r.querySelectorAll('iframe')); for(var i=0;i<fs.length;i++){ var dd=null; try{dd=fs[i].contentDocument}catch(e){} if(dd){var h=deep(dd,d+1); if(h) return h;} } }catch(e){} return null; }`;

console.log('=== 1) 勾选每道题的第一个选项 ===');
const picked = await ev(`(function(){ ${DEEP}
  var dd = deep(document,0); if(!dd) return JSON.stringify({err:'no-frame'});
  var qs = Array.from(dd.querySelectorAll('.TiMu'));
  var out = [];
  qs.forEach(function(q, qi){
    var li = q.querySelector('ul li'); if(!li) { out.push({q:qi+1, err:'no-li'}); return; }
    var inp = li.querySelector('input[type=radio], input[type=checkbox]');
    li.click();
    if (inp && !inp.checked) inp.click();
    if (inp && !inp.checked) { inp.checked = true; ['input','change','click'].forEach(function(t){ try{ inp.dispatchEvent(new Event(t,{bubbles:true})); }catch(e){} }); }
    out.push({ q: qi+1, name: inp ? String(inp.name).slice(0,24) : null, val: inp ? inp.value : null, checked: inp ? inp.checked : null });
  });
  return JSON.stringify({ total: qs.length, picked: out });
})()`);
console.log('  ' + String(picked).slice(0, 700));

console.log('=== 2) 看一下提交前的表单状态（答案域）===');
const formState = await ev(`(function(){ ${DEEP}
  var dd = deep(document,0); if(!dd) return null;
  var hs = Array.from(dd.querySelectorAll('input[type=hidden]')).filter(function(x){ return /answer/i.test(x.name||''); });
  return JSON.stringify({ 答案域数: hs.length, 明细: hs.slice(0,6).map(function(x){ return x.name + '=' + String(x.value).slice(0,20); }) });
})()`);
console.log('  ' + String(formState).slice(0, 500));

if (DRY) { console.log('\n--dry：不提交'); ws.close(); process.exit(0); }

console.log('=== 3) 点提交 ===');
const sub = await ev(`(function(){ ${DEEP}
  var dd = deep(document,0); if(!dd) return 'no-frame';
  var btns = Array.from(dd.querySelectorAll('a,button,input,div,span')).filter(function(e){
    var t = (e.innerText || e.value || '').trim();
    return /^(提交|交卷|完成)$/.test(t) && (e.offsetWidth || e.offsetHeight);
  });
  if (!btns.length) return 'no-submit-btn';
  btns[0].click();
  return 'clicked:' + (btns[0].innerText || '').trim();
})()`);
console.log('  ' + sub);
await sleep(2500);

const dlg = await ev(`(function(){ ${DEEP}
  var dd = deep(document,0); if(!dd) return 'n/a';
  var ok = Array.from(dd.querySelectorAll('a,button,div,span')).filter(function(e){
    var t = (e.innerText||'').trim(); return /^(确定|确认|是)$/.test(t) && (e.offsetWidth||e.offsetHeight);
  });
  if (!ok.length) return 'no-confirm';
  ok[0].click();
  return 'confirmed';
})()`);
console.log('  确认框: ' + dlg);
await sleep(8000);

console.log('=== 4) 结果页：每题有没有记录"我的答案" ===');
const res = await ev(`(function(){ ${DEEP}
  var dd = deep(document,0); if(!dd) return null;
  var t = (dd.body ? dd.body.innerText : '').replace(/\\s+/g,' ');
  var m = t.match(/本次成绩[：:]\\s*([0-9.]+)/);
  return JSON.stringify({ 成绩: m ? m[1] : '(未找到)', 含我的答案: (t.match(/我的答案/g)||[]).length, 片段: t.slice(0, 200) });
})()`);
console.log('  ' + String(res).slice(0, 600));
ws.close();
