#!/usr/bin/env node
/**
 * scripts/registry.mjs —— 平台注册表读取器（P0）
 *
 * 目的：把"加平台要改代码"变成"加一个 JSON 块"。
 * 数据源：config/platforms.json（字段含义见 docs/AGENT-ARCHITECTURE.md §2）
 *
 * 纪律：
 *   - 不改任何已有行为；本文件只读。
 *   - validate() 要真检查（脚本文本是否存在 / 端口是否冲突 / 必填字段），不是摆设。
 *   - 文件改动后能热读到（按 mtime 判断，无需重启进程）。
 *
 * CLI：
 *   node scripts/registry.mjs validate     校验并打印结果（有问题时退出码 1）
 *   node scripts/registry.mjs list         列出所有平台
 *   node scripts/registry.mjs show <key>   打印单个平台的完整配置
 *   node scripts/registry.mjs ports        打印端口占用表（查冲突用）
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FILE = join(ROOT, 'config', 'platforms.json');

/** 内部缓存：{ mtimeMs, data } —— 文件变了就重读 */
let _cache = { mtimeMs: 0, data: null };

/** 必填字段（每个平台块都要有） */
const REQUIRED = ['label', 'host', 'cdp', 'capabilities', 'driver'];

/** 读原始 JSON（带 mtime 热重载） */
function raw() {
  if (!existsSync(FILE)) {
    throw new Error('找不到 ' + FILE + '（平台注册表缺失）');
  }
  const st = statSync(FILE);
  if (_cache.data && _cache.mtimeMs === st.mtimeMs) return _cache.data;
  let data;
  try {
    data = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (e) {
    throw new Error('config/platforms.json 不是合法 JSON：' + e.message);
  }
  _cache = { mtimeMs: st.mtimeMs, data };
  return data;
}

/** 强制丢弃缓存（测试用） */
export function reload() { _cache = { mtimeMs: 0, data: null }; }

/** 所有平台 key（排除 _meta） */
export function keys() {
  return Object.keys(raw()).filter(k => !k.startsWith('_'));
}

/** 全部平台（返回 { key: config }） */
export function all() {
  const d = raw();
  const out = {};
  for (const k of keys()) out[k] = d[k];
  return out;
}

/** 单个平台；不存在则抛错并列出可用 key */
export function get(platform) {
  const d = raw();
  if (!platform || platform.startsWith('_') || !d[platform]) {
    throw new Error('未知平台「' + platform + '」，可用：' + keys().join(' / '));
  }
  return d[platform];
}

/** 软查：不存在返回 null（不抛错） */
export function find(platform) {
  try { return get(platform); } catch { return null; }
}

/** 按 CDP 端口反查平台 key（找不到返回 null） */
export function byCdp(port) {
  const p = Number(port);
  for (const k of keys()) if (Number(raw()[k].cdp) === p) return k;
  return null;
}

/** 按 hostname 反查平台 key（支持子域后缀匹配） */
export function byHost(hostname) {
  if (!hostname) return null;
  const h = String(hostname).toLowerCase();
  for (const k of keys()) {
    const dom = String(raw()[k].host || '').toLowerCase();
    if (!dom) continue;
    if (h === dom || h.endsWith('.' + dom)) return k;
  }
  return null;
}

/** 全局组件（不属于某个平台，比如 progress-report） */
export function globals() {
  const d = raw();
  return (d._meta && d._meta.global) ? d._meta.global : [];
}

/** 该平台的全部「托管进程」描述（driver + watchers），展开成 supervisor 能用的形状 */
export function processes(platformKey) {
  const p = get(platformKey);
  const out = [];
  const mk = (kind, obj) => {
    if (!obj) return;
    const args = (obj.args || []).map(a => String(a).replace('{cdp}', String(p.cdp)));
    out.push({
      platform: platformKey,
      label: p.label,
      kind,                          // 'driver' | 'watcher'
      script: obj.script,
      args,
      uniq: obj.uniq !== false,
      watchOnly: obj.watchOnly === true || (kind === 'driver' && p.driver.watchOnly === true),
      out: obj.out || null,
      err: obj.err || null,
      match: obj.script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),  // 用于进程匹配的正则
    });
  };
  mk('driver', p.driver);
  for (const w of (p.watchers || [])) mk('watcher', w);
  return out;
}

