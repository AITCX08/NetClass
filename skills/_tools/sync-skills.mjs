/**
 * 技能同步 / 漂移检测（项目 → 全局 $DSH_HOME/skills）。
 *
 * 设计要点（2026-10-24 升级）：
 *   · **增量**：按文件内容 hash 比对，只拷变的；不再是"全量删+拷"
 *   · **状态清单**：`.sync-state.json` 记录每个技能的文件哈希，用来判定漂移
 *   · **漂移检测**：全局目录被手工改过（hash 与清单不符）时能报出来
 *   · **CI 友好**：`--check` 只报差异并以非 0 退出，可挂 git hook
 *
 * 为什么不能靠 symlink/junction：插件扫描用 entry.isDirectory() 过滤，联接会被跳过，
 * 全局目录必须是真实目录副本。所以以项目为唯一来源，单向复制。
 *
 * 用法：
 *   node sync-skills.mjs                  # 增量同步
 *   node sync-skills.mjs --dry-run        # 只看会做什么
 *   node sync-skills.mjs --check          # 只报差异（有差异退出码 1），给 CI/hook 用
 *   node sync-skills.mjs --force          # 忽略 hash，全量重拷
 *   node sync-skills.mjs --only a,b       # 只处理指定技能
 *   node sync-skills.mjs --status         # 打印清单与漂移概览
 *   node sync-skills.mjs --install-hook   # 装 git pre-commit，提交前自动同步
 */
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const PROJECT_SKILLS = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",           // → AI-Paper/skills
);
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const GLOBAL_SKILLS = path.join(DSH_HOME, "skills");
const STATE_FILE = path.join(PROJECT_SKILLS, "_tools", ".sync-state.json");
const SKIP = new Set(["__pycache__", ".git", "node_modules", ".DS_Store", ".pytest_cache"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const checkOnly = args.includes("--check");
const force = args.includes("--force");
const showStatus = args.includes("--status");
const installHook = args.includes("--install-hook");
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg
  ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1] || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
  : null;

async function listDirs(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith("_"))
    .map((e) => e.name);
}

/** 递归收集相对路径 → sha256（跳过 SKIP 目录）。 */
async function hashTree(root) {
  const out = {};
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) out[r] = createHash("sha256").update(await fsp.readFile(abs)).digest("hex").slice(0, 16);
    }
  }
  try { await walk(root, ""); } catch { /* 目录不存在 */ }
  return out;
}

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE, "utf8")); } catch { return { skills: {} }; }
}

async function writeState(state) {
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function diffHash(src, dst) {
  const added = [], removed = [], changed = [];
  for (const [f, h] of Object.entries(src)) {
    if (!(f in dst)) added.push(f);
    else if (dst[f] !== h) changed.push(f);
  }
  for (const f of Object.keys(dst)) if (!(f in src)) removed.push(f);
  return { added, removed, changed };
}

async function copyFiles(srcRoot, dstRoot, files) {
  for (const f of files) {
    const s = path.join(srcRoot, f);
    const d = path.join(dstRoot, f);
    await fsp.mkdir(path.dirname(d), { recursive: true });
    await fsp.copyFile(s, d);
  }
}

async function installGitHook() {
  // 找到本仓库的 .git（skills/_tools 在 AI-Paper 仓库内）
  const { execFileSync } = await import("node:child_process");
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: PROJECT_SKILLS, encoding: "utf8",
    }).trim();
  } catch {
    console.error("不在 git 仓库内，无法安装 hook");
    return 1;
  }
  const hookDir = path.join(top, ".git", "hooks");
  await fsp.mkdir(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, "pre-commit");
  const marker = "# >>> taskmesh skill sync >>>";
  let body = "";
  try { body = await fsp.readFile(hookPath, "utf8"); } catch { /* 新文件 */ }
  if (body.includes(marker)) { console.log(`已有技能同步 hook：${hookPath}`); return 0; }
  const snippet = [
    "", marker,
    "# 提交前检查技能是否需要同步到全局目录；有差异只提示，不阻断提交",
    'node "skills/_tools/sync-skills.mjs" --check || echo "[hint] 技能有改动，跑 node skills/_tools/sync-skills.mjs 同步"',
    "# <<< taskmesh skill sync <<<", "",
  ].join("\n");
  const shebang = body.startsWith("#!") ? "" : "#!/bin/sh\n";
  await fsp.writeFile(hookPath, shebang + body + snippet, { encoding: "utf8" });
  await fsp.chmod(hookPath, 0o755).catch(() => {});
  console.log(`已安装 pre-commit hook：${hookPath}`);
  return 0;
}

