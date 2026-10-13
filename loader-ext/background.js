/**
 * NetClass Loader — 用 chrome.userScripts 直接注册 NetClass 网课脚本
 *
 * 为什么需要它：Tampermonkey 依赖 chrome.userScripts 执行用户脚本，
 * 在 OCS 内置的 Chrome 137（未打包扩展 + 计划任务启动）环境里这条链路不稳定，
 * 表现为「脚本装得上、不执行」。本扩展把「注册 + 执行」这一层自己做掉，稳且可控。
 *
 * 行为：
 *   - 启动 / 安装 / 每 15 分钟：从本机服务拉最新脚本（拉不到就用内置副本）
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
  try { console.log('[NetClassLoader]', ...a); } catch (_) { }
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

async function register(code, source) {
  await chrome.userScripts.configureWorld({
    worldId: WORLD_ID,
    csp: "script-src 'self' 'unsafe-inline' *",
    messaging: false
  });
  const existing = await chrome.userScripts.getScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  if (existing.length) {
    await chrome.userScripts.unregister({ ids: [SCRIPT_ID] }).catch(() => { });
  }
  await chrome.userScripts.register([{
    id: SCRIPT_ID,
    matches: MATCHES,
    js: [{ code }],
    runAt: 'document_start',
    allFrames: false,
    world: 'MAIN'
  }]);
  await chrome.storage.local.set({ lastSource: source, lastAt: Date.now(), lastLen: code.length });
  log('registered', source, code.length + 'B');
  await injectIntoOpenTabs(code);
}

/** 浏览器启动时页面可能先于扩展注册完成，导致脚本没注入 —— 补一次到已打开的标签页 */
async function injectIntoOpenTabs(code) {
  const patterns = MATCHES.map(m => m.replace('/*', '/*'));
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: patterns }); } catch (e) { log('tabs.query failed: ' + e.message); return; }
  for (const t of tabs) {
    if (!t.id) continue;
    try {
      const probe = await chrome.userScripts.execute({
        target: { tabId: t.id },
        js: [{ code: 'Boolean(window.__NETCLASS_SHELL__ || window.NetClass)' }],
        world: 'MAIN',
        injectImmediately: true
      }).catch(() => null);
      const already = probe && probe[0] && probe[0].result === true;
      if (already) { log('tab ' + t.id + ' 已有脚本，跳过补注入'); continue; }
      await chrome.userScripts.execute({
        target: { tabId: t.id },
        js: [{ code }],
        world: 'MAIN',
        injectImmediately: true
      });
      log('补注入到 tab ' + t.id + ' (' + String(t.url).slice(0, 50) + ')');
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
  try {
    const prev = await chrome.storage.local.get(['lastAt', 'lastSource', 'lastLen']);
    if (prev.lastSource === source && prev.lastLen === code.length && reason === 'alarm') {
      // 长度一样且是定时检查：仍做一次 register 以保证注册存在
    }
    await register(code, source);
  } catch (e) {
    log('register failed: ' + e.message);
  }
}

chrome.runtime.onInstalled.addListener(() => ensure('installed'));
chrome.runtime.onStartup.addListener(() => ensure('startup'));
chrome.alarms.create('netclass-refresh', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'netclass-refresh') ensure('alarm'); });

// 立即执行一次
ensure('boot');

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
