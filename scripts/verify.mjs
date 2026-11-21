#!/usr/bin/env node
/**
 * scripts/verify.mjs —— 统一验收：5 种 completion.kind 的适配器
 *
 * 只做**读取与判定**，不推进度（推进是驱动的活）。
 *
 * 统一返回
 * --------
 *   { platform, done, total, pct, unit, kind, source, evidence[], lagSec, verifiedAt, status }
 *   status: ok        —— 读到了并对上了
 *           offline   —— CDP 不可达 / 没有匹配的页面（数字一律 null，不编）
 *           no-target —— 端口通但没有该平台的页面
 *           unparsed  —— 页面读到了，但 completion.pattern 对不上（配置或页面变了）
 *
 * 5 种 kind 的现状（诚实版）
 * -------------------------
 *   pageText   ✅ 通用（正则两捕获组 = done/total；单捕获组 = 计数）
 *   domClass   ✅ 通用（pattern 选择器 + classes.done / classes.todo）
 *   domAbsent  ✅ 通用（元素不存在 = 完成）
 *   videoEnd   ✅ 通用（currentTime / duration）
 *   api        ⚠ 结构就位，但通用化不了：zhihuishu / qiyang 的 completion 里只有
 *                人类可读的 endpoint 描述（"POST learning/queryStuyInfo"、"getUrl + '&current_time='"），
 *                没有可执行的请求定义。要跑起来得先在数据层补 `completion.expr`（页面内 JS 表达式），
 *                那属于改 config 语义，本阶段不动 → 返回 unparsed 并说明缺什么。
 *
 * 用法
 * ----
 *   node scripts/verify.mjs --platform ccjyxy [--json] [--port N]
 *   node scripts/verify.mjs --all --json
 *   node scripts/verify.mjs --selftest        # 纯解析函数，不连浏览器
 */
import { fileURLToPath } from 'node:url';
import { get, keys, all } from './registry.mjs';

// ─────────────────────────────────────────────────────────────
// unit 回落表
// ─────────────────────────────────────────────────────────────
// 平台显式写 completion.unit 就用它；否则按 kind 回落。
// 这张表是「没有更好信息时的口径名」，不是数值，不影响任何判定。
const UNIT_BY_KIND = {
  pageText: '条',
  domClass: '任务点',
  domAbsent: '视频',
  videoEnd: '视频',
  api: '条目',
};

// ─────────────────────────────────────────────────────────────
// 纯解析函数（--selftest 直接喂它们）
// ─────────────────────────────────────────────────────────────

/** pageText：正则两捕获组 = (done,total)；单捕获组 = 命中计数；零捕获 = 命中布尔 */
export function parsePageText(pattern, text) {
  if (typeof pattern !== 'string' || !pattern) return { status: 'unparsed', why: 'completion.pattern 缺失' };
  if (typeof text !== 'string') return { status: 'unparsed', why: '页面正文不可读' };
  let re;
  try { re = new RegExp(pattern); } catch (e) { return { status: 'unparsed', why: 'pattern 不是合法正则：' + e.message }; }

  const m = text.match(re);
  if (!m) return { status: 'unparsed', why: 'pattern 在页面正文里没有命中', pattern };

  const g = m.length - 1;
  if (g >= 2) {
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(done) || !Number.isFinite(total)) {
      return { status: 'unparsed', why: '捕获组不是数字：' + m[1] + ' / ' + m[2] };
    }
    return { status: 'ok', done, total, evidence: [m[0]] };
  }
  if (g === 1) {
    // 单捕获组：按「匹配到的条目数」计
    const all = [...text.matchAll(new RegExp(pattern, 'g'))];
    const done = all.length;
    return { status: 'ok', done, total: done, evidence: ['命中 ' + done + ' 处：' + m[0]] };
  }
  return { status: 'ok', done: 1, total: 1, evidence: ['命中布尔判据：' + m[0]] };
}

/** domClass：pattern 选择器 + classes.done / classes.todo */
export function parseDomClass(counts, classes) {
  const done = Number(counts && counts.done);
  const todo = Number(counts && counts.todo);
  if (!Number.isFinite(done) || !Number.isFinite(todo)) return { status: 'unparsed', why: 'DOM 计数不可读' };
  const total = done + todo;
  if (!total) return { status: 'unparsed', why: '选择器命中 0 个元素（页面没到该状态或 pattern 过期）' };
  return {
    status: 'ok', done, total,
    evidence: ['done(' + (classes && classes.done) + ')=' + done, 'todo(' + (classes && classes.todo) + ')=' + todo],
  };
}

