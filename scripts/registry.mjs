#!/usr/bin/env node
/**
 * scripts/registry.mjs —— 平台注册表读取器（P0）
 *
 * 目的：把「加平台要改代码」变成「加一个 JSON 块」。
 * 数据源：config/platforms.json（字段契约见 docs/AGENT-ARCHITECTURE.md §2）
 *
 * 纪律：
 *   - 只读：本文件不改任何既有行为，不碰浏览器、不碰 runs/ 状态。
 *   - 热读：按 mtime 缓存，文件改了下一次 load()/get()/targets() 就生效（另提供 reload() 强制丢弃缓存）。
 *   - validate() 真检查：必填字段 / 端口冲突 / 脚本文件存在 / 正则能编译 / auth.probe 能编译 / supervise 的启动参数存在。
 *
 * 对外 API
 *   load()              → 解析后的整份注册表（含 _meta），非法 JSON 抛错
 *   reload()            → 丢弃缓存（下次调用重读）
 *   keys()              → 平台 key 列表（不含 _ 开头的元数据）
 *   all() / platforms() → { key: config }
 *   get(key)            → 单条；不存在抛错并列出可用 key
 *   find(key)           → 单条或 null（不抛错）
 *   byCdp(port)         → 端口 → key（找不到 null）
 *   byHost(hostname)    → hostname → key（支持子域后缀匹配）
 *   globals()           → _meta.global 里的跨平台组件（如 progress-report）
 *   processes(key)      → 该平台 driver+watchers 的托管进程描述
 *   allProcesses()      → 全部平台 + 全局组件
 *   targets()           → ★ supervisor 直接可用的看护清单（已展开 {cdp}、已按 supervise.order 排序）
 *   supervisePorts()    → ★ 需要做 CDP 体检的端口（由 targets() 反推，去重升序）
 *   validate()          → { ok, errors[], warnings[] }
 *   ports()             → 端口占用表
 *
 * CLI
 *   node scripts/registry.mjs validate     校验并打印结果（有问题退出码 1）
 *   node scripts/registry.mjs list         列出所有平台
 *   node scripts/registry.mjs show <key>   打印单个平台的完整配置
 *   node scripts/registry.mjs ports        打印端口占用表（查冲突）
 *   node scripts/registry.mjs procs        打印全部托管进程（driver/watcher/global）
 *   node scripts/registry.mjs targets      打印 supervisor 会用的看护清单（验证数据驱动的等价性）
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const FILE = join(ROOT, 'config', 'platforms.json');

/** 合法枚举 */
export const CAPABILITIES = ['video', 'quiz', 'homework', 'post', 'exam'];
export const COMPLETION_KINDS = ['pageText', 'api', 'domClass', 'domAbsent'];

/** 每个平台块必须有的字段 */
const REQUIRED = ['label', 'host', 'cdp', 'capabilities', 'driver', 'watchers', 'completion', 'constraints', 'auth'];

/** 缓存：{ mtimeMs, size, doc } —— mtime 或 size 变了就重读（同一毫秒内改两次也能发现） */
let _cache = { mtimeMs: 0, size: -1, doc: null };

