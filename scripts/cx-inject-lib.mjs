/**
 * cx-inject-lib.mjs — 把字形指纹库分块注入页面（绕过单次 evaluate 体积限制）
 *   node scripts/cx-inject-lib.mjs --port 9227 --lib runs/cx/glyph-lib36.json
 * 结果放在 window.__cxGLib = { res, chars, bitmaps:[Uint8Array] }
 * 已注入过就跳过（window.__cxGLibV 标记）。
 */
import { readFileSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const LIBPATH = A.lib || 'runs/cx/glyph-lib36.json';
const CHUNK = Number(A.chunk || 500);          // 每次注入多少个字形

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url));
if (!p) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 60000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
  if (r.timeout) return { __timeout: true };
  if (r.result && r.result.exceptionDetails) return { __err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200) };
  return r.result && r.result.result ? r.result.result.value : null;
};

const lib = JSON.parse(readFileSync(LIBPATH, 'utf8'));
console.log('库: ' + lib.n + ' 字形 res=' + lib.res);

const exists = await ev('window.__cxGLibV || 0');
if (exists === lib.res) { console.log('已注入（res=' + lib.res + '），跳过'); ws.close(); process.exit(0); }

await ev(`(function(){ window.__cxGLib = { res: ${lib.res}, chars: '', bitmaps: [] }; window.__cxGLibV = 0; return 'init'; })()`);
for (let off = 0; off < lib.chars.length; off += CHUNK) {
  const c = JSON.stringify(lib.chars.slice(off, off + CHUNK));
  const b = JSON.stringify(lib.bitmaps.slice(off, off + CHUNK));
  const r = await ev(`(function(){ window.__cxGLib.chars += ${c}; ${b}.forEach(function(s){ var u = new Uint8Array(s.length); for (var i=0;i<s.length;i++) u[i]=s.charCodeAt(i)-48; window.__cxGLib.bitmaps.push(u); }); return window.__cxGLib.bitmaps.length; })()`);
  if (r && r.__err) { console.log('注入失败: ' + r.__err); break; }
  process.stdout.write('\r  已注入 ' + r + '/' + lib.n + '  ');
}
const done = await ev(`(function(){ window.__cxGLibV = (window.__cxGLib.bitmaps.length === ${lib.n}) ? ${lib.res} : 0; return JSON.stringify({ n: window.__cxGLib.bitmaps.length, chars: window.__cxGLib.chars.length, v: window.__cxGLibV }); })()`);
console.log('\n结果: ' + done);
ws.close();
