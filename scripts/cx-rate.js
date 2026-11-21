/**
 * cx-rate.js — 学习通播放器倍速模块（独立注入，可反复注入不重装）
 *
 * 事实（2026-10-15 实测）：
 *  · 站点在 ratechange 后**同一个 tick** 就把 <video>.playbackRate 写回 1（未完成任务点前锁定 1x）；
 *  · 只在 DOM 层反复写会被站点覆盖，且会与站点的 ratechange 处理打转。
 * 对策：
 *  · 在该 <video> 实例上 defineProperty('playbackRate')，getter 恒返回目标值 → **站点读到的永远是目标值，
 *    不会再触发它的"还原"逻辑**；setter 吞掉回写；
 *  · 由 watchdog（每 3s）用**原生 setter**（HTMLMediaElement.prototype 上的那个）把真实倍速压回目标值。
 * 上限 2x（平台高倍速风控会清进度，OCS 明确警告过）。
 */
(function(){
  if (window.__cxRateV === 1) return 'rate-module-already';
  window.__cxRateV = 1;

  var LS = 'ncCx:rate';
  function getRate(){
    var r = Number((function(){ try { return localStorage.getItem(LS); } catch(e){ return null; } })());
    // P3：调用方可先用 window.__ncPlanRate 注入决策器给的倍速（plan.rate）；没注入就沿用 1.5 默认，行为不变
    if (!(r >= 1 && r <= 2) && typeof window.__ncPlanRate === 'number') r = window.__ncPlanRate;
    return (r >= 1 && r <= 2) ? r : 1.5;
  }
  var target = getRate();

  function findVideo(){
    var v = null;
    (function walk(r){
      try {
        var e = r.querySelector && r.querySelector('video');
        if (e) { v = e; return; }
        Array.from(r.querySelectorAll('iframe')).forEach(function(f){ var d = null; try { d = f.contentDocument; } catch(x){} if (d) walk(d); });
      } catch(x){}
    })(document);
    return v;
  }

  function apply(){
    var v = findVideo();
    if (!v) return null;
    var w = v.ownerDocument.defaultView;
    w.__cxRateTarget = target;
    try {
      if (v !== w.__cxRateEl) {
        w.__cxRateEl = v;
        Object.defineProperty(v, 'playbackRate', {
          configurable: true,
          get: function(){ return w.__cxRateTarget; },
          set: function(x){ w.__cxRateTarget = target; }        // 吞掉站点/播放器的回写
        });
      }
      w.HTMLMediaElement.prototype.__lookupSetter__('playbackRate').call(v, target);
    } catch(e){}
    return target;
  }

  window.__cxRateSet = function(r){
    r = Number(r);
    if (!(r >= 1)) return target;
    if (r > 2) r = 2;
    target = Math.round(r * 100) / 100;
    try { localStorage.setItem(LS, String(target)); } catch(e){}
    apply();
    return target;
  };
  window.__cxRateNow = function(){ return { target: target, read: (function(){ var v = findVideo(); return v ? v.playbackRate : null; })(), patched: (function(){ var v = findVideo(); return v ? (v.ownerDocument.defaultView.__cxRateEl === v) : null; })() }; };

  apply();
  setInterval(apply, 3000);
  return 'rate-module-installed target=' + target;
})()
