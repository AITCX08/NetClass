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
const HOME = 'https://col.ccjyxy.cn';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function listTabs(port) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    return l.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
  } catch (_) { return null; }
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
  if (cur && !cur.tag && cur.done) { writeClaims(o); return false; }   // 已完成的排到队尾
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
/** 清掉我的认领（用 completed=true 排到队尾，避免马上又抢回来） */
export function releaseCourse(name, tag, completed = false) {
  const o = readClaims();
  if (!o[name]) return;
  if (completed) { o[name] = { tag: '', at: Date.now(), done: true }; }
  else delete o[name];
  writeClaims(o);
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
  if (window.__ccHunt) return 'already';
  window.__ccLog = [];
  window.__ccHunt = setInterval(function(){
    function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
    var v = f(document); if (!v) return;
    try { v.muted = true; } catch(e){}
    try {
      var R = parseFloat(localStorage.getItem('ncCc:rate') || '2');
      // ★ 倍速锁突破（学习通同款招法）：站点在 ratechange 后会把 playbackRate 写回 1x。
      //   把实例上的该属性定义成"恒返回目标值"的 getter → 站点的写回被接管、失效；
      //   真正的底层倍速由原生 setter 压上去。实测长春从锁死的 1x → 实速 2.05x（总时长直接砍半）
      if (!v.__ccRateLock) {
        Object.defineProperty(v, 'playbackRate', {
          configurable: true,
          get: function(){ return R; },
          set: function(x){ if (Math.abs(x - R) < 0.01) { try { Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'playbackRate').set.call(v, x); } catch(e){} } }
        });
        v.__ccRateLock = 1;
      }
      try { Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'playbackRate').set.call(v, R); } catch(e){}
    } catch(e){}
    if (v.paused) { try { v.play().catch(function(){}); } catch(e){} }
    if (!v.__ccHooked) {
      v.__ccHooked = 1;
      v.addEventListener('playing', function(){ window.__ccLog.push('playing@' + Math.round(v.currentTime)); });
      v.addEventListener('pause', function(){ window.__ccLog.push('pause@' + Math.round(v.currentTime)); });
    }
  }, 300);
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

/** 保证在培训页（学习总进度）。返回 true/false */
export async function ensureTraining(tab, log = () => { }) {
  await enforceSingleTab(tab, log);        // ★ 每轮先收敛到单标签（多标签会 423 锁死）
  await installHunter(tab);                // ★ 确保猎捕器在位（倍速锁 + 起播都靠它）
  for (let i = 0; i < 8; i++) {
    let s = await pageState(tab);
    if (s && s.onTrain) return true;
    if (!s) { await sleep(4000); continue; }
    if (s.onPlayer) { log('  播放器页 → 点「返回课程列表」'); await tab.clickText('返回课程列表'); await sleep(5000); continue; }
    if (s.onCourse) { log('  课程详情页 → 点「返回培训内容列表」'); await tab.clickText('返回培训内容列表'); await sleep(5000); continue; }
    if (s.onMyTraining) { log('  我的培训页 → 点「进入」'); await tab.clickText('进入'); await sleep(6000); continue; }
    log('  未知页态 → 刷新页面'); await tab.reload(); await sleep(9000);
  }
  // 最后兜底：直接导航首页 + 进入培训
  log('  兜底：导航首页');
  await tab.navigate(HOME); await sleep(9000);
  let s = await pageState(tab);
  if (s && s.onMyTraining) { await tab.clickText('进入'); await sleep(7000); s = await pageState(tab); }
  return !!(s && s.onTrain);
}

/** 展开分类（cat：null=全部 / 0,1,2）。
 *  MUI Accordion：必须真鼠标点击 `.MuiAccordionSummary-root` 左侧区域，
 *  点按钮正中间有可能落在内部按钮上（实测点了不生效）。 */
