#!/usr/bin/env node
/**
 * scripts/orchestrator.mjs —— 任务编排器（P1，第一版：只读）
 *
 * 职责（对应 docs/AGENT-ARCHITECTURE.md §4）：
 *   读任务单 → 推导状态 → 排班判断 → 汇报。**这一版不 spawn/不 kill 任何进程。**
 *
 * 为什么先做只读版（重要）：
 *   长春正跑着 10 小时任务。接管进程管理必须先证明"状态机 + 排班 + 验收"逻辑是对的，
 *   否则一旦它按错误判断去重启/重复拉起驱动，10 小时的任务会被打断。
 *   所以 v1 只做「观察 + 推导 + 记录」，把真实状态和它推导的状态摆在一起对比；
 *   等长春跑完（或人工确认）再开 `--manage` 接管。
 *
 * 单一写者约定（重要）：
 *   task.state 只由本模块写。但 v1 只写「观测字段」（derived / lastSeen / alerts），
 *   **不改 state 本身**，避免和现有 supervisor 打架。
 *
 * CLI：
 *   node scripts/orchestrator.mjs list                 列出所有任务 + 推导状态
 *   node scripts/orchestrator.mjs show <taskId>        单个任务详情
 *   node scripts/orchestrator.mjs summary              汇总（按平台/状态）
 *   node scripts/orchestrator.mjs tick                 跑一轮推导（写 derived 字段）
 *   node scripts/orchestrator.mjs submit '<json>'      提交一个任务单（或 --file <path>）
 *   node scripts/orchestrator.mjs new --platform ccjyxy --type video --goal 90
 *                                                     便捷建单
 *   node scripts/orchestrator.mjs run [--interval 30] [--once]
 *                                                     主循环（只读）
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as registry from './registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TASKS_DIR = join(ROOT, 'runs', 'tasks');
const ORCH_LOG = join(ROOT, 'runs', 'orchestrator.log');
const STALL_MS = 40 * 60 * 1000;      // 40 分钟不动算可疑（与看护纪律一致）

// ── 工具 ────────────────────────────────────────
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { mkdirSync(dirname(ORCH_LOG), { recursive: true }); writeFileSync(ORCH_LOG, line + '\n', { flag: 'a' }); } catch (_) { }
}

// ── 任务单读写（契约见 docs/AGENT-ARCHITECTURE.md §1）────────
export function loadAll() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8')); }
      catch (e) { log(`⚠ 任务单 ${f} 不是合法 JSON：${e.message}`); return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function getTask(id) {
  const p = join(TASKS_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function saveTask(t) {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(join(TASKS_DIR, `${t.id}.json`), JSON.stringify(t, null, 2));
  return t;
}

// ── 观测：真实系统状态（只读）────────────────────────────
/** 当前在跑的 node 进程（按脚本名归类） */
function runningProcs() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    ).trim();
    if (!out) return [];
    const arr = JSON.parse(out);
    return (Array.isArray(arr) ? arr : [arr]).map(p => ({
      pid: p.ProcessId,
      cmd: String(p.CommandLine || ''),
    }));
  } catch (_) { return []; }
}

/** 某平台当前是否有驱动在跑 */
function driverRunning(platformKey, procs) {
  const reg = registry.get(platformKey);
  const drv = reg.driver && reg.driver.script;
  if (!drv) return { running: false, reason: '该平台无 Node 驱动（driver.script=null）' };
  const hit = procs.find(p => p.cmd.includes(drv));
  return hit ? { running: true, pid: hit.pid } : { running: false, reason: `没找到 ${drv} 进程` };
}

/** 读平台真实进度（平台口径）—— v1 用 CDP 页面读，失败则用缓存 */
function readProgress(platformKey) {
  const reg = registry.get(platformKey);
  const cacheFile = join(ROOT, 'runs', 'cc-stats-cache.json');
  // 长春有专门的缓存（cc-auto 每次停在培训页会刷新）
  // ★ 2026-10-19：缓存是【嵌套】结构，别读错层级：
  //   { "total": {"done":71.1,"target":90}, "cats":[{"cat":0,"done":30.9,"target":30,"raw":"..."}], "onTrain":true, "at":1792374839475 }
  if (platformKey === 'ccjyxy' && existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
      const done = Number(c?.total?.done);
      const target = Number(c?.total?.target ?? reg.categories?.reduce((s, x) => s + (x.goal || 0), 0) ?? 90);
      if (!Number.isFinite(done)) {
        return { ok: false, source: 'cache', now: null, goal: target, reason: '缓存里 total.done 不是数字（结构变了？）' };
      }
      return {
        ok: true, source: 'cache',
        now: done, goal: target,
        cats: (c.cats || []).map(x => ({
          idx: x.cat,
          key: reg.categories?.[x.cat]?.key ?? null,
          done: Number(x.done), target: Number(x.target),
          met: Number(x.done) >= Number(x.target),
        })),
        cacheAt: c.at ? new Date(Number(c.at)).toISOString() : null,
        staleMin: c.at ? Math.round((Date.now() - Number(c.at)) / 60000) : null,
      };
    } catch (e) {
      return { ok: false, source: 'cache', now: null, goal: 90, reason: '缓存解析失败：' + e.message };
    }
  }
  // 其它平台 v1 返回未知（不瞎猜）
  return { ok: false, source: null, now: null, goal: null, reason: `${platformKey} 暂无可用进度源（v1 只接长春缓存）` };
}

