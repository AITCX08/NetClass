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

  const P_ADAPTER = PLATFORM === 'shengsheng' ? ADAPTER_SHENGSHENG : PLATFORM === 'qiyang' ? ADAPTER_QIYANG : null;

  // ------------------------------------------------------------ 收工：全部刷完
  const DONE_KEY = 'netclass.done.' + PLATFORM;
  function readDone() { try { return JSON.parse(localStorage.getItem(DONE_KEY) || 'null'); } catch (_) { return null; } }

  /** 明显的横幅提示（面板之外的独立元素，不容易被忽略）；带关闭按钮，可收起 */
  let bannerEl = null;
  function showBanner(html, tone) {
    try {
      if (bannerEl) bannerEl.remove();
      bannerEl = document.createElement('div');
      bannerEl.id = 'netclass-banner';
      const bg = tone === 'done' ? 'linear-gradient(90deg,#0f5132,#1b7a4b)'
        : tone === 'warn' ? 'linear-gradient(90deg,#5a3a0a,#8a5a12)'
          : 'linear-gradient(90deg,#1e3a5f,#2b5286)';
      bannerEl.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;' +
        'font:14px/1.7 "Segoe UI",system-ui,"Microsoft YaHei",sans-serif;color:#fff;background:' + bg + ';' +
        'padding:10px 40px 10px 22px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:88vw;text-align:center;user-select:none';
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
      // 30 秒后自动收起（仍在面板上能看到状态）
      timers.push(setTimeout(() => { if (bannerEl) hideBanner(); }, 30000));
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
    showBanner(
      '<b>✅ ' + (PLATFORM === 'qiyang' ? '职业培训' : '心理学导论') + ' 已全部完成</b><br>' +
      '<span style="opacity:.9">' + msg + ' —— 自动化已暂停，播放已停止</span><br>' +
      '<span style="opacity:.75;font-size:12px">如需重新扫描，点右下角面板的「启动」</span>'
      , 'done');
    return true;
  }

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
      const BTN = 'background:#2b2b34;color:#eaeaea;border:1px solid #4d4d5a;border-radius:5px;padding:3px 9px;font:12px/1.5 inherit;display:inline-block;cursor:pointer';
      const btn = (a, label) => `<button data-a="${a}" style="${BTN}">${label}</button>`;
      panelEl.innerHTML =
        `<div style="font-weight:600">NetClass ${VERSION} <span style="opacity:.55">${PLATFORM}</span> <span style="opacity:.55;color:${state.allDone ? '#6ee7a8' : 'inherit'}">${state.allDone ? '已完成' : (CFG.enabled ? '运行' : '暂停')}</span></div>
         <div style="opacity:.8">视频 ${state.video.seen} · 结束 ${state.video.ended} · 倍速修正 ${state.video.rateFixes}</div>
         <div style="opacity:.8">弹题 见${state.quiz.seen} 答${state.quiz.answered} ✔${state.quiz.correct} ✘${state.quiz.wrong} 库${Object.keys(bank).length}</div>
         <div style="opacity:.8">${vs}</div>
         <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
           ${btn('toggle', CFG.enabled ? '暂停' : '启动')}
           ${btn('rate', '倍速 ' + effRate() + 'x')}
           ${btn('quiz', '答题')}
           ${btn('next', '下一节')}
           ${btn('hide', '收起')}
         </div>`;
      panelEl.querySelectorAll('button').forEach(b => {
        b.onmouseenter = () => { b.style.background = '#3a3a46'; };
        b.onmouseleave = () => { b.style.background = '#2b2b34'; };
        b.onclick = () => {
          const a = b.dataset.a;
          if (a === 'toggle') {
            CFG.enabled = !CFG.enabled;
            if (CFG.enabled) {          // 用户在面板重新点「启动」→ 清掉已完成标记，重新扫描
              state.allDone = false;
              try { localStorage.removeItem(DONE_KEY); } catch (_) { }
              if (P_ADAPTER && P_ADAPTER.resetRound) P_ADAPTER.resetRound();
              hideBanner();
            }
            saveCfg();
          }
          if (a === 'rate') {
            CFG.rate = effRate() >= 4 ? 1 : +(effRate() + 0.5).toFixed(1); CFG.userRate = true; saveCfg();
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

    // 本门课之前已经刷完过：直接把提示挂出来，并且不自动跑（除非用户在面板点了「启动」）
    const prevDone = readDone();
    if (prevDone && !CFG.enabled) {
      state.allDone = true;
      const when = prevDone.at ? new Date(prevDone.at).toLocaleString('zh-CN') : '';
      const label = PLATFORM === 'qiyang' ? '职业培训' : '心理学导论';
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
