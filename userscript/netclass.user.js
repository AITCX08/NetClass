// ==UserScript==
// @name         NetClass 网课自动处理
// @namespace    taskmesh.local/netclass
// @version      0.2.0
// @description  两站自适应：自动播放 / 静音 / 倍速 / 自动下一节 / 随堂弹题自动作答 / 作业页提示。自研实现，无第三方题库、无卡密、不上传题目。
// @author       TaskMesh
// @match        https://edu.shengshengketang.com/*
// @match        https://study.bjqiyang.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// ==/UserScript==

/* ===========================================================================
 * 结构
 *   0. 通用工具 / 配置
 *   1. 网络观察层：被动解析页面自己的接口响应（含随堂练习题目）
 *   2. 本地题库：命中即答；未命中记录为待办（可选送到本机 17999 汇总）
 *   3. 通用视频控制：播放 / 静音 / 倍速 / 结束检测 / 掉速纠正
 *   4. 平台适配：shengsheng（已知接口）/ qiyang（探测式）
 *   5. 控制面板 + 快捷键
 *   6. 自检与上报
 * 说明：本脚本只做页面内的正常播放与页面自身表单作答，不伪造学习时长、
 *       不代考、不绕过验证码/人脸/短信；遇到这类页面一律停下来提示本人。
 * =========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 0. 基础
  const VERSION = '0.2.0';
  const NS = '[NetClass]';
  const HOST = location.hostname;
  const PLATFORM = /shengshengketang/i.test(HOST) ? 'shengsheng'
    : /bjqiyang/i.test(HOST) ? 'qiyang' : 'unknown';

  const log = (...a) => console.log(NS, ...a);
  const warn = (...a) => console.warn(NS, ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();

  const DEFAULTS = {
    enabled: true,
    autoPlay: true,
    mute: true,
    rate: 2,
    autoNext: true,
    autoQuiz: true,
    quizDelayMs: 800,
    wrongRetry: true,
    maxRetryPerVideo: 3,
    antiPauseReplay: true,
    report: false,           // 是否把探测/待办 POST 到本机汇总端口
    reportBase: 'http://192.168.1.6:17999',
    panel: true
  };
  const CFG_KEY = 'netclass.cfg.v2';
  function loadCfg() {
    try {
      const raw = (typeof GM_getValue === 'function') ? GM_getValue(CFG_KEY, null) : localStorage.getItem(CFG_KEY);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
    } catch { return { ...DEFAULTS }; }
  }
  function saveCfg(cfg) {
    try {
      const s = JSON.stringify(cfg);
      if (typeof GM_setValue === 'function') GM_setValue(CFG_KEY, s); else localStorage.setItem(CFG_KEY, s);
    } catch (_) { }
  }
  const CFG = loadCfg();

  const state = {
    version: VERSION,
    platform: PLATFORM,
    startedAt: now(),
    video: { seen: 0, ended: 0, rateFixes: 0, lastEndedAt: 0 },
    quiz: { seen: 0, answered: 0, correct: 0, wrong: 0, bankHit: 0, bankMiss: 0, pending: 0 },
    lastError: null,
    route: location.href
  };
  window.__NETCLASS_STATE__ = state;   // 供控制端读取
  window.__NETCLASS_READY__ = true;

  function report(kind, payload) {
    if (!CFG.report) return;
    try {
      const body = JSON.stringify({ platform: PLATFORM, host: HOST, kind, at: now(), payload });
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({ method: 'POST', url: CFG.reportBase + '/ingest', headers: { 'Content-Type': 'application/json' }, data: body, timeout: 5000 });
      } else {
        fetch(CFG.reportBase + '/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => { });
      }
    } catch (_) { }
  }

  // ------------------------------------------------- 1. 网络观察层（被动）
  const netLog = [];
  const quizFeed = [];      // 页面自己拿到的随堂题目
  const apiLog = [];        // 便于适配未见过的新接口

  function looksLikeQuiz(body) {
    if (!body || typeof body !== 'object') return false;
    const s = JSON.stringify(body).slice(0, 4000);
    return /"question"|"optionList"|"popQuizId"|"isMustRight"|"questionId"/.test(s);
  }
  function rememberQuiz(body, url) {
    try {
      const data = body && body.data;
      const items = [];
      if (Array.isArray(data)) items.push(...data);
      else if (data && Array.isArray(data.list)) items.push(...data.list);
      else if (data && data.question) items.push(data);
      else if (data && data.id && data.question) items.push(data);
      for (const it of items) {
        if (it && it.question) { quizFeed.push({ at: now(), url, item: it }); }
      }
      if (items.length) log('捕获随堂题目', items.length, '来自', url);
    } catch (_) { }
  }

  function hookNetwork() {
    // fetch
    const of = window.fetch;
    if (of && !of.__netclassHooked) {
      const hooked = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        return of.apply(this, arguments).then(res => {
          try {
            const ct = res.headers && res.headers.get && res.headers.get('content-type') || '';
            if (/json/i.test(ct) && url) {
              res.clone().json().then(b => {
                apiLog.push({ at: now(), url: url.slice(0, 300), keys: b && typeof b === 'object' ? Object.keys(b).slice(0, 12) : null });
                if (looksLikeQuiz(b)) rememberQuiz(b, url);
              }).catch(() => { });
            }
          } catch (_) { }
          return res;
        });
      };
      hooked.__netclassHooked = true;
      window.fetch = hooked;
    }
    // XHR
    const OX = window.XMLHttpRequest;
    if (OX && !OX.prototype.__netclassHooked) {
      const open = OX.prototype.open, send = OX.prototype.send;
      OX.prototype.open = function (m, u) { this.__ncUrl = u; return open.apply(this, arguments); };
      OX.prototype.send = function () {
        this.addEventListener('load', () => {
          try {
            const u = this.__ncUrl || '';
            const ct = this.getResponseHeader && this.getResponseHeader('content-type') || '';
            if (/json/i.test(ct) && u) {
              const b = JSON.parse(this.responseText);
              apiLog.push({ at: now(), url: String(u).slice(0, 300), keys: b && typeof b === 'object' ? Object.keys(b).slice(0, 12) : null });
              if (looksLikeQuiz(b)) rememberQuiz(b, String(u));
            }
          } catch (_) { }
        });
        return send.apply(this, arguments);
      };
      OX.prototype.__netclassHooked = true;
    }
    log('网络观察层已挂载');
  }

  // --------------------------------------------------------- 2. 本地题库
  // 只存本机：正确/错误答案都记下来，下次同题直接命中。不上传、不查询第三方。
  const BANK_KEY = 'netclass.bank.v2';
  let bank = (() => {
    try {
      const raw = (typeof GM_getValue === 'function') ? GM_getValue(BANK_KEY, null) : localStorage.getItem(BANK_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  })();
  let bankDirty = 0;
  function bankKey(q) {
    const name = (q && (q.name || q.title || '')).replace(/[\s\u3000]+/g, '');
    if (name) return 'q:' + name.slice(0, 200);
    return 'h:' + hash32(JSON.stringify(q && q.optionList || q || {}));
  }
  function hash32(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function bankGet(q) { const k = bankKey(q); const v = bank[k]; if (v && v.answer) { return v.answer; } return null; }
  function bankPut(q, answer, correct) {
    const k = bankKey(q);
    const cur = bank[k] || { name: (q && q.name || '').slice(0, 300), type: q && q.type, tries: 0, hits: 0 };
    cur.answer = answer; cur.correct = !!correct; cur.tries = (cur.tries || 0) + 1; cur.at = now();
    bank[k] = cur; bankDirty++;
    if (bankDirty % 5 === 0) flushBank();
    return cur;
  }
  function flushBank() { try { const s = JSON.stringify(bank); if (typeof GM_setValue === 'function') GM_setValue(BANK_KEY, s); else localStorage.setItem(BANK_KEY, s); } catch (_) { } }
  setInterval(flushBank, 15000);

  /** 从选项文本里做本地启发式作答（只用于「页面自己要求作答」的随堂练习） */
  function guessAnswer(q) {
    const opts = (q && q.optionList) || [];
    const texts = opts.map(o => ({ name: o.name, data: String(o.data || '').trim() }));
    if (!texts.length) return { answer: '', why: 'no-options', confidence: 0 };

    const known = bankGet(q);
    if (known) { state.quiz.bankHit++; return { answer: known, why: 'bank', confidence: 1 }; }
    state.quiz.bankMiss++;

    // 判断题：选项通常是 正确/错误、对/错、A/B
    if (q.type === 3) {
      const byName = {}; texts.forEach(t => byName[t.name] = t.data);
      for (const [n, d] of Object.entries(byName)) {
        if (/^(正确|对|是|true|√)$/i.test(d)) return { answer: n, why: 'judge-true', confidence: 0.6 };
      }
      return { answer: '', why: 'judge-unknown', confidence: 0 };
    }

    // 单选/多选：绝对化词是错误项的特征；含「以上/都」常为正确项
    const score = t => {
      let s = 0;
      if (/以上|全都|都是|均|都正确|以上都/.test(t)) s += 2;
      if (/绝对|一定|必然|只有|必须|只能|全部|所有|never|always/.test(t)) s -= 1.5;
      if (/不是|不能|不对/.test(t)) s -= 1;
      if (t.length >= 6) s += 0.4;
      if (t.length >= 14) s += 0.4;
      return s;
    };
    const ranked = texts.map(t => ({ ...t, s: score(t.data) })).sort((a, b) => b.s - a.s);
    const best = ranked[0];
    if (!best || best.s <= 0) return { answer: opts.length === 1 ? opts[0].name : '', why: 'no-signal', confidence: 0.2 };
    if (q.type === 1 || q.type === 3) return { answer: best.name, why: 'heuristic-single', confidence: 0.35 };
    // 多选：取正分项；全都正分则取全部
    const picks = ranked.filter(r => r.s > 0.5).map(r => r.name);
    return { answer: (picks.length ? picks : [best.name]).join(','), why: 'heuristic-multi', confidence: 0.25 };
  }

  // ------------------------------------------------------ 3. 通用视频控制
  function videos() {
    const list = Array.from(document.querySelectorAll('video'));
    // 也支持阿里播放器暴露的实例
    return list;
  }
  function activeVideo() {
    const v = videos();
    if (!v.length) return null;
    // 取「有 src 且未结束」的第一个，否则取第一个
    return v.find(x => !x.ended && x.readyState >= 1) || v[0];
  }
  function applyVideoPolicy(v, why) {
    if (!v || !CFG.enabled) return;
    try {
      if (CFG.mute && !v.muted) { v.muted = true; v.volume = 0; }
      if (CFG.rate && Math.abs((v.playbackRate || 1) - CFG.rate) > 0.01) {
        v.playbackRate = CFG.rate;
        state.video.rateFixes++;
        log('设置倍速', CFG.rate, why || '');
      }
      if (CFG.autoPlay && v.paused && !v.ended) {
        const p = v.play();
        if (p && p.catch) p.catch(e => warn('play() 被拒', e && e.message));
      }
    } catch (e) { state.lastError = String(e && e.message || e); }
  }
  function watchVideo() {
    setInterval(() => {
      const v = activeVideo();
      if (!v) return;
      if (!v.__ncSeen) {
        v.__ncSeen = true;
        state.video.seen++;
        log('发现视频', { duration: Math.round(v.duration || 0), src: (v.currentSrc || '').slice(0, 80) });
        v.addEventListener('ended', () => {
          state.video.ended++;
          state.video.lastEndedAt = now();
          log('视频播放结束 #' + state.video.ended);
          report('video-ended', { url: location.href, ended: state.video.ended });
          if (CFG.autoNext) setTimeout(goNext, 1500);
        });
        v.addEventListener('pause', () => {
          if (CFG.autoPlay && !v.ended && v.currentTime > 0.3) {
            setTimeout(() => { if (v.paused && !v.ended) applyVideoPolicy(v, 'anti-pause'); }, 1200);
          }
        });
      }
      applyVideoPolicy(v, 'tick');
    }, 2500);

    // 视频元素是 SPA 动态插入的，做一次 MutationObserver 加速首帧控制
    try {
      new MutationObserver(() => {
        const v = activeVideo();
        if (v && !v.__ncSeen) applyVideoPolicy(v, 'mutation');
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) { }
  }

  /** 进入下一节：优先点「下一节」按钮，其次点左侧目录里「未完成」的下一项 */
  function goNext() {
    const cands = [
      '[class*="next"]:not([disabled])',
      'button[class*="next"]',
      '.next-btn', '.btn-next', '.next-section', '.nextChapter', '.next-chapter'
    ];
    for (const sel of cands) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || el.textContent || '').trim();
        if (!t || /下一题|下一页|下一部分/.test(t) === false) {
          if (/下一节|下一章|下一课|下一个|继续学习|下一讲/.test(t) || /next/i.test(el.className)) {
            log('点击下一节', sel, t.slice(0, 20));
            el.click();
            return true;
          }
        }
      }
    }
    // 目录侧边栏：找带进度未满的项
    const items = Array.from(document.querySelectorAll('[class*="catalog"] li, [class*="chapter"] li, [class*="menu"] li, .section-item, .node-item'));
    const pending = items.filter(li => !/100%|已完成/.test(li.innerText || '') && /(\d|[一二三四五六七八九十])/.test(li.innerText || ''));
    if (pending.length) {
      const cur = items.findIndex(li => /active|current|playing|选中/.test(li.className));
      const next = pending.find((li, i) => items.indexOf(li) > cur) || pending[0];
      if (next) { log('点击目录下一项', (next.innerText || '').trim().slice(0, 30)); next.click(); return true; }
    }
    warn('没找到下一节入口，等待人工/AI 处理');
    report('next-not-found', { url: location.href });
    return false;
  }

  // ---------------------------------------------------------- 4. 平台适配
  // shengsheng：随堂练习走 /api/exam/popQuiz/*（页面自己会请求，我们只解析响应并作答）
  const shengsheng = {
    id: 'shengsheng',
    matched: /shengshengketang/i.test(HOST),
    popQuizSelectors: ['.pop-quiz-dialog', '[class*="pop-quiz"]', '[class*="PopQuiz"]'],
    /** 页面弹层出现后，把题目读出来、选答案、点提交 */
    async handleQuiz() {
      const box = this.popQuizSelectors.map(s => document.querySelector(s)).find(Boolean) || matchByText('随堂练习');
      if (!box) return false;
      if (box.__ncHandled && now() - box.__ncHandled < 5000) return false;
      box.__ncHandled = now();
      state.quiz.seen++;

      // 优先用网络层捕获到的题目数据（最准）
      let item = null;
      for (let i = quizFeed.length - 1; i >= 0; i--) { if (now() - quizFeed[i].at < 60000) { item = quizFeed[i].item; break; } }
      if (!item) return await this.handleQuizByDom(box);
      return await this.answerByItem(box, item);
    },
    /** DOM 兜底：直接读弹层里的题面与选项 */
    async handleQuizByDom(box) {
      const title = box.querySelector('.question-title, [class*="question-title"]');
      const typeText = (box.querySelector('.question-type') || {}).innerText || '';
      const type = /多选|不定项/.test(typeText) ? 2 : /判断/.test(typeText) ? 3 : 1;
      const opts = Array.from(box.querySelectorAll('.option-item, [class*="option"]')).map(el => ({
        name: ((el.querySelector('.option-label') || {}).innerText || '').replace(/[.\s]/g, '') || (el.getAttribute('name') || ''),
        data: ((el.querySelector('.option-text, .option-content') || {}).innerText || el.innerText || '').trim(),
        el
      })).filter(o => o.data);
      if (!opts.length) return false;
      const q = { type, name: (title && title.innerText) || '', optionList: opts.map(o => ({ name: o.name, data: o.data })) };
      const g = guessAnswer(q);
      for (const o of opts) { if (g.answer.split(',').includes(o.name)) o.el.click(); }
      await sleep(CFG.quizDelayMs);
      const submit = Array.from(box.querySelectorAll('button, [class*="btn"]')).find(b => /提交|确定|确认|保存/.test(b.innerText || ''));
      if (submit) { submit.click(); log('已提交随堂练习（DOM 模式）', g.why, g.confidence); }
      else warn('没找到提交按钮');
      return true;
    },
    /** 有接口数据时：填 → 提交，并把结果写回本地题库 */
    async answerByItem(box, item) {
      const q = item.question || {};
      const g = guessAnswer(q);
      const opts = Array.from(box.querySelectorAll('.option-item, [class*="option"]'));
      const names = g.answer ? g.answer.split(',') : [];
      if (!opts.length) return false;
      for (const el of opts) {
        const label = ((el.querySelector('.option-label') || {}).innerText || '').replace(/[.\s]/g, '');
        if (names.includes(label)) el.click();
      }
      await sleep(CFG.quizDelayMs);
      const submit = Array.from(box.querySelectorAll('button, [class*="btn"]')).find(b => /提交|确定|确认|保存/.test(b.innerText || ''));
      if (submit) submit.click();
      state.quiz.answered++;
      log('已作答随堂练习', { id: item.id, type: q.type, pick: g.answer, why: g.why });
      // 结果由网络层观察 insertUserAnswer 的响应来判定
      pendingQuiz.push({ id: item.id, q, answer: g.answer, at: now() });
      return true;
    },
    /** 观察提交结果，回写题库 */
    observeAnswerResponse(body) {
      const d = body && body.data;
      if (!d || typeof d !== 'object') return;
      const last = pendingQuiz[pendingQuiz.length - 1];
      if (!last) return;
      if (d.state === 2) {
        state.quiz.correct++; bankPut(last.q, last.answer, true);
        log('✅ 答对', last.answer);
        pendingQuiz.pop();
      } else if (d.state === 3) {
        state.quiz.wrong++;
        const right = d.answer || '';
        if (right) {
          bankPut(last.q, right, true);
          log('❌ 答错，平台给出正确答案', right, '→ 已写回本地题库');
          // 用正确答案再点一次（如果弹层还在）
          pendingQuiz.pop();
          setTimeout(() => this.handleQuiz(), 1200);
        } else {
          bankPut(last.q, last.answer, false);
        }
      }
      report('quiz-result', { state: d.state, answer: last.answer, right: d.answer || null });
    }
  };

  // qiyang：先用探测式适配（DOM 未定型），关键行为靠通用视频控制 + 通用弹题启发
  const qiyang = {
    id: 'qiyang',
    matched: /bjqiyang/i.test(HOST),
    popQuizSelectors: ['[class*="pop"]', '[class*="quiz"]', '[class*="question"]', '.layui-layer', '[class*="dialog"]'],
    async handleQuiz() {
      const box = ['[class*="quiz"]', '[class*="question"]', '.layui-layer-content', '[class*="dialog"]']
        .map(s => document.querySelector(s)).find(el => el && /题|选项|作答|练习/.test(el.innerText || ''));
      if (!box) return false;
      if (box.__ncHandled && now() - box.__ncHandled < 5000) return false;
      box.__ncHandled = now();
      state.quiz.seen++;
      const inputs = Array.from(box.querySelectorAll('input[type=radio], input[type=checkbox]'));
      const q = { type: inputs[0] && inputs[0].type === 'checkbox' ? 2 : 1, name: (box.innerText || '').slice(0, 300), optionList: [] };
      const labels = Array.from(box.querySelectorAll('label'));
      for (let i = 0; i < inputs.length; i++) {
        const lab = labels[i] || inputs[i].closest('label') || inputs[i].parentElement;
        q.optionList.push({ name: String.fromCharCode(65 + i), data: (lab && lab.innerText || '').trim() });
      }
      if (!q.optionList.length) return false;
      const g = guessAnswer(q);
      const picks = g.answer ? g.answer.split(',') : [];
      picks.forEach(p => { const i = p.charCodeAt(0) - 65; if (inputs[i] && !inputs[i].checked) inputs[i].click(); });
      await sleep(CFG.quizDelayMs);
      const submit = Array.from(box.querySelectorAll('button, a, input[type=submit]')).find(b => /提交|确定|确认|保存|交卷/.test(b.innerText || b.value || ''));
      if (submit) { submit.click(); log('已提交弹题（qiyang，探测模式）', g.why); }
      return true;
    },
    observeAnswerResponse() { /* 结果结构未知，等真实页面确认后补 */ }
  };

  const pendingQuiz = [];
  const ADAPTERS = [shengsheng, qiyang].filter(a => a.matched);
  const ADAPTER = ADAPTERS[0];

  function matchByText(txt) {
    const all = document.querySelectorAll('div,section,aside');
    for (const el of all) {
      const t = el.innerText || '';
      if (t.length < 400 && t.includes(txt)) return el;
    }
    return null;
  }

  function quizLoop() {
    setInterval(async () => {
      if (!CFG.enabled || !CFG.autoQuiz || !ADAPTER) return;
      try { await ADAPTER.handleQuiz(); } catch (e) { state.lastError = String(e && e.message || e); }
    }, 3000);
  }

  // ---------------------------------------------------------- 5. 控制面板
  function mountPanel() {
    if (!CFG.panel || document.getElementById('netclass-panel')) return;
    const el = document.createElement('div');
    el.id = 'netclass-panel';
    el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646;font:12px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;background:rgba(20,20,24,.92);color:#eee;border-radius:10px;padding:8px 10px;min-width:186px;box-shadow:0 6px 20px rgba(0,0,0,.35)';
    const render = () => {
      const v = activeVideo();
      const info = v ? `${Math.floor(v.currentTime || 0)}/${Math.floor(v.duration || 0)}s x${v.playbackRate} ${v.paused ? '暂停' : '播放'}` : '无视频';
      el.innerHTML = `
        <div style="font-weight:600;margin-bottom:4px">NetClass ${VERSION} <span style="opacity:.6">${PLATFORM}</span></div>
        <div style="opacity:.8">视频 ${state.video.seen} · 完成 ${state.video.ended} · 倍速修正 ${state.video.rateFixes}</div>
        <div style="opacity:.8">弹题 见${state.quiz.seen} 答${state.quiz.answered} ✔${state.quiz.correct} ✘${state.quiz.wrong} 题库命中${state.quiz.bankHit}</div>
        <div style="opacity:.8">当前：${info}</div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          <button data-a="toggle" style="cursor:pointer">${CFG.enabled ? '暂停' : '启动'}</button>
          <button data-a="rate" style="cursor:pointer">倍速 ${CFG.rate}x</button>
          <button data-a="quiz" style="cursor:pointer" title="手动触发一次弹题处理">答题</button>
          <button data-a="next" style="cursor:pointer">下一节</button>
          <button data-a="hide" style="cursor:pointer">收起</button>
        </div>`;
      el.querySelectorAll('button').forEach(b => b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'toggle') { CFG.enabled = !CFG.enabled; saveCfg(CFG); }
        if (a === 'rate') { CFG.rate = CFG.rate >= 4 ? 1 : CFG.rate + 0.5; saveCfg(CFG); const v = activeVideo(); if (v) v.playbackRate = CFG.rate; }
        if (a === 'quiz') ADAPTER && ADAPTER.handleQuiz();
        if (a === 'next') goNext();
        if (a === 'hide') { el.style.display = 'none'; }
        render();
      });
    };
    render();
    setInterval(render, 2000);
    (document.body || document.documentElement).appendChild(el);
  }

  // ---------------------------------------------------------- 6. 启动
  function main() {
    log('启动', { version: VERSION, platform: PLATFORM, host: HOST, cfg: CFG });
    hookNetwork();
    watchVideo();
    quizLoop();
    if (document.body) mountPanel(); else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });

    // 观察随堂练习提交结果
    const origFetch = window.fetch;
    // 结果解析挂在已挂载的观察层里（见 hookNetwork 的 quizFeed/apiLog）

    // 页面切换（SPA）
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href; state.route = lastUrl;
        log('路由变化', lastUrl);
        if (CFG.enabled) setTimeout(() => { const v = activeVideo(); if (!v) goNext && void 0; applyVideoPolicy(activeVideo(), 'route'); }, 1500);
      }
    }, 1500);

    report('boot', { version: VERSION, platform: PLATFORM, url: location.href });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true });
  else main();

  // 暴露给控制端（CDP 注入时用）
  window.NetClass = {
    version: VERSION, platform: PLATFORM, cfg: CFG, state,
    goNext, activeVideo,
    applyRate(r) { CFG.rate = r; saveCfg(CFG); const v = activeVideo(); if (v) v.playbackRate = r; return r; },
    handleQuizNow() { return ADAPTER && ADAPTER.handleQuiz(); },
    dumpApis() { return apiLog.slice(-50); },
    dumpBank() { return bank; },
    dumpQuizFeed() { return quizFeed.slice(-10); }
  };
})();
