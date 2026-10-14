/**
 * NetClass Loader — 用 chrome.userScripts 直接注册 NetClass 网课脚本
 *
 * 为什么需要它：Tampermonkey 依赖 chrome.userScripts 执行用户脚本，
 * 在 OCS 内置的 Chrome 137（未打包扩展 + 计划任务启动）环境里这条链路不稳定，
 * 表现为「脚本装得上、不执行」。本扩展把「注册 + 执行」这一层自己做掉，稳且可控。
 *
 * 行为：
 *   - 启动 / 安装 / 每 2 分钟（alarm）/ 目标站点导航时：从本机服务拉最新脚本（拉不到就用内置副本）
 *   - 用 chrome.userScripts.update/register 注册到 MAIN world，document_start
 *   - 脚本更新后，新开的页面自动用新版
 */

const SCRIPT_ID = 'netclass-user-script';
const MATCHES = [
  'https://edu.shengshengketang.com/*',
  'https://study.bjqiyang.com/*'
];
const CODE_URL = 'http://127.0.0.1:17800/netclass.user.js';
const WORLD_ID = 'netclass';

// 构建时嵌入的脚本副本（scripts/build-loader.mjs 生成）
importScripts('bundled.js');

function log(...a) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { console.log('[NetClassLoader]', ...a); } catch (_) { }
  // 落一份到 storage，SW 被回收后还能查
  try {
    chrome.storage.local.get(['logRing'], v => {
      let ring = (v && v.logRing) || [];
      ring.push(line);
      if (ring.length > 120) ring = ring.slice(-120);
      chrome.storage.local.set({ logRing: ring });
    });
  } catch (_) { }
}

/** 简单的字符串哈希，用来做「页面跑的是不是最新代码」的判据 */
function hashCode(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** 注册/注入时都带上构建标记，页面据此判断是否需要换新版 */
function stamp(code) {
  const id = hashCode(code);
  return { id, code: 'window.__NETCLASS_BUILD_ID__=' + JSON.stringify(id) + ';\n' + code };
}

async function fetchRemote() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(CODE_URL + '?t=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('status ' + r.status);
    const text = await r.text();
    if (!text || text.length < 2000) throw new Error('too short: ' + (text ? text.length : 0));
    return { code: text, source: 'remote' };
  } finally { clearTimeout(t); }
}

async function register(code, source, sig) {
  await chrome.userScripts.configureWorld({
    worldId: WORLD_ID,
    csp: "script-src 'self' 'unsafe-inline' *",
    messaging: false
  });
  const st = stamp(code);
  self.__lastBuildId = st.id;
  const existing = await chrome.userScripts.getScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  if (existing.length) {
    await chrome.userScripts.unregister({ ids: [SCRIPT_ID] }).catch(() => { });
  }
  await chrome.userScripts.register([{
    id: SCRIPT_ID,
    matches: MATCHES,
    js: [{ code: st.code }],
    runAt: 'document_start',
    allFrames: false,
    world: 'MAIN'
  }]);
  // 去重签名必须最先落盘：MV3 的 SW 随时可能在后面的补注入过程中被回收，
  // 一旦这句没执行到，下一个 alarm 读不到 lastSig 就会重复注册（表现为日志每 60s 一条
  // "registered ..."，页面模块内存状态被反复清零）。2026-10-14：qiyang 配置就是这样刷了一整晚。
  try {
    await chrome.storage.local.set({ lastSource: source, lastAt: Date.now(), lastLen: code.length, lastBuildId: st.id, lastSig: sig });
  } catch (_) { }
  log('registered', source, code.length + 'B', 'build=' + st.id);
  await injectIntoOpenTabs(code);
}

/** 浏览器启动时页面可能先于扩展注册完成，导致脚本没注入 —— 补一次到已打开的标签页 */
async function injectIntoOpenTabs(code) {
  const st = stamp(code);
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: MATCHES }); } catch (e) { log('tabs.query failed: ' + e.message); return; }
  for (const t of tabs) {
    if (!t.id) continue;
    try {
      const probe = await chrome.userScripts.execute({
        target: { tabId: t.id },
        js: [{ code: 'Boolean(window.__NETCLASS_SHELL__ || window.NetClass) && window.__NETCLASS_BUILD_ID__ === ' + JSON.stringify(st.id) }],
        world: 'MAIN',
        injectImmediately: true
      }).catch(() => null);
      const upToDate = probe && probe[0] && probe[0].result === true;
      if (upToDate) { log('tab ' + t.id + ' 已是最新版，跳过'); continue; }
      await chrome.userScripts.execute({
        target: { tabId: t.id },
        js: [{ code: st.code }],
        world: 'MAIN',
        injectImmediately: true
      });
      log('注入到 tab ' + t.id + ' (' + String(t.url).slice(0, 50) + ') build=' + st.id);
    } catch (e) {
      log('tab ' + t.id + ' 注入失败: ' + e.message);
    }
  }
}

