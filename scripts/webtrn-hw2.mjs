/** 打开学习平台的作业入口（带 domain/classId），等它落到 homework 页，再 dump 该标签 */
const PORT = Number(process.argv[2] || 9226);
const CID = process.argv[3];
const WAIT = Number(process.argv[4] || 14) * 1000;
const base = 'https://tea.webtrn.cn';
const url = 'https://zjdx-kfkc.webtrn.cn/learnspace/sign/signLearn.action?courseId=' + CID +
  '&loginType=true&loginId=2024lns00031300003&sign=3&siteCode=zjdx&domain=' +
  encodeURIComponent(base) + '&classId=ff808081a075235f01a08e6529e54389';
// 用 tea 页的 CDP 建新标签
let list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let anchor = list.find(t => t.type === 'page' && String(t.url).includes('tea.webtrn.cn'));
let ws = new WebSocket(anchor.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0, sendW = (ws) => (method, params = {}, ms = 30000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
let send = sendW(ws);
const t = await send('Target.createTarget', { url });
console.log('新标签: ' + JSON.stringify(t.result || t.error).slice(0, 90));
ws.close();
await new Promise(r => setTimeout(r, WAIT));
// 之后按 URL 找到真正的作业页
list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tgt = list.find(x => t.type === 'page' && String(x.url).includes('homework'));
console.log('落地页: ' + String(tgt ? tgt.url : '(未找到 homework 页)').slice(0, 110));
if (!tgt) process.exit(0);
ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
send = sendW(ws);
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({title:document.title,body:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,800),controls:Array.from(new Set(Array.from(document.querySelectorAll('a,input[type=button],button')).map(b=>(b.value||b.innerText||'').trim().slice(0,14)).filter(Boolean))).slice(0,15)})`,
  returnByValue: true
});
console.log(r.timeout ? '求值超时' : String((r.result && r.result.result && r.result.result.value) || '').slice(0, 1100));
ws.close();