// ── 推导：把真实状态映射成任务应该处于的状态 ───────────────
/**
 * ★ v1 的关键：不改 task.state，只产出 derived 供对比。
 *   这样即便推导逻辑有 bug，也不会影响正在跑的自动化。
 */
export function derive(t, procs) {
  const reg = registry.find(t.platform);
  if (!reg) return { derived: 'failed', why: `平台 ${t.platform} 不在注册表` };

  const prog = readProgress(t.platform);
  const drv = driverRunning(t.platform, procs);

  // 目标达成？
  const goal = (t.target && t.target.goal) || {};
  const reached = (prog.ok && prog.goal && prog.now !== null && prog.now >= prog.goal);

  let derived, why;
  if (reached) { derived = 'done'; why = `平台学时 ${prog.now}/${prog.goal} 已达标`; }
  else if (drv.running) { derived = 'running'; why = `驱动在跑（pid=${drv.pid}）`; }
  else if (!drv.running && !drv.reason?.includes('无 Node 驱动')) { derived = 'queued'; why = drv.reason; }
  else { derived = 'blocked'; why = drv.reason; }

  return {
    derived, why,
    observed: {
      at: now(),
      progress: prog,
      driver: drv,
      processes: procs.filter(p => p.cmd.includes('cc-') || p.cmd.includes('cx-') || p.cmd.includes('ss-')).length,
    },
  };
}

/** 算出该任务的告警（供人快速判断） */
export function alerts(t, d) {
  const out = [];
  const p = d.observed && d.observed.progress;
  // 学时长时间不动（用 lastSeen 里的历史）
  const hist = t._hist || [];
  if (p && p.ok && p.now !== null) {
    const prev = hist.length ? hist[hist.length - 1] : null;
    if (prev && prev.now === p.now) {
      const staleMs = Date.now() - new Date(prev.at).getTime();
      if (staleMs > STALL_MS) out.push(`学时 ${p.now} 已 ${Math.round(staleMs / 60000)} 分钟未变（>40min 需查，但平台批量记账属正常）`);
    }
  }
  if (d.derived === 'queued' && t.state === 'running') out.push('任务标记 running 但驱动不在 → 可能已死');
  if (d.derived === 'blocked') out.push(d.why);
  if (!p || !p.ok) out.push('读不到平台进度（验收会失败）');
  return out;
}

// ── 主循环（只读）──────────────────────────────────
export async function run({ interval = 30, once = false } = {}) {
  log('=== orchestrator v1 启动（只读模式：不 spawn / 不 kill / 不改 state）===');
  const v = registry.validate();
  log(`注册表校验：${v.ok ? '✅ 通过' : '❌ 失败'}（${registry.keys().length} 平台）`);
  if (!v.ok) { v.errors.forEach(e => log('  ✗ ' + e)); }

  for (; ;) {
    const procs = runningProcs();
    const tasks = loadAll();
    if (!tasks.length) log('（没有任务单；用 submit 或 new 建一个）');
    for (const t of tasks) {
      const d = derive(t, procs);
      const al = alerts(t, d);
      // 只写观测字段，不动 state
      t._derived = d.derived;
      t._derivedWhy = d.why;
      t._observed = d.observed;
      t._alerts = al;
      t._hist = [...(t._hist || []).slice(-20), { at: now(), now: d.observed.progress?.now ?? null }];
      saveTask(t);
      // ★ 日志里带上进度与分类达标情况（比只说"驱动在跑"有用得多）
      const pr = d.observed.progress || {};
      const prTxt = pr.ok
        ? ` · 学时 ${pr.now}/${pr.goal}` + (pr.staleMin != null && pr.staleMin >= 10 ? `(缓存${pr.staleMin}min)` : '')
          + (pr.cats ? ' · ' + pr.cats.map(c => `${c.key || ('cat' + c.idx)} ${c.done}/${c.target}${c.met ? '✅' : ''}`).join(' | ') : '')
        : ` · 进度不可读（${pr.reason || '未知'}）`;
      log(`[${t.id}] ${t.platform}/${t.taskType} → 推导=${d.derived}（${d.why}）${prTxt}` + (al.length ? ` ⚠ ${al.join('；')}` : ''));
    }
    if (once) return;
    await sleep(interval * 1000);
  }
}

