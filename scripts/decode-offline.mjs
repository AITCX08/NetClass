/**
 * decode-offline.mjs — 用 glyph-lib.json 解码密文字形（离线验证 + 复用同一套算法）
 *   node scripts/decode-offline.mjs --cipher runs/cx/font-contours.json --lib runs/cx/glyph-lib.json [--truth runs/cx/font-map.json]
 */
import { readFileSync } from 'node:fs';
import { shapeFromContours, blur9, matchInk, inkCount, morph } from './glyph-decode.mjs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const CIPHER = A.cipher || 'runs/cx/font-contours.json';
const LIBPATH = A.lib || 'runs/cx/glyph-lib.json';
const TGT = Number(A.ink || 0);           // 0 = 用密文平均墨迹
const TRUTH = A.truth || null;
const RES = Number(A.res || 24);

function parseBm(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) - 48; return b; }

const cipher = JSON.parse(readFileSync(CIPHER, 'utf8'));
const lib = JSON.parse(readFileSync(LIBPATH, 'utf8'));
console.log('库: ' + lib.n + ' 字形 res=' + lib.res + ' / 密文: ' + Object.keys(cipher).length);

// 繁体→简体映射（OpenCC TSCharacters）：参考字库里有大量繁体/异体字形，
// 它们在**形状上常常比简体目标更接近**（如 恣→俧 而真值 法），所以给繁体候选一点惩罚。
let TS = {};
try { TS = JSON.parse(readFileSync('runs/cx/ts-map.json', 'utf8')); } catch (e) { console.log('（未加载 ts-map.json，跳过繁简偏好）'); }
const isTrad = ch => Object.prototype.hasOwnProperty.call(TS, ch);

// 目标墨迹：先算一遍密文字形的平均墨迹，双方都归一到它
const targets = Object.keys(cipher).map(ch => ({ ch, bm: shapeFromContours(cipher[ch].contours, RES) })).filter(t => t.bm);
const avgInk = targets.reduce((s, t) => s + inkCount(t.bm), 0) / Math.max(1, targets.length);
console.log('密文平均墨迹: ' + avgInk.toFixed(1));

const refs = [];
for (let i = 0; i < lib.chars.length; i++) {
  const bm = parseBm(lib.bitmaps[i]);
  refs.push({ ch: lib.chars[i], bm, bg: blur9(matchInk(bm, RES, avgInk), RES) });
}
/** 参考位图在多个"粗细档位"下的模糊形态：目标只算一次，参考按需 dilat/erode 匹配（处理字体笔画粗细差） */
function variants(bm, res, base) {
  const out = []; let cur = bm, ink = inkCount(cur);
  // 先往细的方向收 2 档
  const fine = [cur];
  for (let i = 0; i < 2; i++) { const n = morph(cur, res, false); if (inkCount(n) < inkCount(cur) * 0.4) break; cur = n; fine.unshift(cur); }
  cur = bm;
  const thick = [];
  for (let i = 0; i < 2; i++) { const n = morph(cur, res, true); if (inkCount(n) === inkCount(cur)) break; cur = n; thick.push(cur); }
  return fine.concat(thick);
}

const truth = TRUTH ? JSON.parse(readFileSync(TRUTH, 'utf8')) : null;
// 参考字形的多粗细档位（预计算，一次）
for (const r of refs) r.varB = variants(r.bm, RES).map(b => blur9(b, RES));

let correct = 0, total = 0, weak = 0;
const out = {};
for (const t of targets) {
  const tg = blur9(matchInk(t.bm, RES, TGT || avgInk), RES);
  let best = null, second = null;
  for (const c of refs) {
    let bestC = 1e9;
    for (const vb of c.varB) {
      let s = 0;
      for (let i = 0; i < tg.length; i++) s += Math.abs(tg[i] - vb[i]);
      const d = s / tg.length / 9;
      if (d < bestC) bestC = d;
    }
    let d2 = bestC;
    if (isTrad(c.ch)) d2 += 0.015;                        // 繁体/异体字形惩罚（形状接近但不是简体目标字）
    if (!best || d2 < best.d) { second = best; best = { ch: c.ch, d: d2 }; }
    else if (!second || d2 < second.d) second = { ch: c.ch, d: d2 };
  }
  const margin = second ? second.d - best.d : 1;
  out[t.ch] = { ch: best.ch, d: +best.d.toFixed(4), margin: +margin.toFixed(4), alt: second ? second.ch : null };
  total++;
  if (best.d < 0.07 && margin > 0.008) correct++; else weak++;
  const tv = truth && truth[t.ch] ? truth[t.ch].ch : null;
  console.log((tv ? (best.ch === tv ? '✔' : '✗') : '·') + ' ' + t.ch + ' → ' + best.ch + (tv ? '  (真值 ' + tv + ')' : '') +
    '  d=' + best.d.toFixed(4) + ' 2nd=' + (second ? second.ch : '-') + ' m=' + margin.toFixed(4));
}
console.log('自评高置信 ' + correct + ' / 待确认 ' + weak + ' / 共 ' + total);
if (truth) {
  let hit = 0;
  for (const k of Object.keys(out)) { const tv = truth[k] ? truth[k].ch : null; if (tv && out[k] && out[k].ch === tv) hit++; }
  console.log('★ 与真值一致率: ' + hit + '/' + totals(truth, out) + ' = ' + (hit / totals(truth, out) * 100).toFixed(1) + '%');
}
function totals(truth, out) { return Object.keys(truth).filter(k => truth[k] && out[k]).length; }

