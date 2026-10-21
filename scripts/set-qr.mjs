#!/usr/bin/env node
/**
 * scripts/set-qr.mjs —— 把二维码图片转成 base64 并写进 userscript/brand.js
 *
 * 为什么需要它：userscript 注入在页面里，读不到本地文件路径，
 * 所以图片必须以 data URI 内联进脚本。手工转 base64 又容易粘错，
 * 这个脚本负责：读图 → 校验尺寸 → 转 base64 → 精确改写 brand.js 的对应字段。
 *
 * 用法：
 *   node scripts/set-qr.mjs --wechat 微信.png
 *   node scripts/set-qr.mjs --donate 捐赠.png
 *   node scripts/set-qr.mjs --wechat 微信.png --donate 捐赠.png
 *   node scripts/set-qr.mjs --clear            清空两个二维码
 *   node scripts/set-qr.mjs --status           只看当前填了没有
 *
 * 约束：
 *   - 只支持 PNG / JPG（浏览器都能直接渲染）
 *   - 单张建议 ≤ 80KB（转成 base64 后约 ×1.37；太大拖慢每次注入）
 *   - 建议尺寸 240~400px 正方形（面板里显示 84×84，2 倍屏够用）
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BRAND = join(ROOT, 'userscript', 'brand.js');

const MAX_KB = 120;

function argOf(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** 读图 → data URI */
function toDataUri(p) {
  if (!existsSync(p)) throw new Error('文件不存在：' + p);
  const ext = extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png'
    : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
      : null;
  if (!mime) throw new Error('只支持 PNG/JPG，收到：' + ext);
  const kb = statSync(p).size / 1024;
  if (kb > MAX_KB) throw new Error(`图片 ${kb.toFixed(0)}KB 太大（上限 ${MAX_KB}KB），请先压缩`);
  const b64 = readFileSync(p).toString('base64');
  return { uri: `data:${mime};base64,${b64}`, kb, name: basename(p) };
}

/** 改写 brand.js 里某个字段（正则精确替换，保留其余格式） */
function setField(src, field, value) {
  const re = new RegExp(`(\\s*${field}:\\s*)'(?:[^'\\\\]|\\\\.)*'`, 'm');
  if (!re.test(src)) throw new Error(`brand.js 里找不到字段 ${field}`);
  return src.replace(re, `$1'${value}'`);
}

const README = `/**
 * userscript/assets/ —— 二维码原图放这里（可选）
 *
 * 实际使用时图片会被转成 base64 内联进 userscript/brand.js，
 * 这个目录只是留档原图，方便随时替换。
 *
 * 推荐尺寸：300×300 px PNG，≤ 80KB
 * 填充命令：
 *   node scripts/set-qr.mjs --wechat userscript/assets/wechat.png --donate userscript/assets/donate.png
 */`;

function status(src) {
  const get = (f) => {
    const m = src.match(new RegExp(`${f}:\\s*'([^']*)'`, 'm'));
    return m ? m[1] : '';
  };
  const w = get('wechatQr'), d = get('donateQr');
  console.log('=== 二维码配置状态 ===');
  console.log('  微信   : ' + (w ? `✅ 已填（${Math.round(w.length / 1024)}KB base64）` : '⬜ 空 → 不显示'));
  console.log('  捐赠   : ' + (d ? `✅ 已填（${Math.round(d.length / 1024)}KB base64）` : '⬜ 空 → 不显示'));
  console.log('  赞助链接: ' + (get('sponsorUrl') || '⬜ 空'));
  console.log('  Pro 入口: ' + (get('proEnabled') === 'true' ? '✅ 开启' : '⬜ 关闭'));
}

const main = () => {
  if (!existsSync(BRAND)) { console.error('找不到 ' + BRAND); process.exit(1); }
  let src = readFileSync(BRAND, 'utf8');

  if (process.argv.includes('--status') || process.argv.length === 2) { status(src); return; }

  if (process.argv.includes('--clear')) {
    src = setField(src, 'wechatQr', '');
    src = setField(src, 'donateQr', '');
    writeFileSync(BRAND, src);
    console.log('✅ 已清空两个二维码');
    status(src);
    return;
  }

  const w = argOf('wechat');
  const d = argOf('donate');
  if (!w && !d) {
    console.log('用法：node scripts/set-qr.mjs --wechat 微信.png [--donate 捐赠.png]');
    console.log('      node scripts/set-qr.mjs --status | --clear');
    process.exit(2);
  }

  if (w) { const r = toDataUri(w); src = setField(src, 'wechatQr', r.uri); console.log(`✅ 微信   ${r.name}  ${r.kb.toFixed(0)}KB → base64 ${Math.round(r.uri.length / 1024)}KB`); }
  if (d) { const r = toDataUri(d); src = setField(src, 'donateQr', r.uri); console.log(`✅ 捐赠   ${r.name}  ${r.kb.toFixed(0)}KB → base64 ${Math.round(r.uri.length / 1024)}KB`); }

  writeFileSync(BRAND, src);
  console.log('');
  status(src);
  console.log('\n下一步：node scripts/build.mjs && node scripts/netclass-deploy.ps1 -Action push');
};

try { main(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
