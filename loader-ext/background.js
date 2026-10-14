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
  'https://study.bjqiyang.com/*',
  'https://tea.webtrn.cn/*'      // 教师培训：目前只读监看（研修活动/作业的正文与提交另行授权）
];
const CODE_URL = 'http://127.0.0.1:17800/netclass.user.js';

/**
 * 弹题作答要问 DeepSeek，路由方式几经实测，最后落在**「SW 把 key 注入页面 + 页面直连 DeepSeek」**：
 *
 *   SW（key 存在 chrome.storage.local）-- register/execute 注入 --> 页面 MAIN world
 *   页面 -- fetch（DeepSeek 放行 CORS，实测 401 而非 CORS 报错）--> api.deepseek.com
 *
 * 2026-10-14 试过并排除的三条路（别再回头）：
 *   ① register()/execute() 的 `world` 只接受 MAIN 或 USER_SCRIPT —— 传自定义 worldId 会让
 *      整批注册抛 "Value must be one of MAIN, USER_SCRIPT"，页面连脚本都拿不到；
 *   ② USER_SCRIPT 世界 + configureWorld({messaging:true})：隔离世界里 chrome.runtime.sendMessage
 *      仍是 undefined；
 *   ③ manifest 的 externally_connectable + 页面侧 sendMessage/connect：页面里 API 确实存在，
 *      但一发就是 "Could not establish connection. Receiving end does not exist."（重启浏览器无效）。
 *   另外页面 fetch http://127.0.0.1:17800 被 mixed-content/PNA 拦，本机服务中转也不通。
 *
 * 代价：key 会出现在页面 MAIN world（仅内存，不写 localStorage、不落盘）。这是本环境里唯一
 * 跑得通的组合；要更严的隔离得先换一个 messaging 正常的 Chrome。
 */

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

