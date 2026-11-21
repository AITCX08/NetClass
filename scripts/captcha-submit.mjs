/**
 * fill-code-submit.mjs —— 填验证码 + 提交 + 立刻截图（截图驱动）
 * 用法: node runs/fill-code-submit.mjs <port> <code> <shotName>
 */
const PORT = Number(process.argv[2] || 9231);
const CODE = process.argv[3] || '';
const NAME = process.argv[4] || 'after-submit';
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (!CODE) { console.log('缺 code'); process.exit(2); }

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
const t = pages.find(p => /jcpxkh|91huayi/.test(p.url)) || pages[0];
if (!t) { console.log('没有页面'); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
let id = 0; const pend = new Map();
const sent = [];
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    if (/UserNameLogin|login/i.test(r.url)) sent.push({ id: m.params.requestId, url: r.url, body: r.postData });
  }
});
const send = (me, pa = {}, to = 30000) => new Promise(res => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const snap = async (n) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) { fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.result.data, 'base64')); console.log('  📸 ' + n + '.png'); }
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await sleep(400);

// ① 填验证码（原生 setter，这个是之前验证过能生效的）
console.log('① 填码: ' + String(await ev(`(function(){
  var el = document.getElementById('userCode');
  if(!el) return 'no userCode';
  el.focus();
  var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(el, ${JSON.stringify(CODE)});
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return 'len=' + el.value.length + ' val=' + el.value;
})()`)));

// ② 提交前把三个字段状态打出来
console.log('② 提交前: ' + String(await ev(`JSON.stringify({
  user_name: (document.getElementById('user_name')||{}).value,
  password_len: ((document.getElementById('password')||{}).value||'').length,
  userCode: (document.getElementById('userCode')||{}).value,
  tab: (function(){var c=Array.from(document.querySelectorAll('dd,li')).filter(function(e){return /cur|act/i.test((e.className||'').toString())})[0];return c?(c.innerText||'').trim():'?';})()
})`)));

// ③ 立刻截图（提交前）
await snap(NAME + '-before');

// ④ 点登录
console.log('④ 点登录: ' + String(await ev(`(function(){
  var b = document.querySelector('button.login');
  if(!b) b = Array.from(document.querySelectorAll('button')).filter(function(e){return /^登\\s*录$/.test((e.innerText||'').trim())})[0];
  if(!b) return 'no button';
  b.click(); return 'clicked ' + b.tagName;
})()`)));

// ⑤ 等结果
for (let k = 1; k <= 15; k++) {
  await sleep(1100);
  const u = String(await ev('location.href'));
  if (!/VerifySSOCode/.test(u)) { console.log('★★★ 登录成功 → ' + u.slice(0, 105)); break; }
  if (k === 15) console.log('… 仍在登录页');
}

// ⑥ 抓请求体 + 响应
if (sent.length) {
  const last = sent[sent.length - 1];
  console.log('\n请求: POST ' + last.url.slice(0, 90));
  console.log('  body: ' + String(last.body || '').slice(0, 200));
  try {
    const b = await send('Network.getResponseBody', { requestId: last.id });
    console.log('  响应: ' + String(b.result?.body || '').slice(0, 260));
  } catch (_) { }
}

// ⑦ 结果截图
await snap(NAME);
ws.close();
