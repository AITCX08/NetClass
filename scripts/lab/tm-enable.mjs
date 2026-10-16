/** tm-enable.mjs — 在油猴列表里把所有脚本勾上「已启用」 */
const PORT = Number(process.argv[2] || 9225);
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM}/options.html#nav=scripts`)}`, { method: 'PUT' })).json();
await sleep(10000);
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });
const ev = async expr => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  return r.err || (r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : (r.result && r.result.value));
};

console.log('== 行结构（找启用控件）==');
console.log(await ev(`(function(){
  var out = [];
  var rows = document.querySelectorAll('tr.scripttr');
  for (var i = 0; i < rows.length && i < 5; i++) {
    var tds = rows[i].querySelectorAll('td');
    var info = { i: i, name: (rows[i].querySelector('.script_name') || {}).innerText || '', cells: [] };
    for (var j = 0; j < tds.length; j++) {
      var td = tds[j];
      var cb = td.querySelector('input[type=checkbox]');
      info.cells.push({ j: j, cls: String(td.className).slice(0,30), text: (td.innerText||'').trim().slice(0,20), hasCb: !!cb, cbChecked: cb ? cb.checked : null, cbCls: cb ? String(cb.className).slice(0,40) : null });
    }
    out.push(info);
  }
  return JSON.stringify(out, null, 1);
})()`));

console.log('');
console.log('== 勾选所有「已启用」 ==');
console.log(await ev(`(function(){
  var done = [];
  var rows = document.querySelectorAll('tr.scripttr');
  for (var i = 0; i < rows.length; i++) {
    var name = (rows[i].querySelector('.script_name') || {}).innerText || ('row' + i);
    var cb = rows[i].querySelector('td input[type=checkbox]');
    if (!cb) { done.push(name + ':no-cb'); continue; }
    if (cb.checked) { done.push(name + ':already'); continue; }
    cb.click();
    done.push(name + ':clicked');
  }
  return done.join(' | ');
})()`));
await sleep(3000);

console.log('');
console.log('== 复查 ==');
console.log(await ev(`(function(){
  var out = [];
  var rows = document.querySelectorAll('tr.scripttr');
  for (var i = 0; i < rows.length; i++) {
    var name = (rows[i].querySelector('.script_name') || {}).innerText || ('row' + i);
    var cb = rows[i].querySelector('td input[type=checkbox]');
    out.push(name + '=' + (cb ? cb.checked : 'n/a'));
  }
  return out.join(' | ');
})()`));
c.close();