export async function expand(tab, cat = null, log = () => { }) {
  const names = cat === null ? CATNAMES : [CATNAMES[cat]];
  for (const nm of names) {
    let ok = false;
    for (let k = 0; k < 6 && !ok; k++) {
      const res = await tab.ev(`(function(){
        var accs = Array.from(document.querySelectorAll('.MuiAccordion-root'));
        var a = accs.find(function(x){ var h=x.querySelector('h3'); return h && (h.innerText||'').indexOf(${JSON.stringify(nm)})>=0; });
        if (!a) return 'noacc';
        if (a.className.indexOf('Mui-expanded') >= 0) return 'open';
        var s = a.querySelector('.MuiAccordionSummary-root'); if (!s) return 'nosum';
        s.scrollIntoView({block:'center'});
        var r = s.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return 'invisible';
        return JSON.stringify({x: Math.round(r.left + 22), y: Math.round(r.top + r.height/2), y2: Math.round(r.top + Math.min(20, r.height/2))});
      })()`);
      if (res === 'open') { ok = true; break; }
      if (!res || res === 'noacc' || res === 'nosum' || res === 'invisible' || res.__err) { await sleep(2000); continue; }
      const b = JSON.parse(res);
      await tab.clickAt(b.x, b.y);
      await sleep(2000);
      const chk = await tab.ev(`(function(){
        var accs = Array.from(document.querySelectorAll('.MuiAccordion-root'));
        var a = accs.find(function(x){ var h=x.querySelector('h3'); return h && (h.innerText||'').indexOf(${JSON.stringify(nm)})>=0; });
        return a ? (a.className.indexOf('Mui-expanded') >= 0 ? 'open' : 'closed') : 'noacc';
      })()`);
      if (chk === 'open') ok = true;
    }
    if (!ok) log('    ⚠ 分类「' + nm + '」展开失败');
  }
  await sleep(1500);
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
          return /小初高公需/.test(tx)?0:(/初中学段通识/.test(tx)?1:(/专业课/.test(tx)?2:null));
        }
      }
      return null;
    }
    Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root')).forEach(function(b){
      var t=(b.innerText||'').replace(/\\s+/g,' ').trim();
      if(!/编码[:：]/.test(t) || !/学时/.test(t)) return;
      var name=t.split('编码')[0].trim();
      if(!name||name.length>80||seen[name])return; seen[name]=1;
      out.push({name:name, cat:catOf(b), undone:!/(已完成|已学习|合格)/.test(t)});
    });
    return out;
  })())`);
  if (!raw || raw.__err) return [];
  let all;
  try { all = JSON.parse(raw); } catch (_) { return []; }
  return cat === null ? all : all.filter(x => x.cat === cat);
}

/** 打开课程（课程名）→ 等课程详情页 */
export async function openCourse(tab, name, log = () => { }) {
  for (let a = 1; a <= 3; a++) {
    const box = await tab.ev(`(function(){
      var bs = Array.from(document.querySelectorAll('.MuiListItemButton-root'));
      var b = bs.find(function(e){ return (e.innerText||'').indexOf(${JSON.stringify(name.slice(0, 16))}) >= 0; });
      if (!b) return null; b.scrollIntoView({block:'center'});
      var r = b.getBoundingClientRect(); if (r.width < 1) return null;
      return JSON.stringify({x: Math.round(r.left + Math.min(48, r.width/2)), y: Math.round(r.top + r.height/2)});
    })()`);
    if (!box || box.__err) { log('  列表里找不到 ' + name.slice(0, 16)); return false; }
    const b = JSON.parse(box);
    await tab.clickAt(b.x, b.y);
    for (let w = 0; w < 20; w++) {
      await sleep(2000);
      const s = await pageState(tab);
      if (s && (s.onCourse || s.onPlayer)) { log('  已进课程页(' + ((w + 1) * 2) + 's)'); return true; }
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
    for (var i=0;i<items.length;i++){
      var b = Array.from(items[i].querySelectorAll('button')).find(function(x){ return /^(播放|继续|重播)$/.test((x.innerText||'').trim()); });
      if (b) { var seg=(items[i].innerText||'').replace(/\\s+/g,' ').trim().slice(0,34); b.click(); return JSON.stringify({label:(b.innerText||'').trim(), seg:seg}); }
    }
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

/** 关掉页面内的 NetClass 用户脚本 —— 实测它会在播放器页反复「按停播放」，
 *  导致 <video> 被 pause()、startSegment 的 play() 被中断（错误：play() request was interrupted by a call to pause()）。
 *  纯视频任务不需要它（它也没有 ccjyxy 适配器）。 */
export async function killUserscript(tab) {
  return await tab.ev(`(function(){
    var r = { disposed: 0, panel: 0 };
    try { if (window.NetClass && window.NetClass.dispose) { window.NetClass.dispose(); r.disposed = 1; } } catch (e) { }
    try {
      if (window.NetClass && window.NetClass.cfg) {
        window.NetClass.cfg.enabled = false; window.NetClass.cfg.autoPlay = false;
        window.NetClass.cfg.antiPause = false; window.NetClass.cfg.autoNext = false;
      }
      var KEY = 'netclass.cfg.v3';
      var cfg = {}; try { cfg = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { cfg = {}; }
      cfg.enabled = false; cfg.autoPlay = false; cfg.autoNext = false; cfg.autoQuiz = false; cfg.antiPause = false;
      localStorage.setItem(KEY, JSON.stringify(cfg));
      localStorage.setItem('ncCc:paused', '0');
    } catch (e) { }
    var p = document.getElementById('netclass-panel'); if (p) { p.remove(); r.panel = 1; }
    var b = document.getElementById('netclass-banner'); if (b) b.remove();
    return JSON.stringify(r);
  })()`);
}

export { CATNAMES, HOME, sleep, listTabs as listCcTabs };

/** 从当前页回退到培训页（播放器→课程列表→课程→培训内容列表→培训页） */
export async function backToTraining(tab, log = () => { }) {
  for (let i = 0; i < 10; i++) {
    const s = await pageState(tab);
    if (!s) { await sleep(4000); continue; }
    if (s.onTrain) return true;
    if (s.onPlayer) { log('    回退：播放器页 → 返回课程列表'); await tab.clickText('返回课程列表'); await sleep(5000); continue; }
    if (s.onCourse) { log('    回退：课程详情 → 返回培训内容列表'); await tab.clickText('返回培训内容列表'); await sleep(6000); continue; }
    if (s.onMyTraining) { log('    回退：我的培训 → 进入'); await tab.clickText('进入'); await sleep(6000); continue; }
    log('    回退：未知页态 → 刷新'); await tab.reload(); await sleep(10000);
  }
  return !!(await pageState(tab))?.onTrain;
}