/** 全部平台的托管进程（含全局组件） */
export function allProcesses() {
  const out = [];
  for (const k of keys()) out.push(...processes(k));
  for (const g of globals()) {
    out.push({
      platform: null, label: g.name, kind: 'global',
      script: (g.args && g.args[0] ? String(g.args[0]).replace(/^scripts\//, '') : ''),
      args: g.args || [], uniq: g.uniq !== false, watchOnly: g.watchOnly === true,
      out: g.out || null, err: g.err || null,
      match: (g.match || '').replace(/\\\\/g, '\\'),
    });
  }
  return out;
}

/**
 * 校验注册表。
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validate() {
  const errors = [];
  const warnings = [];
  let d;
  try { d = raw(); } catch (e) { return { ok: false, errors: [e.message], warnings }; }

  const ks = keys();
  if (!ks.length) errors.push('注册表里一个平台都没有');

  // ── 端口冲突 ──────────────────────────────
  const portMap = {};
  for (const k of ks) {
    const p = d[k];
    for (const f of REQUIRED) {
      if (p[f] === undefined || p[f] === null || p[f] === '') errors.push(`[${k}] 缺必填字段 ${f}`);
    }
    if (p.cdp !== undefined) {
      const n = Number(p.cdp);
      if (!Number.isInteger(n) || n < 1 || n > 65535) errors.push(`[${k}] cdp 端口非法：${p.cdp}`);
      else {
        (portMap[n] = portMap[n] || []).push(k);
      }
    }
    if (!Array.isArray(p.capabilities) || !p.capabilities.length) {
      errors.push(`[${k}] capabilities 必须是非空数组`);
    } else {
      const VALID = ['video', 'quiz', 'homework', 'post', 'exam'];
      for (const c of p.capabilities) if (!VALID.includes(c)) warnings.push(`[${k}] capabilities 含未知值「${c}」（合法：${VALID.join('/')}）`);
    }
    // 驱动脚本存在性
    const drv = p.driver && p.driver.script;
    if (!drv) errors.push(`[${k}] 缺 driver.script`);
    else {
      const cand = [join(ROOT, 'scripts', drv), join(ROOT, 'runs', drv)];
      if (!cand.some(existsSync)) warnings.push(`[${k}] driver.script「${drv}」在 scripts/ 或 runs/ 下都找不到（可能在 lab/ 或未实现）`);
    }
    // watchers 脚本存在性
    for (const w of (p.watchers || [])) {
      if (!w.script) { errors.push(`[${k}] watchers 有条目缺 script`); continue; }
      const cand = [join(ROOT, 'scripts', w.script), join(ROOT, 'runs', w.script)];
      if (!cand.some(existsSync)) warnings.push(`[${k}] watcher「${w.script}」找不到`);
    }
    // 完成判据
    if (!p.completion || !p.completion.kind) warnings.push(`[${k}] 缺 completion 判据（orchestrator 无法验收）`);
    else if (!p.completion.verified) warnings.push(`[${k}] completion 未标注 verified 日期`);
    // auth
    if (!p.auth) warnings.push(`[${k}] 缺 auth 段（auth.mjs 无法工作）`);
    else if (p.auth.probe === null || p.auth.probe === undefined) warnings.push(`[${k}] auth.probe 未填写（登录态探测不可用）`);
    // 未验证标记
    if (p._probeUnverified) warnings.push(`[${k}] 整块标记为 _probeUnverified，接入前需实测`);
  }
  for (const [port, owners] of Object.entries(portMap)) {
    if (owners.length > 1) errors.push(`端口 ${port} 被多个平台占用：${owners.join(', ')}`);
  }

  // ── 全局组件 ──────────────────────────────
  for (const g of globals()) {
    if (!g.name) errors.push('_meta.global 有条目缺 name');
    if (!Array.isArray(g.args) || !g.args.length) errors.push(`_meta.global「${g.name}」缺 args`);
    else {
      const s = String(g.args[0]).replace(/^scripts\//, '');
      if (!existsSync(join(ROOT, 'scripts', s)) && !existsSync(join(ROOT, 'runs', s))) {
        warnings.push(`_meta.global「${g.name}」的脚本 ${s} 找不到`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 端口占用表（查冲突用） */
export function ports() {
  const out = {};
  for (const k of keys()) {
    const n = Number(raw()[k].cdp);
    (out[n] = out[n] || []).push(k);
  }
  return out;
}

// ── CLI ────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2] || 'list';
  try {
    if (cmd === 'validate') {
      const r = validate();
      console.log('注册表校验：' + (r.ok ? '✅ 通过' : '❌ 失败'));
      if (r.errors.length) { console.log('\n错误（必须修）：'); r.errors.forEach(e => console.log('  ✗ ' + e)); }
      if (r.warnings.length) { console.log('\n警告（可接受但要知道）：'); r.warnings.forEach(w => console.log('  ⚠ ' + w)); }
      console.log('\n平台数：' + keys().length + '（' + keys().join(' / ') + '）');
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'list') {
      const ps = ports();
      console.log('平台注册表（config/platforms.json）\n');
      for (const k of keys()) {
        const p = raw()[k];
        const flag = p._probeUnverified ? ' ⚠未验证' : '';
        console.log(`  ${k.padEnd(12)} ${String(p.label).padEnd(16)} cdp=${String(p.cdp).padEnd(5)} host=${p.host}${flag}`);
        console.log(`  ${''.padEnd(12)} 能力=${(p.capabilities || []).join('/')}  驱动=${p.driver && p.driver.script}  分类=${p.categories ? p.categories.length + '个' : '无'}`);
      }
      console.log('\n全局组件：' + globals().map(g => g.name).join(' / '));
      console.log('端口占用：' + Object.entries(ps).map(([p, a]) => p + '→' + a.join('+')).join('  '));
    } else if (cmd === 'show') {
      console.log(JSON.stringify(get(process.argv[3]), null, 2));
    } else if (cmd === 'ports') {
      for (const [p, a] of Object.entries(ports())) {
        console.log(`  ${p}  ${a.length > 1 ? '⚠ 冲突：' : ''}${a.join(', ')}`);
      }
    } else if (cmd === 'procs') {
      for (const pr of allProcesses()) {
        console.log(`  [${pr.platform || 'global'}] ${pr.kind.padEnd(8)} ${pr.script}  ${pr.args.join(' ')}${pr.watchOnly ? '  (watchOnly)' : ''}`);
      }
    } else {
      console.log('用法：node scripts/registry.mjs [validate|list|show <key>|ports|procs]');
      process.exit(2);
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(1);
  }
}
