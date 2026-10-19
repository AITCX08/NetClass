#!/usr/bin/env node
/**
 * scripts/converge-supervisor.mjs —— 把重复的 supervisor 收敛到 1 个
 *
 * 为什么单独写一个脚本，而不是随手 Stop-Process：
 *   2026-10-19 我因为"按父进程判断该留哪个"去杀重复 supervisor，结果把
 *   cc-cycle / cc-auto / cc-watch 整条链一起弄没了（全部进程消失，靠重启才恢复，
 *   长春断点续播没丢进度但白等了 2 分钟）。
 *   Stop-Process 的连带效应不可控 —— 被杀的 supervisor 可能持有 Windows Job Object，
 *   子进程随它一起被回收。
 *
 * 所以这个脚本的设计原则是【可回滚】：
 *   1. 先只列出，不杀（--dry 默认行为）
 *   2. 真要动手时，一次只杀一个
 *   3. 每杀一个，立刻检查 cc-cycle / cc-auto / cc-watch 是否还活着
 *   4. 一旦发现链路断了 → 立刻重启 supervisor 并停止收敛
 *   5. 全过程写日志，任何一步失败都能看出停在哪
 *
 * 用法：
 *   node scripts/converge-supervisor.mjs                只看不杀（默认）
 *   node scripts/converge-supervisor.mjs --yes          真的收敛（一次一个，带自愈）
 *   node scripts/converge-supervisor.mjs --yes --keep <pid>   指定保留哪个
 *
 * 建议时机：**长春跑完之后**（收敛必然有短暂断链风险，别拿正在跑的任务赌）。
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOG = join(ROOT, 'runs', 'converge-supervisor.log');

const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  try { mkdirSync(dirname(LOG), { recursive: true }); writeFileSync(LOG, line + '\n', { flag: 'a' }); } catch (_) { }
}

/** 列出所有 node 进程 {pid, cmd} */
function procs() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    ).trim();
    if (!out) return [];
    const arr = JSON.parse(out);
    return (Array.isArray(arr) ? arr : [arr]).map(p => ({
      pid: p.ProcessId, ppid: p.ParentProcessId,
      cmd: String(p.CommandLine || ''), started: p.CreationDate,
    }));
  } catch (_) { return []; }
}

const isSup = p => /supervisor\.mjs/.test(p.cmd);
const isCycle = p => /cc-cycle\.mjs/.test(p.cmd);
const isAuto = p => /cc-auto\.mjs/.test(p.cmd);
const isWatch = p => /cc-watch\.mjs/.test(p.cmd);

/** 链路是否完整（cc-cycle 与 cc-auto 至少各 1 个） */
function chainAlive() {
  const ps = procs();
  return {
    cycle: ps.filter(isCycle).length,
    auto: ps.filter(isAuto).length,
    watch: ps.filter(isWatch).length,
    ok: ps.filter(isCycle).length >= 1 || ps.filter(isAuto).length === 0,  // auto 可以是 0（分类切换间隙）
  };
}

/** 重启 supervisor（隐藏窗口、不等待） */
function restartSupervisor() {
  try {
    execSync(
      `powershell -NoProfile -Command "Start-Process -FilePath '${process.execPath}' -ArgumentList 'scripts/supervisor.mjs','--interval=60' -WorkingDirectory '${ROOT}' -WindowStyle Hidden -RedirectStandardOutput '${join(ROOT, 'runs', 'supervisor-console.log')}' -RedirectStandardError '${join(ROOT, 'runs', 'supervisor.err.log')}'"`,
      { encoding: 'utf8', timeout: 30000, windowsHide: true }
    );
    log('  🔧 已重启 supervisor');
    return true;
  } catch (e) {
    log('  ❌ 重启 supervisor 失败：' + String(e.message).slice(0, 80));
    return false;
  }
}

function kill(pid) {
  try {
    execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return true;
  } catch (e) {
    log(`  ❌ 杀 ${pid} 失败：${String(e.message).slice(0, 60)}`);
    return false;
  }
}

// ── main ─────────────────────────────────────────
const argv = process.argv.slice(2);
const REALLY = argv.includes('--yes');
const idxKeep = argv.indexOf('--keep');
const KEEP = idxKeep >= 0 ? Number(argv[idxKeep + 1]) : null;

const ps = procs();
const sups = ps.filter(isSup).sort((a, b) => a.pid - b.pid);
const cyc = ps.filter(isCycle);

log(`=== 当前状态 ===`);
log(`  supervisor: ${sups.length} 个  ${sups.map(s => s.pid).join(', ') || '(无)'}`);
log(`  cc-cycle:   ${cyc.length} 个  ${cyc.map(s => s.pid).join(', ') || '(无)'}`);
log(`  cc-auto:    ${ps.filter(isAuto).length} 个`);
log(`  cc-watch:   ${ps.filter(isWatch).length} 个`);

if (sups.length <= 1) {
  log('✅ supervisor 已经是 1 个（或 0 个），无需收敛');
  process.exit(0);
}

// 决定保留哪个：优先 --keep；否则保留是 cc-cycle 的父进程的那个；再否则保留最早启动的
let keepPid = KEEP;
if (!keepPid && cyc.length) {
  const parentOfCycle = cyc[0].ppid;
  if (sups.some(s => s.pid === parentOfCycle)) {
    keepPid = parentOfCycle;
    log(`  推断：保留 ${keepPid}（它是 cc-cycle ${cyc[0].pid} 的父进程）`);
  }
}
if (!keepPid) {
  keepPid = sups[0].pid;
  log(`  推断：保留最早启动的 ${keepPid}`);
}

const toKill = sups.filter(s => s.pid !== keepPid);

if (!REALLY) {
  log('');
  log(`🔍 dry-run —— 将要杀掉 ${toKill.length} 个：${toKill.map(s => s.pid).join(', ')}`);
  log(`   保留：${keepPid}`);
  log('');
  log('   真要执行请加 --yes（脚本会一次杀一个，并在断链时立刻自愈）');
  process.exit(0);
}

log('');
log(`★ 开始收敛：保留 ${keepPid}，要杀 ${toKill.length} 个`);

let killed = 0;
for (const s of toKill) {
  log(`  杀 ${s.pid} …`);
  kill(s.pid);
  await new Promise(r => setTimeout(r, 5000));   // 等进程真正退出 & 系统回收

  const c = chainAlive();
  log(`    杀后链路：cc-cycle=${c.cycle} cc-auto=${c.auto} cc-watch=${c.watch}`);

  if (c.cycle === 0 && c.auto === 0) {
    log('  🔴 检测到链路断开 → 立刻重启 supervisor 并停止收敛');
    restartSupervisor();
    await new Promise(r => setTimeout(r, 20000));
    const c2 = chainAlive();
    log(`    恢复后：cc-cycle=${c2.cycle} cc-auto=${c2.auto} cc-watch=${c2.watch}`);
    if (c2.cycle > 0) log('  ✅ 已恢复；中止收敛，保留现状');
    else log('  ❌ 未能恢复，请人工介入：node scripts/supervisor.mjs --interval=60');
    process.exit(1);
  }
  killed++;
}

const final = procs().filter(isSup);
log('');
log(`✅ 收敛完成：杀掉 ${killed} 个，supervisor 现在 ${final.length} 个（${final.map(s => s.pid).join(', ') || '无'}）`);
const c = chainAlive();
log(`   链路：cc-cycle=${c.cycle} cc-auto=${c.auto} cc-watch=${c.watch}`);
process.exit(0);