/** 读并解析整份注册表（带热重载）。JSON 非法/文件缺失 → 抛错。 */
export function load() {
  if (!existsSync(FILE)) throw new Error('找不到平台注册表 ' + FILE);
  const st = statSync(FILE);
  if (_cache.doc && _cache.mtimeMs === st.mtimeMs && _cache.size === st.size) return _cache.doc;
  let doc;
  try {
    doc = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (e) {
    throw new Error('config/platforms.json 不是合法 JSON：' + e.message);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('config/platforms.json 顶层必须是对象（key = 平台）');
  _cache = { mtimeMs: st.mtimeMs, size: st.size, doc };
  return doc;
}

/** 强制丢弃缓存（测试 / 明确要重读时用） */
export function reload() { _cache = { mtimeMs: 0, size: -1, doc: null }; }

/** 平台 key 列表（排除 _meta / _schema 等元数据块） */
export function keys() {
  return Object.keys(load()).filter(k => !k.startsWith('_'));
}

/** 全部平台：{ key: config } */
export function all() {
  const d = load();
  const out = {};
  for (const k of keys()) out[k] = d[k];
  return out;
}
/** all() 的别名（语义更直白） */
export const platforms = all;

/** 单个平台；不存在抛错并列出可用 key */
export function get(platform) {
  const d = load();
  if (!platform || String(platform).startsWith('_') || !d[platform]) {
    throw new Error('未知平台「' + platform + '」，可用：' + keys().join(' / '));
  }
  return d[platform];
}

/** 软查：不存在返回 null */
export function find(platform) {
  try { return get(platform); } catch { return null; }
}

/** 端口 → 平台 key（找不到 null） */
export function byCdp(port) {
  const p = Number(port);
  if (!Number.isFinite(p)) return null;
  const d = load();
  for (const k of keys()) if (Number(d[k].cdp) === p) return k;
  return null;
}

/** hostname → 平台 key（精确或子域后缀匹配；找不到 null） */
export function byHost(hostname) {
  if (!hostname) return null;
  const h = String(hostname).toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const d = load();
  let best = null;
  for (const k of keys()) {
    const dom = String(d[k].host || '').toLowerCase().trim();
    if (!dom) continue;
    if (h === dom || h.endsWith('.' + dom)) {
      if (!best || dom.length > String(d[best].host).length) best = k;   // 最长后缀优先
    }
  }
  return best;
}

/** 跨平台组件（_meta.global） */
export function globals() {
  const d = load();
  return (d._meta && Array.isArray(d._meta.global)) ? d._meta.global : [];
}

/** 展开 args 里的 {cdp} 占位符 */
export function expandArgs(args, platform) {
  const cdp = String(platform && platform.cdp !== undefined ? platform.cdp : '');
  return (Array.isArray(args) ? args : []).map(a => String(a).replace(/\{cdp\}/g, cdp));
}

/**
 * 把 driver/watchers 里的 `script` 变成 argv[0] 的相对路径。
 * 规则（与 docs/AGENT-ARCHITECTURE.md §4 的 startDriver 一致）：裸文件名 → scripts/<name>；
 * 带目录的（scripts/… 、runs/…、lab/…）原样返回。
 * 结果就是 supervisor spawn 时用的字面量（例：'scripts/cc-cycle.mjs'）。
 */
export function scriptArg(script) {
  if (!script) return null;
  const s = String(script);
  if (s.includes('/') || s.includes('\\')) return s.replace(/\\/g, '/');
  return 'scripts/' + s;
}

/** 平台 driver/watchers 的完整 argv（[脚本路径, ...参数]）；全局组件本来就是完整 argv */
export function argvOf(obj, platform) {
  if (!obj) return [];
  return [scriptArg(obj.script), ...expandArgs(obj.args, platform)].filter(x => x !== null);
}

/** 该平台的托管进程（driver + watchers），形状给 supervisor / orchestrator 用 */
export function processes(platformKey) {
  const p = get(platformKey);
  const out = [];
  const mk = (kind, obj) => {
    if (!obj) return;
    out.push({
      platform: platformKey,
      label: p.label,
      cdp: Number(p.cdp),
      kind,                                   // 'driver' | 'watcher'
      script: obj.script || null,
      args: expandArgs(obj.args, p),
      argv: argvOf(obj, p),
      singleton: obj.singleton !== false && p.driver.singleton !== false,
      uniq: obj.uniq !== false && obj.singleton !== false,
      watchOnly: obj.watchOnly === true,
      watchNote: obj.watchNote || null,
      readOnly: obj.readOnly === true,
      out: obj.out || null,
      err: obj.err || null,
      supervise: obj.supervise || null,
    });
  };
  mk('driver', p.driver);
  for (const w of (p.watchers || [])) mk('watcher', w);
  return out;
}

/** 全部平台的托管进程 + 全局组件 */
export function allProcesses() {
  const out = [];
  for (const k of keys()) out.push(...processes(k));
  for (const g of globals()) {
    out.push({
      platform: null, label: g.name, cdp: null, kind: 'global',
      script: String((g.args || [])[0] || '').replace(/^scripts\//, '') || null,
      args: (g.args || []).map(String),
      uniq: g.uniq !== false, watchOnly: g.watchOnly === true, watchNote: g.watchNote || null,
      readOnly: false, out: g.out || null, err: g.err || null,
      supervise: { name: g.name, match: g.match, order: g.order, uniq: g.uniq },
    });
  }
  return out;
}

/**
 * ★ supervisor 用的看护清单：只收带 `supervise` 块的进程（driver / watcher）+ _meta.global。
 * 已展开 {cdp}、已按 supervise.order 升序排好（order 相同则保持 JSON 里的先后）。
 * 返回元素可直接赋给 supervisor 的 TARGETS。
 */
export function targets() {
  const d = load();
  const out = [];
  const order = (sv) => (sv && Number.isFinite(Number(sv.order)) ? Number(sv.order) : 1000);
  for (const k of keys()) {
    const p = d[k];
    const push = (kind, obj) => {
      if (!obj || !obj.supervise) return;
      const sv = obj.supervise;
      out.push({
        platform: k,
        kind,
        cdp: Number(p.cdp),
        name: sv.name,
        match: sv.match,
        uniq: sv.uniq !== false && obj.singleton !== false,
        order: order(sv),
        args: argvOf(obj, p),
        out: obj.out || null,
        err: obj.err || null,
        // 只在真时出现：保持与改造前硬编码 TARGETS 的字段形状一致（缺省=不 watchOnly）
        ...(obj.watchOnly === true ? { watchOnly: true, watchNote: obj.watchNote || null } : {}),
      });
    };
    push('driver', p.driver);
    for (const w of (p.watchers || [])) push('watcher', w);
  }
  for (const g of globals()) {
    if (!g || !g.name) continue;
    out.push({
      platform: null, kind: 'global', cdp: null,
      name: g.name, match: g.match, uniq: g.uniq !== false, order: order(g),
      args: (g.args || []).map(String), out: g.out || null, err: g.err || null,
      ...(g.watchOnly === true ? { watchOnly: true, watchNote: g.watchNote || null } : {}),
    });
  }
  out.sort((a, b) => a.order - b.order);   // V8 的 sort 是稳定排序：order 打平时保持数据里的先后
  return out;
}

/** ★ 需要做 CDP 体检的端口：由 targets() 反推（去重升序）。今天的值应为 [9224,9227,9228] */
export function supervisePorts() {
  const s = new Set();
  for (const t of targets()) if (t.cdp) s.add(t.cdp);
  return [...s].sort((a, b) => a - b);
}

/** 解析脚本路径：先去 scripts/、再试 runs/、再按仓库根相对路径。返回存在的绝对路径或 null */
export function resolveScript(rel) {
  if (!rel) return null;
  const s = String(rel);
  const cands = [];
  if (isAbsolute(s)) cands.push(s);
  if (s.includes('/') || s.includes('\\')) cands.push(join(ROOT, s));
  else { cands.push(join(ROOT, 'scripts', s)); cands.push(join(ROOT, 'runs', s)); }
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { } }
  return null;
}

/** 编译正则（supervise.match 会被 supervisor 交给 PowerShell -match；这里先保证它是合法正则） */
function regexOk(src) {
  try { new RegExp(src); return true; } catch { return false; }
}
/** 编译页面内 JS 表达式（auth.probe 由 CDP Runtime.evaluate 执行；先在这里抓语法错） */
function exprOk(src) {
  try { new Function('return (' + src + ')'); return true; } catch { return false; }
}

/**
 * 校验注册表。
 * @returns {{ ok: boolean, errors: string[], warnings: string[], platforms: string[] }}
 */
export function validate() {
  const errors = [];
  const warnings = [];
  let d;
  try { d = load(); } catch (e) { return { ok: false, errors: [e.message], warnings, platforms: [] }; }

  const ks = keys();
  if (!ks.length) errors.push('注册表里一个平台都没有');

  const portMap = new Map();
  const seenName = new Map();

  for (const k of ks) {
    const p = d[k];
    const tag = `[${k}]`;

    // ── 必填 ─────────────────────────────────
    for (const f of REQUIRED) {
      const v = p[f];
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) errors.push(`${tag} 缺必填字段 ${f}`);
    }
    if (typeof p.label !== 'string' || !p.label.trim()) errors.push(`${tag} label 必须是非空字符串`);
    if (typeof p.host !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(p.host).trim())) errors.push(`${tag} host 不像主机名：${p.host}`);

    // ── 端口 ─────────────────────────────────
    const n = Number(p.cdp);
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.push(`${tag} cdp 端口非法：${p.cdp}`);
    else { if (!portMap.has(n)) portMap.set(n, []); portMap.get(n).push(k); }

    // ── 能力 ─────────────────────────────────
    if (!Array.isArray(p.capabilities)) errors.push(`${tag} capabilities 必须是数组`);
    else if (!p.capabilities.length) errors.push(`${tag} capabilities 不能为空（nl-dispatch 靠它判能不能派活）`);
    else for (const c of p.capabilities) if (!CAPABILITIES.includes(c)) warnings.push(`${tag} capabilities 含未知值「${c}」（合法：${CAPABILITIES.join('/')}）`);

    // ── driver ───────────────────────────────
    const drv = p.driver;
    if (!drv || typeof drv !== 'object' || Array.isArray(drv)) errors.push(`${tag} driver 必须是对象`);
    else {
      if (!Array.isArray(drv.args)) errors.push(`${tag} driver.args 必须是数组`);
      if (drv.script === null || drv.script === undefined) {
        warnings.push(`${tag} driver.script 为 null（无 Node 驱动，orchestrator 不能自动起它）`);
      } else {
        if (typeof drv.script !== 'string' || !drv.script.trim()) errors.push(`${tag} driver.script 必须是非空字符串或 null`);
        else if (!resolveScript(drv.script)) errors.push(`${tag} driver.script「${drv.script}」在 scripts/ 或 runs/ 下不存在`);
      }
    }

    // ── watchers ─────────────────────────────
    if (!Array.isArray(p.watchers)) errors.push(`${tag} watchers 必须是数组（没有就写 []）`);
    else for (const [i, w] of p.watchers.entries()) {
      if (!w || typeof w !== 'object') { errors.push(`${tag} watchers[${i}] 必须是对象`); continue; }
      if (!Array.isArray(w.args)) errors.push(`${tag} watchers[${i}].args 必须是数组`);
      if (typeof w.script !== 'string' || !w.script.trim()) errors.push(`${tag} watchers[${i}].script 缺失`);
      else if (!resolveScript(w.script)) errors.push(`${tag} watchers[${i}].script「${w.script}」在 scripts/ 或 runs/ 下不存在`);
    }

    // ── supervise（喂给 supervisor 的那一段）──
    const checkSup = (where, obj) => {
      if (!obj || !obj.supervise) return;
      const sv = obj.supervise;
      if (typeof sv.name !== 'string' || !sv.name.trim()) errors.push(`${tag} ${where}.supervise.name 缺失`);
      if (typeof sv.match !== 'string' || !sv.match.trim()) errors.push(`${tag} ${where}.supervise.match 缺失`);
      else if (!regexOk(sv.match)) errors.push(`${tag} ${where}.supervise.match 不是合法正则：${sv.match}`);
      if (sv.order !== undefined && !Number.isFinite(Number(sv.order))) errors.push(`${tag} ${where}.supervise.order 必须是数字`);
      if (seenName.has(sv.name)) errors.push(`${tag} ${where}.supervise.name「${sv.name}」与 ${seenName.get(sv.name)} 重名（日志会分不清）`);
      else seenName.set(sv.name, k);
      // supervisor 真的会 spawn 的是 argv[0] = scriptArg(script)，必须存在
      const a0 = scriptArg(obj.script);
      if (!a0) errors.push(`${tag} ${where} 有 supervise 但缺 script（supervisor 没法拉起）`);
      else if (!resolveScript(a0)) errors.push(`${tag} ${where} 的启动脚本「${a0}」不存在（supervisor 会拉起失败）`);
      if (!obj.out || !obj.err) warnings.push(`${tag} ${where} 有 supervise 但缺 out/err 日志路径`);
    };
    if (drv && typeof drv === 'object') checkSup('driver', drv);
    for (const [i, w] of (Array.isArray(p.watchers) ? p.watchers.entries() : [])) checkSup(`watchers[${i}]`, w);

    // ── 分类 ─────────────────────────────────
    if (p.categories !== null && p.categories !== undefined) {
      if (!Array.isArray(p.categories)) errors.push(`${tag} categories 必须是数组或 null`);
      else for (const [i, c] of p.categories.entries()) {
        if (!c || typeof c.key !== 'string' || !c.key.trim()) errors.push(`${tag} categories[${i}].key 缺失`);
        if (!c || !Number.isFinite(Number(c.goal))) errors.push(`${tag} categories[${i}].goal 必须是数字（学时）`);
      }
    }

    // ── 完成判据 ─────────────────────────────
    const cp = p.completion;
    if (!cp || typeof cp !== 'object') errors.push(`${tag} completion 缺失（orchestrator 无法验收）`);
    else {
      if (!COMPLETION_KINDS.includes(cp.kind)) errors.push(`${tag} completion.kind 非法：${cp.kind}（合法：${COMPLETION_KINDS.join('/')}）`);
      if (typeof cp.pattern !== 'string' || !cp.pattern.trim()) errors.push(`${tag} completion.pattern 缺失`);
      if (!cp.verified) warnings.push(`${tag} completion.verified 未标注日期（判据未复测）`);
      if (cp.verified && !/^\d{4}-\d{2}-\d{2}$/.test(String(cp.verified))) errors.push(`${tag} completion.verified 必须是 YYYY-MM-DD：${cp.verified}`);
    }

    // ── 约束 ─────────────────────────────────
    const cs = p.constraints;
    if (!cs || typeof cs !== 'object') errors.push(`${tag} constraints 缺失`);
    else {
      const mp = Number(cs.maxParallel);
      if (!Number.isInteger(mp) || mp < 1) errors.push(`${tag} constraints.maxParallel 必须是 >=1 的整数`);
      if (cs.creditsPerHour !== null && cs.creditsPerHour !== undefined && !Number.isFinite(Number(cs.creditsPerHour))) errors.push(`${tag} constraints.creditsPerHour 必须是数字或 null`);
      if (cs.accountingMaxRate !== null && cs.accountingMaxRate !== undefined && !Number.isFinite(Number(cs.accountingMaxRate))) errors.push(`${tag} constraints.accountingMaxRate 必须是数字或 null`);
    }

    // ── 登录 ─────────────────────────────────
    const au = p.auth;
    if (!au || typeof au !== 'object') errors.push(`${tag} auth 缺失（auth.mjs 无法工作）`);
    else {
      for (const f of ['loginUrl', 'probe', 'fields', 'captcha']) if (!(f in au)) errors.push(`${tag} auth.${f} 字段缺失（没有就写 null）`);
      if (au.probe === null || au.probe === undefined) warnings.push(`${tag} auth.probe 未填写（登录态不可机判）${au._probeUnverified ? ' · 已标 _probeUnverified' : ''}`);
      else if (typeof au.probe !== 'string') errors.push(`${tag} auth.probe 必须是字符串或 null`);
      else if (!exprOk(au.probe)) errors.push(`${tag} auth.probe 不是合法 JS 表达式：${au.probe}`);
      if (au.loginUrl === null) warnings.push(`${tag} auth.loginUrl 未填写`);
      if (!['none', 'image', 'sms', 'face'].includes(String(au.captcha))) errors.push(`${tag} auth.captcha 非法：${au.captcha}（none/image/sms/face）`);
    }

    if (p._probeUnverified) warnings.push(`${tag} 整块标了 _probeUnverified，接入前需实测`);
  }

  for (const [port, owners] of portMap) {
    if (owners.length > 1) errors.push(`端口 ${port} 被多个平台占用：${owners.join(', ')}`);
  }

  // ── 全局组件 ───────────────────────────────
  for (const g of globals()) {
    const gt = `_meta.global「${g && g.name}」`;
    if (!g || !g.name) { errors.push('_meta.global 有条目缺 name'); continue; }
    if (typeof g.match !== 'string' || !regexOk(g.match)) errors.push(`${gt} match 不是合法正则：${g.match}`);
    if (!Array.isArray(g.args) || !g.args.length) errors.push(`${gt} 缺 args`);
    else if (!resolveScript(g.args[0])) errors.push(`${gt} args[0]「${g.args[0]}」不存在`);
    if (g.order !== undefined && !Number.isFinite(Number(g.order))) errors.push(`${gt} order 必须是数字`);
  }

  // ── 看护清单自检 ───────────────────────────
  let tg = [];
  try { tg = targets(); } catch (e) { errors.push('targets() 失败：' + e.message); }
  if (!tg.length) warnings.push('看护清单为空（supervisor 将什么都不管）');

  return { ok: errors.length === 0, errors, warnings, platforms: ks };
}

