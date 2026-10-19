/**
 * cc-lib.mjs — 长春教师培训（col.ccjyxy.cn）共享库
 * 放这里统一 CDP 原语 + 页面动作，供 cc-auto-v3 / cc-* 工具复用。
 *
 * 关键事实（实测）：
 *  · 训练页：3 个 MuiAccordion 分类；课程 = .MuiListItemButton-root（90 条，含「编码:」+「学时」）
 *  · 课程详情页 = 「播放列表视图」：手机 UA 下 **没有**「返回课程列表」，只有 courseId 路由 + 「视频课程」+ 播放/继续 段条目
 *  · 播放页 = 「播放器视图」：有「返回课程列表」+ <video>；两视图在同一个 URL（SPA 内部状态切换）
 *  · 油猴脚本 ccjyxy 无适配器：cfg.autoNext 必须关掉（否则盲点「下一节」把 SPA 反复踢回训练页）
 */
const CATNAMES = ['小初高公需', '初中学段通识', '专业课-初中数学'];
// ★ 2026-10-18 修正：第三类页面上的标题是「初中数学」（旧值写成 '专业课-初中数学'，
//   expand() 用 indexOf 子串匹配，'初中数学' 依然能命中；但 catOf() 里的 /专业课/ 正则会漏，
//   导致这一类的课程 cat=null → 按分类过滤时就丢了）。
const HOME = 'https://col.ccjyxy.cn';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function listTabs(port) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    return l.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
  } catch (_) { return null; }
}

/* ---------- 只读探测：平台真实学时（不抢标签归属，任何进程都能安全调用） ----------
 * 返回 { total:{done,target}, cats:[{cat,done,target,raw}], onTrain, unknown? }
 *  · 只有停在培训页时才有分类明细；在课程页/播放器页 → onTrain=false（stats 读不到属正常）
 *  · CDP 走 SSH 隧道到笔记本，隧道断时返回 null（判断"没读到"，不要当成"完成了"） */
export async function readCcStats(port = 9228) {
  const tabs = await listTabs(port);
  if (!tabs || !tabs.length) return null;
  /* ★ 2026-10-19 修：原来只读 tabs[0]。驱动在播放器页时 tabs[0] 就是播放器 → 读不到分类明细
   *   → cc-cycle 过滤不掉已达标的分类（分类0 30.9/30 还继续跑 cat=0）。改成逐个标签试，
   *   优先返回「停在培训页」（onTrain=true）的那份，没有再退回第一份可读结果。 */
  let fallback = null;
  for (const page of tabs) {
    const st = await readStatsFromTab(page);
    if (!st) continue;
    if (st.onTrain) return st;
    if (!fallback) fallback = st;
  }
  return fallback;
}

async function readStatsFromTab(page) {
  let ws;
  try {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws-error')), { once: true });
      setTimeout(() => rej(new Error('ws-open-timeout')), 8000);
    });
    const got = new Promise(res => {
      const h = e => { try { const m = JSON.parse(e.data); if (m.id === 1) { ws.removeEventListener('message', h); res(m); } } catch (_) { } };
      ws.addEventListener('message', h);
      setTimeout(() => res(null), 8000);
    });
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: {
        returnByValue: true, expression: `(function(){
          var t=(document.body.innerText||'').replace(/\\s+/g,' ');
          var total=t.match(/已修\\s*([\\d.]+)\\s*\\/\\s*达标\\s*(\\d+)\\s*学时/);
          var out={total: total?{done:Number(total[1]),target:Number(total[2])}:null, cats:[], onTrain:false, onCourse:/返回培训内容列表/.test(t), onPlayer:/返回课程列表/.test(t)};
          Array.from(document.querySelectorAll('.MuiAccordion-root')).forEach(function(a){
            var h=a.querySelector('h3'); if(!h) return;
            var x=(h.innerText||'').replace(/\\s+/g,' ');
            var m=x.match(/([\\d.]+)\\s*\\/\\s*达标\\s*(\\d+)\\s*学时/);
            var nm=/小初高公需/.test(x)?0:(/初中学段通识/.test(x)?1:(/初中数学|专业课/.test(x)?2:null));
            if(nm!==null) out.cats.push({cat:nm, done:m?Number(m[1]):null, target:m?Number(m[2]):null, raw:x.slice(0,46)});
          });
          out.onTrain = out.cats.length>=2;
          return JSON.stringify(out);
        })()`
      }
    }));
    const m = await got;
    const v = m && m.result && m.result.result && m.result.result.value;
    if (!v) return null;
    return JSON.parse(v);
  } catch (_) { return null; } finally { try { ws && ws.close(); } catch (_) { } }
}

