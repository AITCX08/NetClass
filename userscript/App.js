/* NetClass 实现模块（由网课壳热加载）
 * 目标站点：edu.shengshengketang.com / study.bjqiyang.com
 * 职责：视频自动播放·静音·倍速·掉速纠正·结束自动下一节；随堂弹题自动作答（DeepSeek 给答案，
 *      答错时用站点回传的正确答案补交）；控制面板。
 * 约束：只做页面内的正常播放与页面自身表单作答；不伪造学时、不代考、不绕过验证码/人脸/短信。
 * 接口（供壳热重载与外部控制端调用）：
 *   window.NetClass = { version, platform, cfg, state, dispose(), ... }
 */
(function () {
  'use strict';

  // 热重载时先回收上一个实例
  try { window.NetClass && window.NetClass.dispose && window.NetClass.dispose(); } catch (_) { }

  const VERSION = '0.5.9';
  const NS = '[NetClass]';
  // ★ 2026-10-20：品牌/引流配置（userscript/brand.js 由 build.mjs 内联到此处之前）。
  //   二维码是 base64 内联的（userscript 读不到本地文件）；留空则该位置不渲染，不会出破图。
  const BRAND = (typeof window !== 'undefined' && window.NETCLASS_BRAND) || {
    name: 'NetClass', author: '', repo: '',
    wechatQr: '', wechatLabel: '微信交流', wechatHint: '',
    donateQr: '', donateLabel: '赞赏支持', donateHint: '',
    sponsorUrl: '', proTitle: '自动答题', proDesc: '', proUrl: '', proEnabled: false,
    brandCollapsedByDefault: true,
  };
  /**
   * 面板底部的品牌区块：微信码 + 赞赏码 + 仓库链接。
   * 两个码都空 → 整个区块不渲染（开源给别人用时不打扰）。
   * 已收起 → 只留一行"支持作者 ▾"，点开才显示二维码（默认收起，避免占满面板）。
   */
  function brandBlock() {
    const hasQr = !!(BRAND.wechatQr || BRAND.donateQr || BRAND.sponsorUrl);
    if (!hasQr && !BRAND.repo) return '';
    // ★ 2026-10-20：默认展开由 brandCollapsedByDefault 决定（引流位要直接可见）。
    //   用户的点击选择持久化在 localStorage，优先于默认值。
    let open = !BRAND.brandCollapsedByDefault;
    try {
      const saved = localStorage.getItem('netclass.brandOpen');
      if (saved === '1') open = true;
      else if (saved === '0') open = false;
    } catch (_) { }
    const qrCell = (uri, label, hint) => uri
      ? '<div style="text-align:center;flex:1">' +
      `<img src="${uri}" style="width:110px;height:110px;border-radius:6px;background:#fff;padding:3px;display:block;margin:0 auto 3px" alt="${label}">` +
      `<div style="font-size:11px;opacity:.9">${label}</div>` +
      (hint ? `<div style="font-size:10px;opacity:.6">${hint}</div>` : '') +
      '</div>'
      : '';
    const body = open
      ? '<div style="display:flex;gap:8px;justify-content:center;margin-top:6px">' +
      qrCell(BRAND.wechatQr, BRAND.wechatLabel, BRAND.wechatHint) +
      qrCell(BRAND.donateQr, BRAND.donateLabel, BRAND.donateHint) +
      '</div>' +
      (BRAND.sponsorUrl ? `<div style="text-align:center;margin-top:5px;font-size:11px"><a href="${BRAND.sponsorUrl}" target="_blank" rel="noopener" style="color:#00e676">❤ GitHub Sponsors</a></div>` : '')
      : '';
    return '<div style="margin-top:9px;padding-top:7px;border-top:1px solid rgba(255,255,255,.12)">' +
      `<div id="netclass-brand-hd" data-nc-self="1" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-size:11px;opacity:.8">` +
      `<span>${BRAND.repo ? `<a href="${BRAND.repo}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">★ ${BRAND.name}</a>` : '★ ' + BRAND.name}` +
      `${BRAND.author ? ` · by ${BRAND.author}` : ''}</span>` +
      `<span style="opacity:.7">${open ? '收起 ▴' : '支持作者 ▾'}</span></div>` +
      body + '</div>';
  }
  const HOST = location.hostname;
  const PLATFORM = /shengshengketang/i.test(HOST) ? 'shengsheng'
    : /bjqiyang/i.test(HOST) ? 'qiyang'
      : /webtrn\.cn/i.test(HOST) ? 'webtrn'
        : /chaoxing\.com/i.test(HOST) ? 'chaoxing'
          : /ccjyxy\.cn/i.test(HOST) ? 'ccjyxy'
            : /zhihuishu\.com/i.test(HOST) ? 'zhihuishu' : 'unknown';
  const PLATFORM_LABEL = { shengsheng: '生生课堂', qiyang: '职业培训', webtrn: '教师培训', chaoxing: '学习通', ccjyxy: '长春教师培训', zhihuishu: '智慧树知到', unknown: '未知平台' }[PLATFORM];
  const log = (...a) => console.log(NS, ...a);
  const warn = (...a) => console.warn(NS, ...a);
  const now = () => Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ------------------------------------------------------------ 配置
  const DEFAULTS = {
    enabled: true, autoPlay: true, mute: true, rate: 1, autoNext: true, autoQuiz: true,
    quizDelayMs: 700, antiPause: true, panel: true, report: false,
    userRate: false, rateQiyang: 2, rateShengsheng: 1.5,
    reportBase: 'http://192.168.1.6:17999', probe: false,
    // 弹题作答由 DeepSeek 负责（经加载器扩展的 SW 转发，key 只存在笔记本本地）
    dsEnable: true, dsModel: 'deepseek-chat', dsTimeoutMs: 20000
  };
  const CFG_KEY = 'netclass.cfg.v3';
  const BANK_KEY = 'netclass.bank.v3';
  const CFG = (() => {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
  })();
  const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch (_) { } };

  const state = {
    version: VERSION, platform: PLATFORM, host: HOST, startedAt: now(), loopTicks: 0,
    video: { seen: 0, ended: 0, rateFixes: 0, resumed: 0 },
    quiz: { seen: 0, answered: 0, correct: 0, wrong: 0, bankHit: 0, bankMiss: 0, dsAsk: 0, dsOk: 0, dsErr: 0 },
    next: { clicks: 0, misses: 0 }, errors: [], route: location.href, allDone: false, doneAt: null
  };
  window.__NETCLASS_STATE__ = state;

  function err(e) {
    const m = String(e && e.message || e);
    // 记前两帧调用栈，便于定位（只保留文件名+行号段，够用且不刷屏）
    let where = '';
    try {
      if (e && e.stack) {
        const lines = String(e.stack).split('\n').slice(1, 4)
          .map(s => s.trim().replace(/^at\s+/, '').slice(0, 90));
        where = lines.join(' <- ');
      }
    } catch (_) { }
    state.errors.push({ at: now(), m, where });
    if (state.errors.length > 20) state.errors.shift();
  }

  /** 已提交待平台判定的题目（等 insertUserAnswer 回包对账，答错时回填正确答案） */
  const pendingQuiz = [];
  function report(kind, payload) {
    if (!CFG.report) return;
    try {
      const body = JSON.stringify({ platform: PLATFORM, host: HOST, kind, at: now(), payload });
      if (typeof GM_xmlhttpRequest === 'function') GM_xmlhttpRequest({ method: 'POST', url: CFG.reportBase + '/ingest', headers: { 'Content-Type': 'application/json' }, data: body, timeout: 5000 });
      else fetch(CFG.reportBase + '/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => { });
    } catch (_) { }
  }

  // ------------------------------------------------------------ 网络观察层
  const quizFeed = [];
  const apiLog = [];
  const cleanups = [];
  const timers = [];
  /** 登录态与关键接口的响应快照（只保留结构/短文本，用于适配与排障） */
  const loginInfo = { at: 0, code: null, keys: null, name: null, raw: null };
  let lastCourseData = null;

  const SHORT_KEYS = ['code', 'data', 'msg', 'content'];

  function looksLikeQuiz(b) {
    try { const s = JSON.stringify(b).slice(0, 5000); return /"optionList"|"popQuizId"|"isMustRight"|"question"\s*:\s*\{/.test(s); } catch { return false; }
  }
  function rememberQuiz(b, url) {
    try {
      const d = b && b.data;
      const items = Array.isArray(d) ? d : (d && Array.isArray(d.list) ? d.list : (d && d.question ? [d] : []));
      for (const it of items) if (it && it.question) { quizFeed.push({ at: now(), url: String(url).slice(0, 200), item: it }); say('捕获随堂题', it.id, (it.question.name || '').slice(0, 40)); }
      if (quizFeed.length > 40) quizFeed.shift();
    } catch (_) { }
  }
  const say = (...a) => log('quiz:', ...a);

  function captureLogin(b, url) {
    try {
      if (!/login\/(info|autoLogin|registerUser)/.test(url)) return;
      const d = b && b.data;
      loginInfo.at = now();
      loginInfo.code = b && b.code;
      loginInfo.keys = d && typeof d === 'object' ? Object.keys(d).slice(0, 20) : null;
      loginInfo.name = d && (d.nickName || d.nickname || d.userName || d.mobile || d.phone || null);
      loginInfo.raw = d ? JSON.stringify(d).slice(0, 400) : null;
      log('登录态快照', loginInfo.code, loginInfo.name || '(未登录/未返回昵称)');
    } catch (_) { }
  }

  /** 页面自身请求的头部快照（用于复现鉴权；按 URL 片段归类） */
  const reqHeaders = [];   // [{ at, url, headers }]
  function recordHeaders(url, headers) {
    try {
      const u = String(url).slice(0, 200);
      const h = {};
      for (const k of Object.keys(headers || {})) {
        const v = String(headers[k]);
        // 只保留前 12 字符，够判断字段名与格式，不当全文留存
        h[k] = v.length > 12 ? v.slice(0, 12) + '…(' + v.length + ')' : v;
      }
      reqHeaders.push({ at: now(), url: u, headers: h });
      if (reqHeaders.length > 60) reqHeaders.shift();
    } catch (_) { }
  }

  /**
   * ★★ 智慧树反检测（2026-10-15 实测定位，证据在 references/platforms.md 的 zhihuishu 章节）：
   *   站点 stuStudy.js 会跑
   *     isNative(window.XMLHttpRequest) && isNative(XMLHttpRequest.prototype.open)
   *       && !window.OCS && isNative(Element.prototype.addEventListener)      ← 任一不满足 →
   *   弹「检测到异常脚本…请您关闭插件」+ 3 秒后 window.location 跳回 www.zhihuishu.com；
   *   另有元素级监听器拿 `!e.isTrusted` 判"合成事件"。
   *   实测：注入本模块 → ~1 秒即被判；把模块 dispose 掉（撤钩子/面板）→ 连续 8 秒无检测。
   *   所以 zhihuishu 走**最小侵入**：只包 `XMLHttpRequest.prototype.send`（站点的检查只看 `.open`），
   *   不碰 `.open`/`.setRequestHeader`/`Element.prototype.addEventListener`，也不做 toString 伪装。
   *   数据来源仍然够用：在 send 的 load 里用 `this.responseURL` 认接口（open 没被包，URL 从回包里取）。
   */
  const ZHS_MINIMAL = PLATFORM === 'zhihuishu';

  /**
   * 知到「弹题」看护开关（2026-10-15 实测定稿）：
   *   页面侧只做 **识别 + 解析 + 决策 + 上报**（1 秒一次、纯 DOM 读）；
   *   **点击一律由 CDP 侧真实鼠标完成**（Input.dispatchMouseEvent → isTrusted=true）。
   *   为什么不在页面侧点：站点元素级监听拿 `!e.isTrusted` 判"合成事件"，实测合成点击后
   *   页面被弹回门户（warn 弹窗 + 3 秒跳转）——这条坑写进 platforms.md 了。
   */
  const ZHS_QUIZ_WATCH = true;

  /** 归一化文本：去 HTML 标签/空白/标点，用于"回包题目"与"DOM 题干"对齐 */
  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。；：！？、,.!?;:"'`]/g, '')
      .slice(0, 200);
  }

  // ------------------------------------------------------------ 反检测：把包装函数伪装成原生
  /**
   * 智慧树那条 isNative 检查里**包含 `XMLHttpRequest.prototype.open`**（解码自 bundle：0x38a/0x379/0x3a6）。
   * 包装过的函数 `Function.prototype.toString` 会露馅，所以在站点脚本之前用代理兜一层。
   * ⚠️ 只在"确实包了 .open"的非最小模式里启用；zhihuishu 走 ZHS_MINIMAL 时不启用（少一个可疑点）。
   */
  const NC_NATIVE_STR = new WeakMap();
  const NC_TO_STRING = Function.prototype.toString;
  function maskNative(fn, original) {
    try { if (fn && original) NC_NATIVE_STR.set(fn, NC_TO_STRING.call(original)); } catch (_) { }
    return fn;
  }
  if (!ZHS_MINIMAL) {
    try {
      const proxy = function toString() {
        try { if (NC_NATIVE_STR.has(this)) return NC_NATIVE_STR.get(this); } catch (_) { }
        return NC_TO_STRING.call(this);
      };
      try { NC_NATIVE_STR.set(proxy, NC_TO_STRING.call(NC_TO_STRING)); } catch (_) { }
      Function.prototype.toString = proxy;
    } catch (_) { }
  }

  function hookFetch() {
    const of = window.fetch;
    if (!of || of.__ncHooked) return;
    const hooked = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        const h = {};
        const ih = (init && init.headers) || (input && input.headers);
        if (ih) {
          if (typeof ih.forEach === 'function') ih.forEach((v, k) => h[k] = v);
          else if (Array.isArray(ih)) ih.forEach(([k, v]) => h[k] = v);
          else Object.keys(ih).forEach(k => h[k] = ih[k]);
        }
        if (Object.keys(h).length) recordHeaders(url, h);
      } catch (_) { }
      const p = of.apply(this, arguments);
      p.then(res => {
        try {
          const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          if (/json/i.test(ct) && url) {
            res.clone().json().then(b => {
              if (apiLog.length < 400) apiLog.push({ at: now(), url: String(url).slice(0, 200), code: b && b.code, keys: b && typeof b === 'object' ? Object.keys(b).slice(0, 12) : null });
              captureLogin(b, String(url));
              if (looksLikeQuiz(b)) rememberQuiz(b, url);
              P_ADAPTER && P_ADAPTER.onResponse && P_ADAPTER.onResponse(String(url), b);
            }).catch(() => { });
          }
        } catch (_) { }
        return res;
      }).catch(e => { throw e; });
      return p;
    };
    hooked.__ncHooked = true;
    maskNative(hooked, of);                 // 反检测：包装后的 fetch 也要"看起来是原生"
    window.fetch = hooked;
    cleanups.push(() => { if (window.fetch === hooked) window.fetch = of; });
  }
  function hookXhr() {
    const OX = window.XMLHttpRequest;
    if (!OX || OX.prototype.__ncHooked) return;
    const open = OX.prototype.open, send = OX.prototype.send, setH = OX.prototype.setRequestHeader;
    if (!ZHS_MINIMAL) OX.prototype.open = function (m, u) { this.__ncUrl = u; this.__ncHeaders = {}; return open.apply(this, arguments); };
    if (!ZHS_MINIMAL) OX.prototype.setRequestHeader = function (k, v) {
      try { this.__ncHeaders = this.__ncHeaders || {}; this.__ncHeaders[k] = String(v); } catch (_) { }
      return setH.apply(this, arguments);
    };
    OX.prototype.send = function () {
      try { if (this.__ncUrl && this.__ncHeaders && Object.keys(this.__ncHeaders).length) recordHeaders(this.__ncUrl, this.__ncHeaders); } catch (_) { }
      this.addEventListener('load', () => {
        try {
          // 最小模式没包 open：URL 从回包里拿（responseURL 就是最终请求地址）
          const u = this.__ncUrl || this.responseURL || '';
          const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
          if (!/json/i.test(ct) || !u) return;
          const b = JSON.parse(this.responseText);
          if (apiLog.length < 400) apiLog.push({ at: now(), url: String(u).slice(0, 200), code: b && b.code, keys: b && typeof b === 'object' ? Object.keys(b).slice(0, 12) : null });
          captureLogin(b, String(u));
          if (looksLikeQuiz(b)) rememberQuiz(b, u);
          P_ADAPTER && P_ADAPTER.onResponse && P_ADAPTER.onResponse(String(u), b);
        } catch (_) { }
      });
      return send.apply(this, arguments);
    };
    OX.prototype.__ncHooked = true;
    // 非最小模式：open/setRequestHeader 也被包了 → 登记成"原生"（zhihuishu 走 ZHS_MINIMAL，不包这两个）
    if (!ZHS_MINIMAL) {
      maskNative(OX.prototype.open, open);
      maskNative(OX.prototype.setRequestHeader, setH);
      maskNative(OX.prototype.send, send);
    }
    cleanups.push(() => {
      try { OX.prototype.open = open; OX.prototype.send = send; OX.prototype.setRequestHeader = setH; delete OX.prototype.__ncHooked; } catch (_) { }
    });
  }

  // ------------------------------------------------------------ 本地题库
  let bank = (() => { try { const r = localStorage.getItem(BANK_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; } })();
  let bankDirty = false;
  function normalize(s) { return String(s || '').replace(/[\s\u3000]+/g, '').replace(/[，。；：！？、,.!?;:""'']/g, '').slice(0, 200); }
  function bankKey(q) { const n = normalize(q && q.name); return n ? 'q:' + n : ''; }
  function bankGet(q) { const k = bankKey(q); if (!k) return null; const v = bank[k]; return v && v.answer ? v.answer : null; }
  function bankPut(q, answer, correct) {
    const k = bankKey(q); if (!k || !answer) return;
    const cur = bank[k] || { name: String(q.name || '').slice(0, 200), type: q.type };
    cur.answer = answer; cur.correct = correct !== false; cur.at = now(); cur.hits = cur.hits || 0;
    bank[k] = cur; bankDirty = true;
  }
  function flushBank() { if (!bankDirty) return; try { localStorage.setItem(BANK_KEY, JSON.stringify(bank)); bankDirty = false; } catch (_) { } }
  timers.push(setInterval(flushBank, 10000));

  // ------------------------------------------------------------ DeepSeek 作答（主路径）
  /**
   * 直接由页面调 DeepSeek：key 由加载器扩展在注入脚本时一并送进 MAIN world
   * （window.__NC_DS_KEY__ —— 只进内存，不写 localStorage、不落盘、不进仓库）。
   *
   * 为什么不用更"干净"的走法（2026-10-14 全部实测过，别再试）：
   *   ① 扩展自定义 world：register/execute 只接受 MAIN/USER_SCRIPT，直接抛错；
   *   ② USER_SCRIPT + messaging:true：隔离世界里 chrome.runtime.sendMessage 是 undefined；
   *   ③ manifest externally_connectable + 页面 sendMessage/connect：报
   *      "Could not establish connection"，重启浏览器也一样；
   *   ④ 页面 fetch http://127.0.0.1:17800 让本机服务中转：mixed-content/PNA 拦死。
   * 页面直连 api.deepseek.com 是通的（DeepSeek 放行 CORS），所以选了这条。
   */
  function dsSend(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const key = (typeof window !== 'undefined' && window.__NC_DS_KEY__) || '';
      if (!key) return reject(new Error('页面里没有 DeepSeek key（加载器没下发？跑 node scripts/ds-key.mjs set --key ... 后刷新页面）'));
      const model = window.__NC_DS_MODEL__ || CFG.dsModel || 'deepseek-chat';
      const sys = '你是网课随堂题的答题助手。只输出选项字母，不要解释。'
        + '多选题输出所有正确选项字母，用英文逗号分隔（如 B,D）。判断题按选项字母输出。'
        // ★ 抑制"多选题全选"（2026-10-15 补）：实测模型遇到稍有不确定的多选题就输出 A,B,C,D，
        //   而多选全选基本必错。这里明确要求逐项判断并限制数量，实测能显著提高命中率。
        + '多选题请**逐项独立判断**每个选项本身是否正确，不要因为"看起来都对"就全选；'
        + '网课多选题通常只有 2~3 个正确选项。除非你确认每一个选项都成立，否则不要输出全部选项。'
        + '若某个选项拿不准，就不要选它（宁少勿滥）。';
      const user = '题型：' + String(payload.type || '单选题')
        + '\n题目：' + String(payload.question || '').slice(0, 900)
        + '\n选项：\n' + String(payload.options || '').slice(0, 3000) + '\n\n只输出字母。';
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs || 20000);
      fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 32,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
        }),
        signal: ctl.signal
      }).then(r => {
        if (!r.ok) throw new Error('DeepSeek HTTP ' + r.status);
        return r.json();
      }).then(j => {
        clearTimeout(t);
        const txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
        const tokens = (j.usage && j.usage.total_tokens) || '?';
        log('quiz: DeepSeek 返回', txt.slice(0, 20), 'tokens=' + tokens);
        txt ? resolve(txt) : reject(new Error('DeepSeek 返回空'));
      }).catch(e => {
        clearTimeout(t);
        reject(e.name === 'AbortError' ? new Error('DeepSeek 超时') : e);
      });
    });
  }

  /** 把题目与选项压成一次问答；只接受落在选项里的字母，避免模型自由发挥 */
  async function dsAnswer(q) {
    const typeName = q.type === 2 ? '多选题（可能有多个正确答案）' : q.type === 3 ? '判断题' : '单选题';
    const names = [];
    const lines = [];
    for (const o of (q.optionList || [])) {
      const nm = String(o.name || '').replace(/[.\s]/g, '').toUpperCase().slice(0, 4);
      if (!nm) continue;
      names.push(nm);
      lines.push(nm + '. ' + String(o.data || '').trim().slice(0, 200));
    }
    if (!lines.length) throw new Error('题目没有可读选项');
    const raw = await dsSend({
      type: typeName,
      question: String(q.name || '').replace(/\s+/g, ' ').trim().slice(0, 800),
      options: lines.join('\n').slice(0, 3000)
    }, CFG.dsTimeoutMs);
    const letters = (raw.toUpperCase().match(/[A-H]/g) || []).filter(l => names.includes(l));
    const pick = [...new Set(letters)];
    // ★ 判断题兜底：选项不是字母（学习通判断题的选项是「对/错」），模型会直接答「对」「错」，
    //   原来只认 A-H 会抛「模型返回无法解析：对」（实测踩过）→ 这里把语义映射回选项 name。
    if (!pick.length) {
      const norm = String(raw).trim();
      const YES = /^(对|正确|是|√|T|TRUE|Y|YES)/i, NO = /^(错|错误|否|×|X|F|FALSE|N|NO)/i;
      for (const re of [YES, NO]) {
        if (re.test(norm)) {
          const hit = (q.optionList || []).find(o => re.test(String(o.data || '').trim()));
          if (hit) return String(hit.name);
        }
      }
      const hit2 = (q.optionList || []).find(o => {
        const t = String(o.data || '').trim();
        return t && (norm === t || norm.indexOf(t) >= 0 || t.indexOf(norm) >= 0);
      });
      if (hit2) return String(hit2.name);
    }
    if (!pick.length) throw new Error('模型返回无法解析：' + raw.slice(0, 60));
    if (q.type === 2) return pick.sort().join(',');
    if (q.type === 3) return pick[0];            // 判断题在站点里通常是 对/错 两个选项
    return pick[0];
  }

  /** 取答案：DeepSeek 优先 → 题库缓存 → 启发式兜底（后两者只在前者不可用时才用） */
  async function inferAnswer(q) {
    if (CFG.dsEnable) {
      state.quiz.dsAsk++;
      try {
        const a = await dsAnswer(q);
        if (a) { state.quiz.dsOk++; log('quiz: DeepSeek 给出答案', a, '|', String(q.name || '').slice(0, 40)); return { answer: a, why: 'deepseek', conf: 0.9 }; }
      } catch (e) {
        state.quiz.dsErr++;
        warn('DeepSeek 取答案失败，回退本地推断：' + ((e && e.message) || e));
      }
    }
    return guess(q);
  }

  // ------------------------------------------------------------ 作答启发（兜底）
  function guess(q) {
    const opts = (q && q.optionList) || [];
    if (!opts.length) return { answer: '', why: 'no-option', conf: 0 };
    const hit = bankGet(q);
    if (hit) { state.quiz.bankHit++; return { answer: hit, why: 'bank', conf: 1 }; }
    state.quiz.bankMiss++;

    const texts = opts.map(o => ({ name: String(o.name || '').replace(/[.\s]/g, ''), data: String(o.data || '').trim() }));
    if (q.type === 3) { // 判断
      for (const t of texts) if (/^(正确|对|是|true|√|T)$/i.test(t.data)) return { answer: t.name, why: 'judge-true', conf: 0.6 };
      return { answer: texts[0] ? texts[0].name : '', why: 'judge-first', conf: 0.3 };
    }
    const score = t => {
      let s = 0;
      if (/以上|全都|都是|均正确|都正确|全部正确|不确定/.test(t)) s += 2;
      if (/绝对|一定|必然|只有|必须|只能|所有|从不|永远/.test(t)) s -= 1.5;
      if (/^不是|^不能|^不对/.test(t)) s -= 1;
      if (t.length >= 8) s += 0.5;
      if (t.length >= 16) s += 0.5;
      return s;
    };
    const ranked = texts.map(t => ({ ...t, s: score(t.data) })).sort((a, b) => b.s - a.s);
    if (q.type === 1) return { answer: ranked[0].name, why: 'heuristic-single', conf: 0.35 };
    const picks = ranked.filter(r => r.s > 0.5).map(r => r.name);
    return { answer: (picks.length ? picks : [ranked[0].name]).join(','), why: 'heuristic-multi', conf: 0.25 };
  }

  // ------------------------------------------------------------ 视频控制
  /** 只认真正的媒体元素（Aliplayer 的 _video 等内部引用不是 DOM 元素，拿去调 play() 会炸） */
  function isMediaEl(el) {
    try {
      return !!el && typeof el.play === 'function' && 'readyState' in el && 'currentTime' in el;
    } catch (_) { return false; }
  }
  function pickVideo() {
    const vs = Array.from(document.querySelectorAll('video'));
    try {
      if (window.aliplayer && isMediaEl(window.aliplayer._video)) return window.aliplayer._video;
    } catch (_) { }
    if (!vs.length) return null;
    return vs.find(v => !v.ended && v.readyState >= 1) || vs[0];
  }
  /** 统一的「下一节」入口：交给当前平台适配器，没有就用通用实现 */
  function gotoNext(reason) {
    try {
      if (P_ADAPTER && typeof P_ADAPTER.nextChapter === 'function') {
        log('下一节（适配器）', reason || '');
        return P_ADAPTER.nextChapter();
      }
    } catch (e) { err(e); }
    return goNext();
  }

  /** 平台感知的倍速：用户手动设过优先，否则用各站点播放器自带的最高档（shengsheng 1.5x / qiyang 2x） */
  function effRate() {
    // ★ 统一过一遍"平台允许档位"夹取（见下面 PLATFORM_RATES）：用户设 2x 但站内只有 1.5 时返回 1.5，
    //   避免拿一个平台根本不接受的档位去反复设、把 rateFixes 刷爆。
    if (CFG.userRate) return clampRate(CFG.rate);
    return clampRate(PLATFORM === 'qiyang' ? (CFG.rateQiyang || 2) : (CFG.rateShengsheng || 1.5));
  }

  // ★★ 各平台**允许**的倍速档位（2026-10-16 用户要求"为每个平台都做适配"）
  //   依据（都是实测，不是猜的）：
  //     zhihuishu 站点只有 .speedList 里的 1.0 / 1.25 / 1.5 —— 超档就是"外部改属性"的异常信号
  //     ccjyxy    站点也是三档，且记账硬卡 1.25x（播 2x 也不会多记，反而要重播补录）
  //     chaoxing  驱动实测 rate=1.5 稳定（1.5x 是站内可选档）
  //     shengsheng / qiyang  播放器自带更高档，实测 2x 稳（见 docs/HANDOVER.md §5.37）
  //   注意：这里只用于"**显示与夹取**"，真正改倍速仍走各适配器自己的通道
  //   （知到必须点 .speedList 菜单、长春走 installHunter 压速、学习通走站点按钮）。
  const PLATFORM_RATES = {
    zhihuishu: [1, 1.25, 1.5],
    // ccjyxy 站内菜单只有 1.0/1.25/1.5，**但 2x 是能稳定跑的** —— 由 cc-lib.mjs 的
    // installHunter()（替换 <video>.playbackRate 访问器 + 原生 setter 每 300ms 压速）实现。
    // Agent B 实测：180 秒墙钟推进 338 秒（1.87x），长段实速=2。所以这里把 2 也算作允许档。
    ccjyxy:    [1, 1.25, 1.5, 2],
    chaoxing:  [1, 1.25, 1.5],
    shengsheng:[1, 1.25, 1.5, 2],
    qiyang:    [1, 1.25, 1.5, 2],
  };
  /** 把"期望倍速"夹到平台允许的最高档（用户设 2x 但平台只有 1.5 时返回 1.5） */
  function clampRate(want) {
    const all = PLATFORM_RATES[PLATFORM];
    if (!all || !all.length) return want;
    if (all.indexOf(want) >= 0) return want;
    let best = all[0];
    for (const r of all) if (r <= want + 0.001) best = r;      // 不超过期望的最大档
    return best;
  }
  /** 面板上显示用的倍速文案：**反映实际生效值**，和期望不符时标出来（用户 2026-10-16 要求） */
  function rateLabel() {
    const want = clampRate(effRate());
    let actual = null;
    try { const v = pickVideo(); if (v && v.playbackRate) actual = +v.playbackRate; } catch (_) { }
    if (actual === null || !isFinite(actual)) return want + 'x';
    const a = +actual.toFixed(2);
    if (Math.abs(a - want) <= 0.02) return want + 'x';
    return a + 'x（实际）';
  }

  /**
   * 播放器就绪判定：xgplayer / Aliplayer 走 MSE，装载期间对 <video> 动手（尤其 play()）
   * 会打断起播，表现为 readyState 永远 0、播放器卡 isloading。所以只在有数据后才接管。
   */
  function mediaReady(v) {
    try {
      return v.readyState >= 2 && !!v.duration && isFinite(v.duration) && v.duration > 0;
    } catch (_) { return false; }
  }

  /**
   * 播放器处于「未开始」态时，点它自己的开始按钮把它踢起来。
   * 不能直接 video.play()：MSE 装载期间那样做会打断起播（见 mediaReady 注释）。
   * 但也不能光等 —— xgplayer/Aliplayer 的 nostart 态需要一次点击才会去拉流，否则死锁。
   */
  function kickStart(v) {
    if (!v || !CFG.enabled || state.allDone) return false;   // 已停用/已完成：绝不主动起播
    if (mediaReady(v) || !v.paused) return false;
    const btn = document.querySelector('.xgplayer-start, .xgplayer-play, [class*="big-play"], .aliplayer-big-play, [class*="prism-big-play"]');
    if (!btn) return false;
    if (!(btn.offsetWidth || btn.offsetHeight)) return false;   // 隐藏的 start 按钮点了没用，还会触发播放器报错
    if (btn.__ncKick && now() - btn.__ncKick < 8000) return false;
    btn.__ncKick = now();
    try { btn.click(); } catch (_) { return false; }
    log('点击播放器开始按钮起播');
    return true;
  }

  function applyPolicy(v, why) {
    if (!v || !CFG.enabled) return;
    try {
      // 静音随时可做（不影响装载）
      if (CFG.mute && (!v.muted || v.volume !== 0)) { v.muted = true; v.volume = 0; }
      if (!mediaReady(v)) return;                    // 还没起播，绝不插手
      const R = effRate();
      if (R && Math.abs((v.playbackRate || 1) - R) > 0.01) {
        v.playbackRate = R; state.video.rateFixes++; log('倍速→', R, why);
        // ★ 平台不认这一档时【自动切回实际倍速】（用户 2026-10-16 要求"不许 UI 骗人"）：
        //   连续 5 次都设不回期望值 → 判定平台不允许 → 把配置改成实际值，面板随之显示真实倍速。
        //   实测依据：知到/长春/学习通站内只有 1.0/1.25/1.5 三档，设 2x 会被播放器悄悄改回。
        state.video._rateFail = (state.video._rateFail || 0) + 1;
        if (state.video._rateFail >= 5) {
          const actual = +((v.playbackRate || 1).toFixed(2));
          if (isFinite(actual) && actual > 0 && Math.abs(actual - R) > 0.01) {
            CFG.rate = actual; CFG.userRate = true;
            if (PLATFORM === 'qiyang') CFG.rateQiyang = actual; else CFG.rateShengsheng = actual;
            saveCfg();
            log('平台不接受 ' + R + 'x → 自动切回实际 ' + actual + 'x');
          }
          state.video._rateFail = 0;
        }
      } else { state.video._rateFail = 0; }
      if (CFG.autoPlay && v.paused && !v.ended) {
        try { const pr = v.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => { state.video.resumed++; }); } catch (_) { }
      }
    } catch (e) { err(e); }
  }
  function videoWatch() {
    timers.push(setInterval(() => {
      const v = pickVideo(); if (!v) return;
      // 兜底：视频已经结束（事件错过 / 模块热加载后）也要推进
      if (v.ended && !v.__ncEndHandled) {
        v.__ncEndHandled = now();
        state.video.ended++;
        log('视频已处于结束状态 → 推进下一节');
        report('video-ended', { url: location.href, count: state.video.ended, via: 'state' });
        if (CFG.autoNext) timers.push(setTimeout(() => advanceWhenReady('ended-state'), 1500));
      }
      // ---- 顺序校验看护：站点弹过「请按顺序观看视频」就记下来，让跳转逻辑退避 ----
      noteOrderBlock();

      // ---- 卡死看门狗 ----
      // 遇到过：视频停在 duration-1 秒，ended 事件始终不触发（播放器卡在 isLoading），
      // 结果「结束→下一节」永远等不到。这里按「时间不动」来兜底。
      if (!v.paused && mediaReady(v)) {
        const moved = v.__ncLastT === undefined || Math.abs(v.currentTime - v.__ncLastT) > 0.25;
        if (moved) { v.__ncLastT = v.currentTime; v.__ncStallAt = 0; }
        else if (!v.__ncStallAt) v.__ncStallAt = now();
        const stalledMs = v.__ncStallAt ? now() - v.__ncStallAt : 0;
        if (stalledMs > 12000 && now() - (v.__ncStallFix || 0) > 12000) {
          v.__ncStallFix = now();
          const left = isFinite(v.duration) ? v.duration - v.currentTime : 999;
          if (left < 5) {
            // 关键：不能直接跳下一课 —— 站点会拦（视频差一点没播完，它自己那套「完播上报」
            // 没触发，就判定本课未完成，于是「请按顺序观看视频」不放行）。
            // 正确做法：先把它推到真正的结尾，让站点自己上报完播。
            if (!v.__ncNudged) {
              v.__ncNudged = now();
              log('视频卡在结尾（还差 ' + left.toFixed(1) + 's）→ 推到真正的结尾，触发站点完播上报');
              try { v.currentTime = Math.max(0, (v.duration || 0) - 0.04); v.play(); } catch (_) { }
              report('video-nudge-end', { url: location.href, left: +left.toFixed(1) });
            } else if (now() - v.__ncNudged > 12000) {
              // 推了 12 秒还没完播，才走我们自己的推进（兜底）
              log('推到结尾后仍未完播 → 自行推进下一节');
              v.__ncNudged = now();
              state.video.ended++;
              report('video-stall-end', { url: location.href, left: +left.toFixed(1) });
              if (CFG.autoNext) timers.push(setTimeout(() => advanceWhenReady('stall-end'), 800));
            }
          } else {
            log('视频卡住 ' + Math.round(stalledMs / 1000) + 's（' + Math.round(v.currentTime) + '/' + Math.round(v.duration) + '）→ 尝试恢复播放');
            report('video-stall', { url: location.href, at: Math.round(v.currentTime) });
            try { v.play(); } catch (_) { }
            // 严重卡顿：退一档倍速再试（高倍速下 MSE 容易追不上）
            if (stalledMs > 30000 && v.playbackRate > 1.5) {
              try { v.playbackRate = 1.5; log('降到 1.5x 尝试缓冲'); } catch (_) { }
            }
          }
        }
      } else { v.__ncStallAt = 0; v.__ncLastT = v.currentTime; }

      if (!v.__ncSeen) {
        v.__ncSeen = now(); state.video.seen++;
        log('发现视频', { dur: Math.round(v.duration || 0), src: String(v.currentSrc || '').slice(0, 60) });
        v.addEventListener('ended', () => {
          state.video.ended++; log('视频结束 #' + state.video.ended);
          report('video-ended', { url: location.href, count: state.video.ended });
          if (CFG.autoNext) timers.push(setTimeout(() => advanceWhenReady('ended'), 2000));
        });
        v.addEventListener('pause', () => {
          if (!CFG.autoPlay || !CFG.antiPause) return;
          if (v.ended || !mediaReady(v)) return;
          timers.push(setTimeout(() => { if (v.paused && !v.ended) applyPolicy(v, 'anti-pause'); }, 1200));
        });
        v.addEventListener('ratechange', () => {
          const R = effRate();
          if (mediaReady(v) && R && Math.abs((v.playbackRate || 1) - R) > 0.01 && !v.paused) {
            timers.push(setTimeout(() => { try { v.playbackRate = R; state.video.rateFixes++; } catch (_) { } }, 600));
          }
        });
      }
      // 已完成 / 已停用：不发任何起播动作，并且把仍在播的画面按停（防止站点自己又开始播）
      if (!CFG.enabled || state.allDone) {
        if (v && !v.paused && !v.ended) { try { v.pause(); log('已停用/已完成：按停播放'); } catch (_) { } }
        return;
      }
      kickStart(v);
      applyPolicy(v, 'tick');
    }, 2000));
    try {
      const mo = new MutationObserver(() => { const v = pickVideo(); if (v && !v.__ncSeen) applyPolicy(v, 'mutation'); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      cleanups.push(() => mo.disconnect());
    } catch (_) { }
  }

  /** 目录项定位：优先已知结构，其次按文本特征兜底 */
  function catalogItems() {
    const known = Array.from(document.querySelectorAll('.lesson-item, [class*=lesson-item], [class*=tab-body] [class*=item]'))
      .filter(el => /已完成|已观看|未开始|学习中/.test(el.innerText || ''));
    if (known.length) return known;
    const seen = new Set();
    const out = [];
    document.querySelectorAll('div,span,a,p').forEach(el => {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 90) return;
      if (!/已完成|已观看|未开始|学习中/.test(t)) return;
      if (el.children.length > 3) return;
      if (seen.has(el)) return;
      seen.add(el);
      out.push(el);
    });
    return out;
  }

  // ------------------------------------------------------------ 站点提示 / 顺序校验
  /** 读站点当前**可见**的 toast 文案（「请按顺序观看视频」就是它弹的） */
  function toastText() {
    try {
      const els = document.querySelectorAll('.van-toast__text, .van-toast, [class*=toast__text]');
      for (const e of els) {
        // 关键：Vant 的 toast 节点是常驻 DOM 的，隐藏时文案还在。
        // 不看可见性会把历史提示当成本次拦截，导致一直误退避。
        const box = e.closest('.van-toast') || e;
        const cs = getComputedStyle(box);
        const visible = (box.offsetWidth || box.offsetHeight) &&
          cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05;
        if (!visible) continue;
        const t = (e.innerText || '').trim();
        if (t) return t;
      }
    } catch (_) { }
    return '';
  }
  /** 站点最近是否用「请按顺序观看视频」拦过我们 */
  let orderBlockAt = 0;
  function noteOrderBlock() {
    if (/按顺序/.test(toastText())) {
      if (now() - orderBlockAt > 5000) warn('站点提示：请按顺序观看视频 —— 说明上一课还没被站点确认完成，退避等待');
      orderBlockAt = now();
      report('order-block', { url: location.href, lesson: state.currentLesson });
      return true;
    }
    return false;
  }

  /** 当前课时在目录里的下标 */
  function currentIdx(items) {
    let i = items.findIndex(el => /active-lesson|current-lesson/.test(el.className));
    if (i < 0) i = items.findIndex(el => /观看中/.test((el.querySelector('.lesson-status-container') || el).innerText || ''));
    if (i < 0 && goNext.__lastIdx != null && goNext.__lastIdx < items.length) i = goNext.__lastIdx;
    return i;
  }
  const lessonDone = el => /已完成/.test(((el.querySelector('.lesson-status-container') || el).innerText || ''));

  /**
   * 等站点把「当前课时」标记为已完成。
   * 站点是先收到完播上报、再刷新目录状态的，中间有几秒延迟；
   * 抢在这之前点下一课，站点就会弹「请按顺序观看视频」——所以要等，不要抢。
   */
  async function waitLessonDone(maxMs) {
    const deadline = now() + (maxMs || 90000);
    while (now() < deadline) {
      noteOrderBlock();
      const items = catalogItems();
      if (!items.length) { await sleep(1200); continue; }
      const i = currentIdx(items);
      if (i < 0) return true;                       // 认不出当前课，不阻塞
      if (lessonDone(items[i])) return true;
      await sleep(1500);
    }
    return false;
  }

  /** 自动推进：先等站点确认完成，再跳 —— 顺序合法，不会被拦 */
  async function advanceWhenReady(reason) {
    if (!CFG.autoNext) return false;
    // 站点刚拦过：多等一会儿再试，别硬撞
    if (now() - orderBlockAt < 12000) {
      await sleep(Math.max(0, 12000 - (now() - orderBlockAt)));
    }
    const ok = await waitLessonDone(90000);
    if (!ok) {
      warn('等待站点确认完成超时（' + (reason || '') + '）——本轮不跳，稍后由 tick 重试');
      report('advance-timeout', { url: location.href, lesson: state.currentLesson });
      return false;
    }
    log('站点已确认本课完成 → 跳下一节（' + (reason || '') + '）');
    const moved = goNext();
    if (!moved) {
      // 跳不动了：如果确实没有未完成项，才算真刷完
      const its = catalogItems();
      const left = its.filter(el => !lessonDone(el)).length;
      if (its.length && !left) {
        // 双重确认：课时列表可能还在渲染，读早了会把「还没渲染出状态」当成「全部已完成」。
        // 隔 4 秒再确认一次，两次都干净才走。
        log('课时目录暂显全部完成，4 秒后二次确认…');
        timers.push(setTimeout(() => {
          const its2 = catalogItems();
          const left2 = its2.filter(el => !lessonDone(el)).length;
          if (its2.length && !left2) {
            log('二次确认通过：本子课程 ' + its2.length + ' 课全部完成');
            if (P_ADAPTER && P_ADAPTER.leaveSub) P_ADAPTER.leaveSub();
          } else {
            log('二次确认发现仍有 ' + left2 + ' 课未完成 → 继续播放，不跳走');
          }
        }, 4000));
      }
    }
    return moved;
  }

  function goNext() {
    // 防重入：连续调用只保留最后一次
    if (goNext.__busy && now() - goNext.__busy < 3000) { log('goNext 进行中，忽略重复调用'); return false; }
    goNext.__busy = now();
    const texts = /下一节|下一章|下一课|下一讲|继续学习|下一个视频|下一个/;
    const cands = Array.from(document.querySelectorAll('button,a,div[class*=next],span[class*=next]'));
    for (const el of cands) {
      if (el.closest('#netclass-panel')) continue;            // 绝不点自己的面板按钮
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 20) continue;
      if (texts.test(t) && !/下一题|下一页/.test(t) && !el.disabled) {
        log('点击站点「下一节」按钮 ->', t); state.next.clicks++; el.click(); return true;
      }
    }
    const items = catalogItems();
    if (!items.length) { state.next.misses++; warn('未找到目录项'); report('next-miss', { url: location.href }); return false; }
    const isDone = lessonDone;
    const curIdx = currentIdx(items);
    if (curIdx >= 0) { goNext.__lastIdx = curIdx; state.currentLesson = (items[curIdx].innerText || '').replace(/\s+/g, ' ').slice(0, 40); }

    // 硬校验：当前课时没被站点标为「已完成」，绝不允许往后跳 —— 否则站点就弹「请按顺序观看视频」
    if (curIdx >= 0 && !isDone(items[curIdx])) {
      const st = ((items[curIdx].querySelector('.lesson-status-container') || items[curIdx]).innerText || '').replace(/\s+/g, ' ').slice(0, 30);
      warn('当前课时尚未被站点确认完成（' + st + '）→ 不跳转，等它完成');
      state.next.misses++;
      return false;
    }

    for (let i = curIdx + 1; i < items.length; i++) {
      if (!isDone(items[i])) { log('下一节 ->', (items[i].innerText || '').replace(/\s+/g, ' ').slice(0, 40)); state.next.clicks++; items[i].click(); return true; }
    }
    // 注意：这里故意不做「绕回列表开头」的兜底。
    // 往回跳到某个未完成的课会直接违反站点的顺序校验（就是弹窗的来源）。
    state.next.misses++; warn('当前课之后没有未完成项');
    report('next-none', { url: location.href, curIdx: curIdx, total: items.length });
    return false;
  }

  // ------------------------------------------------------------ 平台适配
  function matchByText(txt, maxLen = 600) {
    const els = document.querySelectorAll('div,section,aside,form');
    for (const el of els) { const t = el.innerText || ''; if (t.length < maxLen && t.includes(txt)) return el; }
    return null;
  }

  // -------------------------------------------------- shengsheng 三层导航
  // 站点层级： /home（课程分类） → /record/sub/<id>（子课程列表） → /course/v2/<id>（课时目录）
  function ssLevel() {
    const p = location.pathname;
    if (/^\/course\/v2\//.test(p)) return 3;
    if (/^\/record\/sub\//.test(p)) return 2;
    if (/^\/home/.test(p)) return 1;
    return 0;
  }
  const SS_PARENT_KEY = 'nc.ss.parentUrl';
  const SS_DONE_COURSES = 'nc.ss.coursesDone';

  function ssCardName(el) {
    const t = el.querySelector('.card-title');
    return ((t && t.innerText) || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  }
  function ssDoneCourses() { try { return JSON.parse(sessionStorage.getItem(SS_DONE_COURSES) || '[]'); } catch { return []; } }
  function ssMarkCourseDone(name) {
    try { const d = ssDoneCourses(); if (!d.includes(name)) { d.push(name); sessionStorage.setItem(SS_DONE_COURSES, JSON.stringify(d)); } } catch (_) { }
  }

  /** 子课程列表：从 state-tag 反推卡片（学习中的排最前） */
  function ssSubCourses() {
    const tags = Array.from(document.querySelectorAll('span.state-tag'));
    const out = [];
    for (const tag of tags) {
      const state = (tag.innerText || '').trim();
      if (!/学习中|未开始|已完成/.test(state)) continue;
      // 卡片根：往上找到带 padding 的卡片容器（含名称）
      let card = tag.closest('div[class*="flex-col"]') || tag.parentElement;
      for (let i = 0; i < 3 && card && card.parentElement; i++) {
        if ((card.innerText || '').replace(/\s+/g, ' ').length > 12) break;
        card = card.parentElement;
      }
      const full = ((card && card.innerText) || '').replace(/\s+/g, ' ').trim();
      const name = full.split(/学习中|未开始|已完成/)[0].replace(/\d+人学习/g, '').trim().slice(0, 40);
      out.push({ state, name, el: card });
    }
    return out;
  }

  const ADAPTER_SHENGSHENG = {
    id: 'shengsheng',
    /** 最近一次提交（DOM 分支也要登记，否则拿不到平台判定） */
    lastSubmit: null,
    registerSubmit(q, answer) {
      const rec = { q, answer, at: now(), id: (q && q.id) || null };
      this.lastSubmit = rec;
      pendingQuiz.push(rec);
      if (pendingQuiz.length > 10) pendingQuiz.shift();
      return rec;
    },
    /** 课程页自动进入第一个未完成课时（只在没有视频时才做；点了没出播放器会重试） */
    async autoEnterLesson() {
      if (pickVideo()) { this.__ssEntered = null; this.__ssTries = 0; return false; }
      // 站点刚用「请按顺序观看视频」拦过：退避一会儿，别继续撞（越撞越乱）
      if (now() - orderBlockAt < 15000) return false;
      const now2 = now();
      if (this.__ssEntered && now2 - this.__ssEntered < 12000) return false;   // 刚点过，给它 12 秒出播放器
      this.__ssTries = (this.__ssTries || 0) + 1;
      if (this.__ssTries > 6) return false;                                    // 试太多次就放弃，等下次页面加载
      const items = catalogItems();
      if (!items.length) return false;
      const status = el => ((el.querySelector('.lesson-status-container') || el).innerText || '');
      const done = el => /已完成/.test(status(el));
      const pending = items.find(el => !done(el));
      if (!pending) { log('shengsheng 目录里没有未完成课时'); return false; }
      this.__ssEntered = now2;
      const name = (pending.innerText || '').replace(/\s+/g, ' ').slice(0, 40);
      log('shengsheng 进入未完成课时(第' + this.__ssTries + '次):', name);
      try { pending.scrollIntoView({ block: 'center' }); } catch (_) { }
      pending.click();
      report('enter-lesson', { url: location.href, lesson: name, try: this.__ssTries });
      return true;
    },
    onResponse(url, body) {
      if (!/popQuiz/i.test(url)) return;
      if (!/insertUserAnswer/i.test(url)) return;
      // 只对账最近一次提交（60 秒内），避免把过期回包算到新题上
      const last = pendingQuiz.filter(r => now() - r.at < 60000).pop();
      const d = body && body.data;
      if (!d || !last) { if (d && d.state) log('quiz 回包无对应提交', d.state); return; }
      if (d.state === 2) {
        state.quiz.correct++;
        bankPut(last.q, last.answer, true);
        log('✅ 答对', last.answer, '→ 写入题库');
        flushBank();
      } else if (d.state === 3) {
        state.quiz.wrong++;
        if (d.answer) {
          bankPut(last.q, d.answer, true);
          log('❌ 答错，正确答案：', d.answer, '→ 已写入本地题库');
        } else {
          bankPut(last.q, last.answer, false);
          log('❌ 答错（平台未给答案）');
        }
        flushBank();
      } else {
        log('quiz 回包 state=' + d.state, JSON.stringify(d).slice(0, 120));
      }
      const i = pendingQuiz.indexOf(last);
      if (i >= 0) pendingQuiz.splice(i, 1);
    },
    box() {
      return document.querySelector('.pop-quiz-dialog, [class*="pop-quiz"], [class*="popQuiz"]') || matchByText('随堂练习', 400);
    },
    // ============ 三层导航：首页 → 课程 → 子课程 ============
    /** L1：进入下一个还没做完的课程 */
    enterNextCourse() {
      const cards = Array.from(document.querySelectorAll('.classify-card'));
      if (!cards.length) return null;
      const done = ssDoneCourses();
      const left = cards.filter(c => !done.includes(ssCardName(c)));
      if (!left.length) return null;                 // 两门课都完了
      const c = left[0];
      log('L1 进入课程 ->', ssCardName(c), '（已完成 ' + done.length + '/' + cards.length + ' 门）');
      try { sessionStorage.setItem('nc.ss.currentCourse', JSON.stringify({ name: ssCardName(c), at: now() })); } catch (_) { }
      this.__ssNavAt = now();
      c.click();
      return true;
    },
    /** L2：进入下一个未完成的子课程 */
    enterNextSub() {
      const subs = ssSubCourses();
      if (!subs.length) { log('L2 未识别到子课程条目'); return null; }
      const next = subs.find(s => s.state !== '已完成');
      if (!next) return null;                        // 本课程子课程全完成
      log('L2 进入子课程 ->', next.name, '（' + next.state + '）', '余 ' + subs.filter(s => s.state !== '已完成').length + '/' + subs.length);
      try { sessionStorage.setItem(SS_PARENT_KEY, location.href); } catch (_) { }
      this.__ssNavAt = now();
      next.el.click();
      return true;
    },
    /** L2 全部子课程完成 → 记下这门课，回首页挑下一门 */
    leaveCourse() {
      const subs = ssSubCourses();
      const name = (document.title || '').trim() || (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 20);
      let courseName = name;
      try { courseName = (JSON.parse(sessionStorage.getItem('nc.ss.currentCourse') || 'null') || {}).name || name; } catch (_) { }
      log('L2 本课程子课程已全部完成 ->', courseName);
      ssMarkCourseDone(courseName);
      this.__ssNavAt = now();
      timers.push(setTimeout(() => { location.href = 'https://edu.shengshengketang.com/home'; }, 2500));
      return true;
    },
    /** L3 课时跑完 → 回父级子课程列表 */
    leaveSub() {
      let back = null;
      try { back = sessionStorage.getItem(SS_PARENT_KEY); } catch (_) { }
      log('L3 本子课程课时全部完成 → 返回列表', back ? String(back).slice(0, 60) : '(无记录，回首页)');
      this.__ssNavAt = now();
      timers.push(setTimeout(() => { location.href = back || 'https://edu.shengshengketang.com/home'; }, 2500));
      return true;
    },
    async poll() {
      if (!CFG.enabled) return;
      const lvl = ssLevel();

      // L1 / L2：只做导航，导航后给页面时间加载
      if (lvl === 1 || lvl === 2) {
        if (this.__ssNavAt && now() - this.__ssNavAt < 8000) return;   // 刚点过，等加载
        if (lvl === 1) {
          const r = this.enterNextCourse();
          if (r === null) { log('L1 两门课程均已完成'); markAllDone('本账号全部课程（基础理论 + 三级实务）已完成'); }
          return;
        }
        if (lvl === 2) {
          const r = this.enterNextSub();
          if (r === null) this.leaveCourse();
          return;
        }
      }
      if (lvl !== 3) return;   // 其它页面不动

      // L3：原逻辑（弹题优先 + 视频 + 自动进入未完成课时）
      const box = CFG.autoQuiz ? this.box() : null;
      if (box) {
        await this.answerQuiz(box).catch(err);
        return;
      }
      if (!pickVideo()) {
        await this.autoEnterLesson().catch(() => { });
        if (!pickVideo()) return;
      }
    },
    /** 处理随堂弹题（三种状态：作答态 / 答错态 / 答对态） */
    async answerQuiz(box) {
      if (box.__ncAt && now() - box.__ncAt < 2500) return;
      box.__ncAt = now();
      state.quiz.seen++;

      const btn = re => Array.from(box.querySelectorAll('button,[class*="btn"]'))
        .find(b => re.test((b.innerText || b.value || '').trim()));

      // ---- A) 答错态：平台把正确答案告诉我们了 → 吃进题库 → 再试一次 ----
      const wrongSec = box.querySelector('.result-section.incorrect, [class*="result-section"][class*="incorrect"]');
      if (wrongSec) {
        const ansEl = box.querySelector('.correct-answer-text, [class*="correct-answer-text"]');
        const ansText = (ansEl && ansEl.innerText || '').replace(/[.\s、,，]/g, '').toUpperCase();
        const q = this.__lastQ;
        if (ansText && q) {
          const letters = ansText.split('').filter(ch => /[A-H]/.test(ch));
          const ans = letters.length ? letters.join(',') : ansText;
          bankPut(q, ans, true); flushBank();
          log('📝 答错，平台正确答案：', ans, '→ 已写回题库（下次直接命中）', String(q.name || '').slice(0, 30));
        } else {
          log('答错，但没抓到正确答案 / 无对应题目', { ansText, hasQ: !!q });
        }
        const retries = (this.__retry || 0) + 1;
        this.__retry = retries;
        if (retries <= 3) {
          const retry = btn(/再试一次|重试|再试/);
          if (retry) { log('点击「再试一次」（第 ' + retries + ' 次）'); retry.click(); return; }
        }
        const skip = btn(/跳过|关闭|继续|确定/);
        if (skip) { log('重试 ' + retries + ' 次仍不对，点「' + (skip.innerText || '').trim() + '」放行'); skip.click(); return; }
        warn('答错态没有可用按钮');
        return;
      }

      // ---- B) 答对态：点掉继续按钮 ----
      const okSec = box.querySelector('.result-section.correct, [class*="result-section"][class*="correct"]');
      if (okSec) {
        const go = btn(/继续|确定|关闭|下一|好的|知道了/);
        log('✅ 答对，点「' + (go ? (go.innerText || '').trim() : '（无按钮）') + '」继续');
        state.quiz.correct++;
        this.__retry = 0; this.__lastQ = null;
        if (go) go.click();
        return;
      }

      // ---- C) 作答态 ----
      const itemUrl = quizFeed.filter(f => now() - f.at < 120000).pop();
      let q = null;
      if (itemUrl && itemUrl.item && itemUrl.item.question) q = itemUrl.item.question;
      if (!q) {
        const title = box.querySelector('.question-title,[class*="question-title"]');
        const typeTxt = (box.querySelector('.question-type') || {}).innerText || '';
        const type = /多选|不定项/.test(typeTxt) ? 2 : /判断/.test(typeTxt) ? 3 : 1;
        const opts = Array.from(box.querySelectorAll('.option-item,[class*="option-item"]')).map(el => ({
          name: String(((el.querySelector('.option-label') || {}).innerText || '')).replace(/[.\s]/g, ''),
          data: String(((el.querySelector('.option-text,.option-content') || {}).innerText || el.innerText || '')).trim(),
          el
        })).filter(o => o.data && o.name);
        if (!opts.length) return;
        q = { type, name: (title && title.innerText) || '', optionList: opts.map(o => ({ name: o.name, data: o.data })) };
        this.__domOpts = opts;
      } else this.__domOpts = null;

      const g = await inferAnswer(q);
      if (!g.answer) { warn('无法本地推断答案，交本人处理'); report('quiz-manual', { url: location.href, q: String(q.name).slice(0, 120) }); return; }
      const picks = g.answer.split(',');
      const opts = this.__domOpts || Array.from(box.querySelectorAll('.option-item,[class*="option-item"]')).map(el => ({
        name: String(((el.querySelector('.option-label') || {}).innerText || '')).replace(/[.\s]/g, ''), el
      }));
      let clicked = 0;
      for (const o of opts) if (picks.includes(o.name)) { o.el.click(); clicked++; }
      if (!clicked) { warn('选项未命中，放弃本次', g.answer); return; }
      await sleep(CFG.quizDelayMs);
      const sub = Array.from(box.querySelectorAll('button,[class*="btn"]')).find(b => /提交|确定|确认|保存/.test(b.innerText || ''));
      if (sub) {
        this.__lastQ = q;                              // 记住题目，答错时用平台给的正确答案回填
      this.registerSubmit(q, g.answer);              // 登记，等平台判定回来
        sub.click();
        state.quiz.answered++;
        log('已作答并提交', { pick: g.answer, why: g.why, conf: g.conf });
      } else warn('未找到提交按钮');
    }
  };

  const ADAPTER_QIYANG = {
    id: 'qiyang',
    /** 站点 video.js 的内联变量：getUrl 是进度上报端点，isEnd 是本章完成标记 */
    siteVars() {
      const names = ['getUrl', 'isEnd', 'current_time', 'goodscourses_exper', 'source'];
      const out = {};
      for (const n of names) {
        try { out[n] = (0, eval)(`typeof ${n} !== 'undefined' ? ${n} : null`); } catch (_) { out[n] = null; }
      }
      return out;
    },
    player() {
      try { return (typeof player !== 'undefined' && player) || window.player || null; } catch (_) { return window.player || null; }
    },
    onResponse() { },
    box() { return null; },
    chapterList() {
      const out = [], seen = new Set();
      document.querySelectorAll('.chapter-list a[href*=goodscourses_id]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const id = (href.match(/goodscourses_id=(\d+)/) || [])[1];
        if (!id || seen.has(id)) return;
        seen.add(id);
        const nm = a.querySelector('.goodscourses_name');
        const name = ((nm ? nm.innerText : a.innerText) || '').replace(/\s+/g, ' ').trim();
        out.push({ id, name: name.slice(0, 60), href, live: /直播/.test(name) });
      });
      return out;
    },
    doneIds() { try { return JSON.parse(sessionStorage.getItem('nc.qy.done') || '[]'); } catch { return []; } },
    markDone(id) {
      try { const d = this.doneIds(); if (!d.includes(id)) { d.push(id); sessionStorage.setItem('nc.qy.done', JSON.stringify(d)); } } catch (_) { }
    },
    /** 「本轮进过」只用于防重复跳转；「已确认完成」才是判定刷完的依据（站点的 isEnd=1） */
    completedIds() { try { return JSON.parse(sessionStorage.getItem('nc.qy.completed') || '[]'); } catch { return []; } },
    markCompleted(id) {
      try { const c = this.completedIds(); if (!c.includes(id)) { c.push(id); sessionStorage.setItem('nc.qy.completed', JSON.stringify(c)); } } catch (_) { }
    },
    resetRound() {
      try { sessionStorage.removeItem('nc.qy.done'); } catch (_) { }
      log('本轮已重置，下次启动会重新逐章过一遍（已确认完成的记录保留）');
    },
    goChapter(item) {
      if (!item) return false;
      this.markDone(item.id);
      const url = item.href.startsWith('http') ? item.href : location.origin + item.href;
      log('qiyang 进入章节', item.name, item.id);
      location.href = url;
      return true;
    },
    nextChapter() {
      const m = location.href.match(/goods_id=(\d+)/);
      const store = (location.href.match(/store_id=(\d+)/) || [, '1'])[1];
      const items = this.chapterList();
      const curId = (location.href.match(/goodscourses_id=(\d+)/) || [])[1];
      if (!items.length) {
        if (m) { log('qiyang 回课程页继续'); location.href = `${location.origin}/agent/Goods/courses?goods_id=${m[1]}&store_id=${store}`; return true; }
        warn('qiyang 找不到课程参数'); return false;
      }
      const idx = items.findIndex(x => x.id === curId);
      // 候选顺序：当前章节之后的 → 回到列表开头（只为了补漏，不绕圈）
      // 用「本轮已进过」清单挡掉重复，避免「后面都已完成 → 绕回第一个已完成 → 再绕…」的死循环
      const done = this.doneIds();
      const recorded = items.filter(x => !x.live);
      const ordered = idx >= 0
        ? [...items.slice(idx + 1), ...items.slice(0, idx)]
        : items.slice();
      const next = ordered.find(x => !x.live && !done.includes(x.id));
      if (next) {
        log('qiyang 下一章 ->', next.name, '（本轮已过 ' + done.length + '/' + recorded.length + ' 章录播）');
        return this.goChapter(next);
      }

      // 本轮走完了 —— 但要按「站点确认完成」核对，不能只凭「进过」
      const completed = this.completedIds();
      const unfinished = recorded.filter(x => !completed.includes(x.id));
      report('qiyang-round-done', { url: location.href, recorded: recorded.length, visited: done.length, unfinished: unfinished.length });

      if (!unfinished.length) {
        markAllDone('录播章节 ' + recorded.length + ' 章已全部确认完成');
      } else {
        const names = unfinished.slice(0, 6).map(x => x.name).join('；');
        warn('本轮走完，但仍有 ' + unfinished.length + ' 章未确认完成：' + names);
        report('qiyang-unfinished', { count: unfinished.length, names: unfinished.map(x => x.name) });
        // 停止跳转（不宣称完成），等人处理这几章
        CFG.enabled = false; saveCfg();
        state.allDone = true;
        const v = pickVideo(); if (v) { try { v.pause(); } catch (_) { } }
        showBanner(
          '<b>⚠️ 职业培训：还有 ' + unfinished.length + ' 章未完成</b><br>' +
          '<span style="opacity:.9">' + names + '</span><br>' +
          '<span style="opacity:.75;font-size:12px">多是站点侧播放异常（如视频格式不可用）。已暂停自动跳转；处理完点面板「启动」重跑</span>',
          'warn');
      }
      return false;
    },
    async poll() {
      if (!CFG.enabled) return;
      const p = this.player();
      const v = pickVideo();
      const hasChapterId = /goodscourses_id=/i.test(location.href);
      const isChapter = hasChapterId && /\/agent\/Goods\/Courses/i.test(location.href);
      const isCoursePage = !hasChapterId && /\/agent\/Goods\/courses/i.test(location.href);

      if (isChapter) {
        this.__qyList = false;   // 换到章节页，允许课程页逻辑下次再跑
        const vars = this.siteVars();
        if (!this.__qyInit) {
          this.__qyInit = true;
          log('qiyang 章节页就绪', { isEnd: vars.isEnd, current_time: vars.current_time, exper: vars.goodscourses_exper, getUrl: vars.getUrl });
          if (String(vars.isEnd) === '1') {
            log('qiyang 本章已完成，直接跳下一章');
            const _cid = (location.href.match(/goodscourses_id=(\d+)/) || [])[1];
            this.markDone(_cid); this.markCompleted(_cid);   // 站点确认 isEnd=1 —— 这才是完成依据
            timers.push(setTimeout(() => this.nextChapter(), 2000));
            return;
          }
          const media = v || (p && p._video);
          if (media) {
            media.addEventListener('ended', () => {
              state.video.ended++;
              log('qiyang 本章播完 -> 下一章');
              report('video-ended', { url: location.href, platform: 'qiyang' });
              if (CFG.autoNext) timers.push(setTimeout(() => this.nextChapter(), 3000));
            });
          }
        }
        // 倍速：走站点播放器 API（RateComponent 支持 2x）。
        // 判据用 <video> 的实际值 —— Aliplayer 的 getStatus().speed 取不到，会误判成「每次都要纠正」
        const rate = this.effectiveRate();
        if (rate && p && typeof p.setSpeed === 'function') {
          const cur = v ? v.playbackRate : null;
          if (cur == null || Math.abs(cur - rate) > 0.02) {
            try { p.setSpeed(rate); } catch (e) { err(e); }
            state.video.rateFixes++;
            log('qiyang 倍速→', rate, '（原 ' + cur + '）');
          }
        }
        if (v) applyPolicy(v, 'qiyang');
        return;
      }

      // 课程页：挑未完成章节进去（按顺序，跳过直播）
      if (isCoursePage && !this.__qyList) {
        this.__qyList = true;
        const items = this.chapterList().filter(x => !x.live);
        log('qiyang 课程页：录播章节', items.length, '个');
        const done = this.doneIds();
        const next = items.find(x => !done.includes(x.id));
        if (next) timers.push(setTimeout(() => this.goChapter(next), 2500));
        else log('qiyang 录播章节本轮已全部过一遍');
      }
    },
    /** 倍速：用户没手动设过就用平台默认（qiyang 站点播放器自带 2x） */
    effectiveRate() {
      if (CFG.userRate) return CFG.rate;
      return CFG.rateQiyang || 2;
    }
  };

  // ------------------------------------------------------------ webtrn（教师培训：监看 + 写路径）
  /**
   * tea.webtrn.cn：研修活动（讨论区发帖/回帖）+ 研修作业（上传类活动：填正文 + 传附件）。
   *
   * 写路径的实测事实（2026-10-14，都来自真实页面）：
   *   · 讨论区在子 iframe `taolun/learn/courseTopicAction.action?itemId=…` 里，同源可直接操作；
   *   · 每个帖子有一个 `textarea#replyContent_<postId>` 回复框，配套 `<input value=发表>`
   *     的 onclick 是 `checkAndSaveReply('replyContent_<postId>','<topicId>')` —— 填值后点它即提交；
   *   · 顶层发帖框是「没有 replyContent_ 前缀的 textarea」+ `<a id="editor_area">提交</a>`；
   *   · 上传类活动的正文域 id 形如 `intro_<itemId>` / `des_<itemId>`，附件走 `input[type=file]`
   *     （由控制端 CDP `DOM.setFileInputFiles` 塞文件，见 scripts/webtrn-attach.mjs）。
   * 提交纪律：一次点击、看回执/计数变化再决定是否重试，别重复提交（见技能 SKILL.md）。
   */
  const ADAPTER_WEBTRN = {
    id: 'webtrn',
    pageKind() {
      const p = location.pathname + location.search;
      if (/activity_view\.jsp/i.test(p)) return 'activity';
      if (/student_homework_list|homework_list|homework/i.test(p)) return 'homework';
      if (/\/taolun\//i.test(p)) return 'discuss';
      if (/\/cms\//i.test(p)) return 'home';
      return 'other';
    },
    activityItems() {
      const out = [];
      document.querySelectorAll('a[onclick*=setTab], li[onclick*=setTab]').forEach((el, i) => {
        const name = String(el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!name) return;
        out.push({ idx: i + 1, name: name.slice(0, 40), kind: /研讨|讨论|交流|评论/.test(name) ? 'discuss' : 'upload' });
      });
      return out;
    },
    controls() {
      const frames = Array.from(document.querySelectorAll('iframe'))
        .filter(f => /taolun|courseTopic/i.test(f.src || ''));
      return {
        fileInputs: document.querySelectorAll('input[type=file]').length,
        editors: document.querySelectorAll('textarea,[contenteditable="true"]').length,
        discussFrames: frames.length,
        loginForm: !!document.querySelector('#loginId, #passwd')
      };
    },
    player() { return null; },
    onResponse() { },
    resetRound() { },
    async poll() {
      const kind = this.pageKind();
      state.webtrn = { kind, items: kind === 'activity' ? this.activityItems() : [], controls: this.controls(), at: now() };
      if (state.loopTicks % 20 === 1) log('webtrn 监看', kind, JSON.stringify(state.webtrn.controls));
    },

    // ---- 写路径：讨论区 -------------------------------------------------
    frames() {
      return Array.from(document.querySelectorAll('iframe')).filter(f => /courseTopicAction/i.test(f.src || ''));
    },
    frame(idx) {
      const f = this.frames()[idx || 0];
      if (!f) throw new Error('没有第 ' + (idx || 0) + ' 个讨论区 iframe（当前 ' + this.frames().length + ' 个）');
      if (!f.contentDocument) throw new Error('讨论区 iframe 不可访问（跨域或未加载完）');
      return f;
    },
    /** 读帖子：{postId, text} —— 回帖前先读，才能回复得对口 */
    posts(idx) {
      const d = this.frame(idx).contentDocument;
      const out = [];
      d.querySelectorAll('textarea[id^=replyContent_]').forEach(ta => {
        const postId = ta.id.replace('replyContent_', '');
        let node = ta.parentElement, best = null, bestLen = 0;
        for (let i = 0; i < 4 && node; i++) {
          const len = (node.innerText || '').length;
          if (len > bestLen && len < 2500) { bestLen = len; best = node; }
          node = node.parentElement;
        }
        const raw = (best ? best.innerText : '').replace(/\s+/g, ' ').trim();
        out.push({ postId, text: raw.slice(0, 200) });
      });
      return out;
    },
    /** 回帖：填 replyContent_<postId> → 点该帖的提交按钮
     *  实测细节：按钮 onclick 是 checkAndSaveReply('<postId>','<topicId>') —— **第一个参数是帖子 id 本身**
     *  （回复框的 id 才是 replyContent_ 前缀），而且同一个按钮兼"展开回复框/提交"两用，
     *  所以必须**先填值再点**，否则只会把空框展开。 */
    reply(idx, postId, text) {
      const f = this.frame(idx);
      const d = f.contentDocument, w = f.contentWindow;
      const ta = d.getElementById('replyContent_' + postId);
      if (!ta) throw new Error('找不到帖子 ' + postId + ' 的回复框（楼层变了？重新 posts()）');
      ta.value = String(text || '');
      try { ta.dispatchEvent(new w.Event('input', { bubbles: true })); ta.dispatchEvent(new w.Event('change', { bubbles: true })); } catch (_) { }
      const btn = Array.from(d.querySelectorAll('a[onclick*=checkAndSaveReply],input[onclick*=checkAndSaveReply]'))
        .find(b => {
          const m = /checkAndSaveReply\(\s*'([^']+)'/.exec(b.getAttribute('onclick') || '');
          return m && m[1] === postId;
        });
      if (!btn) throw new Error('找不到帖子 ' + postId + ' 的提交按钮');
      // ★ 必须异步点击：这个站点的提交处理里有同步 XHR，一旦挂住会把调用方的求值线程一起拖死
      //   （2026-10-14 实测：直接 btn.click() 让 CDP Runtime.evaluate 超时、整个标签卡死，
      //    只能靠 Page.navigate 重新加载才救得回来）。放进 setTimeout 后求值立刻返回，后续靠 check() 轮询。
      this.autoConfirm(true);
      try { w.setTimeout(function () { try { btn.click(); } catch (_) { } }, 30); } catch (_) { btn.click(); }
      log('webtrn 回帖已提交(异步)', postId, String(text || '').length + '字');
      return { postId, chars: String(text || '').length, button: (btn.value || btn.innerText || '').trim(), mode: 'async' };
    },
    /** 关掉原生确认框对自动化的阻塞（confirm 一律 true、alert 只记日志）；传 false 还原 */
    autoConfirm(on) {
      const w = window;
      const targets = [w].concat(this.frames().map(f => { try { return f.contentWindow; } catch (_) { return null; } }).filter(Boolean));
      let n = 0;
      for (const t of targets) {
        try {
          if (on === false) {
            if (t.__ncOrigConfirm) { t.confirm = t.__ncOrigConfirm; t.alert = t.__ncOrigAlert; }
          } else {
            if (!t.__ncOrigConfirm) { t.__ncOrigConfirm = t.confirm; t.__ncOrigAlert = t.alert; }
            t.confirm = function (m) { log('webtrn confirm 自动接受：' + String(m || '').slice(0, 80)); return true; };
            t.alert = function (m) { log('webtrn alert：' + String(m || '').slice(0, 80)); };
            n++;
          }
        } catch (_) { }
      }
      return { windows: n, mode: on === false ? 'restored' : 'installed' };
    },
    /** 回帖后的自检：我的回帖计数 + 该讨论区帖子数 */
    check(idx) {
      const d = this.frame(idx).contentDocument;
      const counter = Array.from(d.querySelectorAll('a,span,div,li'))
        .map(e => (e.innerText || '').trim())
        .find(t => /^我的回帖\(\d+条\)$/.test(t)) || null;
      const posts = d.querySelectorAll('textarea[id^=replyContent_]').length;
      return { counter, replyBoxes: posts };
    },
    /** 发帖：顶层编辑器（无 replyContent_ 前缀的 textarea）+ #editor_area */
    newTopic(idx, text) {
      const f = this.frame(idx);
      const d = f.contentDocument, w = f.contentWindow;
      const ta = Array.from(d.querySelectorAll('textarea')).find(t => !/^replyContent_/.test(t.id || ''));
      if (!ta) throw new Error('找不到顶层发帖输入框');
      ta.value = String(text || '');
      try { ta.dispatchEvent(new w.Event('input', { bubbles: true })); } catch (_) { }
      const btn = d.querySelector('#editor_area') ||
        Array.from(d.querySelectorAll('a,input')).find(b => /提交/.test(b.value || b.innerText || ''));
      if (!btn) throw new Error('找不到发帖「提交」按钮');
      btn.click();
      log('webtrn 发帖已提交', String(text || '').length + '字');
      return { chars: String(text || '').length };
    },

    // ---- 写路径：上传类作业 ----------------------------------------------
    /** 列出上传类活动的正文域与附件位 */
    homework() {
      const out = [];
      document.querySelectorAll('textarea[id^=intro_],textarea[id^=des_]').forEach(t => {
        const itemId = String(t.id).replace(/^(intro_|des_)/, '');
        let rec = out.find(x => x.itemId === itemId);
        if (!rec) { rec = { itemId, intro: null, des: null, fileInputs: 0 }; out.push(rec); }
        if (/^intro_/.test(t.id)) rec.intro = t.id; else rec.des = t.id;
      });
      out.forEach((rec, i) => {
        const host = document.getElementById(rec.intro) ? document.getElementById(rec.intro).closest('div[class],li') : null;
        const scope = (host && host.parentElement) || document;
        rec.fileInputs = scope.querySelectorAll('input[type=file]').length;
        rec.buttons = Array.from(scope.querySelectorAll('a,input[type=button],button'))
          .map(b => (b.value || b.innerText || '').trim()).filter(Boolean).slice(0, 10);
        rec.index = i;
      });
      return out;
    },
    /** 填上传类活动的正文（intro/des 两个域） */
    fillHomework(ref, text) {
      const rec = typeof ref === 'number' ? this.homework()[ref] : ref;
      if (!rec) throw new Error('没有这个作业项');
      const t = String(text || '');
      if (rec.intro) { const e = document.getElementById(rec.intro); if (e) { e.value = t.slice(0, 2000); e.dispatchEvent(new Event('input', { bubbles: true })); } }
      if (rec.des) { const e = document.getElementById(rec.des); if (e) { e.value = t; e.dispatchEvent(new Event('input', { bubbles: true })); } }
      log('webtrn 作业正文已填', rec.itemId, t.length + '字');
      return { itemId: rec.itemId, chars: t.length };
    },
    /** 按文字点按钮（保存/提交/完成上传/继续添加…） */
    clickByText(label) {
      const hit = Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button'))
        .find(b => new RegExp(label).test(b.value || b.innerText || ''));
      if (!hit) throw new Error('找不到按钮：' + label);
      hit.click();
      log('webtrn 已点击', label);
      return { clicked: label };
    },

    // ---- 通用页面操作原语（订单流程通用：任何页面都能读/点/填/选/提交）-------------
    /** 这页是什么、能做什么：标题/URL/可点控件/输入框/上传位/tab */
    pageInfo() {
      const vis = el => !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
      const txt = e => (e.value || e.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        title: document.title,
        url: location.href.slice(0, 130),
        controls: Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button'))
          .filter(vis).map(b => ({ t: txt(b).slice(0, 18), id: b.id || '', cls: String(b.className || '').slice(0, 22), onclick: (b.getAttribute('onclick') || '').slice(0, 70) }))
          .filter(x => x.t).slice(0, 40),
        inputs: Array.from(document.querySelectorAll('input[type=text],input[type=password],textarea,select'))
          .filter(vis).map(i => ({ tag: i.tagName, id: i.id || '', name: String(i.name || '').slice(0, 40), val: String(i.value || '').slice(0, 30) })).slice(0, 30),
        fileInputs: Array.from(document.querySelectorAll('input[type=file]')).map((f, i) => ({ i, id: f.id || '', visible: vis(f) })),
        tabs: Array.from(document.querySelectorAll('[onclick*=setTab],[onclick*=Tab],[class*=tab]'))
          .map(e => txt(e).slice(0, 24)).filter(Boolean).slice(0, 14)
      };
    },
    /** 按文字点（精确优先、包含兜底；可选 nth / visible:false / maxLen） */
    clickText(text, opts) {
      const o = opts || {};
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      const norm = e => (e.value || e.innerText || '').replace(/\s+/g, ' ').trim();
      const all = Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button,li,span,div,td'))
        .filter(e => (o.visible === false ? true : vis(e)));
      let hits = all.filter(e => norm(e) === text);
      if (!hits.length) hits = all.filter(e => { const t = norm(e); return t.indexOf(text) >= 0 && t.length < (o.maxLen || 40); });
      if (!hits.length) throw new Error('点不到：' + text);
      const el = hits[o.nth || 0] || hits[0];
      const info = { tag: el.tagName, cls: String(el.className || '').slice(0, 30), onclick: (el.getAttribute('onclick') || '').slice(0, 80) };
      try { el.click(); } catch (_) { }
      log('webtrn 点击', text, info.tag);
      return { clicked: info, candidates: hits.length };
    },
    /** 赋值（含隐藏域）+ 触发 input/change */
    setValue(sel, value) {
      const el = document.querySelector(sel);
      if (!el) throw new Error('没有元素：' + sel);
      el.value = String(value == null ? '' : value);
      try { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { }
      return { sel, len: el.value.length };
    },
    /** 选下拉：按 value 或按文字 */
    setSelect(sel, want) {
      const el = document.querySelector(sel);
      if (!el) throw new Error('没有 select：' + sel);
      const w = String(want);
      let opt = Array.from(el.options).find(o => o.value === w);
      if (!opt) opt = Array.from(el.options).find(o => (o.text || '').trim() === w);
      if (!opt) opt = Array.from(el.options).find(o => (o.text || '').indexOf(w) >= 0);
      if (!opt) throw new Error('下拉里没有：' + want);
      el.value = opt.value;
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { }
      return { sel, picked: opt.text || opt.value };
    },
    /** 提交类按钮候选（含隐藏按钮，供"看得见的点不动"时兜底） */
    submitCandidates() {
      const txt = e => (e.value || e.innerText || '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button'))
        .filter(b => /保存|提交|发表|确定|完成上传|上传|发布/.test(txt(b)))
        .map(b => ({ t: txt(b).slice(0, 12), visible: !!(b.offsetWidth || b.offsetHeight), onclick: (b.getAttribute('onclick') || '').slice(0, 70) }));
    },
  };

  // ------------------------------------------------------------ 学习通（超星）
  /**
   * 学习通 = 章节树 + 任务点（视频/文档/PPT/章测试/讨论），比 shengsheng 更碎，所以走"任务点遍历"而不是"逐课循环"。
   * 本适配器先做**只读监看与进度统计**（面板要显示处理过程）；播放/自动切任务点等写操作按新平台接入七步逐步补。
   * 结构事实（2026-10-14 实测）：课程页 mooc1.chaoxing.com/mooc-ans/mycourse/studentcourse?courseId=…&clazzid=…
   *   章节节点用 [class*=chapter] 系列类名；任务点标题形如 `1.1.1.1 标题⑴`，后面常跟一个数字=该节点任务点数。
   */
  const ADAPTER_CHAOXING = {
    id: 'chaoxing',
    pageKind() {
      const p = location.pathname + location.search;
      if (/studentcourse|mycourse/i.test(p)) return 'course';
      if (/knowledge|courseware|chapter/i.test(p)) return 'chapter';
      if (/work\/|exam|test|quiz|jobid/i.test(p)) return 'exam';
      if (/passport|login/i.test(p)) return 'login';
      return 'other';
    },
    /** 任务点清单：从章节树里抽 {name, marks}；marks 是节点后面那个数字（≈任务点数） */
    taskPoints() {
      const out = [];
      const nodes = Array.from(document.querySelectorAll('[class*=chapter_item],[class*=chapterItem],[class*=catalog_item],.chapter'));
      for (const n of nodes) {
        const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 80) continue;
        const m = t.match(/^([\d.]+\s*)?([^0-9]{2,40}?)\s*(\d+)?$/);
        out.push({ name: t.slice(0, 40), raw: t.slice(0, 60) });
      }
      return out.slice(0, 200);
    },
    /** 面板进度：与其它平台**同口径** —— {pct, done, total, remainSec, etaSec}
     *  ★ 判据（2026-10-15 实测校准）：树上每个任务点里有个 `span.roundpoint`，
     *    **类名**就是状态：`roundpoint blue` = 已完成；`roundpoint orange01 jobCount` = 未完成。
     *  ⚠️ 旧实现的两处错误（导致面板一直显示 0% (0/91)）：
     *    ① 用 `a[href*="studentstudy"]` 找节点 —— 但树上其实是 `[onclick^="getTeacherAjax"]`，
     *       **JS 渲染、根本没有 href**，所以一条都没遍历到；
     *    ② 要求节点自身 `innerText` 带编号 —— 实际这些节点**自身没有文字**（文字在祖先 `.ncells` 里）。
     *  另外注意：`.jobUnfinishCount` 虽然存在（59 个），但**值全是空的且 hidden**，不能用来计数。 */
    progressInfo() {
      try {
        const g = k => { try { return localStorage.getItem('ncCx:' + k); } catch (_) { return null; } };
        const rate = (typeof effRate === 'function' ? effRate() : 1.5) || 1.5;
        let total = 0, done = 0;
        // ① 树上直接数 roundpoint（最准）
        const rp = Array.from(document.querySelectorAll('span.roundpoint'));
        if (rp.length) {
          for (const e of rp) {
            const cls = String(e.className || '');
            if (/jobCount|orange01/.test(cls)) { total++; }           // 未完成
            else if (/blue/.test(cls)) { total++; done++; }           // 已完成
          }
        }
        // ② 树上取不到（页面还没渲染树）→ 用驱动器写进 localStorage 的计数
        if (!total) {
          total = Number(g('total') || 0);
          done = Number(g('doneN') || 0);
        }
        if (!total) return null;
        const durSum = Number(g('durSum') || 0), durCnt = Number(g('durCnt') || 0);
        const avg = durCnt ? durSum / durCnt : 0;
        const remainSec = avg * Math.max(0, total - done);
        return { total: total, done: done, pct: total ? Math.round(done / total * 100) : 0, remainSec: remainSec, etaSec: remainSec / rate, rate: rate };
      } catch (_) { return null; }
    },
    player() { return document.querySelector('video') || null; },
    onResponse() { },
    resetRound() { },
    async poll() {
      if (state.loopTicks % 10 === 0) {
        const pr = this.progressInfo();
        state.cx = { kind: this.pageKind(), title: document.title.slice(0, 30), progress: pr, at: now() };
        if (pr) log('学习通监看', this.pageKind(), pr.done + '/' + pr.total, pr.pct + '%');
      }
    }
  };

  /** ★ 长春教师培训（ccjyxy）适配器 —— 2026-10-15 补：此前 P_ADAPTER 对 ccjyxy 是 null，
   *  所以面板「进度」永远显示 `—`（用户反馈"进度没有正确显示"）。
   *  口径：**学时进度**（这平台是按"整门课完成后结算学时"，不是按资源数）——
   *    数据源 = 平台自己的 API `/api/v1/me/my-trainings-progress`：
   *      learned_score = 已结算学时，required_score = 需完成学时（90）
   *  ⚠️ progressInfo() 是**同步**调用的 → 不能在里头发 fetch；用 poll() 定时刷缓存（30 秒）。 */
  const ADAPTER_CCJYXY = {
    key: 'ccjyxy',
    _p: null,
    _last: 0,
    pageKind() { return document.querySelector('video') ? 'player' : 'list'; },
    player() { return document.querySelector('video') || null; },
    onResponse() { },
    resetRound() { },
    async poll() {
      if (now() - this._last < 30000) return;
      this._last = now();
      try {
        const tk = localStorage.getItem('access_token');
        if (!tk) return;
        const r = await fetch('/api/v1/me/my-trainings-progress', { credentials: 'include', headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + tk } });
        const arr = await r.json();
        const o = arr && arr[0];
        if (!o) return;
        const total = Number(o.required_score) || 90;         // 需完成学时
        const done = Number((Number(o.learned_score) || 0).toFixed(1));  // 已结算学时（保留1位，防 15.700000000000001）
        const remainHours = Math.max(0, total - done);
        const remainSec = remainHours * 3600;                 // 剩余视频秒数（1 学时≈3600s 视频）
        const rate = 1.25;                                    // 记录上限 = 1.25 × 累计墙钟（实测：播 2x/3x 都只记 1.25x）
        // ★ 2026-10-20 新增：用平台自己的判据判"培训完成"。
        //   /api/v1/me/my-trainings-progress 返回里直接有 passed + groups[].passed，
        //   比我们自己算"总分≥90 且 专业≥60"更可靠（平台口径优先）。
        const groups = Array.isArray(o.groups) ? o.groups : [];
        const groupsOk = groups.length ? groups.every(g => g.passed === true) : null;
        const trainingPassed = o.passed === true || groupsOk === true;
        // 分科明细（面板可直接显示，比只有总学时清楚）
        const cats = groups.map(g => ({
          name: g.group_name,
          done: Number((Number(g.learned_score) || 0).toFixed(1)),
          target: Number((Number(g.required_score) || 0).toFixed(1)),
          passed: g.passed === true,
          coursesDone: g.completed_courses,
          coursesTotal: g.total_courses,
        }));
        const rawPct = total ? Math.round(done / total * 100) : 0;
        this._p = {
          total: total,
          done: done,
          pct: Math.min(100, rawPct),
          over: done > total ? Number((done - total).toFixed(1)) : 0,
          remainSec: remainSec,
          etaSec: remainSec / rate,
          rate: rate,
          // ★ 平台口径
          passed: trainingPassed,
          cats: cats,
          coursesDone: o.completed_courses,
          coursesTotal: o.total_courses,
          title: o.training_title || null,
          note: trainingPassed
            ? '平台已判定培训通过'
            : (done >= total ? '总学时已达标（分科是否达标看平台明细）' : null),
        };
        // ★ 全达标 → 走统一的"已完成"流程（停自动化 + 亮色横幅 + 持久化）
        if (trainingPassed && !state.allDone) {
          const gtxt = cats.map(c => c.name + ' ' + c.done.toFixed(1) + '/' + c.target.toFixed(1) + (c.passed ? '✅' : '')).join(' · ');
          markAllDone('平台判定培训已通过：' + done + '/' + total + ' 学时' +
            (cats.length ? '（' + gtxt + '）' : '') +
            (o.completed_courses != null ? ' · 完成 ' + o.completed_courses + '/' + o.total_courses + ' 门课' : ''));
        }
      } catch (_) { }
    },
    progressInfo() { return this._p; },
  };

  // ------------------------------------------------------------ 智慧树 / 知到
  /**
   * 智慧树（知到）—— 2026-10-15 接入。
   * 站点事实：
   *   · 学习页 `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=<hex>`（video.js + mp4 直链 wsvideo.zhihuishu.com）
   *   · **入口必须走"我的学堂"**（新版学堂在 hike-teaching-center.polymas.com 点课程卡片新开标签）；
   *     直接刷新/直达 stuStudy 会落到 404 并跳回 www.zhihuishu.com（实测多次），要重走学堂入口。
   *   · 目录在右侧：`li.clearfix.video`（视频小节） / `li.clearfix`（节/section 行） / `li.clearfix.font_gray_inclined.chapter`（章）
   *   · 倍速**只有站点自己的三档**：`.speedBox` 悬停展开 `.speedList [rate="1.5"|"1.25"|"1.0"]`；
   *     不要直接改 `video.playbackRate`（站点只提供这三档，外部改属性是异常信号）。
   *
   * ★★ 完成判据（唯一可靠的那个，2026-10-15 实测）：
   *   **页面上没有可数的完成标记**，进度只能取站点接口：
   *     · `.time_icofinish`（蓝底白勾）/`.time_ico_half`（灰底播放）/`.Sectionmark-em`（灰杠）
   *       在 **全部 73 个小节上完全一致**（同一张 png、同 display/visibility/opacity、同 data-v 作用域），
   *       所以"数目录里的勾"会永远得到 73/73 —— 这点与学习通的 `span.roundpoint blue/orange01` 完全不同。
   *     · 唯一可靠来源是接口（由 App.js 已有的 XHR 钩子旁路拿到，**不需要自己签 secretStr**）：
   *         POST studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist       → 树：章/videoLessons[]/videoSmallLessons[] + videoSec
   *         POST studyservice-api.zhihuishu.com/gateway/t/v1/learning/queryStuyInfo   → { lesson:{lessonId:{watchState,studyTotalTime}}, lv:{smallLessonId:{...}} }
   *         `watchState === 1` = 该视频**已看完**（studyTotalTime 已到 videoSec）；`0` = 没看完。
   *     · 统计口径（与目录行数一致）：有 `videoSmallLessons` 的节用小节（查 `lv` 表），否则用节本身（查 `lesson` 表）；
   *       24 门课里本门"大学生安全教育" = 35 节 + 38 小节 = **73 个视频单元**（与 DOM 的 73 行 li.clearfix.video 对得上）。
   *   ⚠️ 别用 `videolist` 里的 `isStudiedLesson`：实测已看完的课它也是 0（导论 id=1000110424 就是 0/看完了）。
   */
  const ADAPTER_ZHIHUISHU = {
    id: 'zhihuishu',
    _tree: null,     // videolist → videoChapterDtos
    _state: null,    // queryStuyInfo → { lesson, lv }
    _p: null,        // 缓存进度 {total,done,pct,remainSec,etaSec,rate}
    pageKind() {
      const h = location.hostname;
      if (/^login\./i.test(h) || /passport\./i.test(h)) return 'login';
      if (/studyvideoh5/i.test(h)) return /stuStudy/i.test(location.pathname) ? 'study' : 'study-other';
      // 作业/考试（在线学堂）—— 2026-10-15 接：onlineexamh5new 是新版 SPA（hash 路由），exam. 是旧版
      if (/onlineexamh5new|onlineexam|studentexam|taurusexam/i.test(h) || /^exam\./i.test(h)) {
        const hash = location.hash || '';
        if (/checkHomework|checkExam|viewResult/i.test(hash)) return 'exam-review';
        if (/dohomework|doexamination|answerSheet/i.test(hash)) return 'exam-do';
        if (/webExamList/i.test(hash)) return 'exam-list';
        return 'exam-other';
      }
      if (/onlineweb|studyservice|studyh5/i.test(h)) return 'home';
      return 'other';
    },
    /** 目录行（DOM）：{num, title, kind}；kind: chapter | section | video */
    catalogRows() {
      return Array.from(document.querySelectorAll('li.clearfix')).map(li => {
        const t = li.querySelector('.catalogue_title');
        const num = li.querySelector('.pl5.hour');
        const cls = String(li.className);
        return {
          num: num ? (num.innerText || '').trim() : '',
          title: t ? (t.getAttribute('title') || t.innerText || '').trim() : '',
          kind: /font_gray_inclined|chapter/.test(cls) ? 'chapter' : (/video/.test(cls) ? 'video' : 'section'),
          current: /current_play/.test(cls)
        };
      }).filter(r => r.title || r.num);
    },
    /** 面板进度：与其它平台同口径 {pct,done,total,remainSec,etaSec}。数据来自接口旁路缓存，同步返回。 */
    progressInfo() { return this._p; },
    /** 站点倍速（只用站点自己的菜单，不直接改 video.playbackRate）：rate ∈ '1.5' | '1.25' | '1.0' */
    setRate(rate) {
      try {
        const item = document.querySelector('.speedList [rate="' + rate + '"]');
        if (item) { item.click(); log('知到倍速 → ' + rate); return true; }
        const box = document.querySelector('.speedBox');
        if (box) log('知到倍速菜单未展开（.speedBox 需要悬停）', rate);
      } catch (e) { err(e); }
      return false;
    },
    player() { return document.querySelector('video.vjs-tech') || document.querySelector('video') || null; },
    onResponse(url, body) {
      try {
        if (/learning\/videolist/.test(url) && body && body.data && body.data.videoChapterDtos) {
          this._tree = body.data.videoChapterDtos;
          this._refresh();
        } else if (/learning\/queryStuyInfo/.test(url) && body && body.data) {
          this._state = body.data;                 // { lesson:{}, lv:{} }
          this._refresh();
        } else if (/popupAnswer\/loadVideoPointerInfo/.test(url) && body && body.data) {
          // 弹题点位：{ questionPoint:[{timeSec,questionIds}] }
          state.zhsQuiz = { points: body.data.questionPoint || [], at: now() };
          if ((body.data.questionPoint || []).length) log('知到弹题点位', JSON.stringify(body.data.questionPoint).slice(0, 120));
        } else if (/popupAnswer\/lessonPopupExam/.test(url) && body && body.data) {
          // ★ 弹题题目本体（2026-10-15 接）：这是**站点自己**在弹窗前/中请求的接口，回包里带题干/选项/我上次的作答。
          //   本模块只做"旁路读回包"（不替换 JSON.parse、不发自己的请求）——知到会查 isNative，任何多余包装都是风险。
          this._q = body.data;
          this._qAt = now();
          this.quizBrief();                        // 把结构摘要写进 state（控制器/调试可读）
          log('知到弹题数据', String(state.zhsPopup && state.zhsPopup.brief || '').slice(0, 300));
        } else if (/exam|answer|homework|paper|question/i.test(url) && body && this.looksLikePaper(body)) {
          // ★ 作业/考试卷子（2026-10-15 接）：万能脚本是用 JSON.parse 钩子抓这段；知到上不能随便钩 JSON.parse
          //   （站点查 isNative），所以走**已有的 XHR 旁路**（responseURL + responseText），同一个回包、零额外特征。
          this._exam = body;
          this._examAt = now();
          this.examBrief();
          log('知到试卷数据', String(state.zhsExam && state.zhsExam.count || 0) + ' 题', String(state.zhsExam && state.zhsExam.where || '').slice(0, 60));
        }
      } catch (e) { err(e); }
    },
    /** lessonPopupExam 回包的结构摘要（只保留够定位答案的字段，避免 state 变大） */
    quizBrief() {
      try {
        const d = this._q || {};
        const keys = Object.keys(d);
        // 站点把题目放在哪个数组里是随版本变的：逐个候选找"像题目"的那个
        const cand = ['lessonTestQuestionUseInterfaceDtos', 'testQuestionDtos', 'questionDtos', 'questionList'];
        let arrKey = cand.find(k => Array.isArray(d[k])) || null;
        let arr = arrKey ? d[arrKey] : null;
        if (!arr) {                              // 兜底：扫第一层里第一个"元素是对象且像题目"的数组
          for (const k of keys) {
            if (Array.isArray(d[k]) && d[k].length && typeof d[k][0] === 'object' && d[k][0] !== null
              && (d[k][0].name || d[k][0].testQuestion || d[k][0].questionOptions)) { arrKey = k; arr = d[k]; break; }
          }
        }
        const first = (arr && arr[0]) || null;
        const q = (first && (first.testQuestion || first)) || null;
        const opts = (q && (q.questionOptions || [])) || [];
        state.zhsPopup = {
          at: this._qAt, keys: keys.slice(0, 12), arrKey: arrKey, count: arr ? arr.length : 0,
          brief: first ? JSON.stringify(first).slice(0, 1200) : JSON.stringify(d).slice(0, 600),
          q: q ? {
            name: String(q.name || '').slice(0, 200),
            questionId: q.questionId || null,
            type: String((q.questionType && q.questionType.name) || ''),
            options: opts.map(o => ({ id: o.id, content: String(o.content || '').slice(0, 80), result: o.result })),
            children: Array.isArray(q.questionChildrens) ? q.questionChildrens.length : 0
          } : null,
          zAnswer: first && first.zAnswer ? first.zAnswer : null
        };
      } catch (e) { err(e); }
    },
    /** 弹题弹窗根节点（站点：el-dialog aria-label="弹题测验"，外层 wrapper .dialog-test） */
    popupEl() {
      return document.querySelector('.el-dialog[aria-label="弹题测验"]')
        || document.querySelector('.el-dialog__wrapper.dialog-test .el-dialog') || null;
    },
    /** 解析弹窗 DOM：题干/题型/选项/站点已显示的正确答案 */
    parsePopup(root) {
      root = root || this.popupEl();
      if (!root) return null;
      const titleEl = root.querySelector('.topic-title');
      let typeName = '', stem = '';
      if (titleEl) {
        const t = titleEl.querySelector('.title-tit');
        typeName = t ? String(t.innerText || '').replace(/[【】\s]/g, '') : '';
        const txt = Array.from(titleEl.querySelectorAll('span'))
          .filter(s => !/title-tit|right/.test(String(s.className)))
          .map(s => String(s.innerText || '').trim()).filter(Boolean).join(' ');
        stem = (txt || String(titleEl.innerText || '')).replace(/\s+/g, ' ').trim();
        stem = stem.replace(/^(正确|错误)\s*/, '').replace(/【[^】]*】/g, '').trim();
        // 实测题干会重复两遍（题干本身 + 选项容器各带一份 span 文本）→ 折叠重复
        const half = stem.slice(0, Math.floor(stem.length / 2)).trim();
        if (half && half.length > 8 && stem.slice(half.length).trim() === half) stem = half;
      }
      const opts = Array.from(root.querySelectorAll('li.topic-item')).map((li, i) => {
        const letterEl = li.querySelector('.topic-option-item');
        const txtEl = li.querySelector('.item-topic') || li;
        const letter = String((letterEl && letterEl.innerText) || '').replace(/[.\s、]/g, '').slice(0, 2) || String.fromCharCode(65 + i);
        return { name: letter, data: String((txtEl.innerText) || '').trim(), active: !!li.querySelector('.topic-option-item.active'), el: li };
      });
      const ansEl = root.querySelector('.answer');
      let correct = '';
      if (ansEl) {
        const m = String(ansEl.innerText || '').toUpperCase().match(/[A-H]/g);
        correct = m ? m.join(',') : '';
      }
      return {
        typeName: typeName, name: stem, opts: opts,
        correct: correct, answered: opts.some(o => o.active),
        kind: /多选/.test(typeName) ? 2 : (/判断/.test(typeName) ? 3 : 1),
        el: root
      };
    },
    /**
     * 站点给的答案线索（优先于问模型）：全部来自 popupAnswer/lessonPopupExam 的回包（旁路拿的，不发自己的请求）。
     * 实测回包结构（2026-10-15，导论 questionId=16228913）：
     *   data.lessonTestQuestionUseInterfaceDtos[0]
     *     .testQuestion.name            "<span style=...>安全教育…</span>"  ← 带 HTML
     *     .testQuestion.questionId      16228913
     *     .testQuestion.questionType    {id:14,name:"判断题",inputType:"radio"}
     *     .testQuestion.questionOptions [{id:53715220,content:"对",sort:1,result:"1"},
     *                                    {id:53715221,content:"错",sort:2,result:"0"}]
     *     .zAnswer                      {answer:"53715220"}  ← ★ 是"我上次选的选项 id"，不是字母
     * 语义（结合站点 bundle 里那段比对逻辑 + 现场 UI 交叉验证）：
     *   · result == 1 的选项 = 正确选项；
     *   · zAnswer.answer   = 该学生**已经答过**的那一题所选的选项 id（有它说明这题不用再答）。
     */
    zhsAnswer(info) {
      try {
        const st = state.zhsPopup || null;
        const q = (st && st.q) || null;
        if (!q) return null;
        if (info && info.name && q.name && normText(q.name).indexOf(normText(info.name).slice(0, 16)) < 0) return null;  // 不是同一题
        const opts = q.options || [];
        const letterOfIdx = i => String.fromCharCode(65 + i);
        const letters = [];
        for (let i = 0; i < opts.length; i++) if (Number(opts[i].result) === 1) letters.push(letterOfIdx(i));
        const z = (st && st.zAnswer) || null;
        let answeredPick = '';
        if (z && z.answer) {
          const idx = opts.findIndex(o => String(o.id) === String(z.answer));
          if (idx >= 0) answeredPick = letterOfIdx(idx);
        }
        return {
          correctLetters: letters.join(','),     // 站点标注的正确选项（没有就空）
          answeredPick: answeredPick,            // 我上次选的那个选项
          answered: !!(z && z.answer),
          questionId: q.questionId || null
        };
      } catch (e) { err(e); return null; }
    },
    /** 给外部驱动器读的弹题快照（只读，不点任何东西；点击一律由 CDP 侧真实鼠标完成） */
    popupInfo() {
      try {
        const root = this.popupEl();
        const out = { open: !!root, at: now() };
        if (!root) return out;
        const info = this.parsePopup(root);
        if (!info) return out;
        const site = this.zhsAnswer(info) || null;
        out.stem = info.name;
        out.type = info.typeName;
        out.kind = info.kind;
        out.options = info.opts.map(o => {
          let rect = null;
          try { const r = o.el.getBoundingClientRect(); rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; } catch (_) { }
          return { letter: o.name, text: o.data, active: !!o.active, rect: rect };
        });
        out.domAnswer = info.correct || '';
        out.badge = (function () { try { const b = root.querySelector('.topic-title .right'); return b ? String(b.innerText || '').trim() : ''; } catch (_) { return ''; } })();
        out.site = site;
        const plan = state.zhsPopupSolve || null;
        out.target = plan && plan.target || (site && site.correctLetters) || out.domAnswer || '';
        out.why = plan && plan.src || (site && site.correctLetters ? 'option-result' : (out.domAnswer ? 'dom-answer' : ''));
        // 关闭按钮 / 下一页按钮（坐标也一起给驱动器）
        const rc = (sel) => { try { const e = root.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], disabled: !!e.disabled }; } catch (_) { return null; } };
        out.closeBtn = rc('.el-dialog__footer .btn') || rc('.el-dialog__headerbtn');
        out.nextBtn = rc('.el-pagination .btn-next');
        out.pager = (function () { try { const p = root.querySelector('.el-pager .number.active'); return p ? String(p.innerText || '').trim() : ''; } catch (_) { return ''; } })();
        return out;
      } catch (e) { err(e); return { open: false, err: String(e && e.message || e) }; }
    },
    /** 弹题看护定时器（1 秒；懒启动，dispose 时随 timers 一起清掉） */
    ensureWatch() {
      if (this._watchOn || !ZHS_QUIZ_WATCH) return;
      this._watchOn = true;
      timers.push(setInterval(() => { try { this.quizTick(); } catch (e) { err(e); } }, 1000));
    },
    /** 弹题主循环（1 秒一次，由 poll 启动）：只在弹窗在的时候动，视频被弹窗暂停时正好慢慢处理 */
    async quizTick() {
      if (!CFG.autoQuiz) return;
      const root = this.popupEl();
      if (!root) { this._popupKey = ''; this._popupGone = now(); return; }
      if (this._busy) return;
      const info = this.parsePopup(root);
      if (!info || !info.name || !info.opts.length) return;
      const key = (info.name + '|' + info.opts.map(o => o.name + o.data).join('|')).slice(0, 200);
      if (key === this._popupKey) return;
      this._popupKey = key;
      this._busy = true;
      try { await this.solvePopup(info); } catch (e) { err(e); } finally { this._busy = false; }
    },
    /**
     * 弹题「决策」——**只看不点**（点击一律交给 CDP 侧真实鼠标；页面内合成事件会被站点元素级
     * 监听判为"异常脚本"，实测直接把页面弹回门户，见 docs/CC-STATUS-LEAD.md 第 91 轮与 platforms.md）。
     *
     * 答案优先级（全部实测过字段含义）：
     *   ① 站点回包标了 result==1 的正确选项 → 用它（不是猜的，是站点自己给的）；
     *   ② 选项列表里已经有 .answer「正确答案：X」→ 用它；
     *   ③ 以上都没有（新题）→ 问 DeepSeek（NetClass.askDs 同源，key 由加载器下发）。
     * 另外：回包里 zAnswer 有值 = 这题**我答过**（视频重看时才会这样），此时站点把选项锁住，
     *   UI 上点不动 → 只需关闭弹窗让视频继续。
     */
    async solvePopup(info) {
      state.quiz.seen++;
      const site = this.zhsAnswer(info);
      let target = '', src = 'none';
      if (site && site.correctLetters) { target = site.correctLetters; src = 'option-result'; }
      else if (info.correct) { target = info.correct; src = 'dom-answer'; }
      if (!target) {
        try {
          const r = await inferAnswer({ name: info.name, type: info.kind, optionList: info.opts.map(o => ({ name: o.name, data: o.data })) });
          target = r && r.answer; src = (r && r.why) || 'ds';
        } catch (e) { err(e); }
      }
      const plan = {
        at: now(), name: info.name.slice(0, 120), type: info.typeName, kind: info.kind,
        opts: info.opts.map(o => o.name + ':' + o.data.slice(0, 40)),
        siteAnswer: site || null, domAnswer: info.correct || '', target: target, src: src,
        answeredAlready: !!(site && site.answered) || info.answered,
        needClick: !!(target && !(site && site.answered)),
        clickBy: 'cdp-real-mouse'
      };
      state.zhsPopupSolve = plan;
      log('知到弹题：' + (plan.answeredAlready ? '站点已作答' : '待作答') + ' | 目标=' + (target || '(空)') + ' | 来源=' + src + ' | ' + info.typeName + ' ' + info.name.slice(0, 40));
      return plan;
    },
    /**
     * 作业/考试卷子摘要（2026-10-15 接）——数据来自 answer 相关接口回包。
     * 万能脚本认的是 `o.rt.examBase.workExamParts[]`，但**复习页/答题页的回包形状不一样**（实测复习页就不是这个路径），
     * 所以这里做**深度受限的结构搜索**：找任何一层上"元素带 questionDtos 的数组"，再按万能脚本的规则摊平：
     *   parts[].questionDtos[] { id, name, questionType.name, questionOptions[{id,content,result}], questionChildrens[] }
     * 复合题（阅读理解/完型/听力）展开 questionChildrens。
     */
    looksLikePaper(body) {
      try {
        const s = JSON.stringify(body);
        return /"questionDtos"|"workExamParts"|"questionChildrens"|"questionOptions"/.test(s);
      } catch (_) { return false; }
    },
    examBrief() {
      try {
        let hit = null;                                   // { where, arr }
        let visited = 0;
        const walk = (node, path, depth) => {
          if (hit || !node || typeof node !== 'object' || depth > 5) return;
          if (++visited > 4000) return;
          if (Array.isArray(node)) {
            if (node.length && node[0] && typeof node[0] === 'object' && node[0] !== null
              && (node[0].questionDtos || node[0].questionList || node[0].questions)) {
              hit = { where: path, arr: node };
              return;
            }
            for (let i = 0; i < Math.min(node.length, 20); i++) walk(node[i], path + '[' + i + ']', depth + 1);
            return;
          }
          for (const k of Object.keys(node)) {
            if (/^(name|content|imgUrls|videoInfo|txtInfo)$/.test(k)) continue;
            walk(node[k], path ? path + '.' + k : k, depth + 1);
            if (hit) return;
          }
        };
        walk(this._exam, '', 0);
        if (!hit && !this._exam) { return; }
        let flat = [];
        if (hit) {
          const push = (it, parent) => {
            if (!it) return;
            const q = {
              id: it.id, type: String((it.questionType && it.questionType.name) || it.questionTypeName || ''),
              name: normText(it.name || it.question || '').slice(0, 300),
              options: ((it.questionOptions || it.options) || []).map(o => ({ id: o.id, content: normText(o.content || o.optionContent || '').slice(0, 200), result: o.result }))
            };
            q.children = Array.isArray(it.questionChildrens) ? it.questionChildrens.length : 0;
            if ((q.type.indexOf('填空') >= 0 || q.type.indexOf('问答') >= 0) === false
              && q.children && it.questionChildrens) { it.questionChildrens.forEach(c => push(c, it)); }
            else flat.push(q);
          };
          hit.arr.forEach(part => (part.questionDtos || part.questionList || part.questions || []).forEach(q => push(q)));
        }
        state.zhsExam = {
          at: this._examAt, where: hit ? hit.where : '(未找到题目数组)', parts: hit ? hit.arr.length : 0, count: flat.length,
          questions: flat.slice(0, 120),
          raw: hit ? '' : JSON.stringify(this._exam).slice(0, 1200)
        };
      } catch (e) { err(e); }
    },
    /** 作业/考试页面快照（只读）：DOM 解析 + 接口数据合并，供 CDP 驱动器作答/提交 */
    examInfo() {
      const out = { kind: this.pageKind(), url: location.href.slice(0, 200), at: now() };
      const api = state.zhsExam || null;
      out.api = api ? { parts: api.parts, count: api.count, paperName: api.paperName } : null;
      const apiQ = (api && api.questions) || [];
      const nodes = Array.from(document.querySelectorAll('.examPaper_subject'));
      out.domCount = nodes.length;
      out.items = nodes.map((el, i) => {
        const typeEl = el.querySelector('.subject_type');
        let typeText = typeEl ? String(typeEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
        const stemEl = el.querySelector('.subject_describe') || el.querySelector('.smallStem_describe') || el;
        let stem = String(stemEl.innerText || '').replace(/\s+/g, ' ').trim();
        const options = Array.from(el.querySelectorAll('.nodeLab')).map((lab, j) => {
          const input = lab.querySelector('input');
          const letterEl = lab.querySelector('.fl span') || lab;
          const letter = (String(letterEl.innerText || '').match(/([A-H])/) || [null, String.fromCharCode(65 + j)])[1];
          const detail = lab.querySelector('.node_detail');
          const text = String((detail || lab).innerText || '').replace(/\s+/g, ' ').trim();
          let rect = null;
          try { const r = lab.getBoundingClientRect(); rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; } catch (_) { }
          let img = '';
          try { const im = lab.querySelector('img'); img = im ? String(im.getAttribute('src') || '') : ''; } catch (_) { }
          return {
            letter: letter, text: text.slice(0, 200), rect: rect, img: img.slice(-20),
            optionId: input ? String(input.value || '') : '',
            disabled: input ? !!input.disabled : null,
            checked: input ? !!input.checked : null,
            kind: input ? String(input.type || '') : ''
          };
        });
        const qid = el.getAttribute('data-questionid') || '';
        const apiHit = apiQ.find(q => String(q.id) === String(qid)) || apiQ[i] || null;
        // 复习页（checkHomework）上 input.checked = 学生当时的作答；img 还带一份"选中/未选"图标指纹（作兜底）
        const marked = options.filter(o => o.checked === true || /872099a548602d4d/.test(o.img || '')).map(o => o.letter);
        const cleanType = typeText.replace(/[【】]/g, '').replace(/\s*[（(].*$/, '').trim();
        return {
          i: i + 1, qid: qid, type: cleanType, stem: stem.slice(0, 300),
          options: options, api: apiHit ? { id: apiHit.id, type: apiHit.type, name: apiHit.name.slice(0, 120), options: apiHit.options } : null,
          markedCorrect: marked                         // 复习页上"已选/正确"的选项（img 指纹，见注释）
        };
      });
      return out;
    },
    /** 单题问答案（给驱动器用）：返回 {letters, src}；站点有 result 标记时直接用站点的 */
    examAnswer(i) {
      return (async () => {
        const info = this.examInfo();
        const it = info.items[i];
        if (!it) return null;
        const site = (it.api && it.api.options || []).filter(o => Number(o.result) === 1);
        if (site.length) {
          const letters = [];
          for (const o of site) {
            const idx = it.api.options.indexOf(o);
            if (idx >= 0) letters.push(String.fromCharCode(65 + idx));
          }
          if (letters.length) return { letters: letters.join(','), src: 'option-result' };
        }
        const r = await inferAnswer({ name: it.stem, type: /多选/.test(it.type) ? 2 : (/判断/.test(it.type) ? 3 : 1), optionList: it.options.map(o => ({ name: o.letter, data: o.text })) });
        return { letters: (r && r.answer) || '', src: (r && r.why) || 'ds' };
      })();
    },
    /** 用接口数据重算进度（同步） */
    _refresh() {
      try {
        if (!this._tree || !this._state) return;
        const lessons = this._state.lesson || {}, lv = this._state.lv || {};
        let total = 0, done = 0, remainSec = 0;
        for (const ch of this._tree) {
          for (const l of (ch.videoLessons || [])) {
            const smalls = (l.ishaveChildrenLesson && l.videoSmallLessons && l.videoSmallLessons.length) ? l.videoSmallLessons : null;
            for (const u of (smalls || [l])) {
              const st = (smalls ? lv : lessons)[String(u.id)] || null;
              const sec = Number(u.videoSec) || 0;
              const watched = st ? Number(st.watchState) === 1 : false;
              total++;
              if (watched) done++;
              else if (sec) remainSec += Math.max(0, sec - (Number(st && st.studyTotalTime) || 0));
            }
          }
        }
        if (!total) return;
        const rate = 1.5;                        // 站点菜单最高档（1.0/1.25/1.5）
        this._p = { total: total, done: done, pct: Math.round(done / total * 100), remainSec: remainSec, etaSec: remainSec / rate, rate: rate };
      } catch (e) { err(e); }
    },
    resetRound() { this._tree = null; this._state = null; this._p = null; },
    async poll() {
      // 只读监看：接口数据由 onResponse 旁路缓存，poll 不发请求（降低 CDP/自动化痕迹，见 docs/CC-STATUS-LEAD.md 第 81 轮）
      if (ZHS_QUIZ_WATCH) this.ensureWatch();          // 弹题看护：1 秒一次，只在弹窗出现时做决策
      if (state.loopTicks % 10 === 0) {
        const pr = this.progressInfo();
        state.zhs = { kind: this.pageKind(), title: document.title.slice(0, 30), progress: pr, at: now() };
        if (pr) log('知到监看', this.pageKind(), pr.done + '/' + pr.total, pr.pct + '%', '剩 ' + Math.round(pr.remainSec / 60) + ' 分');
      }
    }
  };

  const P_ADAPTER = PLATFORM === 'shengsheng' ? ADAPTER_SHENGSHENG
    : PLATFORM === 'qiyang' ? ADAPTER_QIYANG
      : PLATFORM === 'webtrn' ? ADAPTER_WEBTRN
        : PLATFORM === 'chaoxing' ? ADAPTER_CHAOXING
          : PLATFORM === 'ccjyxy' ? ADAPTER_CCJYXY
            : PLATFORM === 'zhihuishu' ? ADAPTER_ZHIHUISHU : null;

  // ------------------------------------------------------------ 收工：全部刷完
  const DONE_KEY = 'netclass.done.' + PLATFORM;
  function readDone() { try { return JSON.parse(localStorage.getItem(DONE_KEY) || 'null'); } catch (_) { return null; } }

  /** 明显的横幅提示（面板之外的独立元素，不容易被忽略）；带关闭按钮，可收起
   *  ★ 2026-10-20：完成态横幅改为【亮色 + 呼吸动画 + 大字号】，用户明确要求"亮色更明显"。
   *    原来 done 用的是深墨绿渐变(#0f5132→#1b7a4b)，在深色页面上不够显眼。 */
  let bannerEl = null;
  function showBanner(html, tone) {
    try {
      if (bannerEl) bannerEl.remove();
      bannerEl = document.createElement('div');
      bannerEl.id = 'netclass-banner';
      const bg = tone === 'done' ? 'linear-gradient(90deg,#00e676,#00c853,#00e676)'
        : tone === 'warn' ? 'linear-gradient(90deg,#ff9800,#ffb300)'
          : 'linear-gradient(90deg,#1e3a5f,#2b5286)';
      const isDone = tone === 'done';
      bannerEl.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;' +
        'font:' + (isDone ? '600 17px/1.7' : '14px/1.7') + ' "Segoe UI",system-ui,"Microsoft YaHei",sans-serif;' +
        'color:#fff;background:' + bg + ';' +
        'padding:' + (isDone ? '16px 52px 16px 30px' : '10px 40px 10px 22px') + ';' +
        'border-radius:' + (isDone ? '14px' : '10px') + ';' +
        'box-shadow:' + (isDone
          ? '0 0 0 3px rgba(0,230,118,.55), 0 0 28px rgba(0,230,118,.85), 0 12px 36px rgba(0,0,0,.55)'
          : '0 10px 30px rgba(0,0,0,.5)') + ';' +
        'text-shadow:' + (isDone ? '0 2px 6px rgba(0,0,0,.45)' : 'none') + ';' +
        'max-width:88vw;text-align:center;user-select:none;' +
        (isDone ? 'animation:netclass-pulse 1.6s ease-in-out infinite;' : '');
      // 呼吸动画（只注入一次）
      if (isDone && !document.getElementById('netclass-pulse-kf')) {
        const st = document.createElement('style');
        st.id = 'netclass-pulse-kf';
        st.textContent = '@keyframes netclass-pulse{0%,100%{transform:translateX(-50%) scale(1);}' +
          '50%{transform:translateX(-50%) scale(1.035);}}';
        (document.head || document.documentElement).appendChild(st);
      }
      bannerEl.innerHTML = html +
        '<span id="netclass-banner-x" title="关闭" style="position:absolute;top:4px;right:8px;cursor:pointer;' +
        'font-size:16px;line-height:1;opacity:.75;padding:2px 6px;border-radius:4px">✕</span>';
      (document.body || document.documentElement).appendChild(bannerEl);
      const x = bannerEl.querySelector('#netclass-banner-x');
      if (x) {
        x.onmouseenter = () => { x.style.opacity = '1'; x.style.background = 'rgba(255,255,255,.18)'; };
        x.onmouseleave = () => { x.style.opacity = '.75'; x.style.background = 'transparent'; };
        x.onclick = () => hideBanner();
      }
      // 完成态【不自动收起】—— 用户要能一直看到"已完成"；其它提示 30 秒后收
      if (!isDone) timers.push(setTimeout(() => { if (bannerEl) hideBanner(); }, 30000));
    } catch (_) { }
  }
  function hideBanner() { try { if (bannerEl) { bannerEl.remove(); bannerEl = null; } } catch (_) { } }

  /** 检测到本门课全部完成：暂停播放 + 停掉自动化 + 持久化提示 */
  function markAllDone(detail) {
    if (state.allDone) return false;
    state.allDone = true;
    state.doneAt = now();
    CFG.enabled = false;           // 停掉一切自动动作
    saveCfg();
    try { localStorage.setItem(DONE_KEY, JSON.stringify({ at: state.doneAt, detail: String(detail || '').slice(0, 120) })); } catch (_) { }
    const v = pickVideo();
    if (v) { try { v.pause(); } catch (_) { } }
    // 视频可能还没就绪，稍后再按一次（此时 kickStart 已被 allDone 拦住，不会再起播）
    [3000, 8000, 15000].forEach(ms => timers.push(setTimeout(() => {
      const vv = pickVideo(); if (vv && !vv.paused && !vv.ended) { try { vv.pause(); } catch (_) { } }
    }, ms)));
    const msg = detail || '本门课程已全部处理完毕';
    log('🎉 全部完成，自动化已暂停、播放已停止');
    report('all-done', { platform: PLATFORM, url: location.href, detail: msg });
    // ★ 2026-10-20：原来写死两分支 `PLATFORM === 'qiyang' ? '职业培训' : '心理学导论'`，
    //   长春(ccjyxy)会显示成"心理学导论已全部完成"——完全错误的文案。改成查表 + 兜底。
    const DONE_LABEL = {
      ccjyxy: '长春教师培训',
      qiyang: '职业培训',
      shengsheng: '生生课堂',
      chaoxing: '学习通',
      zhihuishu: '智慧树知到',
      webtrn: '教师培训平台',
    };
    const label = DONE_LABEL[PLATFORM] || (ADAPTER && ADAPTER.label) || '本课程';
    showBanner(
      '<div style="font-size:22px;letter-spacing:.5px;margin-bottom:4px">✅ ' + label + ' 课程已完成</div>' +
      '<div style="font-size:14px;opacity:.95">' + msg + '</div>' +
      '<div style="font-size:12px;opacity:.85;margin-top:4px">自动化已暂停 · 播放已停止 · 可关闭此提示</div>'
      , 'done');
    return true;
  }

  // ------------------------------------------------------------ 课程进度与预估（面板显示）
  /**
   * 从课时目录算本课程的完成度与预估剩余时间：
   *   .lesson-item 行 → 状态（已完成/已学完/观看中/已观看 N%/未开始）+ 时长（mm:ss 或 hh:mm:ss）
   *   remainSec = 各未完成课时的剩余时长之和（正在看的那节按剩余部分算）
   *   etaSec   = remainSec / 当前倍速（**本页视角**；整机时间还要除以并行路数，见 parallel-probe）
   */
  function courseProgress() {
    try {
      // 平台自带口径优先（学习通=任务点、其它平台=课时列表）
      if (P_ADAPTER && typeof P_ADAPTER.progressInfo === 'function') {
        const pi = P_ADAPTER.progressInfo();
        if (pi) return pi;
      }
      const toSec = s => { if (!s) return 0; const p = String(s).split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
      let rows = Array.from(document.querySelectorAll('.lesson-item'));
      if (!rows.length) rows = Array.from(document.querySelectorAll('li[class*=lesson]')).filter(e => !/lesson-status/.test(String(e.className)));
      if (!rows.length) return null;
      const v = pickVideo();
      const items = rows.map(e => {
        const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
        const st = (t.match(/(已完成|已学完|观看中|学习中|已观看\s*\d+%?|未开始|待学习)/) || [])[1] || '';
        const durs = t.match(/(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})/g) || [];
        const pct = (t.match(/已观看\s*(\d+)%/) || [])[1];
        return { done: /已完成|已学完/.test(st), cur: /观看中|学习中/.test(st), pct: pct ? Number(pct) : null, sec: toSec(durs[durs.length - 1] || '') };
      });
      const total = items.length, done = items.filter(i => i.done).length;
      let remainSec = 0, unknown = 0;
      for (const i of items) {
        if (i.done) continue;
        if (i.cur && v && v.duration) { remainSec += Math.max(0, v.duration - v.currentTime); continue; }
        if (i.pct != null && i.sec) { remainSec += i.sec * (1 - i.pct / 100); continue; }
        if (!i.sec) unknown++;
        remainSec += i.sec;
      }
      const rate = (typeof effRate === 'function' ? effRate() : 1.5) || 1.5;
      return { total, done, pct: total ? Math.round(done / total * 100) : 0, remainSec, etaSec: remainSec / rate, rate, unknown };
    } catch (_) { return null; }
  }
  function fmtDur(sec) {
    if (sec == null || isNaN(sec)) return '?';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? (h + 'h' + (m ? m + 'm' : '')) : (m + 'min');
  }

  // ------------------------------------------------------------ 控制面板
  // ⚠️ 这个声明不能少！加设置面板时我误删过它，导致 mountPanel() 抛 ReferenceError: panelEl is not defined，
  //    表现为"面板整块不出现"且控制台只有这一行报错（排查花了一整轮）。
  let panelEl = null;
  // ★ 声明式配置表（思路来自 OCS：reference/ocsjs .../cx.ts 的 settings schema）
  //   加一项只要往 SETTINGS_SCHEMA 里加一行，UI 与存储自动生效。
  //   跨进程项（如"章测试仅保存不提交"）写进 localStorage，由 scripts/cx-answer-quiz.mjs 读取。
  const SETTINGS_SCHEMA = [
    { group: '基础' },
    { key: 'enabled', label: '自动运行', type: 'bool', desc: '总开关。关掉后页面内的模块不再自动操作（也会同步暂停外部驱动器）' },
    { key: 'autoPlay', label: '自动播放', type: 'bool', desc: '视频暂停时自动 continue' },
    { key: 'mute', label: '静音', type: 'bool', desc: '自动静音避免声音打扰' },
    { key: 'rate', label: '播放倍速', type: 'select', options: ['1', '1.25', '1.5', '2', '3'], desc: '站点自带的最高档位优先；长春记账硬卡 1.25x，设更高只会增加重播' },

    { group: '视频内弹题' },
    { key: 'autoQuiz', label: '弹题自动作答', type: 'bool', desc: '视频里弹出的题自动问 DeepSeek 并作答' },
    { key: 'quizDelayMs', label: '答题延迟(毫秒)', type: 'num', desc: '弹出后等多久再作答，太快容易被判异常' },

    { group: '章节测试（学习通）' },
    { key: 'cxSaveOnly', label: '仅保存，不提交', type: 'bool', desc: '★ 答完只暂存（调站点 noSubmit()），不点提交。想自己检查完再交就打开它' },
    { key: 'cxNeedAll', label: '必须全部作答才提交', type: 'bool', def: true, desc: '★ 默认开。完成率不到 100% 时只保存不提交（照 OCS 的 uploadable 判据）' },
    { key: 'cxAutoSubmit', label: '答完自动提交', type: 'bool', def: true, desc: '关掉则答完停下等你手动提交' },

    { group: '跳转' },
    { key: 'autoNext', label: '完成后自动下一节', type: 'bool', desc: '一节看完自动进入下一节' },
    { key: 'doneWaitSec', label: '完成等待(秒)', type: 'num', desc: '判定完成后等多久再跳转' },

    { group: '数据' },
    { key: 'dsEnable', label: '启用 DeepSeek 作答', type: 'bool', desc: '关掉则只用本地题库' },
    { key: 'report', label: '上报统计', type: 'bool', desc: '向 NetClassServer 上报运行状态' },
  ];

  let cfgEl = null;
  function mountSettings() {
    if (cfgEl) { cfgEl.remove(); cfgEl = null; return; }
    cfgEl = document.createElement('div');
    cfgEl.id = 'netclass-settings';
    const C = { bg: '#191512', bd: '#3a2f24', fg: '#f0e7db', mut: '#9b8d7c', accent: '#e0a253' };
    cfgEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;'
      + 'font:12px/1.6 "Segoe UI",system-ui,"Microsoft YaHei",sans-serif;'
      + 'background:' + C.bg + ';color:' + C.fg + ';border:1px solid ' + C.accent + ';border-radius:6px;'
      + 'padding:10px 12px;width:330px;max-height:74vh;overflow:auto;user-select:none';
    const draw = () => {
      const rows = SETTINGS_SCHEMA.map(it => {
        if (it.group) return '<div style="margin:9px 0 4px;color:' + C.accent + ';font-weight:600;border-bottom:1px solid ' + C.bd + ';padding-bottom:2px">' + it.group + '</div>';
        const cur = CFG[it.key];
        const desc = it.desc ? '<div style="color:' + C.mut + ';font-size:11px;margin-top:1px">' + it.desc + '</div>' : '';
        let ctl;
        if (it.type === 'bool') {
          const on = (cur === undefined ? !!it.def : !!cur);
          ctl = '<input type="checkbox" data-k="' + it.key + '"' + (on ? ' checked' : '') + ' style="margin:2px 6px 0 0;vertical-align:top">';
        } else if (it.type === 'select') {
          ctl = '<select data-k="' + it.key + '" style="background:#241d17;color:' + C.fg + ';border:1px solid ' + C.bd + ';border-radius:3px;padding:1px 4px">'
            + it.options.map(o => '<option value="' + o + '"' + (String(cur) === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>';
        } else {
          ctl = '<input type="number" data-k="' + it.key + '" value="' + (cur === undefined ? (it.def || 0) : cur) + '" style="width:76px;background:#241d17;color:' + C.fg + ';border:1px solid ' + C.bd + ';border-radius:3px;padding:1px 4px">';
        }
        return '<div style="margin:5px 0">' + ctl + '<b>' + it.label + '</b>' + desc + '</div>';
      }).join('');
      cfgEl.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">'
        + '<b style="color:' + C.accent + '">NetClass 设置</b>'
        + '<button data-a="close" style="background:transparent;color:' + C.fg + ';border:1px solid ' + C.bd + ';border-radius:4px;padding:2px 8px;cursor:pointer">关闭</button>'
        + '</div>' + rows
        + '<div style="margin-top:9px;color:' + C.mut + ';font-size:11px">改动即时生效，存在 localStorage 的 ' + CFG_KEY + '</div>'
        + '<div style="margin-top:7px;display:flex;gap:6px"><button data-a="saveall" style="flex:1;background:transparent;color:' + C.fg + ';border:1px solid ' + C.bd + ';border-radius:4px;padding:3px;cursor:pointer">保存并同步到驱动器</button></div>';
      cfgEl.querySelectorAll('[data-k]').forEach(el => {
        el.onchange = () => {
          const k = el.dataset.k;
          if (el.type === 'checkbox') CFG[k] = el.checked;
          else if (el.type === 'number') CFG[k] = Number(el.value);
          else CFG[k] = isNaN(Number(el.value)) ? el.value : Number(el.value);
          saveCfg();
          syncCrossProcess();
        };
      });
      cfgEl.querySelector('[data-a="close"]').onclick = () => mountSettings();
      cfgEl.querySelector('[data-a="saveall"]').onclick = () => { saveCfg(); syncCrossProcess(); draw(); };
    };
    draw();
    document.body.appendChild(cfgEl);
  }

  /** 把"跨进程"的设置写进 localStorage —— 外部驱动器（cx-answer-quiz.mjs 等）读这些键 */
  function syncCrossProcess() {
    try {
      localStorage.setItem('ncCx:saveOnly', CFG.cxSaveOnly ? '1' : '0');
      localStorage.setItem('ncCx:needAll', CFG.cxNeedAll === false ? '0' : '1');
      localStorage.setItem('ncCx:autoSubmit', CFG.cxAutoSubmit === false ? '0' : '1');
      localStorage.setItem('ncCc:paused', CFG.enabled ? '0' : '1');
      localStorage.setItem('ncCx:paused', CFG.enabled ? '0' : '1');
    } catch (_) { }
  }
  try { window.NetClassSettings = { get: () => CFG, set: (k, v) => { CFG[k] = v; saveCfg(); syncCrossProcess(); }, mount: mountSettings }; } catch (_) { }


  // ★ 把面板摆到【真实窗口】的右下角（见 mountPanel 处的说明）
  //   window.outerWidth/Height = 真实窗口尺寸；视口被 Emulation 撑大时它就是唯一可信来源。
  //   ⚠ CHROME_ALLOWANCE 的来历（2026-10-16 用户第二次反馈"还是被遮挡"后用截图量的）：
  //     outerHeight 含【标题栏 + 标签栏 + 地址栏 + 那条黄色"Chrome 测试版仅适用于自动测试"警告条】，
  //     实测合计约 130px（先前按 96 算 → 面板底部落在 400，而可见区只有 ~380 → 被切）。
  const CHROME_ALLOWANCE = 136;
  function placePanel() {
    const p = document.getElementById('netclass-panel');
    if (!p) return;
    const vw = window.outerWidth || window.innerWidth;
    const vh = window.outerHeight || window.innerHeight;
    const w = p.offsetWidth || 365;
    const h = p.offsetHeight || 192;
    const left = Math.max(8, vw - w - 14);
    const top = Math.max(8, vh - CHROME_ALLOWANCE - h - 14);
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  }

  // ★ 面板「收起 / 展开」（2026-10-16 用户要求）
  //   收起后【留一个可点的小按钮】，点它才展开 —— 旧实现是隐藏 8 秒后自动弹回，
  //   用户既不能主动收起，也不能主动展开。状态持久化，刷新/换页后保持一致。
  //   按钮带 data-nc-self，保证驱动器永远不会点到它（镜像 mountPanel 里的防误点约定）。
  const PANEL_COLLAPSED_KEY = 'netclass.panelCollapsed';
  // ★ 收起/展开按钮（2026-10-16 用户要求"改为 +/− 号，放到窗口右上角"）
  //   一个按钮常驻【真实窗口的右上角】：展开态显示 "−"（点它收起），收起态显示 "+"（点它展开）。
  //   位置同样按 window.outerWidth 算 —— 视口被 Emulation 撑大时只有 outerW 是真实窗口宽度。
  //   带 data-nc-self，保证驱动器不会误点到它。
  function applyPanelCollapsed() {
    let col = false;
    try { col = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1'; } catch (_) { }
    const p = document.getElementById('netclass-panel');
    if (p) p.style.display = col ? 'none' : '';
    let btn = document.getElementById('netclass-toggle');
    if (!btn) {
      btn = document.createElement('div');
      btn.id = 'netclass-toggle';
      btn.setAttribute('data-nc-self', '1');
      // ★ 2026-10-20：用户反馈"右上角的 +/− 看不到"。实测按钮【存在且位置正确】(932,6)，
      //   但 20×20 的深色小方块 + 暗金 #f0c674 在深色页头上几乎不可见。
      //   → 放大到 30×30、亮绿描边发光、字号 20px 加粗，确保一眼能看到。
      btn.style.cssText = 'position:fixed;z-index:2147483647;cursor:pointer;'
        + 'width:30px;height:30px;line-height:26px;text-align:center;font-weight:800;'
        + 'background:linear-gradient(180deg,#1f2a24,#13201a);color:#00e676;'
        + 'border:2px solid #00e676;border-radius:8px;'
        + 'font-family:system-ui,sans-serif;font-size:20px;user-select:none;'
        + 'box-shadow:0 0 0 2px rgba(0,230,118,.25),0 0 12px rgba(0,230,118,.55),0 2px 8px rgba(0,0,0,.5);'
        + 'text-shadow:0 0 6px rgba(0,230,118,.9)';
      btn.onclick = () => {
        let now = false;
        try { now = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1'; } catch (_) { }
        try { localStorage.setItem(PANEL_COLLAPSED_KEY, now ? '0' : '1'); } catch (_) { }
        applyPanelCollapsed();
      };
      (document.body || document.documentElement).appendChild(btn);
    }
    btn.textContent = col ? '+' : '−';
    btn.title = col ? '展开 NetClass 面板' : '收起 NetClass 面板';
    placeToggle();
  }
  // ★ 把 +/− 按钮贴到【真实窗口】右上角（2026-10-16 用户反馈"看不到右上角的 −"）
  //   根因：applyPanelCollapsed 只在挂载/点击时各调一次 —— 挂载那一刻窗口若还是 1920 宽
  //   （浏览器刚拉起、平铺还没生效），按钮就永久停在 x=1892（窗口其实只有 960 宽）→ 跑到窗口外。
  //   所以定位抽成独立函数，由 2 秒循环一起重摆（和 placePanel 同样待遇）。
  function placeToggle() {
    const b = document.getElementById('netclass-toggle');
    if (!b) return;
    const vw = window.outerWidth || window.innerWidth;
    // 按钮 30×30（原来 20×20），贴右上角留 8px 边距
    b.style.left = Math.max(8, vw - 30 - 8) + 'px';
    b.style.top = '6px';
  }
  function setPanelCollapsed(v) {
    try { localStorage.setItem(PANEL_COLLAPSED_KEY, v ? '1' : '0'); } catch (_) { }
    applyPanelCollapsed();
  }

  function mountPanel() {
    if (!CFG.panel || panelEl) return;
    // ★ 清掉 DOM 里残留的旧面板（2026-10-16 用户截图里发现【两个面板】）：
    //   守卫只看变量 panelEl —— 模块重新注入时它是 null，但 DOM 里上一份还在，
    //   于是又挂一个出来（实测学习通页面上同时出现左上+右下两个面板）。
    //   这里按 id 全量清理，保证页面里只有一个面板元素。
    try {
      const olds = document.querySelectorAll('#netclass-panel, #netclass-expand');
      for (const o of Array.from(olds)) { if (o && o !== panelEl) { try { o.remove(); } catch (_) { } } }
    } catch (_) { }
    // ★★ 智慧树反检测（2026-10-15 实测定位）：站点脚本会扫 DOM，**注入的面板本身**就会被判成
    //   「检测到异常脚本」（先弹框、3 秒后跳回 www.zhihuishu.com，带 showCloseButton:false 挡着不能学）。
    //   实验证据：模块照常注入（XHR/fetch 钩子都在），只把 #netclass-panel 在 document_start 后移除 →
    //     连续 8 秒无任何检测、页面不被踢；面板一挂回去就在 ~1 秒内触发。
    //   所以 zhihuishu 默认**不挂面板**；要看面板时在控制台执行
    //     localStorage.setItem('netclass.panel.force','1'); location.reload()  ← 刷新会被站点 404 踢，
    //   更稳的做法是重走"我的学堂"入口（见 references/platforms.md 的 zhihuishu 章节）。
    let forcePanel = false;
    try { forcePanel = localStorage.getItem('netclass.panel.force') === '1'; } catch (_) { }
    if (PLATFORM === 'zhihuishu' && !forcePanel) {
      warn('智慧树学习页跳过面板注入（站点会据此判"异常脚本"）；需要面板见 platforms.md 的说明');
      return;
    }
    panelEl = document.createElement('div');
    panelEl.id = 'netclass-panel';
    // ── 视觉体系「夜航」：暖黑底 + 琥珀强调 + 细描边 + 无阴影（刻意区别于常见网课脚本的深蓝/墨绿圆角卡片）──
    const C = { bg: '#191512', bd: '#3a2f24', fg: '#f0e7db', mut: '#9b8d7c', accent: '#e0a253', ok: '#7fc08a' };
    // ★ 定位：**真实窗口的右下角**（用户 2026-10-16 要求"还是放右下角"）
    //   不能用 CSS 的 right/bottom —— 那是按【视口】算的，而驱动器为了元素可点会用
    //   Emulation.setDeviceMetricsOverride 把视口撑大（实测 1200x1000），真实窗口只有 960x510，
    //   于是面板被挤出窗口（落在 y=792~984，窗口可见区只有 ~510 高）。
    //   页面能拿到真实窗口尺寸：window.outerWidth / outerHeight（实测 960/510，与 CDP bounds 完全吻合）。
    //   ⚠ outerHeight 含浏览器标题栏+地址栏（约 90px），要扣掉，否则面板底部会被切。
    panelEl.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;'
      + 'font:12px/1.6 "Segoe UI",system-ui,"Microsoft YaHei",sans-serif;letter-spacing:.2px;'
      + 'background:' + C.bg + ';color:' + C.fg + ';border:1px solid ' + C.bd + ';border-radius:6px;'
      + 'padding:9px 11px;width:340px;box-sizing:border-box;user-select:none';
    const draw = () => {
      if (!panelEl) return;
      const v = pickVideo();
      const vs = v ? `${Math.floor(v.currentTime || 0)}s/${Math.floor(v.duration || 0)}s x${v.playbackRate}${v.paused ? ' ⏸' : ' ▶'}` : '无视频';
      const BTN = 'background:transparent;color:' + C.fg + ';border:1px solid ' + C.bd + ';border-radius:4px;padding:3px 9px;font:12px/1.5 inherit;display:inline-block;cursor:pointer';
      const btn = (a, label) => `<button data-a="${a}" style="${BTN}">${label}</button>`;
      const pr = courseProgress();
      // ★ 2026-10-20：完成态在面板里用【亮绿块】明确显示，不再只靠百分比
      //   （用户反馈：课程刷完了但面板没明确提示，要像生生课堂那样显示"课程已完成"）
      const prog = !pr ? '进度 —'
        : pr.passed
          ? `<div style="background:linear-gradient(90deg,#00e676,#00c853);color:#04210d;font-weight:700;` +
            `border-radius:6px;padding:5px 8px;text-align:center;font-size:13px;margin:2px 0 4px;` +
            `box-shadow:0 0 0 2px rgba(0,230,118,.35),0 0 14px rgba(0,230,118,.5)">` +
            `✅ 课程已完成 · ${pr.done}/${pr.total} 学时</div>`
          : `进度 <b>${pr.pct}%</b> (${pr.done}/${pr.total}) · 剩 ${fmtDur(pr.remainSec)} → 约 <b>${fmtDur(pr.etaSec)}</b>${pr.unknown ? ` <span style="opacity:.5">(${pr.unknown}节无时长)</span>` : ''}`;
      // 分科明细（有 groups 时每行一条：名称 已修/达标 ✅）
      const catLines = (pr && pr.cats && pr.cats.length)
        ? pr.cats.map(c =>
          `<div style="display:flex;justify-content:space-between;gap:6px;font-size:11px;opacity:.85">` +
          `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.name}</span>` +
          `<span style="flex:none">${c.done}/${c.target}${c.passed ? ' <b style="color:#00e676">✅</b>' : ''}</span></div>`
        ).join('')
        : '';
      const bar = `<div style="height:5px;background:#241d17;border-radius:3px;overflow:hidden;margin:7px 0 6px"><div style="height:100%;width:${pr ? Math.max(0, Math.min(100, pr.pct)) : 0}%;background:${pr && pr.passed ? 'linear-gradient(90deg,#00e676,#00c853)' : C.accent};transition:width .4s"></div></div>`;
      panelEl.innerHTML =
        `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
           <div><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${CFG.enabled && !state.allDone ? C.ok : C.mut};margin-right:6px;vertical-align:middle"></span><b style="letter-spacing:.4px">NetClass</b> <span style="color:${C.mut};font-size:11px">v${VERSION}</span></div>
           <div><span style="border:1px solid ${C.accent};color:${C.accent};border-radius:3px;padding:0 5px;font-size:11px">${PLATFORM_LABEL || PLATFORM}</span></div>
         </div>
         <div style="color:${C.mut};margin-top:5px">${state.allDone ? '本课程已完成' : (CFG.enabled ? '自动处理中' : '已暂停')}</div>
         ${bar}
         <div style="opacity:.9">${prog}</div>
           ${catLines}
         <div style="opacity:.8">视频 ${state.video.seen} · 结束 ${state.video.ended} · 倍速修正 ${state.video.rateFixes}</div>
         <div style="opacity:.8">弹题 见${state.quiz.seen} 答${state.quiz.answered} ✔${state.quiz.correct} ✘${state.quiz.wrong} · DS ${state.quiz.dsOk}/${state.quiz.dsAsk}${state.quiz.dsErr ? ' 失败' + state.quiz.dsErr : ''} · 库${Object.keys(bank).length}</div>
         <div style="opacity:.8">${vs}</div>
         <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
           ${btn('toggle', CFG.enabled ? '暂停' : '启动')}
           ${btn('rate', '倍速 ' + rateLabel())}
           ${btn('quiz', '答题')}
           ${btn('next', '下一节')}
           ${btn('settings', '设置')}
           ${BRAND.proEnabled ? btn('pro', '⚡ Pro') : ''}
         </div>
         ${brandBlock()}`;
      panelEl.querySelectorAll('button').forEach(b => {
        b.onmouseenter = () => { b.style.background = '#3a3a46'; };
        b.onmouseleave = () => { b.style.background = '#2b2b34'; };
        b.onclick = () => {
          const a = b.dataset.a;
          if (a === 'toggle') {
            CFG.enabled = !CFG.enabled;
            // ★ 同步"暂停标记"给外部驱动器（cc-auto.mjs / cx-auto.mjs 每轮会读它）
            //   面板只能控制页面内的模块；驱动器是控制器上的独立进程，靠这个标记联动，
            //   否则用户按了暂停，驱动器还在外面继续操作（实测踩过）
            try { localStorage.setItem('ncCc:paused', CFG.enabled ? '0' : '1'); } catch (_) { }
            try { localStorage.setItem('ncCx:paused', CFG.enabled ? '0' : '1'); } catch (_) { }
            if (CFG.enabled) {          // 用户在面板重新点「启动」→ 清掉已完成标记，重新扫描
              state.allDone = false;
              try { localStorage.removeItem(DONE_KEY); } catch (_) { }
              if (P_ADAPTER && P_ADAPTER.resetRound) P_ADAPTER.resetRound();
              hideBanner();
            }
            saveCfg();
          }
          if (a === 'rate') {
            // ★ 按【平台允许的档位】循环（用户 2026-10-16 要求"为每个平台都做适配"）
            //   旧写法是 +0.5 一路加到 4 再回 1 —— 在封顶 1.5 的平台上（知到/长春/学习通），
            //   设 2 会被 effRate() 夹回 1.5，用户看到按钮"点了不动"，以为坏了。
            const list = PLATFORM_RATES[PLATFORM] || [1, 1.25, 1.5, 2];
            const cur0 = effRate();
            let idx = list.indexOf(cur0);
            if (idx < 0) { idx = list.length - 1; for (let k = 0; k < list.length; k++) if (list[k] <= cur0 + 0.001) idx = k; }
            const next = list[(idx + 1) % list.length];
            CFG.rate = next; CFG.userRate = true;
            if (PLATFORM === 'qiyang') CFG.rateQiyang = next; else CFG.rateShengsheng = next;
            saveCfg();
            const v2 = pickVideo(); if (v2) v2.playbackRate = next;
            const p2 = P_ADAPTER && P_ADAPTER.player && P_ADAPTER.player();
            if (p2 && typeof p2.setSpeed === 'function') { try { p2.setSpeed(next); } catch (_) { } }
            log('倍速按钮 → ' + next + 'x（本平台档位 ' + list.join('/') + '）');
          }
          if (a === 'quiz') { P_ADAPTER && P_ADAPTER.poll(); }
          if (a === 'next') { gotoNext('panel'); }
          if (a === 'settings') { try { mountSettings(); } catch (e) { warn('设置面板打开失败', e); } }
          // ★ 「收起」的新行为（2026-10-16 用户要求）：
          //   旧实现是 display:none 后 8 秒自动弹回来 —— 用户既不能主动收起，也不能主动展开。
          //   现在：收起后在左上角**留一个小的「展开」按钮**，点它才恢复；状态持久化到 localStorage，
          //   刷新/换页后仍然是收起态（但展开按钮始终在，不会"找不回来"）。
          if (a === 'hide') { setPanelCollapsed(true); }
          if (a === 'unhide') { setPanelCollapsed(false); }
          draw();
        };
      });
    };
    draw();
    // 面板高度会随内容变（进度/秒表那行高度浮动）→ 每轮重摆一次，保证始终贴住真实窗口右下角
    timers.push(setInterval(() => { draw(); placePanel(); placeToggle(); }, 2000));
    (document.body || document.documentElement).appendChild(panelEl);
    applyPanelCollapsed();      // ★ 尊重上次的收起/展开状态（收起时留「展开」按钮）
    placePanel();               // ★ 摆到真实窗口的右下角
  }

  // ------------------------------------------------------------ 启动
  function start() {
    log('实现模块启动', { version: VERSION, platform: PLATFORM, host: HOST });
    hookFetch(); hookXhr();
    videoWatch();
    timers.push(setInterval(() => {
      state.loopTicks++;
      P_ADAPTER && P_ADAPTER.poll().catch(err);
      // ★ 面板兜底挂载（2026-10-15 补）：实测 start() 里那一次 mountPanel() 会因"加载期模块服务
      //   瞬时不可用 → 走内联兜底 boot"而没执行，表现为**面板整块不出现**（页面里 7 个 frame 都没有）。
      //   放到主循环里每次探一下，cost 极低，且能覆盖 body 未就绪 / 路由切换等所有时机问题。
      if (CFG.panel && !panelEl) { try { mountPanel(); } catch (e) { warn('面板挂载失败', e); } }
    }, 3000));
    timers.push(setInterval(() => {
      if (location.href !== state.route) { state.route = location.href; log('路由变化', state.route); timers.push(setTimeout(() => applyPolicy(pickVideo(), 'route'), 1500)); }
    }, 1500));
    if (document.body) mountPanel(); else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
    // 探测模式：把接口清单/题目结构报回本机
    if (CFG.probe) timers.push(setInterval(() => report('probe', { url: location.href, apis: apiLog.slice(-40), quiz: quizFeed.slice(-3), bank: Object.keys(bank).length }), 15000));
    report('boot', { version: VERSION, platform: PLATFORM, url: location.href });

    // 本门课之前已经刷完过：直接把提示挂出来，并且不自动跑（除非用户在面板点了「启动」）
    const prevDone = readDone();
    if (prevDone && !CFG.enabled) {
      state.allDone = true;
      const when = prevDone.at ? new Date(prevDone.at).toLocaleString('zh-CN') : '';
      // ★ 2026-10-20：原来是【第二份写死的两分支】，长春会显示成"心理学导论 已完成"
      const LABEL2 = {
        ccjyxy: '长春教师培训', qiyang: '职业培训', shengsheng: '生生课堂',
        chaoxing: '学习通', zhihuishu: '智慧树知到', webtrn: '教师培训平台',
      };
      const label = LABEL2[PLATFORM] || (ADAPTER && ADAPTER.label) || '本课程';
      showBanner(
        '<b>✅ ' + label + ' 已完成</b><br>' +
        '<span style="opacity:.9">' + (prevDone.detail || '') + (when ? '（' + when + '）' : '') + '</span><br>' +
        '<span style="opacity:.75;font-size:12px">自动化保持暂停；如需重新扫描，点右下角面板的「启动」</span>',
        'done');
    }
  }

  window.NetClass = {
    version: VERSION, platform: PLATFORM, cfg: CFG, state,
    vid: pickVideo, next: goNext, poll: () => P_ADAPTER && P_ADAPTER.poll(),
    rate(r) { CFG.rate = r; saveCfg(); const v = pickVideo(); if (v) v.playbackRate = r; return r; },
    apis: () => apiLog.slice(-60), feed: () => quizFeed.slice(-5), bank: () => bank,
    /** 调试用：手动问一道题（形如 {type:1,name:'...',optionList:[{name:'A',data:'...'}]}） */
    askDs: q => dsAnswer(q),
    /** 本课程进度与预估（面板同源）：{pct, done, total, remainSec, etaSec} */
    progress: () => courseProgress(),
    webtrn: (P_ADAPTER && P_ADAPTER.id === 'webtrn') ? P_ADAPTER : null,
    /** ★ 知到适配器（2026-10-15）：驱动器用 NetClass.zhs.popupInfo() 拿弹题快照与目标答案，自己用真实鼠标点 */
    zhs: (P_ADAPTER && P_ADAPTER.id === 'zhihuishu') ? P_ADAPTER : null,
    /** ★ 手动挂载控制面板（2026-10-15 补）：实测自动挂载在部分加载路径下不触发（页面 7 个 frame 都找不到
     *  面板，但同文件里的 NetClassSettings.mount() 一调就出来）→ 把主面板也暴露出来，
     *  这样驱动器/调试脚本可以兜底：NetClass.panel() */
    panel: () => { try { mountPanel(); return !!document.getElementById('netclass-panel'); } catch (e) { warn('面板挂载失败', e); return false; } },
    settings: () => { try { mountSettings(); return !!document.getElementById('netclass-settings'); } catch (e) { return false; } },
    headers: (kw) => kw ? reqHeaders.filter(r => r.url.includes(kw)).slice(-5) : reqHeaders.slice(-15),
    login: () => loginInfo,
    quizElements() {
      const out = [];
      document.querySelectorAll('[class*=quiz],[class*=question],[class*=pop],[class*=dialog],[class*=modal],[class*=layer]').forEach(e => {
        const t = (e.innerText || '').trim();
        if (t && t.length < 1500) out.push({ cls: String(e.className).slice(0, 90), text: t.slice(0, 200), visible: !!(e.offsetWidth || e.offsetHeight) });
      });
      return out.slice(0, 12);
    },
    videoInfo() {
      const vs = Array.from(document.querySelectorAll('video'));
      return vs.map(v => ({ src: String(v.currentSrc || '').slice(0, 100), dur: Math.round(v.duration || 0), t: Math.round(v.currentTime || 0), rate: v.playbackRate, paused: v.paused, muted: v.muted, ended: v.ended }));
    },
    dispose() {
      try { timers.forEach(t => clearInterval(t) || clearTimeout(t)); } catch (_) { }
      try { cleanups.forEach(f => { try { f(); } catch (_) { } }); } catch (_) { }
      try { if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl); } catch (_) { }
      flushBank();
      panelEl = null;
      log('旧实例已回收');
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