/** 端口占用表：{ port: [key...] } */
export function ports() {
  const out = {};
  for (const k of keys()) { const n = Number(load()[k].cdp); (out[n] = out[n] || []).push(k); }
  return out;
}

// ── CLI ────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2] || 'list';
  try {
    if (cmd === 'validate') {
      const r = validate();
      console.log('注册表校验：' + (r.ok ? '✅ 通过' : '❌ 失败') + `  (ok=${r.ok}, errors=${r.errors.length})`);
      if (r.errors.length) { console.log('\n错误（必须修）：'); r.errors.forEach(e => console.log('  ✗ ' + e)); }
      if (r.warnings.length) { console.log('\n警告（可接受但要知道）：'); r.warnings.forEach(w => console.log('  ⚠ ' + w)); }
      console.log('\n平台数：' + r.platforms.length + '（' + r.platforms.join(' / ') + '）');
      console.log('看护端口：' + supervisePorts().join(',') + '  |  看护进程：' + targets().map(t => t.name).join(' → '));
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'list') {
      const d = load();
      console.log('平台注册表（config/platforms.json）\n');
      for (const k of keys()) {
        const p = d[k];
        const flag = p._probeUnverified ? '  ⚠未验证' : '';
        console.log(`  ${k.padEnd(11)} ${String(p.label).padEnd(14)} cdp=${String(p.cdp).padEnd(5)} host=${p.host}${flag}`);
        console.log(`  ${''.padEnd(11)} 能力=${(p.capabilities || []).join('/')}   driver=${(p.driver && p.driver.script) || '（无，页面内模块）'}   categories=${p.categories ? p.categories.length + '个' : 'null'}`);
        console.log(`  ${''.padEnd(11)} 完成判据=${p.completion && p.completion.kind}  verified=${p.completion && p.completion.verified}   auth.probe=${p.auth && p.auth.probe ? '已填' : 'null'}${p.auth && p.auth._probeUnverified ? '（未验证）' : ''}`);
      }
      console.log('\n全局组件：' + (globals().map(g => g.name).join(' / ') || '无'));
      console.log('端口占用：' + Object.entries(ports()).map(([p, a]) => p + '→' + a.join('+')).join('  '));
    } else if (cmd === 'show') {
      console.log(JSON.stringify(get(process.argv[3]), null, 2));
    } else if (cmd === 'ports') {
      for (const [p, a] of Object.entries(ports())) console.log(`  ${p}  ${a.length > 1 ? '⚠ 冲突：' : ''}${a.join(', ')}`);
    } else if (cmd === 'procs') {
      for (const pr of allProcesses()) {
        console.log(`  [${pr.platform || 'global'}] ${String(pr.kind).padEnd(8)} ${String(pr.script).padEnd(22)} ${pr.args.join(' ')}${pr.watchOnly ? '  (watchOnly)' : ''}`);
      }
    } else if (cmd === 'targets') {
      for (const t of targets()) {
        console.log(`  #${String(t.order).padEnd(4)} ${String(t.name).padEnd(12)} match=${String(t.match).padEnd(26)} args=${t.args.join(' ')}${t.watchOnly ? '  (watchOnly)' : ''}`);
      }
    } else {
      console.log('用法：node scripts/registry.mjs [validate|list|show <key>|ports|procs|targets]');
      process.exit(2);
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(1);
  }
}
