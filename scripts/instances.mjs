#!/usr/bin/env node
/**
 * scripts/instances.mjs —— 实例注册表：端口分配 / profile 隔离 / 资源闸门
 *
 * 模型
 * ----
 *   1 实例 = 1 浏览器进程 = 1 个独占 user-data-dir = 1 个 CDP 端口
 *   同一平台可以开多个实例（不同账号，各用一份 profile 副本）
 *
 * 端口
 * ----
 *   9224–9249  静态默认位（7 个平台各占一格，向后兼容现有计划任务与隧道脚本）
 *   9250–9399  动态池（额外实例从这里取第一个空闲，并用 9400 起的号段做探活）
 *
 * 为什么保留静态位
 * ----------------
 * 现有的 `NetClassVis-*` 计划任务、`tunnel.ps1 -Port 9228`、`registry.mjs byCdp`
 * 全都锚在静态端口上。改掉等于自毁，所以只做"向后兼容的扩展"。
 *
 * 资源闸门
 * --------
 * 实测：单实例空闲 ~180–250MB，播视频 ~450–700MB。
 * 8GB 机器安全上限 4–6 个，所以默认 maxConcurrent = 4，超出的排队而不是硬起。
 *
 * profile
 * -------
 *   绝不共享（Chrome 有单实例锁）。
 *   同平台多账号的正确姿势：登录一次 → 关浏览器 → clone 出 N 份 → N 个实例并行。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, '..');

export const STATIC_BASE = 9224;
export const STATIC_END = 9249;
export const DYN_START = 9250;
export const DYN_END = 9399;
export const DEFAULT_MAX = 4;

// ---------------------------------------------------------------- 路径
function stateDir() {
  const base = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local') : null)
    || join(process.env.HOME || '.', '.local', 'share');
  return join(base, 'NetClass');
}
export function instancesDir() { return join(stateDir(), 'instances'); }
export function profilesDir() { return join(stateDir(), 'profiles'); }
export function instanceProfile(id) { return join(profilesDir(), id); }
function instanceFile(id) { return join(instancesDir(), id + '.json'); }

function ensureDirs() {
  for (const d of [instancesDir(), profilesDir()]) mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------- 平台注册表
export function loadPlatforms() {
  const p = join(REPO, 'config', 'platforms.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

/** 平台默认端口（platforms.json 里的 cdp） */
export function defaultPort(platform) {
  const pl = loadPlatforms();
  return pl[platform]?.cdp ?? null;
}

// ---------------------------------------------------------------- id
/** 平台 + 4 位短哈希，便于人肉辨认，也便于同平台多实例区分 */
export function makeId(platform, seed) {
  const s = String(seed || Date.now() + Math.random());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `${platform}--${h.toString(16).padStart(4, '0').slice(-4)}`;
}

// ---------------------------------------------------------------- 读写
export function listInstances() {
  ensureDirs();
  const out = [];
  for (const f of readdirSync(instancesDir())) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(instancesDir(), f), 'utf8'));
      j._file = join(instancesDir(), f);
      out.push(j);
    } catch { }
  }
  return out.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
}

export function getInstance(id) {
  const p = instanceFile(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function saveInstance(inst) {
  ensureDirs();
  inst.updatedAt = new Date().toISOString();
  writeFileSync(instanceFile(inst.id), JSON.stringify(inst, null, 2));
  return inst;
}

export function removeInstance(id) {
  try { rmSync(instanceFile(id), { force: true }); } catch { }
}

// ---------------------------------------------------------------- 端口
async function portInUse(port) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1200);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

/** 同步的端口占用粗检（不依赖网络）：Windows 用 netstat，其他用 /proc 或 ss */
function portBound(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, { encoding: 'utf8', timeout: 4000, windowsHide: true });
      return /LISTENING/.test(out);
    }
  } catch { }
  return false;
}

/**
 * 分配端口。
 *  - platform 给了且默认位空闲 → 用默认位（向后兼容）
 *  - 否则从动态池取第一个空闲
 */
export async function allocatePort(platform) {
  // ★ 只把【活着】的实例算进占用。把已死实例的端口也算进去，
  //   会导致刚 stop 掉的默认位永远拿不回来（实测踩到：9227 释放后仍被跳过）。
  const used = new Set(listInstances().filter((i) => pidAlive(i.pid)).map((i) => i.port));
  const want = defaultPort(platform);

  if (want && !used.has(want) && !(await portInUse(want))) return want;

  for (let p = DYN_START; p <= DYN_END; p++) {
    if (used.has(p)) continue;
    if (await portInUse(p)) continue;
    return p;
  }
  throw new Error(`端口池 ${DYN_START}-${DYN_END} 已耗尽`);
}

// ---------------------------------------------------------------- 闸门
export function maxConcurrent() {
  const n = Number(process.env.NETCLASS_MAX_INSTANCES || 0);
  return n > 0 ? n : DEFAULT_MAX;
}

