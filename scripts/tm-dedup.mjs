/** tm-dedup.mjs — 删除油猴里重复/旧的用户脚本条目（按名字匹配）
 *  用法：node tm-dedup.mjs --port 9224 --name netclass --keep "NetClass 网课自动处理"
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const DROP = A.name || 'netclass';
const KEEP = A.keep || 'NetClass 网课自动处理';

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var st = await chrome.storage.local.get(null);
    var uids = Object.keys(st).filter(function(k){ return k.indexOf('!extdb.@uid#') === 0; });
    var removed = [];
    for (var i = 0; i < uids.length; i++) {
      var k = uids[i];
      var name = String(st[k].value);
      if (name === '${DROP}' && name !== '${KEEP}') {
        var uuid = k.split('@uid#')[1];
        var prefixes = ['!extdb.@uid#', '!extdb.@meta#', '!extdb.@source#', '!extdb.@re#', '!extdb.@st#'];
        for (var j = 0; j < prefixes.length; j++) {
          await chrome.storage.local.remove(prefixes[j] + uuid);
        }
        removed.push(name + ' (' + uuid.slice(0, 8) + ')');
      }
    }
    var st2 = await chrome.storage.local.get(null);
    var names = Object.keys(st2).filter(function(k){ return k.indexOf('!extdb.@uid#') === 0; }).map(function(k){ return st2[k].value; });
    return JSON.stringify({ removed: removed, remaining: names });
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
await c.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }).catch(() => { });
c.close();
console.log('(已重载扩展)');
