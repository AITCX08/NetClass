/**
 * webtrn-reply-batch.mjs — 把一个 Markdown 的章节当作回帖正文，逐条发到指定讨论区
 *   node scripts/webtrn-reply-batch.mjs --port 9226 --frame 1 --file <md> [--max 8] [--min 150]
 * 机制：取讨论区里的真实 postId（NetClass.webtrn.posts），逐条 reply（页内异步点击），
 *       每条发完等几秒看「我的回帖(N条)」是否 +1，不 +1 就停下报错（避免盲发）。
 */
const fs = await import('node:fs');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9226);
const FRAME = Number(A.frame || 0);
const FILE = String(A.file || '');
const MAX = Number(A.max || 8);
const MIN = Number(A.min || 150);

// 解析 Markdown：取二~九这类正文章节（跳过引言/结论）
const md = fs.readFileSync(FILE, 'utf8').replace(/\r/g, '');
const parts = md.split(/\n(?=#{2,3}\s)/).map(s => s.trim()).filter(Boolean);
const items = [];
for (const p of parts) {
  const m = p.match(/^#{2,3}\s*([^\n]+)\n([\s\S]+)$/);
  if (!m) continue;
  const title = m[1].trim();
  let body = m[2].replace(/[#*>`]/g, '').replace(/\s+/g, ' ').trim();
  if (/引言|结论|参考文献|摘要|关键词/.test(title)) continue;
  if (body.length < MIN) continue;
  items.push({ title, body: body.slice(0, 900) });
}
console.log('可用发言段: ' + items.length + ' 条（' + items.map(i => i.title.slice(0, 10)).join(' / ') + '）');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes('activity_view'));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 40000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const posts = JSON.parse(await ev(`JSON.stringify(NetClass.webtrn.posts(${FRAME}).slice(0, 12).map(function(p){ return p.postId; }))`));
console.log('候选帖子: ' + posts.length + ' 个');

await ev(`JSON.stringify(NetClass.webtrn.autoConfirm(true))`);
const before = await ev(`(function(){ var d=NetClass.webtrn.frames()[${FRAME}].contentDocument; var m=(d.body.innerText.match(/我的回帖\\((\\d+)条\\)/)||[]); return m[1]||'0'; })()`);
console.log('发帖前「我的回帖」: ' + before);

let ok = 0;
const SKIP = Number(A.skip || 0);
for (let i = SKIP; i < Math.min(items.length, SKIP + MAX, posts.length); i++) {
  const it = items[i], pid = posts[i];
  let r;
  try {
    r = await ev(`JSON.stringify(NetClass.webtrn.reply(${FRAME}, ${JSON.stringify(pid)}, ${JSON.stringify(it.body)}))`);
  } catch (e) { console.log('  ✗ 第' + (i + 1) + '条异常: ' + e.message); break; }
  console.log('  → 第' + (i + 1) + '条 [' + it.title.slice(0, 12) + '] ' + String(r).slice(0, 80));
  await sleep(6000);
  // ★ 判定用正文特征串（计数要刷新才更新，不可靠）
  const mark = it.body.slice(0, 14).replace(/["'\\]/g, '');
  const seen = await ev(`(function(){
    var d = NetClass.webtrn.frames()[${FRAME}].contentDocument;
    var t = d.body ? d.body.innerText : '';
    var hits = 0;
    Array.from(d.querySelectorAll('div,li,span,td,p')).forEach(function(e){
      if (/textarea|input/i.test(e.tagName)) return;
      if ((e.innerText||'').indexOf(${JSON.stringify(mark)}) >= 0 && (e.innerText||'').length < 1500) hits++;
    });
    return hits;
  })()`);
  console.log('     正文命中: ' + seen + (Number(seen) > 0 ? ' ✅' : ' ⚠'));
  if (Number(seen) > 0) ok++; else { console.log('     ⚠ 未在正文里出现，停手'); break; }
}
console.log('完成：本轮成功 ' + ok + ' 条');
ws.close();
