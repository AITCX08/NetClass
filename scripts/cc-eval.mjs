#!/usr/bin/env node
/**
 * cc-eval.mjs — 对 9228 上第 N 个 ccjyxy 标签执行一段 JS（直接 CDP，不经 nc.mjs）
 *   node scripts/cc-eval.mjs --tab 0 --file runs/cc-probe2.js
 *   node scripts/cc-eval.mjs --all --file runs/cc-probe2.js
 *   node scripts/cc-eval.mjs --tab 0 --expr "location.href"
 */
import { readFileSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228);
const TABS = A.all ? null : Number(A.tab || 0);
const expr = A.file ? readFileSync(A.file, 'utf8') : String(A.expr || '1');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const pick = TABS === null ? cand : [cand[TABS]].filter(Boolean);

for (const t of pick) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const res = await new Promise(r => {
    ws.addEventListener('message', e => { const x = JSON.parse(e.data); if (x.id === 1) r(x); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => r({}), 12000);
  });
  const v = res.result && res.result.result ? res.result.result.value : null;
  const ex = res.result && res.result.exceptionDetails ? ('ERR: ' + JSON.stringify(res.result.exceptionDetails).slice(0, 200)) : '';
  console.log('[' + t.id.slice(0, 6) + '] ' + (v === null ? (ex || 'null') : v));
  ws.close();
}
if (!pick.length) console.log('没有 ccjyxy 标签');
