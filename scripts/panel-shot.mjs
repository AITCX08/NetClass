/** panel-shot.mjs — 截取 NetClass 面板区域，看那个白框到底是什么 */
const PORT = Number(process.argv[2] || 9225);
const sleep = ms => new Promise(r => setTimeout(r, ms));
import { writeFileSync } from 'node:fs';

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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /bjqiyang|shengshengketang/.test(t.url));
if (!page) { console.log('no page'); process.exit(1); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

// 面板 DOM 与计算样式
const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var p = document.getElementById('netclass-panel');
    if (!p) return JSON.stringify({ panel: null });
    var rect = p.getBoundingClientRect();
    var btns = Array.from(p.querySelectorAll('button')).map(function(b){
      var cs = getComputedStyle(b);
      var br = b.getBoundingClientRect();
      return {
        text: (b.innerText || '').trim(),
        rect: { w: Math.round(br.width), h: Math.round(br.height) },
        bg: cs.backgroundColor, color: cs.color, border: cs.border, fontSize: cs.fontSize,
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity
      };
    });
    var pcs = getComputedStyle(p);
    return JSON.stringify({
      panelRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      panelStyle: { bg: pcs.backgroundColor, color: pcs.color, display: pcs.display, zIndex: pcs.zIndex, overflow: pcs.overflow },
      innerHTMLlen: p.innerHTML.length,
      text: (p.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
      buttons: btns
    }, null, 1);
  })()`, returnByValue: true
});
console.log(r.result && r.result.value);

// 截图面板区域
try {
  const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 960, height: 1032, scale: 0.6 } });
  const out = 'C:/Users/Administrator/Desktop/Vibe/_opensource/artifacts/TaskMesh/netclass-20261013/runs/panel-shot.png';
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('');
  console.log('截图已保存: ' + out);
} catch (e) { console.log('截图失败: ' + e.message); }
c.close();
