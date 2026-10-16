/** refresh-diag.mjs — 查两个浏览器有没有在频繁刷新：标签标题、导航次数、加载时间 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.navs = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) this.navs.push({ t: Date.now(), url: String(m.params.frame.url).slice(0, 70) });
        if (m.method === 'Page.frameStartedLoading') this.navs.push({ t: Date.now(), url: '(loading)' });
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

for (const PORT of [9224, 9225]) {
  console.log('===== :' + PORT + ' =====');
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
  catch (e) { console.log('  CDP 不可达'); continue; }

  for (const t of list.filter(x => x.type === 'page')) {
    const c = new Cdp(t.webSocketDebuggerUrl);
    try { await c.open(); } catch { continue; }
    const r = await c.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.title,
        url: location.href.slice(0, 70),
        readyState: document.readyState,
        navEntries: (function(){ try { return performance.getEntriesByType('navigation').length; } catch(e){ return -1; } })(),
        timeSinceLoad: (function(){ try { var n = performance.getEntriesByType('navigation')[0]; return n ? Math.round((Date.now() - n.startTime)/1000) : -1; } catch(e){ return -1; } })(),
        loadCount: (function(){ try { return performance.getEntriesByType('navigation').length; } catch(e){ return -1; } })(),
        docId: (function(){ return window.__ncDocSeq = (window.__ncDocSeq || 0); })(),
        visibility: document.visibilityState,
        netclass: !!window.NetClass,
        build: window.__NETCLASS_BUILD_ID__ || null,
        cfgEnabled: window.NetClass ? window.NetClass.cfg.enabled : null,
        ticks: window.NetClass ? window.NetClass.state.loopTicks : null,
        errs: window.NetClass ? window.NetClass.state.errors.slice(-3) : null
      })`, returnByValue: true
    }).catch(() => null);
    console.log('  [' + t.url.slice(0, 55) + ']');
    console.log('    ' + (r && r.result.value));

    // 监听 20 秒内的导航事件
    await c.send('Page.enable').catch(() => { });
    c.navs = [];
    await sleep(20000);
    const frameNavs = c.navs.filter(n => n.url !== '(loading)');
    console.log('    20 秒内 frameNavigated 次数: ' + frameNavs.length + (frameNavs.length ? '  → ' + frameNavs.map(n => n.url.slice(0, 40)).join(' | ') : ''));
    c.close();
  }
  console.log('');
}