/** 把 DeepSeek 凭据随脚本一起送进页面（只进内存：不写 localStorage、不落盘、不进仓库） */
async function credsBootstrap() {
  try {
    const cfg = await chrome.storage.local.get(['deepseekKey', 'deepseekModel']);
    if (!cfg.deepseekKey) return { boot: '', sigPart: 'nokey' };
    const boot = 'window.__NC_DS_KEY__=' + JSON.stringify(cfg.deepseekKey)
      + ';window.__NC_DS_MODEL__=' + JSON.stringify(cfg.deepseekModel || 'deepseek-chat') + ';\n';
    return { boot, sigPart: hashCode(cfg.deepseekKey) + '-' + (cfg.deepseekModel || 'deepseek-chat') };
  } catch (_) { return { boot: '', sigPart: 'nokey' }; }
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

async function register(code, source, sig, boot) {
  const st = stamp(code);
  self.__lastBuildId = st.id;
  const existing = await chrome.userScripts.getScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  if (existing.length) {
    await chrome.userScripts.unregister({ ids: [SCRIPT_ID] }).catch(() => { });
  }
  await chrome.userScripts.register([{
    id: SCRIPT_ID,
    matches: MATCHES,
    js: [{ code: (boot || '') + st.code }],   // 凭据随脚本下发（只进内存）
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
  await injectIntoOpenTabs(code, boot);
}

/** 浏览器启动时页面可能先于扩展注册完成，导致脚本没注入 —— 补一次到已打开的标签页 */
async function injectIntoOpenTabs(code, boot) {
  const st = stamp(code);
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: MATCHES }); } catch (e) { log('tabs.query failed: ' + e.message); return; }
  for (const t of tabs) {
    if (!t.id) continue;
    try {
      if (boot) {
        // 凭据单独补一次：换 key 后不需要等模块重建
        await chrome.userScripts.execute({
          target: { tabId: t.id },
          js: [{ code: boot }],
          world: 'MAIN',
          injectImmediately: true
        }).catch(() => { });
      }
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
  // 串行化：alarm 与「页面导航」可能同时触发，两个 ensure 并发时会双双读到旧的 lastSig，
  // 于是注册两遍（2026-10-14 在日志里看到同一秒两条 registered）。
  if (self.__ensureRunning) return self.__ensureRunning;
  self.__ensureRunning = ensureOnce(reason).finally(() => { self.__ensureRunning = null; });
  return self.__ensureRunning;
}

async function ensureOnce(reason) {
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
  // 签名里带上 key/模型的指纹：换 key 后也要重新下发一次。
  const { boot, sigPart } = await credsBootstrap();
  const sig = hashCode(code) + ':' + source + ':' + sigPart;
  const force = reason === 'installed' || reason === 'startup' || reason === 'boot' || reason === 'manual';
  try {
    const prev = await chrome.storage.local.get(['lastSig']);
    if (!force && prev.lastSig === sig) {
      return;                       // 一模一样，什么都不用做
    }
  } catch (_) { }

  try {
    await register(code, source, sig, boot);
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
    const { boot } = await credsBootstrap();
    await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code: (boot || '') + st.code }],
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

// 外部可触发：页面（externally_connectable）问题、脚本/调试触发刷新与状态查询
const ALLOWED_PAGE = /^https:\/\/(edu\.shengshengketang\.com|study\.bjqiyang\.com)\//;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromPage = !!(sender && sender.url && ALLOWED_PAGE.test(sender.url));
  if (msg && msg.cmd === 'refresh') {
    ensure('manual').then(() => reply({ ok: true })).catch(e => reply({ ok: false, err: String(e) }));
    return true;
  }
  if (msg && msg.cmd === 'ask') {
    // 只接受两个课程页发来的提问；别的来源（含其它扩展/页面）一律拒绝
    if (!fromPage) {
      log('ask 被拒: ' + ((sender && sender.url) || 'unknown sender'));
      reply({ ok: false, err: 'sender not allowed' });
      return true;
    }
    dsAsk(msg).then(answer => reply({ ok: true, answer })).catch(e => reply({ ok: false, err: String((e && e.message) || e) }));
    return true;
  }
  if (msg && msg.cmd === 'status') {
    chrome.storage.local.get(null).then(v => reply({ ok: true, v }));
    return true;
  }
});

// ---------------------------------------------------------------- DeepSeek 转发
// 页面（主世界）没有跨域能力，key 也不该出现在页面里：统一由 SW 代发。
// key 与模型名放在 chrome.storage.local，用 `node scripts/ds-key.mjs set --key <key>` 写入。
const DS_URL = 'https://api.deepseek.com/chat/completions';
const DS_SYSTEM = '你是网课随堂题的答题助手。只输出选项字母，不要解释、不要标点以外的内容。'
  + '多选题输出所有正确选项的字母，用英文逗号分隔（如 B,D）。判断题按选项字母输出。';

async function dsAsk(payload) {
  const cfg = await chrome.storage.local.get(['deepseekKey', 'deepseekModel']);
  if (!cfg.deepseekKey) throw new Error('未配置 DeepSeek key（在 PC 上跑 node scripts/ds-key.mjs set --key <sk-...>）');
  const user = '题型：' + String(payload.type || '单选题') + '\n题目：' + String(payload.question || '').slice(0, 900)
    + '\n选项：\n' + String(payload.options || '').slice(0, 3000) + '\n\n只输出字母。';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  const started = Date.now();
  try {
    const r = await fetch(DS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.deepseekKey },
      body: JSON.stringify({
        model: cfg.deepseekModel || 'deepseek-chat',
        temperature: 0,
        max_tokens: 32,
        messages: [{ role: 'system', content: DS_SYSTEM }, { role: 'user', content: user }]
      }),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    const tokens = (j.usage && j.usage.total_tokens) || '?';
    log('deepseek ->', text.slice(0, 24), 'tokens=' + tokens, (Date.now() - started) + 'ms');
    return text;
  } finally { clearTimeout(t); }
}