/** domAbsent：元素不存在 = 完成 */
export function parseDomAbsent(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return { status: 'unparsed', why: '元素计数不可读' };
  return {
    status: 'ok',
    done: n === 0 ? 1 : 0,
    total: 1,
    evidence: [n === 0 ? '目标元素不存在 → 判完成' : '目标元素仍在（' + n + ' 个）→ 未完成'],
  };
}

/** videoEnd：currentTime / duration */
export function parseVideoEnd(ct, dur, threshold = 0.995) {
  const c = Number(ct);
  const d = Number(dur);
  if (!Number.isFinite(c) || !Number.isFinite(d) || d <= 0) {
    return { status: 'unparsed', why: '没有可读的 video currentTime/duration' };
  }
  const ratio = c / d;
  return {
    status: 'ok',
    done: Math.round(c * 100) / 100,
    total: Math.round(d * 100) / 100,
    evidence: ['currentTime=' + Math.round(c) + ' / duration=' + Math.round(d) + '  ratio=' + ratio.toFixed(4) + (ratio >= threshold ? ' → 已到尾部' : ' → 未到尾部')],
    reachedTail: ratio >= threshold,
  };
}

/** 百分比：0–100 取整；total 为 0 时返回 null（不制造 NaN） */
export function pctOf(done, total) {
  const d = Number(done);
  const t = Number(total);
  if (!Number.isFinite(d) || !Number.isFinite(t) || t <= 0) return null;
  return Math.round(Math.min(100, (d / t) * 100));
}

// ─────────────────────────────────────────────────────────────
// CDP 读取
// ─────────────────────────────────────────────────────────────
async function cdpList(port, timeoutMs = 6000) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  return r.json();
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP ws 连接失败')));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, timeout = 20000) {
        const id = ++seq;
        return new Promise((res, rej) => {
          pend.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
          setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, timeout);
        });
      },
      close() { try { ws.close(); } catch { } },
    }));
  });
}

/** 在匹配 host 的页面里取 innerText */
async function readPageText(port, host, scope) {
  let list;
  try { list = await cdpList(port); } catch (e) { return { status: 'offline', why: '端口 ' + port + ' CDP 不可达：' + e.message }; }
  const pages = list.filter((t) => t.type === 'page' && !/tampermonkey|devtools/i.test(t.url));
  const hit = pages.find((t) => host && t.url.includes(host)) || (scope === 'any' ? pages[0] : null);
  if (!hit) return { status: 'no-target', why: '端口 ' + port + ' 上没找到 ' + (host || scope) + ' 的页面', urls: pages.map((p) => p.url.slice(0, 90)) };
  const c = await cdpConnect(hit.webSocketDebuggerUrl);
  try {
    const r = await c.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
    return { status: 'ok', text: r.result?.value ?? '', url: hit.url };
  } finally { c.close(); }
}

async function evalOnPage(port, host, expression) {
  let list;
  try { list = await cdpList(port); } catch (e) { return { status: 'offline', why: '端口 ' + port + ' CDP 不可达：' + e.message }; }
  const pages = list.filter((t) => t.type === 'page' && !/tampermonkey|devtools/i.test(t.url));
  const hit = pages.find((t) => host && t.url.includes(host)) || null;
  if (!hit) return { status: 'no-target', why: '端口 ' + port + ' 上没找到 ' + host + ' 的页面' };
  const c = await cdpConnect(hit.webSocketDebuggerUrl);
  try {
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) return { status: 'unparsed', why: 'JS 异常：' + (r.exceptionDetails.exception?.description || '').slice(0, 160) };
    return { status: 'ok', value: r.result?.value, url: hit.url };
  } finally { c.close(); }
}