async function ensure(reason) {
  let code = null, source = null;
  try {
    const r = await fetchRemote();
    code = r.code; source = r.source;
  } catch (e) {
    log('remote fetch failed (' + e.message + '), using bundled');
    code = self.NETCLASS_BUNDLED; source = 'bundled';
  }
  if (!code) { log('no code available'); return; }
  self.__lastCode = code;

  // 内容没变就不要再 register：反复注册会让 Chrome 在每个匹配文档里重跑脚本，
  // 页面里的模块被反复重置（内存状态、弹题处理全丢），日志也会被刷满。
  const sig = hashCode(code) + ':' + source;
  const force = reason === 'installed' || reason === 'startup' || reason === 'boot' || reason === 'manual';
  try {
    const prev = await chrome.storage.local.get(['lastSig']);
    if (!force && prev.lastSig === sig) {
      return;                       // 一模一样，什么都不用做
    }
  } catch (_) { }

  try {
    await register(code, source, sig);
  } catch (e) {
    log('register failed: ' + e.message);
  }
}

chrome.runtime.onInstalled.addListener(() => ensure('installed'));
chrome.runtime.onStartup.addListener(() => ensure('startup'));
chrome.alarms.create('netclass-refresh', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'netclass-refresh') ensure('alarm'); });

// MV3 的 SW 会被回收，光靠 alarm 不够 —— 每次目标站点导航时都检查一次更新
let lastNavCheck = 0;
try {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    const url = String((tab && tab.url) || '');
    log('onUpdated tab=' + tabId + ' status=' + info.status + ' url=' + url.slice(0, 60));
    if (!/shengshengketang\.com|bjqiyang\.com/.test(url)) return;
    if (info.status === 'loading') {
      const t = Date.now();
      if (t - lastNavCheck < 5000) return;      // 去抖
      lastNavCheck = t;
      ensure('navigate');
    } else if (info.status === 'complete') {
      // 兜底：页面可能比扩展先加载完，检查一次，没有脚本就补注入
      ensureThenInject(tabId, url);
    }
  });
} catch (e) { log('tabs.onUpdated hook failed: ' + e.message); }

/** 页面加载完成后：确保脚本已注册，并检查该页是否真的跑起来了，没跑就补注入 */
async function ensureThenInject(tabId, url) {
  try {
    await ensure('tab-complete');
    let code = self.__lastCode || self.NETCLASS_BUNDLED;
    if (!code) return;
    const st = stamp(code);
    const probe = await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code: 'Boolean(window.__NETCLASS_SHELL__ || window.NetClass) && window.__NETCLASS_BUILD_ID__ === ' + JSON.stringify(st.id) }],
      world: 'MAIN', injectImmediately: true
    }).catch(() => null);
    if (probe && probe[0] && probe[0].result === true) return;   // 已是最新版
    await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code: st.code }],
      world: 'MAIN', injectImmediately: true
    });
    log('兜底注入 tab ' + tabId + ' ' + String(url).slice(0, 50) + ' build=' + st.id);
  } catch (e) {
    log('ensureThenInject 失败: ' + e.message);
  }
}

// 立即执行一次；启动时浏览器往往先把目标页打开完了，onUpdated 不会再触发，
// 所以再安排两次延时补注入兜底
ensure('boot');
[12000, 40000, 90000].forEach(ms => setTimeout(() => ensureThenInjectAll(), ms));

async function ensureThenInjectAll() {
  try {
    await ensure('delayed');
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: MATCHES }); } catch { return; }
    for (const t of tabs) {
      if (t.id) await ensureThenInject(t.id, t.url);
    }
  } catch (e) { log('ensureThenInjectAll 失败: ' + e.message); }
}

// 外部可触发（调试用）
chrome.runtime.onMessage.addListener((msg, s, reply) => {
  if (msg && msg.cmd === 'refresh') {
    ensure('manual').then(() => reply({ ok: true })).catch(e => reply({ ok: false, err: String(e) }));
    return true;
  }
  if (msg && msg.cmd === 'status') {
    chrome.storage.local.get(null).then(v => reply({ ok: true, v }));
    return true;
  }
});