async function main() {
  if (installHook) return await installGitHook();
  const names = (await listDirs(PROJECT_SKILLS)).filter((n) => !only || only.includes(n));
  const state = await readState();
  state.skills ||= {};

  if (showStatus) {
    console.log(`项目: ${PROJECT_SKILLS}\n全局: ${GLOBAL_SKILLS}\n`);
    let drift = 0;
    for (const [name, rec] of Object.entries(state.skills)) {
      const dst = path.join(GLOBAL_SKILLS, name);
      const live = await hashTree(dst);
      const d = diffHash(rec.files || {}, live);
      const dirty = d.added.length + d.removed.length + d.changed.length;
      if (dirty) { drift++; console.log(`  ⚠ ${name}: 全局有 ${dirty} 个文件被改动(${live ? "手工改过?" : "目录缺失"})`); }
    }
    const untracked = (await listDirs(GLOBAL_SKILLS)).filter((n) => !(n in state.skills));
    if (untracked.length) console.log(`  · 全局独有（非本项目来源）: ${untracked.join(", ")}`);
    console.log(`\n已跟踪 ${Object.keys(state.skills).length} 个技能，漂移 ${drift} 个。`);
    return 0;
  }

  console.log(`项目技能目录: ${PROJECT_SKILLS}`);
  console.log(`全局技能目录: ${GLOBAL_SKILLS}`);
  console.log(`模式: ${checkOnly ? "check" : dryRun ? "dry-run" : force ? "force" : "增量同步"}\n`);

  let anyDiff = 0, synced = 0, skipped = 0;
  for (const name of names) {
    const src = path.join(PROJECT_SKILLS, name);
    const dst = path.join(GLOBAL_SKILLS, name);
    try { await fsp.access(path.join(src, "SKILL.md")); }
    catch { console.log(`跳过 ${name}（无 SKILL.md）`); skipped++; continue; }

    const srcHash = await hashTree(src);
    const dstHash = await hashTree(dst);
    const d = force
      ? { added: Object.keys(srcHash), removed: Object.keys(dstHash), changed: [] }
      : diffHash(srcHash, dstHash);
    const dirty = d.added.length + d.removed.length + d.changed.length;

    if (!dirty) {
      // 内容一致，但清单可能缺失（首次运行）——补记
      if (!state.skills[name]) state.skills[name] = { files: srcHash, at: new Date().toISOString() };
      continue;
    }
    anyDiff++;
    const parts = [];
    if (d.added.length) parts.push(`+${d.added.length}`);
    if (d.changed.length) parts.push(`~${d.changed.length}`);
    if (d.removed.length) parts.push(`-${d.removed.length}`);
    console.log(`  ${name}: ${parts.join(" ")}`);

    if (checkOnly || dryRun) continue;

    // 删除全局多余文件（源已删）
    for (const f of d.removed) {
      await fsp.rm(path.join(dst, f), { force: true }).catch(() => {});
    }
    await copyFiles(src, dst, [...d.added, ...d.changed]);
    state.skills[name] = { files: srcHash, at: new Date().toISOString() };
    synced++;
  }

  if (!checkOnly && !dryRun) {
    // 清掉源里已删除的技能
    const current = new Set(names);
    for (const name of Object.keys(state.skills)) {
      if (current.has(name)) continue;
      const dst = path.join(GLOBAL_SKILLS, name);
      if (await fsp.access(dst).then(() => true).catch(() => false)) {
        console.log(`  移除已删除的技能 ${name}`);
        await fsp.rm(dst, { recursive: true, force: true });
      }
      delete state.skills[name];
    }
    await writeState(state);
  }

  console.log(`\n${checkOnly ? "发现" : "同步"} ${anyDiff} 个有变化的技能` +
              (checkOnly ? "" : `（实际写入 ${synced} 个）`) + `，跳过 ${skipped} 个。`);
  if (checkOnly && anyDiff) {
    console.log("提示：跑 `node sync-skills.mjs` 落地同步。");
    return 1;
  }
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error("同步失败:", err);
  process.exit(1);
});
