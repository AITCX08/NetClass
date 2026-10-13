/**
 * tm-editor-install.mjs — 通过 Tampermonkey 的「新建用户脚本」编辑器安装脚本（比安装页表单更稳）
 * 用法：node tm-editor-install.mjs --port 9224 [--script ../userscript/netclass.shell.user.js]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const SCRIPT = A.script || join(REPO, 'userscript', 'netclass.shell.user.js');
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws err')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

const code = readFileSync(SCRIPT, 'utf8');
console.log(`script=${SCRIPT} (${code.length} bytes)`);

// 打开 options 页（已存在则复用）
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let opt = list.find(t => t.type === 'page' && t.url.includes('options.html'));
if (!opt) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM_ID}/options.html`)}`, { method: 'PUT' }); } catch { }
  await sleep(4000);
  const l2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  opt = l2.find(t => t.type === 'page' && t.url.includes('options.html'));
}
if (!opt) { console.error('没有 options 页面'); process.exit(1); }

const p = new Cdp(opt.webSocketDebuggerUrl);
await p.open();
await p.send('Page.enable');

// 1) 进入「新建用户脚本」编辑器
await p.send('Page.navigate', { url: `chrome-extension://${TM_ID}/options.html#nav=new` });
await sleep(4000);

const state = await p.send('Runtime.evaluate', {
  expression: `(() => {
    const ta = document.querySelector('textarea');
    const mon = window.monaco && window.monaco.editor ? window.monaco.editor.getModels().length : 0;
    return JSON.stringify({ href: location.href, textarea: !!ta, monacoModels: mon });
  })()`, returnByValue: true
});
console.log('editor state => ' + (state.result && state.result.value));

// 2) 写入脚本内容
const b64 = Buffer.from(code, 'utf8').toString('base64');
const wrote = await p.send('Runtime.evaluate', {
  expression: `(() => {
    try {
      const text = atob('${b64}');
      let ok = false;
      if (window.monaco && window.monaco.editor) {
        const models = window.monaco.editor.getModels();
        if (models.length) { models[0].setValue(text); ok = true; }
      }
      const ta = document.querySelector('textarea');
      if (ta) { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); ok = true; }
      // 兜底：用 DOM 事件写入 CodeMirror
      const cm = document.querySelector('.CodeMirror');
      if (cm && cm.CodeMirror) { cm.CodeMirror.setValue(text); ok = true; }
      return 'wrote:' + ok;
    } catch (e) { return 'err:' + e.message; }
  })()`, returnByValue: true
});
console.log('write => ' + (wrote.result && wrote.result.value));
await sleep(1200);

// 3) 触发保存：先点「保存」按钮，再补一发 Ctrl+S
const saved = await p.send('Runtime.evaluate', {
  expression: `(() => {
    const all = Array.from(document.querySelectorAll('button,a,span,div,input'));
    const btn = all.find(e => /^\\s*(保存|Save)\\s*$/.test((e.innerText || e.value || '').trim()));
    if (btn) { btn.click(); return 'clicked:' + (btn.innerText || btn.value); }
    return 'no-save-button';
  })()`, returnByValue: true
});
console.log('save => ' + (saved.result && saved.result.value));

// Ctrl+S
const ki = (t) => ({ type: t, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2 });
await p.send('Input.dispatchKeyEvent', { ...ki('rawKeyDown') }).catch(() => { });
await p.send('Input.dispatchKeyEvent', { ...ki('keyUp') }).catch(() => { });
await sleep(3000);

// 4) 打开已安装脚本列表核对
await p.send('Page.navigate', { url: `chrome-extension://${TM_ID}/options.html#nav=utils` });
await sleep(3500);
const check = await p.send('Runtime.evaluate', {
  expression: `(() => {
    const rows = Array.from(document.querySelectorAll('#script_list, .script_list, tbody tr, [class*=script]'))
      .map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim())
      .filter(x => x && !/请选择一个操作|过滤方式|已启用/.test(x));
    return JSON.stringify({ href: location.href, rows: rows.slice(0, 6) });
  })()`, returnByValue: true
});
console.log('verify => ' + (check.result && check.result.value));
p.close();