/* ---------- 跨进程认领（同一浏览器多实例分工，避免撞车） ---------- */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
export const CLAIM_FILE = 'runs/cc-claim.json';
function readClaims() {
  try { return JSON.parse(readFileSync(CLAIM_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeClaims(o) {
  try { if (!existsSync('runs')) mkdirSync('runs', { recursive: true }); writeFileSync(CLAIM_FILE, JSON.stringify(o)); } catch (_) { }
}
/** 尝试认领一门课；被别的实例占着则返回 false。
 *  housekeeping：若别的实例「占着课但不在播」（页面没视频）且认领超过 STALE_MS，
 *  就把它的认领收回来 —— 否则一个实例崩过一次就能长期霸着几十门课，把另一个饿死。 */
export async function claimCourse(name, tag, opts = {}) {
  const TTL = opts.ttlMs || 3 * 60 * 60 * 1000;
  const STALE = opts.staleMs || 6 * 60 * 1000;
  const port = opts.port || 9228;
  const o = readClaims();
  const now = Date.now();
  for (const k of Object.keys(o)) if (!o[k].done && now - o[k].at > TTL) delete o[k];
  // 回收「别的实例占着、但它当前没在播」的陈旧认领
  const staleOwners = new Set();
  for (const k of Object.keys(o)) {
    if (o[k].done || o[k].tag === tag) continue;
    if (now - o[k].at > STALE) staleOwners.add(o[k].tag);
  }
  if (staleOwners.size) {
    const tabs = (await listTabs(port)) || [];
    for (const owner of staleOwners) {
      let playing = false;
      for (const t of tabs) {
        const tb = new Tab(t, port);
        if (!await tb.connect()) continue;
        const isMine = await tb.ev(`(function(){ return document.documentElement.getAttribute(${JSON.stringify('data-nc-owner')}) })()`);
        if (isMine !== owner) { tb.close(); continue; }
        const hasVid = await tb.ev(`(function(){ return !!document.querySelector('video') })()`);
        if (hasVid) playing = true;
        tb.close();
      }
      if (!playing) {
        const freed = Object.keys(o).filter(k => o[k].tag === owner);
        freed.forEach(k => delete o[k]);
        console.log('[claim] 回收 ' + owner + ' 的 ' + freed.length + ' 条陈旧认领（该标签当前没在播）');
      }
    }
  }
  const cur = o[name];
  if (cur && cur.tag && cur.tag !== tag) { writeClaims(o); return false; }
  if (cur && !cur.tag && cur.done) { writeClaims(o); return false; }   // 别人的"已完成"墓碑：排到队尾（自己的墓碑上面已放行）
  o[name] = { tag, at: now };
  writeClaims(o);
  return true;
}
/** 我的认领数（只算没超时的） */
export function myClaims(tag, ttlMs = 3 * 60 * 60 * 1000) {
  const o = readClaims(), now = Date.now();
  return Object.keys(o).filter(k => o[k].tag === tag && now - o[k].at <= ttlMs);
}
/** 只刷新指定若干门的认领时间戳（心跳）——别把陈旧认领也一起续命 */
export function touchClaims(names, tag) {
  const o = readClaims(), now = Date.now();
  let n = 0;
  for (const k of names) if (o[k] && o[k].tag === tag) { o[k].at = now; n++; }
  writeClaims(o);
  return n;
}
/** 当前认领表快照 */
export function claimsSnapshot() { return readClaims(); }
/** 清掉我的认领（completed=true 时留一个墓碑排到队尾；注意墓碑必须是别人不能抢、自己可以重新认领） */
export function releaseCourse(name, tag, completed = false) {
  const o = readClaims();
  if (!o[name]) return;
  if (completed) { o[name] = { tag: '', at: Date.now(), done: true }; }
  else delete o[name];
  writeClaims(o);
}

/** 视口保活：多次开关标签后，窗口常被压到 ~237px 高 → 按钮点击全部落空。
 *  每次 acquireTab 之后调用一次（幂等）。 */
export async function ensureViewport(tab, w = 1200, h = 1000) {
  try {
    const v = await tab.ev(`JSON.stringify([window.innerWidth, window.innerHeight])`);
    let iw = 0, ih = 0;
    try { const a = JSON.parse(v || '[0,0]'); iw = a[0]; ih = a[1]; } catch (_) { }
    if (ih >= 600 && iw >= 900) return false;
    await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    return true;
  } catch (_) { return false; }
}

/** 找/开一个「属于本实例」的标签：
 *  1) targetId 匹配且 owner 是自己  2) owner==自己  3) owner 为空 → 直接占用
 *  4) 全被占 → 自己新开一个标签（绝不和别人共用同一个标签！） */
export async function acquireTab(port, opts = {}) {
  const { token = null, targetId = null, index = 0, tag = 'x' } = opts;
  const TARGET_URL = 'https://col.ccjyxy.cn';
  const mark = async (tab, id) => { await tab.ev(`(function(){ try{ document.documentElement.setAttribute(${JSON.stringify(id)}, ${JSON.stringify(tag)}); return 1 }catch(e){ return 0 } })()`); };
  const owner = async (tab, id) => await tab.ev(`(function(){ return document.documentElement.getAttribute(${JSON.stringify(id)}) })()`);
  const openNew = async () => {
    try { await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(TARGET_URL)}`, { method: 'PUT' }); } catch (_) { }
    for (let i = 0; i < 12; i++) {
      await sleep(2500);
      const cand = await listTabs(port);
      if (cand) for (const t of cand) {
        const tab = new Tab(t, port);
        if (!await tab.connect()) continue;
        const o = await owner(tab, token);
        if (!o || o === tag) { await mark(tab, token); return tab; }
        tab.close();
      }
    }
    return null;
  };

  let cand = await listTabs(port);
  if (!cand || !cand.length) return await openNew();

  // 1) 自己的 targetId
  if (targetId) {
    const t = cand.find(x => x.id === targetId);
    if (t) {
      const tab = new Tab(t, port);
      if (await tab.connect()) {
        const o = await owner(tab, token);
        if (!o || o === tag) { await mark(tab, token); return tab; }
        tab.close();
      }
    }
  }
  // 2) 扫描：owner==自己 / owner 为空
  const n = cand.length;
  for (let k = 0; k < n; k++) {
    const t = cand[(index + k) % n];
    const tab = new Tab(t, port);
    if (!await tab.connect()) continue;
    const o = await owner(tab, token);
    if (o === tag) return tab;
    if (!o) { await mark(tab, token); return tab; }
    tab.close();
  }
  // 3) 全被占 → 新开
  return await openNew();
}

/** 关掉自己没有 owner 的多余 ccjyxy 标签（只关无主的；绝不关别人的）。返回关掉的数量。 */
export async function closeExtraTabs(port, token, tag, keepId) {
  const cand = await listTabs(port);
  if (!cand || cand.length <= 1) return 0;
  let closed = 0;
  for (const t of cand) {
    if (t.id === keepId) continue;
    const tab = new Tab(t, port);
    if (!await tab.connect()) continue;
    const o = await tab.ev(`(function(){ return document.documentElement.getAttribute(${JSON.stringify(token)}) })()`);
    if (!o) {
      try { await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); } catch (_) { }
      closed++;
    }
    tab.close();
  }
  if (closed) console.log('[tabs] 关掉 ' + closed + ' 个无主 ccjyxy 标签（保留 ' + String(keepId).slice(0, 8) + '）');
  return closed;
}

export class Tab {
  constructor(t, port) { this.targetId = t.id; this.port = port; this.url0 = t.url; this.ws = null; this.seq = 0; }
  async connect() {
    if (this.ws && this.ws.readyState === 1) return true;
    const list = await listTabs(this.port);
    const t = (list || []).find(x => x.id === this.targetId);
    if (!t) return false;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(res, 8000); });
    this.ws = ws; this.seq = 0;
    return true;
  }
  send(method, params = {}, ms = 25000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve({ timeout: true });
    return new Promise(res => {
      const id = ++this.seq;
      const on = e => { let x; try { x = JSON.parse(e.data); } catch (_) { return; } if (x.id === id) { this.ws.removeEventListener('message', on); res(x); } };
      this.ws.addEventListener('message', on);
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (_) { res({ timeout: true }); }
      setTimeout(() => { try { this.ws.removeEventListener('message', on); } catch (_) { } res({ timeout: true }); }, ms);
    });
  }
  async ev(expr, ms = 25000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
    if (!r || r.timeout) return null;
    if (r.result && r.result.exceptionDetails) {
      const d = JSON.stringify(r.result.exceptionDetails).slice(0, 160);
      return { __err: d };
    }
    return r.result && r.result.result ? r.result.result.value : null;
  }
  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  /** 真实鼠标点击（按文本精确/包含匹配） */
  async clickText(txt, exact = true) {
    const box = await this.ev(`(function(){
      var el = Array.from(document.querySelectorAll('button,a,div,span')).find(function(e){
        var x=(e.innerText||'').trim();
        return ${exact ? `x === ${JSON.stringify(txt)}` : `x.indexOf(${JSON.stringify(txt)}) >= 0`} && (e.offsetWidth||e.offsetHeight);
      });
      if (!el) return null; el.scrollIntoView({block:'center'});
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
    })()`);
    if (!box || box.__err) return false;
    const b = JSON.parse(box);
    await this.clickAt(b.x, b.y);
    return true;
  }
  async navigate(url) {
    await this.send('Page.navigate', { url });
  }
  async reload() { await this.send('Page.reload', {}); }
  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r && r.result && r.result.data) {
      const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(r.result.data, 'base64'));
      return true;
    }
    return false;
  }
  close() { try { this.ws && this.ws.close(); } catch (_) { } this.ws = null; }
}

const PROBE = `(function(){
  function find(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=find(d);if(x)return x}}}catch(e){}return null}
  function btnByText(txts){
    return Array.from(document.querySelectorAll('button,a,[role=button]')).filter(function(e){
      return (e.offsetWidth||e.offsetHeight) && txts.indexOf((e.innerText||'').trim()) >= 0;
    });
  }
  var v=find(document);
  var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  var courseItems = Array.from(document.querySelectorAll('.MuiListItemButton-root'));
  // ★ 段「播放」按钮的查找必须**放宽**：实测这些按钮既不在 .MuiListItemButton-root 里、也不一定是 <button>
  //   （旧写法只扫 MuiListItemButton-root 下的 <button> → 课程页明明有 6 个「播放」却报"无待播段"）
  //   新写法：任意可见元素，文本严格等于 播放/继续/重播；父子都命中时只留最内层
  var anyBtn = Array.from(document.querySelectorAll('button,a,[role=button],div,span')).filter(function(e){
    var tx = (e.innerText||'').trim();
    // ★ 播放器上的按钮是**英文 Play**（实测），课程页段按钮是中文播放/继续/重播 —— 两种都要认
    if (!/^(播放|继续|重播|Play|PLAY|Resume)$/i.test(tx)) return false;
    if (!(e.offsetWidth||e.offsetHeight)) return false;
    var r = e.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  });
  var segs = anyBtn.filter(function(e){ return !anyBtn.some(function(o){ return o !== e && e.contains(o); }); });
  var playable = segs.map(function(btn){
    var r = btn.getBoundingClientRect();
    var host = btn.closest('.MuiListItemButton-root, li, [class*=item]') || btn.parentElement || btn;
    return { label:(btn.innerText||'').trim(), seg:(host.innerText||'').replace(/\\s+/g,' ').trim().slice(0,42), x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
  });
  var hasBackCourse = btnByText(['返回课程列表']).length > 0;
  var hasBackTrainContent = btnByText(['返回培训内容列表']).length > 0;
  var hasEnter = btnByText(['进入']).length > 0;
  var isTrainingContent = /学习总进度|本培训须完成/.test(t) || Array.from(document.querySelectorAll('h3.MuiAccordion-heading')).length > 0;
  var NC = window.NetClass;
  return JSON.stringify({
    onTrain: isTrainingContent,
    onPlayer: hasBackCourse,
    onCourse: !hasBackCourse && hasBackTrainContent,
    onMyTraining: !isTrainingContent && hasEnter,
    video: v ? { cur: Math.round(v.currentTime*10)/10, dur: Math.round(v.duration||0), rate: v.playbackRate, paused: v.paused, ended: v.ended, rs: v.readyState, src: String(v.currentSrc||'').slice(0, 46) } : null,
    playable: playable.slice(0, 10),
    nSegs: segs.length,
    nItems: courseItems.length,
    nCourses: courseItems.filter(function(e){ return /编码[:：]/.test(e.innerText||''); }).length,
    nc: NC ? { en: NC.cfg.enabled, next: NC.cfg.autoNext, rate: NC.cfg.rate, seen: NC.state.video.seen, ended: NC.state.video.ended } : null,
    tail: t.slice(0, 130),
    pct: (t.match(/(\d{1,3})\s*%/) || [null])[1]
  });
})()`;

export async function pageState(tab) {
  const s = await tab.ev(PROBE);
  if (!s || s.__err) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

/* ---------- ★ 播放器猎捕器（长春起播的唯一可靠办法） ----------
 * 实测教训：这个平台的播放器**极其短命** —— 用外部每隔十几秒探测的做法永远抓不住它，
 * 而且**只要没被播起来，SPA 很快就会把播放器拆掉**（页面变回列表/空壳）。
 * 唯一稳定的办法是在页面里**常驻一个高频轮询**（300ms）：视频一出现立刻 muted + 限倍速 + play()。
 * 一旦真的起播，播放器就稳定了（实测连续 90 秒 1.0x 推进不掉）。
 * 注意：SPA 内部路由切换不会清掉它；整页刷新会 —— 所以驱动每轮调用一次（幂等）。
 */
export const HUNTER_JS = `(function(){
  // ★★ 心跳自检（2026-10-15 补）：不能只判断 window.__ccHunt 存在！
  //   实测踩过：页面重载/异常会让 setInterval **静默死掉**，但 __ccHunt 还留着一个旧 ID
  //   → installHunter 返回 'already' → 倍速掉回 1x 且无人察觉（面板还显示"自动处理中"）。
  //   现在用 __ccHuntBeat 心跳判断：超过 5 秒没跳 = 已死，清掉重装。
  if (window.__ccHunt && window.__ccHuntBeat && (Date.now() - window.__ccHuntBeat) < 5000) return 'alive';
  if (window.__ccHunt) { try { clearInterval(window.__ccHunt); } catch(e){} }
  window.__ccLog = window.__ccLog || [];
  window.__ccHunt = setInterval(function(){
    window.__ccHuntBeat = Date.now();
    function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
    var v = f(document); if (!v) return;
    try { v.muted = true; } catch(e){}
    try {
      // ★ 倍速锁（修复版）：两个坑都踩过 → ① R 不能在建锁时捕获进闭包（之后改 rate 不生效）
      //   ② setter 不能"有条件忽略"，否则平台用原生 setter 写 1x 时照样生效。
      //   现在：getter **每次实时读** localStorage；setter **一律忽略**外部写入；
      //   真实倍速由我们每 tick 用**原生 setter** 压上去（绕过实例上的访问器）。
      /* ★★ 2026-10-19 记账铁律（抓包实测，别再改回 2x）：
       *   服务端 video-progress/report 返回 max_position_sec = min(历次上报 position, **1.25 × 该资源累计墙钟**)。
       *   实测两组数据：① 40s 墙钟恰好 +50s（1.25x）② 首播起 459s 墙钟 → 记账 564.7s（1.25×459）。
       *   ⇒ 一条 805s 的段，**无论播放倍速多高，最快也只能花 805/1.25 = 644s 墙钟**才记满；
       *     播 2x 时播放器 402s 就冲到末尾，而记账只到 62.5% → 会被判"没完成"，只能反复重进补录（白费导航开销）。
       *   ⇒ 正确做法：**倍速压到 1.25x**，让"播放器位置"与"记账上限"同速 → 一趟播完即 completed。
       *   （平台 UI 无 1.25x 档也没关系：这里是直接改 playbackRate，站内 1.0/1.5/2.0 档位不影响。） */
      var getR = function(){ try { var x = parseFloat(localStorage.getItem('ncCc:rate') || '1.25'); return (x >= 1.1 ? x : 1.25); } catch(e){ return 1.25; } };
      var R = getR();
      // ★★ 2026-10-18 修（倍速掉回 1x 的真因）：
      //   播放器库自己会 Object.defineProperty(v,'playbackRate',{get(){return vt.call(this)}, set:...})
      //   （实测取到的 ownGet 就是 get(){return vt.call(this)}）—— 它把**我们的访问器直接覆盖**了。
      //   旧判据只看 v.__ccRateLock，这个标记还在 → 以为"已装好" → 再不去压，于是永远 1x
      //   （日志：段N 起播 ... @1x、实速 0.6~1.0，墙钟翻倍）。
      //   现在：**每 tick 校验 own descriptor 的 get 还是不是我们那个函数**，被覆盖就重新装。
      var lockOK = false;
      try {
        var dd = Object.getOwnPropertyDescriptor(v, 'playbackRate');
        lockOK = !!(dd && dd.get && dd.get === v.__ccLockGet);
      } catch (e) { lockOK = false; }
      if (!lockOK) {
        var myGet = function(){ return getR(); };
        Object.defineProperty(v, 'playbackRate', {
          configurable: true,
          get: myGet,
          set: function(_x){ /* 平台想写回 1x：一律忽略 */ }
        });
        v.__ccLockGet = myGet;
        v.__ccRateLock = 1;
      }
      // 每 tick 用原生 setter 把真实倍速压上去（这是绕过实例访问器的唯一通道）
      if (v.__ccNativeSet === undefined) { try { v.__ccNativeSet = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate').set; } catch(e){ v.__ccNativeSet = null; } }
      if (v.__ccNativeSet) { try { v.__ccNativeSet.call(v, R); } catch(e){} }
    } catch(e){}
    // ★★ 千万不要对【已播完】的视频调 play()：那会让它从头重播 → 制造无限循环，
    //    驱动等不到 "cur >= dur-2" 的判定 → 永远卡在同一段（实测踩过：resource 1408 已完成却一直循环）
    //    ⚠ 只判 !v.ended 不够：**MSE 流走到末尾时不一定会置 ended=true**（实测又循环了一次）
    //    → 追加**位置判据**：已经贴到末尾（>= dur-1.5s）就一律不碰（注意：本段在模板字符串里，别用反引号）
    var atEnd = v.duration > 0 && v.currentTime >= v.duration - 1.5;
    if (v.paused && !v.ended && !atEnd) { try { v.play().catch(function(){}); } catch(e){} }
    if (!v.__ccHooked) {
      v.__ccHooked = 1;
      v.addEventListener('playing', function(){ window.__ccLog.push('playing@' + Math.round(v.currentTime)); });
      v.addEventListener('pause', function(){ window.__ccLog.push('pause@' + Math.round(v.currentTime)); });
    }
  }, 300);
  window.__ccHuntBeat = Date.now();     // 装好先打一次心跳，免得首次自检误判
  return 'installed';
})()`;

/** 安装/确认猎捕器在位（幂等；每轮调用一次） */
export async function installHunter(tab) {
  try { return await tab.ev(HUNTER_JS); } catch (_) { return null; }
}

/** 停在「我的培训」空页时，点进去 */
export async function enterTraining(tab) {
  if (await tab.clickText('前往学习')) { await sleep(5000); return true; }
  if (await tab.clickText('进入')) { await sleep(6000); return true; }
  return false;
}

/**
 * ★★ 铁律：这个平台**只允许一个会话**。
 *   实测：同账号开 2 个标签 → /api/v1/video-progress/report 返回 **423 Locked**
 *   → media.ccjyxy.cn 的 HLS 流直接 ERR_FAILED，video.readyState 恒为 0（一点数据都没有）
 *   → 表现为"视频卡在 0 秒不动"。
 *   关掉多余标签后立刻恢复（实测 readyState 0→4、实速 2.00x）。
 *   这里自动收敛：把多余的 ccjyxy 标签关掉，只留当前这个。
 */
export async function enforceSingleTab(tab, log = () => { }) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${tab.port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    const pages = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
    if (pages.length <= 1) return 0;
    let closed = 0;
    for (const p of pages) {
      if (p.id === tab.targetId) continue;
      await fetch(`http://127.0.0.1:${tab.port}/json/close/${p.id}`).catch(() => { });
      closed++;
    }
    if (closed) log('  ⚠ 检测到 ' + pages.length + ' 个 ccjyxy 标签（多会话会触发 423 锁）→ 已关闭多余 ' + closed + ' 个');
    await sleep(3000);
    return closed;
  } catch (_) { return 0; }
}

/** 保证在培训页（学习总进度）。返回 true/false。
 *  ★ 实测坑：停在「我的培训」页时，有时「进入」按钮被一个空 DIV 盖住（elementFromPoint 返回 DIV，不是 button）
 *    → 点十几次都进不去。可靠兜底 = **整页导航回首页**（SPA 重载后 svc 会直接落到培训页）。 */
export async function ensureTraining(tab, log = () => { }) {
  let enterTries = 0;
  let backoffRounds = 0;      // ★ 「进入」连续失败的轮数 —— 用来决定退避多久
  for (let i = 0; i < 10; i++) {
    let s = await pageState(tab);
    if (s && s.onTrain) return true;
    if (!s) { await sleep(4000); continue; }
    if (s.onPlayer) { log('  播放器页 → 点「返回课程列表」'); await tab.clickText('返回课程列表'); await sleep(5000); continue; }
    if (s.onCourse) { log('  课程详情页 → 点「返回培训内容列表」'); await tab.clickText('返回培训内容列表'); await sleep(5000); continue; }
    if (s.onMyTraining) {
      enterTries++;
      log('  我的培训页 → 点「进入」（第 ' + enterTries + ' 次）');
      await tab.clickText('进入');
      await sleep(6000);
      if (enterTries >= 3) {
        // ★★ 退避等待（2026-10-16 主线实测结论，写在 docs/CC-STATUS-LEAD.md）：
        //   现象：停在「我的培训」时「进入」连点十几次都没反应（按钮在，点了不动）。
        //   根因：**服务端会话残留**（多半是上一次播放页没释放干净）——
        //         而【快速重试会让服务端一直看到"有新会话在敲门"，反而延长残留】。
        //   实测：干等 100 秒后一次就点通。
        //   所以：第 1 轮失败照旧 15 秒兜底；从第 2 轮起改成 **120 秒长退避**，别再硬撞。
        backoffRounds++;
        const waitMs = backoffRounds >= 2 ? 120000 : 15000;
        if (waitMs >= 60000) {
          log('  「进入」连续 ' + backoffRounds + ' 轮点不动 → 退避 ' + Math.round(waitMs / 1000) + ' 秒'
            + '（★ 疑似服务端会话残留；快速重试反而延长残留，这里主动让路）');
        } else {
          log('  「进入」点不动 → 整页导航回首页重进');
        }
        await sleep(waitMs);
        await tab.navigate(HOME); await sleep(waitMs >= 60000 ? 8000 : 13000);
        let s2 = await pageState(tab);
        if (s2 && s2.onTrain) return true;
        if (s2 && s2.onMyTraining) { await tab.clickText('进入'); await sleep(7000); s2 = await pageState(tab); }
        if (s2 && s2.onTrain) { backoffRounds = 0; return true; }
        enterTries = 0;
      }
      continue;
    }
    log('  未知页态 → 导航首页'); await tab.navigate(HOME); await sleep(12000);
  }
  log('  兜底：导航首页');
  await tab.navigate(HOME); await sleep(12000);
  let s = await pageState(tab);
  if (s && s.onMyTraining) { await tab.clickText('进入'); await sleep(7000); s = await pageState(tab); }
  return !!(s && s.onTrain);
}

/** 展开分类（cat：null=全部 / 0,1,2）。
 *  ★ 三条实测纪律：
 *   ① 只点「还没展开」的（点已展开的会折叠回去 → 枚举变 0）
 *   ② 点 summary 的**右侧文字区**（55% 宽处）；MUI 会忽略落在 expandIcon `<svg>` 上的点击
 *   ③ 点完必须校验 `Mui-expanded` 才认成功，否则继续重试
 */
export async function expand(tab, cat = null, log = () => { }) {
  const names = cat === null ? CATNAMES : [CATNAMES[cat]];
  for (const nm of names) {
    let ok = false;
    for (let k = 0; k < 8 && !ok; k++) {
      const info = await tab.ev(`(function(){
        var accs = Array.from(document.querySelectorAll('.MuiAccordion-root'));
        var a = accs.find(function(x){ var h=x.querySelector('h3'); return h && (h.innerText||'').indexOf(${JSON.stringify(nm)})>=0; });
        if (!a) return 'noacc';
        if (a.className.indexOf('Mui-expanded') >= 0) return 'open';
        // ★ 保险：这一栏的课程卡已经渲染出来了 → 说明它本来就是展开的，绝不再点（点了会折叠）
        var rendered = Array.from(a.querySelectorAll('.MuiListItem-root')).some(function(li){ return /编码[:：]/.test(li.innerText||'') && (li.offsetWidth||li.offsetHeight); });
        if (rendered) return 'open';
        var s = a.querySelector('.MuiAccordionSummary-root');
        if (!s) return 'nosum';
        var abs = s.getBoundingClientRect().top + window.scrollY;
        window.scrollTo(0, Math.max(0, Math.round(abs - window.innerHeight / 2)));
        s.scrollIntoView({block:'center'});
        var r = s.getBoundingClientRect();
        if (r.width < 40 || r.height < 8) return 'invisible';
        return JSON.stringify({
          x: Math.round(r.left + Math.min(r.width - 70, r.width * 0.55)),
          y: Math.round(r.top + r.height / 2),
          top: Math.round(r.top), h: Math.round(r.height), vh: window.innerHeight
        });
      })()`);
      if (info === 'open') { ok = true; break; }
      if (!info || info === 'noacc' || info === 'nosum' || info === 'invisible' || info.__err) { await sleep(1800); continue; }
      const b = JSON.parse(info);
      if (b.top < 12 || b.top > b.vh - 12) { await sleep(1200); continue; }
      await tab.clickAt(b.x, b.y);
      await sleep(1800);
      const chk = await tab.ev(`(function(){
        var accs = Array.from(document.querySelectorAll('.MuiAccordion-root'));
        var a = accs.find(function(x){ var h=x.querySelector('h3'); return h && (h.innerText||'').indexOf(${JSON.stringify(nm)})>=0; });
        return a && a.className.indexOf('Mui-expanded')>=0 ? 'open' : 'closed';
      })()`);
      if (chk === 'open') ok = true;
    }
    if (!ok) log('    ⚠ 分类「' + nm + '」展开失败（保持不动）');
  }
  await sleep(1200);
}

/** 枚举课程（cat 过滤；返回 name/cat/undone）。
 *  站点只渲染可视区域的课程卡（未渲染的 li 无文字）→ 先滚到底触发渲染。 */
export async function enumerate(tab, cat = null) {
  // 滚动 3 遍（顶部→底部→顶部），让懒加载卡片全部渲染
  await tab.ev(`(function(){ window.scrollTo(0, 0); return 1 })()`);
  await sleep(700);
  const H = await tab.ev(`(function(){ return document.documentElement.scrollHeight })()`);
  const steps = Math.min(14, Math.max(3, Math.ceil((H || 3000) / 700)));
  for (let i = 0; i <= steps; i++) {
    await tab.ev(`window.scrollTo(0, ${Math.round(i * ((H || 3000) / steps))})`);
    await sleep(500);
  }
  await sleep(800);
  const raw = await tab.ev(`JSON.stringify((function(){
    var out=[], seen={};
    var accs = Array.from(document.querySelectorAll('.MuiAccordion-root'));
    function catOf(el){
      for (var i=0;i<accs.length;i++){
        if (accs[i].contains(el)) {
          var h = accs[i].querySelector('h3.MuiAccordion-heading');
          var tx = h ? (h.innerText||'') : '';
          return /小初高公需/.test(tx)?0:(/初中学段通识/.test(tx)?1:(/初中数学|专业课/.test(tx)?2:null));
        }
      }
      return null;
    }
    Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root')).forEach(function(b){
      var t=(b.innerText||'').replace(/\\s+/g,' ').trim();
      if(!/编码[:：]/.test(t) || !/学时/.test(t)) return;
      var name=t.split('编码')[0].trim();
      if(!name||name.length>80||seen[name])return; seen[name]=1;
      // ★ 2026-10-19：带上**编码**（唯一）与平台自己的状态词 ——
      //   编码用于精确点开（同前缀课不会串门），状态词用于判 done（平台口径，不是"我试过"）。
      var mc=t.match(/编码[:：]\\s*([A-Za-z0-9_-]+)/);
      var st=/(已完成)/.test(t)?'已完成'
            :/(学习中)/.test(t)?'学习中'
            :/(已学习)/.test(t)?'已学习'
            :/(未学习)/.test(t)?'未学习':'';
      out.push({name:name, cat:catOf(b), code:mc?mc[1]:null, status:st, undone:!/(已完成|已学习|合格)/.test(t)});
    });
    return out;
  })())`);
  if (!raw || raw.__err) return [];
  let all;
  try { all = JSON.parse(raw); } catch (_) { return []; }
  return cat === null ? all : all.filter(x => x.cat === cat);
}

/** 打开课程（课程名）→ 等课程详情页
 *  ★ 2026-10-18 修（"打不开"的真因，此前把 52 门课全塞进跳过表）：
 *    MUI 手风琴**折叠时课程卡仍在 DOM 里，但 display:none → 宽高 0**。
 *    驱动用 ALL 模式先展开分类0/1/2，最后只有分类2是展开的 → 分类0/1 的卡宽 0
 *    → 旧代码 `if (r.width < 1) return null` → 直接报"列表里找不到" → 判死跳过。
 *    实测：单展开分类0 时同一门「国家安全教育」2 秒就进课程页（7 段，5 段已看完）。
 *    现在：卡片不存在/宽 0 时，先 expand(tab, cat) 把它自己的分类展开，再找一次。
 *  @param {number|null|undefined} cat 目标课所属分类（0/1/2，null=全部）
 *  @param {string|null} code 课程编码（如 C2601759）。**强烈建议传**：
 *    ★★ 2026-10-19 定位到的"假完成 / 死循环"总根因 ——
 *    旧写法只用 `name.slice(0,16)` 做子串匹配，而平台里**同系列课共享长前缀**：
 *      「初中数学新课标解读：核心素养的主要表现——运算能力」
 *      「初中数学新课标解读：核心素养的主要表现——推理能力」…（8 门，前 16 字完全一样）
 *      「指向核心素养的单元学历案编制——指向核心素养的教学 / 何为单元学历案？ / 编制」
 *    → `find()` 命中的是**列表里第一门**（往往是已完成的兄弟课）
 *    → 进去看到全是「重看」→ pendingSegments=0 → 被误判"无待播段/本课结束"→ 写 done 墓碑
 *    → 平台仍显示未学习 → 认领表被假墓碑堵死 → "没有可认领的课"死循环。
 *    实测（19:53）：按编码点 C2601759 → 正确打开「运算能力」，3 段全是「播放」，可播。
 *    现在：有 code 一律按 code 匹配；没有 code 时先要求**完整课程名相等**，最后才退回子串。
 */
export async function openCourse(tab, name, log = () => { }, cat = undefined, code = null) {
  const findCard = (nm) => tab.ev(`(function(){
      var bs = Array.from(document.querySelectorAll('.MuiListItemButton-root'));
      var CODE = ${JSON.stringify(code ? String(code) : '')};
      var NM = ${JSON.stringify(String(nm))};
      var b = null;
      if (CODE) b = bs.find(function(e){ return (e.innerText||'').indexOf(CODE) >= 0; });
      // 完整课程名（编码前的整段）必须相等 —— 杜绝同前缀串门
      if (!b) b = bs.find(function(e){ var t=(e.innerText||'').split('编码')[0]; return (t||'').replace(/\\s+/g,' ').trim() === NM; });
      if (!b) b = bs.find(function(e){ return (e.innerText||'').indexOf(NM) >= 0; });
      if (!b) return 'notfound'; b.scrollIntoView({block:'center'});
      var r = b.getBoundingClientRect(); if (r.width < 1) return 'zero';
      return JSON.stringify({x: Math.round(r.left + Math.min(48, r.width/2)), y: Math.round(r.top + r.height/2), t:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80)});
    })()`);
  for (let a = 1; a <= 3; a++) {
    let box = await findCard(name);
    // 卡在 DOM 但不可点（折叠）→ 展开它自己的分类再来一次
    if ((box === 'notfound' || box === 'zero' || !box || box.__err) && cat !== undefined && cat !== null) {
      log('  卡片不可点(' + (box === 'zero' ? '折叠·宽0' : String(box)) + ') → 重新展开分类[' + cat + ']');
      await expand(tab, cat, log);
      await sleep(1500);
      box = await findCard(name);
    }
    if (!box || box === 'notfound' || box === 'zero' || box.__err) { log('  列表里找不到 ' + name.slice(0, 16) + '（' + (box === 'zero' ? '折叠·宽0' : 'DOM 无此卡') + '）'); return false; }
    const b = JSON.parse(box);
    if (b.t) log('  点开卡片: ' + b.t.slice(0, 46));
    await tab.clickAt(b.x, b.y);
    for (let w = 0; w < 20; w++) {
      await sleep(2000);
      const s = await pageState(tab);
      if (s && (s.onCourse || s.onPlayer)) {
        // ★ 进课校验：课程页正文必须出现这个编码，否则说明又串门了 → 退回去重找
        if (code) {
          const has = await tab.ev(`(function(){ return ((document.body.innerText||'').indexOf(${JSON.stringify(String(code))}) >= 0) })()`);
          if (!has) {
            log('  ⚠ 进错课（页面无编码 ' + code + '）→ 退回重找');
            await backToTraining(tab, log);
            await sleep(3000);
            return false;
          }
        }
        log('  已进课程页(' + ((w + 1) * 2) + 's)' + (code ? ' 编码核对通过 ' + code : ''));
        return true;
      }
    }
    log('  第 ' + a + ' 次点开后仍未进课程（可能是弹层/加载慢）');
  }
  return false;
}

/** 播放一段：点第一个可播按钮 → 等 <video> 起播 → 返回起始状态 */
export async function playFirstSegment(tab, log = () => { }) {
  // ★ 挂在这里（而不是 cc-auto 主循环）的原因：本文件是共享库，cc-auto 被重写也不会丢掉这一句。
  //   猎捕器 = 页内常驻 300ms 轮询：视频一出现就 muted + 突破倍速锁 + play()。
  //   没有它，这个平台的播放器会在几秒内被 SPA 拆掉、永远起不来（实测结论）。
  try { await installHunter(tab); } catch (_) { }
  let s = await pageState(tab);
  if (!s) return null;
  if (s.onPlayer && s.video && !s.video.ended && !s.video.paused) return s.video;  // 已经在播
  // 站点的「播放」按钮用 DOM .click() 起播（实测有效；CDP 鼠标点在按钮上偶尔不触发）
  const r = await tab.ev(`(function(){
    var items = Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root')).filter(function(e){
      return /播放|继续|重播/.test(e.innerText||'') && !/编码/.test(e.innerText||''); });
    // ★★ 必须**两轮优选**：先找「播放/继续」（= 未完成），实在没有才退到「重播」（= 已完成）。
    //   旧写法按 DOM 顺序取第一个匹配 → 遇到"上一段已完成、按钮变成重播"时，会一直重播已完成的段，
    //   下一段永远不开始 → 课程永远不完成、学时永远不结算（实测：resource 1408 已完成却反复重播，1415 零进度）
    function pick(re){ for (var i=0;i<items.length;i++){ var b = Array.from(items[i].querySelectorAll('button')).find(function(x){ return re.test((x.innerText||'').trim()); }); if (b) return { i:i, b:b }; } return null; }
    var hit = pick(/^(播放|继续)$/) || pick(/^(重播)$/);
    if (hit) { var seg=(items[hit.i].innerText||'').replace(/\\s+/g,' ').trim().slice(0,34); hit.b.click(); return JSON.stringify({label:(hit.b.innerText||'').trim(), seg:seg}); }
    return null;
  })()`);
  if (!r || r.__err) return null;
  const o = JSON.parse(r);
  log('    点段[' + o.label + '] ' + o.seg);
  for (let w = 0; w < 25; w++) {
    await sleep(2000);
    const st = await pageState(tab);
    if (!st) continue;
    if (st.video && st.video.dur) {
      // 起播后若仍暂停（自动化环境没有真实手势），手动 play（muted）
      if (st.video.paused && w >= 3) {
        await tab.ev(`(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play()}catch(e){}}})()`);
      }
      if (!st.video.paused || w >= 8) return st.video;
    }
    if (!st.onCourse && !st.onPlayer && !st.onTrain) return null;
  }
  return null;
}

/** 当前课程页里还有可播段吗 */
export async function pendingSegments(tab) {
  return await tab.ev(`(function(){
    return Array.from(document.querySelectorAll('.MuiListItemButton-root')).filter(function(e){
      return Array.from(e.querySelectorAll('button')).some(function(b){ return /^(播放|继续|重播)$/.test((b.innerText||'').trim()); });
    }).length;
  })()`);
}

/** 关掉页面内 NetClass 用户脚本里**会捣乱的两块**，但保留倍速能力。
 *  实测教训（2026-10-15 20:00）：
 *    · autoNext=true 时它没有 ccjyxy 适配器 → 盲点站点「下一节」→ SPA 在 训练页/课程页 ping-pong
 *    · 直接 dispose() 整个脚本 → 倍速纠正一起没了（rateFixes 计数停在 0）
 *  正确姿势：脚本 enabled=true、autoNext=false、rate 由驱动器/站点给（实测 2x 能稳住，实速 1.87x） */
export async function killUserscript(tab) {
  return await tab.ev(`(function(){
    var r = { fixed: 0 };
    try {
      if (window.NetClass && window.NetClass.cfg) {
        var c = window.NetClass.cfg;
        c.enabled = true;          // 保留：倍速纠正 / 起播
        c.autoNext = false;        // 关掉：盲点「下一节」把 SPA 踢飞
        c.autoQuiz = false;
        c.antiPause = false;
        c.autoPlay = true;
        r.fixed = 1;
      }
      var KEY = 'netclass.cfg.v3';
      var cfg = {}; try { cfg = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { cfg = {}; }
      cfg.enabled = true;
      cfg.autoNext = false;
      cfg.autoQuiz = false;
      cfg.antiPause = false;
      cfg.autoPlay = true;
      localStorage.setItem(KEY, JSON.stringify(cfg));
      localStorage.setItem('ncCc:paused', '0');
    } catch (e) { }
    // 不再删面板：面板是 ops 视角，留着
    return JSON.stringify(r);
  })()`);
}

export { CATNAMES, HOME, sleep, listTabs as listCcTabs };

/** 从当前页回退到培训页（播放器→课程列表→课程→培训内容列表→培训页） */
export async function backToTraining(tab, log = () => { }) {
  for (let i = 0; i < 6; i++) {
    const s = await pageState(tab);
    if (!s) { await sleep(4000); continue; }
    if (s.onTrain) return true;
    if (s.onPlayer) { log('    回退：播放器页 → 返回课程列表'); await tab.clickText('返回课程列表'); await sleep(5000); continue; }
    if (s.onCourse) { log('    回退：课程详情 → 返回培训内容列表'); await tab.clickText('返回培训内容列表'); await sleep(6000); continue; }
    break;
  }
  // 靠点击回不去就交给 ensureTraining（它会用整页导航兜底）
  return await ensureTraining(tab, log);
}
