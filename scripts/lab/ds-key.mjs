/**
 * ds-key.mjs — 管理加载器扩展里的 DeepSeek 凭据（**key 不进仓库、不进页面**）
 *
 *   node scripts/ds-key.mjs set --key sk-xxxx [--model deepseek-chat] [--port 9224]
 *   node scripts/ds-key.mjs status [--port 9224]
 *   node scripts/ds-key.mjs test  [--port 9224]
 *   （不带 --port 时对 9224 / 9225 / 9226 三个 profile 各做一遍）
 *
 * 原理：key 存在扩展 Service Worker 的 chrome.storage.local 里，只有 SW 用它去调
 * api.deepseek.com；页面（主世界）拿不到 key，只能通过 sendMessage 让 SW 代答。
 * 因此每个浏览器 profile 都要写一次。
 */
const LOADER_ID = 'ebikemhgdinpnfeanicfkahlehcojjmn';
const DEFAULT_PORTS = [9224, 9225, 9226];

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const cmd = argv[0] || 'status';
const PORTS = A.port ? [Number(A.port)] : DEFAULT_PORTS;

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws open failed')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

const mask = k => !k ? '(未设置)' : k.slice(0, 7) + '…' + k.slice(-4) + ' (len=' + k.length + ')';

async function withSw(port, fn) {
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { return { port, err: 'CDP 不通（隧道断？powershell -File scripts/tunnel.ps1 -Port ' + port + '）' }; }
  const sw = list.find(t => t.type === 'service_worker' && t.url.includes(LOADER_ID));
  if (!sw) return { port, err: '加载器 SW 未运行（先 node scripts/loader-reload.mjs ' + port + '）' };
  const c = new Cdp(sw.webSocketDebuggerUrl);
  await c.open();
  try { return { port, ...(await fn(c)) }; } finally { c.close(); }
}

const evalIn = async (c, expression) => {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || 'eval 异常');
  }
  return r.result && r.result.value;
};

async function perPort(fn) {
  const out = [];
  for (const p of PORTS) {
    try { out.push(await withSw(p, fn)); }
    catch (e) { out.push({ port: p, err: String((e && e.message) || e) }); }   // 单端口失败不影响其它
  }
  return out;
}

const TEST_PAYLOAD = {
  cmd: 'ask', type: '单选题',
  question: '在社会心理学中，研究个体如何解释自己或他人行为原因的理论被称作什么？',
  options: 'A. 归因理论\nB. 认知失调理论\nC. 社会学习理论\nD. 精神分析理论'
};

const results = await perPort(async c => {
  if (cmd === 'set') {
    const key = A.key;
    if (!key || !String(key).startsWith('sk-')) throw new Error('需要 --key sk-...');
    const model = A.model || 'deepseek-chat';
    await evalIn(c, `chrome.storage.local.set({ deepseekKey: ${JSON.stringify(String(key))}, deepseekModel: ${JSON.stringify(String(model))}, deepseekSetAt: Date.now() }).then(() => 'ok')`);
    const v = JSON.parse(await evalIn(c, `chrome.storage.local.get(['deepseekKey','deepseekModel']).then(v => JSON.stringify(v))`));
    return { key: mask(v.deepseekKey), model: v.deepseekModel };
  }
  if (cmd === 'status') {
    const v = JSON.parse(await evalIn(c, `chrome.storage.local.get(['deepseekKey','deepseekModel','deepseekSetAt']).then(v => JSON.stringify(v))`));
    return { key: mask(v.deepseekKey), model: v.deepseekModel || '(默认 deepseek-chat)', setAt: v.deepseekSetAt ? new Date(v.deepseekSetAt).toISOString() : null };
  }
  if (cmd === 'test') {
    const t0 = Date.now();
    const raw = await evalIn(c, `dsAsk(${JSON.stringify(TEST_PAYLOAD)}).then(a => JSON.stringify({ ok: true, answer: a })).catch(e => JSON.stringify({ ok: false, err: String(e && e.message || e) }))`);
    const r = JSON.parse(raw);
    return { ...r, ms: Date.now() - t0 };
  }
  throw new Error('未知子命令：' + cmd + '（可用 set / status / test）');
});

console.log('== ds-key ' + cmd + ' ==');
let bad = 0;
for (const r of results) {
  if (r.err) { console.log(`  ${r.port}: ${r.err}`); bad++; continue; }
  if (cmd === 'test') {
    const verdict = r.ok ? ((/[A-H]/.test(String(r.answer)) ? '答案 ' + String(r.answer).trim() : '返回无法解析: ' + r.answer)) : '失败 ' + r.err;
    console.log(`  ${r.port}: ${r.ok ? '✅' : '❌'} ${verdict}  (${r.ms}ms)`);
    if (!r.ok) bad++;
  } else if (cmd === 'set') {
    console.log(`  ${r.port}: key=${r.key} model=${r.model}`);
  } else {
    console.log(`  ${r.port}: key=${r.key} model=${r.model}${r.setAt ? ' 写入于 ' + r.setAt : ''}`);
  }
}
process.exit(bad ? 1 : 0);
