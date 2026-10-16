/**
 * tm-install-final.mjs — 用「chrome.storage.local 直写」把用户脚本装进 Tampermonkey 5.4.0
 * 依据：runs/tm-storage-analysis.md（子代理静态分析结论）
 *   - 每个脚本 = 4~5 个键（前缀 "!extdb."）：
 *       @uid#<uuid>    = 脚本名（索引键，TM 靠它枚举）
 *       @source#<uuid> = 脚本文本
 *       @re#<uuid>     = { inc, match, exc }
 *       @meta#<uuid>   = { name, version, enabled, position, options{...}, lastModified, ... }
 *       @st#<uuid>     = { ts, data }（可选）
 *   - 值一律包一层信封 { origin:'normal', value:<真值> }
 *   - 不要碰全局键 #schema / #version / #config
 *   - 写完 chrome.runtime.reload() 让 TM 重读
 *
 * 用法：node tm-install-final.mjs --port 9224 --script ../userscript/netclass.shell.user.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const SCRIPT = A.script || join(REPO, 'userscript', 'netclass.shell.user.js');
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const UUID = A.uuid || '7f3c9a10-5b2e-4f6d-9c81-2d4e6f8a0b13'; // 固定 uuid：重复安装幂等
const sleep = ms => new Promise(r => setTimeout(r, ms));

const source = readFileSync(SCRIPT, 'utf8');
const matches = ['https://edu.shengshengketang.com/*', 'https://study.bjqiyang.com/*'];
const version = (source.match(/@version\s+([\d.]+)/) || [, '0.3.0'])[1];

// 字段结构照 runs/tm-storage-analysis.md 的解析器默认对象补齐（缺字段会导致 TM 解析/注册异常）
const meta = {
  name: 'netclass',
  description: 'NetClass 网课自动处理（自研）',
  version,
  grant: ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue'],
  icon: null,
  icon64: null,
  supportURL: null,
  fileURL: null,
  downloadURL: null,
  updateURL: null,
  namespace: 'taskmesh.local/netclass',
  requires: [],
  includes: [],
  matches,
  excludes: [],
  homepage: null,
  resources: [],
  connects: ['127.0.0.1'],
  webRequest: null,
  author: 'TaskMesh',
  copyright: null,
  antifeatures: {},
  name_i18n: {},
  description_i18n: {},
  uuid: UUID,
  system: false,
  enabled: true,
  position: 1,
  blockers: [],
  lastModified: Date.now(),
  sync: {},
  evilness: 0,
  header: null,
  textContent: null,
  options: {
    check_for_updates: false,
    user_modified: null,
    comment: null,
    compatopts_for_requires: true,
    compat_wrappedjsobject: false,
    compat_metadata: false,
    compat_foreach: false,
    compat_powerful_this: null,
    sandbox: null,
    noframes: true,
    unwrap: null,
    run_at: 'document-start',
    run_in: [],
    tags: [],
    override: {
      use_includes: [], orig_includes: [], merge_includes: true,
      use_matches: [], orig_matches: [], merge_matches: true,
      use_excludes: [], orig_excludes: [], merge_excludes: true,
      use_connects: [], orig_connects: [], merge_connects: true,
      use_blockers: [], orig_run_at: null, orig_run_in: [], orig_noframes: null, orig_tags: undefined
    }
  }
};
const re = { inc: [], match: matches, exc: [] };

const payload = {
  ['!extdb.@uid#' + UUID]: { origin: 'normal', value: meta.name },
  ['!extdb.@source#' + UUID]: { origin: 'normal', value: source },
  ['!extdb.@re#' + UUID]: { origin: 'normal', value: re },
  ['!extdb.@meta#' + UUID]: { origin: 'normal', value: meta },
  ['!extdb.@st#' + UUID]: { origin: 'normal', value: { ts: Date.now(), data: {} } }
};

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

// 找一个 options 页面（扩展页上下文里才有 chrome.storage）
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let opt = list.find(t => t.type === 'page' && t.url.includes('options.html'));
if (!opt) {
  console.log('打开 options 页面…');
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM_ID}/options.html`)}`, { method: 'PUT' }); } catch { }
  await sleep(5000);
  const l2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  opt = l2.find(t => t.type === 'page' && t.url.includes('options.html'));
}
if (!opt) { console.error('没有 options 页面（检查 devmode / 扩展是否加载）'); process.exit(2); }
console.log('options 页面: ' + opt.url);

const c = new Cdp(opt.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });

// 0) 先看 TM 的存储后端与开发者模式
const probe = await c.send('Runtime.evaluate', {
  expression: `(async () => {
    const out = { hasStorage: !!chrome?.storage?.local, hasUserScripts: !!chrome?.userScripts };
    try {
      const r = await chrome.storage.local.get(null);
      out.totalKeys = Object.keys(r).length;
      out.sample = Object.keys(r).slice(0, 6);
      out.schema = r['!extdb.#schema'] || null;
      out.version = r['!extdb.#version'] || null;
      out.scripts = Object.keys(r).filter(k => k.startsWith('!extdb.@uid#'));
    } catch (e) { out.err = String(e); }
    return JSON.stringify(out);
  })()`, returnByValue: true, awaitPromise: true
});
console.log('存储探测: ' + (probe.result && probe.result.value));

// 1) 写入 5 个键
const js = JSON.stringify(payload);
const write = await c.send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const payload = ${js};
      await chrome.storage.local.set(payload);
      const back = await chrome.storage.local.get(Object.keys(payload));
      return JSON.stringify({ wrote: Object.keys(back).length, keys: Object.keys(back) });
    } catch (e) { return 'err:' + e.message; }
  })()`, returnByValue: true, awaitPromise: true
});
console.log('写入结果: ' + (write.result && write.result.value));

// 2) 让 TM 重载扩展（重读存储）
const reload = await c.send('Runtime.evaluate', {
  expression: `(() => { try { chrome.runtime.reload(); return 'reloading'; } catch (e) { return 'err:' + e.message; } })()`,
  returnByValue: true
});
console.log('重载: ' + (reload.result && reload.result.value));
c.close();

// 3) 等扩展起来后核对脚本列表
await sleep(8000);
const list3 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let opt2 = list3.find(t => t.type === 'page' && t.url.includes('options.html'));
if (!opt2) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM_ID}/options.html`)}`, { method: 'PUT' }); } catch { }
  await sleep(5000);
  const l4 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  opt2 = l4.find(t => t.type === 'page' && t.url.includes('options.html'));
}
if (opt2) {
  const c2 = new Cdp(opt2.webSocketDebuggerUrl);
  await c2.open();
  await c2.send('Page.enable');
  const check = await c2.send('Runtime.evaluate', {
    expression: `(() => {
      const rows = Array.from(document.querySelectorAll('tr,#script_list *,[class*=script]'))
        .map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim())
        .filter(x => x && x.length < 160 && !/请选择一个操作|过滤方式|^#|已启用/.test(x));
      return JSON.stringify({ hasNetClass: /netclass/i.test(document.body.innerText || ''), rows: rows.slice(0, 5) });
    })()`, returnByValue: true
  });
  console.log('核对: ' + (check.result && check.result.value));
  c2.close();
}

// 4) 导出可复用 payload（便于人工/其他机器复现）
const outFile = join(REPO, 'runs', 'tm-install-payload.json');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ uuid: UUID, payload }, null, 2));
console.log('payload 已保存: ' + outFile);