// ── 汇总 ────────────────────────────────────────
export function summary() {
  const tasks = loadAll();
  const byPlatform = {}, byState = {};
  for (const t of tasks) {
    byPlatform[t.platform] = (byPlatform[t.platform] || 0) + 1;
    const s = t._derived || t.state;
    byState[s] = (byState[s] || 0) + 1;
  }
  return { total: tasks.length, byPlatform, byState, tasks: tasks.map(t => ({ id: t.id, platform: t.platform, type: t.taskType, state: t.state, derived: t._derived, why: t._derivedWhy, alerts: t._alerts || [] })) };
}

// ── 建单 ────────────────────────────────────────
export function submit(task) {
  // 最小校验（契约见 §1）
  const need = ['platform', 'taskType'];
  for (const f of need) if (!task[f]) throw new Error(`任务单缺必填字段 ${f}`);
  if (!registry.find(task.platform)) throw new Error(`未知平台 ${task.platform}`);
  const reg = registry.get(task.platform);
  if (!reg.capabilities.includes(task.taskType)) {
    throw new Error(`${reg.label} 不支持 ${task.taskType}（支持：${reg.capabilities.join('/') || '无'}）`);
  }
  // 补默认值
  const id = task.id || `t_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${task.platform.slice(0, 2)}`;
  const full = {
    id, createdAt: now(), source: task.source || 'manual', rawInput: task.rawInput || null,
    confidence: task.confidence ?? 1,
    platform: task.platform, taskType: task.taskType,
    target: task.target || { scope: 'all', category: null, course: null, goal: { kind: 'finish' } },
    constraints: Object.assign({ rate: 2, maxParallel: reg.constraints.maxParallel ?? 1, windowStart: null, windowEnd: null, deadline: null }, task.constraints || {}),
    auth: Object.assign({ accountRef: `${task.platform}-main`, mode: 'auto', onCaptcha: 'pause' }, task.auth || {}),
    deliverable: task.deliverable || { evidenceDir: `runs/orders/${task.platform}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}/`, reportPath: null, screenshots: true },
    state: 'queued', stateHistory: [{ at: now(), from: null, to: 'queued', by: 'orchestrator.submit' }],
    progress: { startedAt: null, updatedAt: null, metric: task.target?.goal || null, current: null },
    result: { ok: null, achieved: null, evidence: [], notes: '', blockedReason: null },
    driver: { script: reg.driver?.script || null, pid: null, args: [] },
  };
  return saveTask(full);
}

// ── CLI ────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2] || 'list';
  const argv = process.argv.slice(3);
  const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  try {
    if (cmd === 'list') {
      const ts = loadAll();
      if (!ts.length) { console.log('（没有任务单。用 `node scripts/orchestrator.mjs new --platform ccjyxy --type video --goal 90` 建一个）'); process.exit(0); }
      console.log('任务单（runs/tasks/）\n');
      for (const t of ts) {
        const d = t._derived || '(未推导)';
        console.log(`  ${t.id}`);
        console.log(`    ${t.platform} / ${t.taskType} / state=${t.state} / 推导=${d}`);
        if (t._derivedWhy) console.log(`    依据：${t._derivedWhy}`);
        if (t._alerts && t._alerts.length) t._alerts.forEach(a => console.log(`    ⚠ ${a}`));
      }
    } else if (cmd === 'show') {
      const t = getTask(argv[0]);
      if (!t) { console.error('找不到任务 ' + argv[0]); process.exit(1); }
      console.log(JSON.stringify(t, null, 2));
    } else if (cmd === 'summary') {
      const s = summary();
      console.log(JSON.stringify(s, null, 2));
    } else if (cmd === 'tick') {
      await run({ once: true });
    } else if (cmd === 'run') {
      await run({ interval: Number(flag('interval', 30)), once: argv.includes('--once') });
    } else if (cmd === 'submit') {
      const raw = argv.includes('--file') ? readFileSync(flag('file'), 'utf8') : argv[0];
      const t = submit(JSON.parse(raw));
      console.log('✅ 已建单：' + t.id);
    } else if (cmd === 'new') {
      const platform = flag('platform'), type = flag('type'), goal = flag('goal');
      if (!platform || !type) { console.error('用法：new --platform <key> --type <video|quiz|homework|post|exam> [--goal 90]'); process.exit(2); }
      const t = submit({
        platform, taskType: type, source: 'manual',
        target: { scope: 'all', goal: goal ? { kind: 'credit', value: Number(goal), unit: '学时' } : { kind: 'finish' } },
      });
      console.log('✅ 已建单：' + t.id + '  →  ' + JSON.stringify(t.target.goal));
    } else {
      console.log('用法：node scripts/orchestrator.mjs [list|show <id>|summary|tick|run [--interval N] [--once]|submit|new]');
      process.exit(2);
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(1);
  }
}
