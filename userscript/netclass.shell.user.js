// ==UserScript==
// @name         NetClass 网课自动处理（壳）
// @namespace    taskmesh.local/netclass
// @version      0.3.0
// @description  两站网课自动处理引导壳：从本机 127.0.0.1:17800 热加载实现模块（不停机更新），并保留内嵌兜底实现。
// @author       TaskMesh
// @match        https://edu.shengshengketang.com/*
// @match        https://study.bjqiyang.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

/* ---------------------------------------------------------------------------
 * 设计
 *  1) 壳只做三件事：拿模块、注入页面、兜底自检。
 *  2) 模块地址：http://127.0.0.1:17800/App.js（本机服务，见 scripts/netclass-server.ps1）
 *  3) 每 30s 校验一次模块哈希，变了就热重载（不清栈、不刷新页面）。
 *  4) 本机服务不可用时，使用下面 INLINE 段的兜底实现（基础视频控制 + 弹题提示）。
 *  5) 需要停掉：把本机服务关掉即进入兜底；需要彻底停：油猴面板里禁用本脚本。
 * --------------------------------------------------------------------------- */
(function () {
  'use strict';
  const VERSION = '0.3.0';
  const BASE = 'http://127.0.0.1:17800/';
  const MODULE = 'App.js';
  const NS = '[NetClass]';
  const HOST = location.hostname;
  const PLATFORM = /shengshengketang/i.test(HOST) ? 'shengsheng' : /bjqiyang/i.test(HOST) ? 'qiyang' : 'unknown';

  const say = (...a) => console.log(NS, ...a);
  const warn = (...a) => console.warn(NS, ...a);

  window.__NETCLASS_SHELL__ = { version: VERSION, base: BASE, platform: PLATFORM, loadedAt: Date.now() };

  // ------------------------------------------------------------- 网络请求
  function get(url, cb) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return GM_xmlhttpRequest({
        method: 'GET', url, timeout: 8000,
        onload: r => cb(r.status >= 200 && r.status < 300 ? r.responseText : null, r.status),
        onerror: () => cb(null, 0), ontimeout: () => cb(null, -1)
      });
    }
    if (typeof window.GM_xmlhttpRequest === 'function') return window.GM_xmlhttpRequest({ method: 'GET', url, onload: r => cb(r.responseText, r.status), onerror: () => cb(null, 0), ontimeout: () => cb(null, -1) });
    fetch(url, { cache: 'no-store' }).then(r => r.text().then(t => cb(r.ok ? t : null, r.status))).catch(() => cb(null, 0));
  }

  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }

  function inject(code, label) {
    try {
      const el = document.createElement('script');
      el.textContent = '\n/* NetClass module: ' + label + ' */\n' + code + '\n';
      (document.head || document.documentElement).appendChild(el);
      el.remove();
      return true;
    } catch (e) { warn('注入失败(<script>)', e && e.message); }
    try { (0, eval)(code); return true; } catch (e) { warn('注入失败(eval)', e && e.message); return false; }
  }

  let currentHash = null;
  let loading = false;

  function loadModule(reason) {
    if (loading) return;
    loading = true;
    get(BASE + MODULE + '?t=' + Date.now(), (text, status) => {
      loading = false;
      if (!text) {
        warn('本机模块服务不可用（status=' + status + '）：' + BASE + MODULE + '，进入兜底模式', reason);
        return inlineFallback();
      }
      const h = hash(text);
      if (h === currentHash) return;
      // 卸载旧实例
      try { window.NetClass && window.NetClass.dispose && window.NetClass.dispose(); } catch (_) { }
      const ok = inject(text, MODULE + '@' + h);
      if (ok) { currentHash = h; say('实现模块已加载', h, text.length + 'B', '(' + reason + ')'); }
      else {
        // CSP 兜底：用 blob 方式再试一次
        try {
          const b = new Blob([text], { type: 'text/javascript' });
          const u = URL.createObjectURL(b);
          const el = document.createElement('script');
          el.src = u; (document.head || document.documentElement).appendChild(el);
          el.onload = () => { currentHash = h; say('实现模块经 blob 加载', h); };
          el.onerror = () => warn('blob 注入也失败');
          setTimeout(() => URL.revokeObjectURL(u), 5000);
        } catch (e) { warn('blob 注入异常', e && e.message); }
      }
    });
  }

  // ------------------------------------------------------------- 兜底实现
  let fallbackMounted = false;
  function inlineFallback() {
    if (fallbackMounted) return;
    fallbackMounted = true;
    say('兜底模式：只做基础播放控制与弹题提示');

    function tick() {
      const v = document.querySelector('video');
      if (!v) return;
      try {
        if (!v.muted) { v.muted = true; v.volume = 0; }
        if (Math.abs((v.playbackRate || 1) - 2) > 0.01) v.playbackRate = 2;
        if (v.paused && !v.ended) v.play().catch(() => { });
      } catch (_) { }
    }
    setInterval(tick, 2500);

    // 弹题提示（不自动作答，避免无依据乱答）
    const seen = new WeakSet();
    setInterval(() => {
      const boxes = document.querySelectorAll('.pop-quiz-dialog, [class*="pop-quiz"], [class*="quiz"], .layui-layer');
      boxes.forEach(b => {
        if (seen.has(b)) return;
        if (!/题|选项|作答|练习/.test(b.innerText || '')) return;
        seen.add(b);
        window.__NETCLASS_QUIZ_PENDING__ = (b.innerText || '').slice(0, 600);
        say('检测到弹题（兜底模式只提示，不代答）');
      });
    }, 3000);
  }

  // ------------------------------------------------------------- 启动
  loadModule('boot');
  // 热更新：每 30 秒比对一次哈希；同时处理 SPA 路由
  setInterval(() => loadModule('hot'), 30000);
  setInterval(() => { if (window.__NETCLASS_QUIZ_PENDING__) delete window.__NETCLASS_QUIZ_PENDING__; }, 60000);

  say('壳已启动', VERSION, PLATFORM, HOST);
})();