// ─────────────────────────────────────────────────────────────
// 单平台验收
// ─────────────────────────────────────────────────────────────
export async function verify(key, opts = {}) {
  const p = get(key);
  const cp = p.completion || {};
  const kind = cp.kind;
  const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : Number(p.cdp);
  const host = String(p.host || '');
  const lagSec = (p.profile && p.profile.accounting && Number.isFinite(p.profile.accounting.settleLagSec))
    ? p.profile.accounting.settleLagSec : 0;

  const base = {
    platform: key,
    kind,
    source: cp.scope || null,
    lagSec,
    verifiedAt: cp.verified || null,
    // unit 优先级：平台显式 completion.unit > pattern 里写明的量纲 > kind 回落表。
    // ccjyxy 的 pattern 本身就是「已修 (…)/达标 (…) 学时」，所以量纲是 学时，不用猜。
    unit: cp.unit || (/学时/.test(String(cp.pattern || '')) ? '学时' : (UNIT_BY_KIND[kind] || '条')),
    port,
  };

  // ── videoEnd ──
  if (kind === 'videoEnd') {
    const r = await evalOnPage(port, host, `(function(){var v=document.querySelector('video');return v?{ct:v.currentTime,dur:v.duration}:null})()`);
    if (r.status !== 'ok') return { ...base, status: r.status, done: null, total: null, pct: null, evidence: [r.why] };
    if (!r.value) return { ...base, status: 'no-target', done: null, total: null, pct: null, evidence: ['页面上没有 <video>（未打开播放页？）'] };
    const j = parseVideoEnd(r.value.ct, r.value.dur);
    return { ...base, status: j.status, done: j.done ?? null, total: j.total ?? null, pct: pctOf(j.done, j.total), evidence: j.evidence || [j.why], reachedTail: j.reachedTail };
  }

  // ── domClass ──
  if (kind === 'domClass') {
    const sel = cp.pattern;
    const cls = cp.classes || {};
    const expr = `(function(){try{
      var es=Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
      var doneRe=new RegExp(${JSON.stringify(cls.done || '$^')}), todoRe=new RegExp(${JSON.stringify(cls.todo || '$^')});
      return { n: es.length,
               done: es.filter(function(e){return doneRe.test(e.className)}).length,
               todo: es.filter(function(e){return todoRe.test(e.className)}).length };
    }catch(e){return {err:String(e)}}})()`;
    const r = await evalOnPage(port, host, expr);
    if (r.status !== 'ok') return { ...base, status: r.status, done: null, total: null, pct: null, evidence: [r.why] };
    if (!r.value || r.value.err) return { ...base, status: 'unparsed', done: null, total: null, pct: null, evidence: ['DOM 读取失败：' + (r.value && r.value.err)] };
    const j = parseDomClass(r.value, cls);
    return { ...base, status: j.status, done: j.done ?? null, total: j.total ?? null, pct: pctOf(j.done, j.total), evidence: j.evidence || [j.why] };
  }

  // ── domAbsent ──
  if (kind === 'domAbsent') {
    const sel = cp.pattern;
    const r = await evalOnPage(port, host, `(function(){try{return document.querySelectorAll(${JSON.stringify(sel)}).length}catch(e){return -1}})()`);
    if (r.status !== 'ok') return { ...base, status: r.status, done: null, total: null, pct: null, evidence: [r.why] };
    if (r.value === -1) return { ...base, status: 'unparsed', done: null, total: null, pct: null, evidence: ['选择器非法：' + sel] };
    const j = parseDomAbsent(r.value);
    return { ...base, status: j.status, done: j.done, total: j.total, pct: pctOf(j.done, j.total), evidence: j.evidence };
  }

  // ── api ──（要 completion.expr 才能通用执行；现有配置里没有 → 说清缺什么）
  if (kind === 'api') {
    if (!cp.expr) {
      return {
        ...base, status: 'unparsed', done: null, total: null, pct: null,
        evidence: [
          'completion.kind=api，但配置里只有人类可读的 endpoint 描述：' + JSON.stringify(cp.endpoint || null),
          'api 适配器需要 completion.expr（页面内可直接执行的 JS 表达式，返回 {done,total}）。补进数据层后本适配器即可用，代码无需再改。',
          'pattern 语义：' + JSON.stringify(cp.pattern || null),
        ],
      };
    }
    const r = await evalOnPage(port, host, cp.expr);
    if (r.status !== 'ok') return { ...base, status: r.status, done: null, total: null, pct: null, evidence: [r.why] };
    const v = r.value || {};
    if (!Number.isFinite(Number(v.done)) || !Number.isFinite(Number(v.total))) {
      return { ...base, status: 'unparsed', done: null, total: null, pct: null, evidence: ['expr 返回值不是 {done,total}：' + JSON.stringify(v).slice(0, 160)] };
    }
    return { ...base, status: 'ok', done: Number(v.done), total: Number(v.total), pct: pctOf(v.done, v.total), evidence: ['expr 返回 ' + JSON.stringify(v).slice(0, 120)] };
  }

  // ── pageText（默认）──
  if (kind === 'pageText') {
    const t = await readPageText(port, host, cp.scope);
    if (t.status !== 'ok') return { ...base, status: t.status, done: null, total: null, pct: null, evidence: [t.why].concat(t.urls || []) };
    const j = parsePageText(cp.pattern, t.text);
    return { ...base, status: j.status, done: j.done ?? null, total: j.total ?? null, pct: pctOf(j.done, j.total), evidence: j.evidence || [j.why], url: t.url };
  }

  return { ...base, status: 'unparsed', done: null, total: null, pct: null, evidence: ['未知 completion.kind：' + kind] };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const val = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes('--' + n);

  if (has('selftest')) {
    let bad = 0;
    const chk = (label, cond, detail) => {
      if (cond) { console.log('  ✓ ' + label); return; }
      bad++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
    };

    // ccjyxy 的生产正则 + P5 验收要求的数字
    const j1 = parsePageText('已修\\s*([\\d.]+)\\s*/\\s*达标\\s*(\\d+)\\s*学时', '…职业科目 已修 71.1 / 达标 90 学时 …');
    chk('parsePageText 71.1/90', j1.status === 'ok' && j1.done === 71.1 && j1.total === 90, JSON.stringify(j1));
    chk('pctOf(71.1,90) = 79', pctOf(71.1, 90) === 79, String(pctOf(71.1, 90)));

    const j2 = parsePageText('已修\\s*([\\d.]+)\\s*/\\s*达标\\s*(\\d+)\\s*学时', '完全没有匹配的正文');
    chk('parsePageText 不匹配 → unparsed', j2.status === 'unparsed', JSON.stringify(j2));

    const j3 = parsePageText('(', 'x');
    chk('parsePageText 非法正则 → unparsed', j3.status === 'unparsed', JSON.stringify(j3));

    const j4 = parseDomClass({ done: 12, todo: 5 }, { done: 'blue', todo: 'orange01|jobCount' });
    chk('parseDomClass 12/17', j4.status === 'ok' && j4.done === 12 && j4.total === 17, JSON.stringify(j4));
    chk('parseDomClass 0 元素 → unparsed', parseDomClass({ done: 0, todo: 0 }, {}).status === 'unparsed');

    const j5 = parseDomAbsent(0);
    chk('parseDomAbsent 0 个 → 完成', j5.status === 'ok' && j5.done === 1 && j5.pct === undefined && pctOf(j5.done, j5.total) === 100, JSON.stringify(j5));
    chk('parseDomAbsent 3 个 → 未完成', parseDomAbsent(3).done === 0);

    const j6 = parseVideoEnd(20654, 20664);
    chk('parseVideoEnd 尾部', j6.status === 'ok' && j6.reachedTail === true, JSON.stringify(j6));
    chk('parseVideoEnd 中段', parseVideoEnd(1000, 20664).reachedTail === false);
    chk('parseVideoEnd duration=0 → unparsed', parseVideoEnd(1, 0).status === 'unparsed');

    chk('pctOf 除以零返回 null（不产生 NaN）', pctOf(5, 0) === null);
    chk('pctOf 上限 100', pctOf(120, 90) === 100);

    // 每个平台都能解析出 unit / kind，且 5 种 kind 全覆盖
    const cfg = all();
    const kinds = new Set();
    for (const k of Object.keys(cfg)) kinds.add(cfg[k].completion && cfg[k].completion.kind);
    chk('注册表覆盖 5 种 completion.kind', ['pageText', 'api', 'domClass', 'domAbsent', 'videoEnd'].every((x) => kinds.has(x)), [...kinds].join(','));

    console.log(bad ? '\n❌ ' + bad + ' 项未过' : '\n✅ all pass');
    process.exit(bad ? 1 : 0);
  }

  const asJson = has('json');
  const one = val('platform');
  const portOpt = val('port') ? Number(val('port')) : undefined;

  if (!one && !has('all')) {
    console.error('用法：node scripts/verify.mjs --platform <key> [--json] [--port N]');
    console.error('      node scripts/verify.mjs --all --json');
    console.error('      node scripts/verify.mjs --selftest');
    console.error('可用平台：' + keys().join(' / '));
    process.exit(2);
  }

  (async () => {
    const list = one ? [one] : keys();
    const out = [];
    for (const k of list) out.push(await verify(k, { port: portOpt }));

    if (asJson) {
      console.log(JSON.stringify(one ? out[0] : out, null, 2));
    } else {
      for (const r of out) {
        const num = (v) => (v === null || v === undefined ? '—' : v);
        console.log(`${r.platform.padEnd(12)} ${String(r.status).padEnd(9)} ${String(r.kind).padEnd(9)} ${num(r.done)}/${num(r.total)}  ${num(r.pct)}%  ${r.unit}  (port ${r.port}${r.verifiedAt ? ', verified ' + r.verifiedAt : ''})`);
        for (const e of (r.evidence || [])) console.log('                 · ' + e);
      }
    }
    // 有平台 ok 就算成功；全部非 ok 时退出码 1（便于脚本判断），但不影响输出
    process.exit(out.some((r) => r.status === 'ok') ? 0 : 1);
  })().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