/** 只数"活着"的实例（有 pid 且进程还在） */
export function aliveCount() {
  return listInstances().filter((i) => pidAlive(i.pid)).length;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 闸门：能不能再起一个？
 * 返回 { ok, reason }
 */
export function gate() {
  const max = maxConcurrent();
  const alive = aliveCount();
  if (alive >= max) {
    return {
      ok: false,
      reason: `已达并发上限 ${alive}/${max}（NETCLASS_MAX_INSTANCES 可调）。` +
        `先 netclass stop <id> 释放，或等其中一个跑完。`,
      alive, max,
    };
  }
  return { ok: true, alive, max };
}

// ---------------------------------------------------------------- 状态机
export const STATES = ['starting', 'needs_login', 'running', 'idle', 'blocked', 'dead'];

export function setState(id, state, patch = {}) {
  const i = getInstance(id);
  if (!i) return null;
  i.state = state;
  i.lastHeartbeat = new Date().toISOString();
  Object.assign(i, patch);
  return saveInstance(i);
}

// ---------------------------------------------------------------- profile
export function createProfile(id, { cloneFrom } = {}) {
  ensureDirs();
  const dst = instanceProfile(id);
  if (cloneFrom) {
    const src = instanceProfile(cloneFrom);
    if (!existsSync(src)) throw new Error(`源 profile 不存在: ${src}`);
    // Node 17+ 有 fs.cpSync
    cpSync(src, dst, { recursive: true });
  } else {
    mkdirSync(dst, { recursive: true });
  }
  return dst;
}

export function profileSize(id) {
  const p = instanceProfile(id);
  if (!existsSync(p)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const fp = join(d, e.name);
      try {
        if (e.isDirectory()) walk(fp);
        else total += statSync(fp).size;
      } catch { }
    }
  };
  try { walk(p); } catch { }
  return total;
}

// ---------------------------------------------------------------- 展示
const ICON = {
  starting: '◌', needs_login: '🔑', running: '▶', idle: '⏸', blocked: '⛔', dead: '✖',
};

export function formatTable(instances = listInstances()) {
  if (!instances.length) return '（没有实例）\n先跑： netclass up --platform <key>';
  const head = ['ID', '平台', '端口', '状态', '任务/进度', 'PID', '心跳'];
  const rows = instances.map((i) => {
    const alive = pidAlive(i.pid);
    const st = alive ? (i.state || 'unknown') : 'dead';
    const prog = i.task ? `${i.task.kind || ''} ${i.task.progress || ''}`.trim() : '—';
    return [
      i.id,
      i.platform || '?',
      String(i.port || ''),
      `${ICON[st] || '?'} ${st}`,
      prog,
      alive ? String(i.pid) : `${i.pid || '?'}(死)`,
      (i.lastHeartbeat || '').slice(11, 19) || '—',
    ];
  });
  const w = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmt = (r) => r.map((v, c) => (c === 0 ? v.padEnd(w[c]) : v.padEnd(w[c]))).join('  ');
  return [fmt(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(fmt)].join('\n');
}

// ---------------------------------------------------------------- CLI
async function main() {
  const cmd = process.argv[2] || 'ps';
  const id = process.argv[3];

  if (cmd === 'ps' || cmd === 'list') { console.log(formatTable()); return; }

  if (cmd === 'show') {
    const i = id ? getInstance(id) : null;
    if (!i) { console.error('没有这个实例: ' + id); process.exit(1); }
    console.log(JSON.stringify({ ...i, _alive: pidAlive(i.pid), _profileSizeMB: +(profileSize(i.id) / 1048576).toFixed(1) }, null, 2));
    return;
  }

  if (cmd === 'rm') {
    if (!id) { console.error('用法: instances.mjs rm <id>'); process.exit(1); }
    const i = getInstance(id);
    if (i && pidAlive(i.pid)) { console.error(`实例 ${id} 还活着（pid ${i.pid}），先 netclass stop ${id}`); process.exit(1); }
    removeInstance(id);
    console.log('已移除记录: ' + id + '（profile 保留，需要清用 --purge）');
    if (process.argv.includes('--purge')) {
      rmSync(instanceProfile(id), { recursive: true, force: true });
      console.log('已删除 profile: ' + instanceProfile(id));
    }
    return;
  }

  if (cmd === 'gate') {
    const g = gate();
    console.log(`并发 ${g.alive}/${g.max}  ${g.ok ? '✅ 可以再起' : '⛔ ' + g.reason}`);
    return;
  }

  if (cmd === 'port') {
    const pl = process.argv[3];
    const p = await allocatePort(pl);
    console.log(`${pl || '(无平台)'} → ${p}${p === defaultPort(pl) ? '（平台默认位）' : '（动态池）'}`);
    return;
  }

  if (cmd === 'profiles') {
    ensureDirs();
    const ps = readdirSync(profilesDir());
    if (!ps.length) { console.log('（没有 profile）'); return; }
    for (const p of ps) {
      const mb = +(profileSize(p) / 1048576).toFixed(1);
      console.log(`  ${p.padEnd(24)} ${String(mb).padStart(7)}MB`);
    }
    return;
  }

  console.log('用法: node scripts/instances.mjs <ps|show <id>|rm <id> [--purge]|gate|port <platform>|profiles>');
}

if (process.argv[1]?.endsWith('instances.mjs')) {
  main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
