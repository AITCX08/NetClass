/* NetClass 实现模块（由网课壳热加载）
 * 目标站点：edu.shengshengketang.com / study.bjqiyang.com
 * 职责：视频自动播放·静音·倍速·掉速纠正·结束自动下一节；随堂弹题自动作答；本地题库；控制面板。
 * 约束：只做页面内的正常播放与页面自身表单作答；不伪造学时、不代考、不绕过验证码/人脸/短信。
 * 接口（供壳热重载与外部控制端调用）：
 *   window.NetClass = { version, platform, cfg, state, dispose(), ... }
 */
(function () {
  'use strict';

  // 热重载时先回收上一个实例
  try { window.NetClass && window.NetClass.dispose && window.NetClass.dispose(); } catch (_) { }

  const VERSION = '0.4.0';
  const NS = '[NetClass]';
  const HOST = location.hostname;
  const PLATFORM = /shengshengketang/i.test(HOST) ? 'shengsheng'
    : /bjqiyang/i.test(HOST) ? 'qiyang' : 'unknown';
  const log = (...a) => console.log(NS, ...a);
  const warn = (...a) => console.warn(NS, ...a);
  const now = () => Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ------------------------------------------------------------ 配置
  const DEFAULTS = {
    enabled: true, autoPlay: true, mute: true, rate: 1, autoNext: true, autoQuiz: true,
    quizDelayMs: 700, antiPause: true, panel: true, report: false,
    userRate: false, rateQiyang: 2, rateShengsheng: 1.5,
    reportBase: 'http://192.168.1.6:17999', probe: false
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
    quiz: { seen: 0, answered: 0, correct: 0, wrong: 0, bankHit: 0, bankMiss: 0 },
    next: { clicks: 0, misses: 0 }, errors: [], route: location.href
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
    window.fetch = hooked;
    cleanups.push(() => { if (window.fetch === hooked) window.fetch = of; });
  }
  function hookXhr() {
    const OX = window.XMLHttpRequest;
    if (!OX || OX.prototype.__ncHooked) return;
    const open = OX.prototype.open, send = OX.prototype.send, setH = OX.prototype.setRequestHeader;
    OX.prototype.open = function (m, u) { this.__ncUrl = u; this.__ncHeaders = {}; return open.apply(this, arguments); };
    OX.prototype.setRequestHeader = function (k, v) {
      try { this.__ncHeaders = this.__ncHeaders || {}; this.__ncHeaders[k] = String(v); } catch (_) { }
      return setH.apply(this, arguments);
    };
    OX.prototype.send = function () {
      try { if (this.__ncUrl && this.__ncHeaders && Object.keys(this.__ncHeaders).length) recordHeaders(this.__ncUrl, this.__ncHeaders); } catch (_) { }
      this.addEventListener('load', () => {
        try {
          const u = this.__ncUrl || '';
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

  // ------------------------------------------------------------ 作答启发
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
    if (CFG.userRate) return CFG.rate;
    return PLATFORM === 'qiyang' ? (CFG.rateQiyang || 2) : (CFG.rateShengsheng || 1.5);
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
    if (!v || mediaReady(v) || !v.paused) return false;
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
      }
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
        if (CFG.autoNext) timers.push(setTimeout(() => gotoNext('ended-state'), 1500));
      }
      if (!v.__ncSeen) {
        v.__ncSeen = now(); state.video.seen++;
        log('发现视频', { dur: Math.round(v.duration || 0), src: String(v.currentSrc || '').slice(0, 60) });
        v.addEventListener('ended', () => {
          state.video.ended++; log('视频结束 #' + state.video.ended);
          report('video-ended', { url: location.href, count: state.video.ended });
          if (CFG.autoNext) timers.push(setTimeout(() => gotoNext('ended'), 2000));
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
    const status = el => (el.querySelector('.lesson-status-container') || el).innerText || '';
    const isDone = el => /已完成/.test(status(el));
    // 当前课次识别：站点用 .active-lesson；退而求其次看文案/上次记录
    let curIdx = items.findIndex(el => /active-lesson|current-lesson/.test(el.className));
    if (curIdx < 0) curIdx = items.findIndex(el => /观看中/.test(status(el)));
    if (curIdx < 0 && goNext.__lastIdx != null && goNext.__lastIdx < items.length) curIdx = goNext.__lastIdx;
    if (curIdx >= 0) { goNext.__lastIdx = curIdx; state.currentLesson = (items[curIdx].innerText || '').replace(/\s+/g, ' ').slice(0, 40); }
    for (let i = curIdx + 1; i < items.length; i++) {
      if (!isDone(items[i])) { log('下一节 ->', (items[i].innerText || '').replace(/\s+/g, ' ').slice(0, 40)); state.next.clicks++; items[i].click(); return true; }
    }
    for (let i = 0; i < items.length; i++) {
      if (!isDone(items[i]) && i !== curIdx) { log('回到首个未完成 ->', (items[i].innerText || '').replace(/\s+/g, ' ').slice(0, 40)); state.next.clicks++; items[i].click(); return true; }
    }
    state.next.misses++; warn('目录里没有未完成项'); report('next-none', { url: location.href });
    return false;
  }

  // ------------------------------------------------------------ 平台适配
  function matchByText(txt, maxLen = 600) {
    const els = document.querySelectorAll('div,section,aside,form');
    for (const el of els) { const t = el.innerText || ''; if (t.length < maxLen && t.includes(txt)) return el; }
    return null;
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
    async poll() {
      if (!CFG.enabled) return;

      // 1) 弹题优先：随堂题弹窗会挡住播放器，必须先答掉，不能再去做别的动作
      const box = CFG.autoQuiz ? this.box() : null;
      if (box) {
        await this.answerQuiz(box).catch(err);
        return;
      }

      // 2) 没有视频 → 进入未完成课时（重试逻辑内部自带节流）
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

      const g = guess(q);
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
      const ordered = idx >= 0
        ? [...items.slice(idx + 1), ...items.slice(0, idx)]
        : items.slice();
      const next = ordered.find(x => !x.live && !done.includes(x.id));
      if (next) { log('qiyang 下一章 ->', next.name, '（本轮已过 ' + done.length + '/' + items.length + '）'); return this.goChapter(next); }
      log('qiyang 录播章节本轮已全部过一遍（' + items.length + ' 章），停止跳转');
      report('qiyang-round-done', { url: location.href, total: items.length, visited: done.length });
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
            this.markDone((location.href.match(/goodscourses_id=(\d+)/) || [])[1]);
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

  const P_ADAPTER = PLATFORM === 'shengsheng' ? ADAPTER_SHENGSHENG : PLATFORM === 'qiyang' ? ADAPTER_QIYANG : null;

  // ------------------------------------------------------------ 控制面板
  let panelEl = null;
  function mountPanel() {
    if (!CFG.panel || panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 'netclass-panel';
    panelEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;font:12px/1.65 "Segoe UI",system-ui,"Microsoft YaHei",sans-serif;background:rgba(18,18,22,.92);color:#eaeaea;border-radius:10px;padding:8px 10px;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,.4);user-select:none';
    const draw = () => {
      if (!panelEl) return;
      const v = pickVideo();
      const vs = v ? `${Math.floor(v.currentTime || 0)}s/${Math.floor(v.duration || 0)}s x${v.playbackRate}${v.paused ? ' ⏸' : ' ▶'}` : '无视频';
      panelEl.innerHTML =
        `<div style="font-weight:600">NetClass ${VERSION} <span style="opacity:.55">${PLATFORM}</span> <span style="opacity:.55">${CFG.enabled ? '运行' : '暂停'}</span></div>
         <div style="opacity:.8">视频 ${state.video.seen} · 结束 ${state.video.ended} · 倍速修正 ${state.video.rateFixes}</div>
         <div style="opacity:.8">弹题 见${state.quiz.seen} 答${state.quiz.answered} ✔${state.quiz.correct} ✘${state.quiz.wrong} 库${Object.keys(bank).length}</div>
         <div style="opacity:.8">${vs}</div>
         <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
           <button data-a="toggle">${CFG.enabled ? '暂停' : '启动'}</button>
           <button data-a="rate">倍速 ${CFG.rate}x</button>
           <button data-a="quiz">答题</button>
           <button data-a="next">下一节</button>
           <button data-a="hide">收起</button>
         </div>`;
      panelEl.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          const a = b.dataset.a;
          if (a === 'toggle') { CFG.enabled = !CFG.enabled; saveCfg(); }
          if (a === 'rate') {
            CFG.rate = CFG.rate >= 4 ? 1 : +(CFG.rate + 0.5).toFixed(1); CFG.userRate = true; saveCfg();
            const v2 = pickVideo(); if (v2) v2.playbackRate = CFG.rate;
            const p2 = P_ADAPTER && P_ADAPTER.player && P_ADAPTER.player();
            if (p2 && typeof p2.setSpeed === 'function') { try { p2.setSpeed(CFG.rate); } catch (_) { } }
          }
          if (a === 'quiz') { P_ADAPTER && P_ADAPTER.poll(); }
          if (a === 'next') { gotoNext('panel'); }
          if (a === 'hide') { panelEl.style.display = 'none'; setTimeout(() => { if (panelEl) panelEl.style.display = ''; }, 8000); }
          draw();
        };
      });
    };
    draw();
    timers.push(setInterval(draw, 2000));
    (document.body || document.documentElement).appendChild(panelEl);
  }

  // ------------------------------------------------------------ 启动
  function start() {
    log('实现模块启动', { version: VERSION, platform: PLATFORM, host: HOST });
    hookFetch(); hookXhr();
    videoWatch();
    timers.push(setInterval(() => { state.loopTicks++; P_ADAPTER && P_ADAPTER.poll().catch(err); }, 3000));
    timers.push(setInterval(() => {
      if (location.href !== state.route) { state.route = location.href; log('路由变化', state.route); timers.push(setTimeout(() => applyPolicy(pickVideo(), 'route'), 1500)); }
    }, 1500));
    if (document.body) mountPanel(); else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
    // 探测模式：把接口清单/题目结构报回本机
    if (CFG.probe) timers.push(setInterval(() => report('probe', { url: location.href, apis: apiLog.slice(-40), quiz: quizFeed.slice(-3), bank: Object.keys(bank).length }), 15000));
    report('boot', { version: VERSION, platform: PLATFORM, url: location.href });
  }

  window.NetClass = {
    version: VERSION, platform: PLATFORM, cfg: CFG, state,
    vid: pickVideo, next: goNext, poll: () => P_ADAPTER && P_ADAPTER.poll(),
    rate(r) { CFG.rate = r; saveCfg(); const v = pickVideo(); if (v) v.playbackRate = r; return r; },
    apis: () => apiLog.slice(-60), feed: () => quizFeed.slice(-5), bank: () => bank,
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
