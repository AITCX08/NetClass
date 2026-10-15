/**
 * glyph-decode.mjs — 用系统 CJK 字体反查超星密文字体（font-cxsecret）的明文
 *
 * 思路：密文字体画的就是**正确汉字的字形**（渲染出来是对的），所以把字形轮廓转成位图后
 *      跟系统字体渲染的参考字形比对即可。必须处理两件事：
 *      ① 轮廓 → 折线 → even-odd 扫描线填充（不然笔画细的地方会丢）；
 *      ② **笔画粗细归一**（密文字体笔画比系统字体细，直接用 L1 距离差很大）→ 腐蚀/膨胀对齐。
 *
 * 用法：node scripts/glyph-decode.mjs --cipher runs/cx/font-contours.json --out runs/cx/font-map.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const CIPHER = A.cipher || 'runs/cx/font-contours.json';
const OUT = A.out || 'runs/cx/font-map.json';
const NFACE = Number(A.face || 0);
const RES = Number(A.res || 24);
const SUPER = 96;
const DEBUG = !!A.debug;

const REFS = (A.ref ? [A.ref] : [
  'C:\\Windows\\Fonts\\Deng.ttf',
  'C:\\Windows\\Fonts\\simkai.ttf',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
]).filter(p => existsSync(p));

// ---------------------------------------------------------------- TrueType
export function parseFont(buf, faceIndex = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let base = 0;
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === 'ttcf') {
    const numFonts = dv.getUint32(8);
    if (faceIndex >= numFonts) faceIndex = 0;
    base = dv.getUint32(12 + faceIndex * 4);
  }
  const numTables = dv.getUint16(base + 4);
  const tables = {};
  for (let t = 0; t < numTables; t++) {
    const o = base + 12 + t * 16;
    const tag = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    tables[tag] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
  }
  const head = tables.head, maxp = tables.maxp, loca = tables.loca, glyf = tables.glyf, cmap = tables.cmap;
  const indexToLocFormat = dv.getInt16(head.off + 50);
  const unitsPerEm = dv.getUint16(head.off + 18);
  const numGlyphs = dv.getUint16(maxp.off + 4);
  const locaAt = g => indexToLocFormat === 0 ? dv.getUint16(loca.off + g * 2) * 2 : dv.getUint32(loca.off + g * 4);
  const cn = dv.getUint16(cmap.off + 2);
  let best = null, bestScore = -1;
  for (let s = 0; s < cn; s++) {
    const pid = dv.getUint16(cmap.off + 4 + s * 8);
    const eid = dv.getUint16(cmap.off + 6 + s * 8);
    const sub = cmap.off + dv.getUint32(cmap.off + 8 + s * 8);
    const fmt = dv.getUint16(sub);
    const score = (fmt === 12 ? 100 : fmt === 4 ? 50 : 0) + (pid === 3 && eid === 10 ? 20 : 0) + (pid === 3 && eid === 1 ? 10 : 0) + (pid === 0 ? 5 : 0);
    if (score > bestScore) { bestScore = score; best = { sub, fmt }; }
  }
  const c2g = new Map();
  if (best) {
    if (best.fmt === 4) {
      const segX2 = dv.getUint16(best.sub + 6), seg = segX2 / 2;
      const endO = best.sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let i = 0; i < seg; i++) {
        const end = dv.getUint16(endO + i * 2), start = dv.getUint16(startO + i * 2);
        const delta = dv.getInt16(deltaO + i * 2), ro = dv.getUint16(rangeO + i * 2);
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let g = 0;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else {
            const gOff = rangeO + i * 2 + ro + (c - start) * 2;
            if (gOff + 1 < dv.byteLength) { g = dv.getUint16(gOff); if (g !== 0) g = (g + delta) & 0xFFFF; }
          }
          c2g.set(c, g);
        }
      }
    } else if (best.fmt === 12) {
      const nGroups = dv.getUint32(best.sub + 12);
      for (let g = 0; g < nGroups; g++) {
        const b0 = best.sub + 16 + g * 12;
        const sCp = dv.getUint32(b0), eCp = dv.getUint32(b0 + 4), sG = dv.getUint32(b0 + 8);
        for (let cp = sCp; cp <= eCp; cp++) c2g.set(cp, sG + (cp - sCp));
      }
    }
  }
  return { dv, glyf, locaAt, numGlyphs, unitsPerEm, c2g };
}

/** 取轮廓（含 off-curve 点），复合字形返回 null */
export function glyphContours(F, gi) {
  const { dv, glyf } = F;
  const start = F.locaAt(gi), end = F.locaAt(gi + 1);
  if (end <= start) return null;
  const o = glyf.off + start;
  const numberOfContours = dv.getInt16(o);
  if (numberOfContours <= 0) return null;
  let p = o + 10;
  const endPts = [];
  for (let i = 0; i < numberOfContours; i++) { endPts.push(dv.getUint16(p)); p += 2; }
  const nPts = endPts[numberOfContours - 1] + 1;
  const insLen = dv.getUint16(p); p += 2 + insLen;
  const flags = [];
  while (flags.length < nPts) {
    const f = dv.getUint8(p++); flags.push(f);
    if (f & 8) { const rep = dv.getUint8(p++); for (let r = 0; r < rep; r++) flags.push(f); }
  }
  const xs = []; let x = 0;
  for (let i = 0; i < nPts; i++) {
    const fl = flags[i];
    if (fl & 2) { const dx = dv.getUint8(p++); x += (fl & 16) ? dx : -dx; }
    else if (!(fl & 16)) { x += dv.getInt16(p); p += 2; }
    xs.push(x);
  }
  const ys = []; let y = 0;
  for (let i = 0; i < nPts; i++) {
    const fl = flags[i];
    if (fl & 4) { const dy = dv.getUint8(p++); y += (fl & 32) ? dy : -dy; }
    else if (!(fl & 32)) { y += dv.getInt16(p); p += 2; }
    ys.push(y);
  }
  const contours = [];
  let s = 0;
  for (let c = 0; c < numberOfContours; c++) {
    const e = endPts[c];
    const seg = [];
    for (let i = s; i <= e; i++) seg.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
    contours.push(seg);
    s = e + 1;
  }
  return contours;
}

/** TrueType 二次贝塞尔 → 折线（处理连续 off-curve 的隐含点） */
export function flatten(contours, steps = 8) {
  const polys = [];
  for (const seg of contours) {
    const n = seg.length;
    if (n < 2) continue;
    let si = seg.findIndex(p => p.on);
    if (si < 0) si = 0;
    const seq = seg.slice(si).concat(seg.slice(0, si));
    const start = seq[0];
    let cur;
    if (start.on) cur = { x: start.x, y: start.y };
    else {
      const last = seq[seq.length - 1];
      cur = { x: (start.x + last.x) / 2, y: (start.y + last.y) / 2 };
      seq.unshift({ x: cur.x, y: cur.y, on: true });
    }
    const pl = [[cur.x, cur.y]];
    let i = 1;
    while (i < seq.length) {
      const p0 = seq[i];
      if (p0.on) { pl.push([p0.x, p0.y]); i++; continue; }
      const p1 = seq[i + 1];
      if (!p1) break;
      const cx = p0.x, cy = p0.y;
      const ex = p1.on ? p1.x : (p0.x + p1.x) / 2;
      const ey = p1.on ? p1.y : (p0.y + p1.y) / 2;
      const sx = pl[pl.length - 1][0], sy = pl[pl.length - 1][1];
      for (let t = 1; t <= steps; t++) {
        const u = t / steps, iu = 1 - u;
        pl.push([iu * iu * sx + 2 * iu * u * cx + u * u * ex, iu * iu * sy + 2 * iu * u * cy + u * u * ey]);
      }
      if (p1.on) i += 2; else i += 1;
    }
    if (pl.length > 2) polys.push(pl);
  }
  return polys;
}

/** even-odd 扫描线填充 → SUPER×SUPER 二值位图（等比缩放到画布内） */
export function rasterize(polys) {
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (const pl of polys) for (const [x, y] of pl) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const w = maxx - minx, h = maxy - miny;
  if (!(w > 0) || !(h > 0)) return null;
  const S = SUPER, pad = 2;
  const sc = (S - pad * 2) / Math.max(w, h);
  const bm = new Uint8Array(S * S);
  const ox = pad + (S - pad * 2 - w * sc) / 2;
  const oy = pad + (S - pad * 2 - h * sc) / 2;
  const tx = x => (x - minx) * sc + ox;
  const ty = y => (y - miny) * sc + oy;
  const edges = [];
  for (const pl of polys) {
    for (let i = 0; i < pl.length; i++) {
      const a = pl[i], b = pl[(i + 1) % pl.length];
      if (a[1] === b[1]) continue;
      edges.push([tx(a[0]), ty(a[1]), tx(b[0]), ty(b[1])]);
    }
  }
  for (let y = 0; y < S; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if ((cy >= y1 && cy < y2) || (cy >= y2 && cy < y1)) {
        xs.push(x1 + (cy - y1) / (y2 - y1) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(S - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = xa; x <= xb; x++) bm[y * S + x] = 1;
    }
  }
  return { bm, S };
}

export function downBin(bmObj, res) {              // → res×res 0/1
  const { bm, S } = bmObj;
  const f = S / res;
  const out = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    let c = 0, n = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const yy = Math.floor(y * f + dy), xx = Math.floor(x * f + dx);
      if (yy < S && xx < S) { c += bm[yy * S + xx]; n++; }
    }
    out[y * res + x] = (c / n) > 0.3 ? 1 : 0;
  }
  return out;
}
export function inkCount(bm) { let s = 0; for (let i = 0; i < bm.length; i++) s += bm[i]; return s; }
export function morph(bm, res, grow) {
  const out = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    let v = grow ? 0 : 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      const s = (yy < 0 || xx < 0 || yy >= res || xx >= res) ? 0 : bm[yy * res + xx];
      if (grow) { if (s > v) v = s; } else { if (s < v) v = s; }
    }
    out[y * res + x] = v;
  }
  return out;
}
/** 把墨迹量对齐到目标（简单迭代腐蚀/膨胀），返回 0/1 位图
 *  ★ 关键防御：腐蚀把笔画抹没了就立刻回退上一版（否则得到全空位图 → 跟谁都 d=0） */
export function matchInk(bm, res, target) {
  let cur = bm, ink = inkCount(cur), guard = 0;
  while (ink > target * 1.12 && guard++ < 5) {
    const next = morph(cur, res, false);
    const ni = inkCount(next);
    if (ni === 0 || ni < ink * 0.25) break;            // 抹没了 → 放弃腐蚀
    cur = next; ink = ni;
  }
  guard = 0;
  while (ink < target * 0.88 && guard++ < 10) {
    const next = morph(cur, res, true);
    const ni = inkCount(next);
    if (ni === ink) break;                              // 不再增长 → 停
    cur = next; ink = ni;
    if (ink > target * 1.3) break;                      // 涨过头 → 停
  }
  return cur;
}
export function blur9(bm, res) {
  const out = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= res || xx >= res) continue;
      s += bm[yy * res + xx]; n++;
    }
    out[y * res + x] = Math.round(s / n * 9);
  }
  return out;
}
function ascii(bm, res) {
  let s = '';
  for (let y = 0; y < res; y++) { let l = ''; for (let x = 0; x < res; x++) l += bm[y * res + x] ? '#' : '.'; s += l + '\n'; }
  return s;
}

/** 轮廓点（浏览器导出格式）→ 归一化位图 */
export function shapeFromContours(contours, res) {
  const polys = flatten(contours.map(seg => seg.map(p => ({ x: p[0], y: p[1], on: !!p[2] }))));
  if (!polys.length) return null;
  const r = rasterize(polys);
  if (!r) return null;
  return downBin(r, res);
}
export function shapeFromGlyph(F, gi, res) {
  const cs = glyphContours(F, gi);
  if (!cs) return null;
  const polys = flatten(cs);
  if (!polys.length) return null;
  const r = rasterize(polys);
  if (!r) return null;
  return downBin(r, res);
}

// ---------------------------------------------------------------- 主流程
// 只有直接执行本文件时才跑 CLI；被 import 时只导出函数（decode-offline.mjs 依赖这一点）
const IS_MAIN = (() => { try { return process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('glyph-decode.mjs'); } catch (e) { return true; } })();
if (IS_MAIN) {
const RES0 = RES;
console.log('参考字体: ' + REFS.map(p => p.split('\\').pop()).join(', ') + '   分辨率=' + RES0);
const cipher = JSON.parse(readFileSync(CIPHER, 'utf8'));
const ckeys = Object.keys(cipher);
console.log('密文字符: ' + ckeys.length);

// 密文位图 + 目标墨迹
const targets = [];
for (const ch of ckeys) {
  const g = cipher[ch];
  const bm = g.contours ? shapeFromContours(g.contours, RES0) : null;
  if (!bm) { targets.push({ ch, bm: null }); continue; }
  targets.push({ ch, bm, ink: inkCount(bm) });
}
const avgInk = targets.filter(t => t.bm).reduce((s, t) => s + t.ink, 0) / Math.max(1, targets.filter(t => t.bm).length);
console.log('密文字形平均墨迹: ' + avgInk.toFixed(1) + ' px（' + RES0 + '×' + RES0 + '）');

// 参考字库（每个字体各建一份，取最优）
const refSets = [];
for (const rp of REFS) {
  const F = parseFont(new Uint8Array(readFileSync(rp)), NFACE);
  const list = [];
  for (const [cp, gi] of F.c2g) {
    if (cp < 0x4E00 || cp > 0x9FA5) continue;
    const bm = shapeFromGlyph(F, gi, RES0);
    if (bm) list.push({ ch: String.fromCharCode(cp), bm, ink: inkCount(bm) });
  }
  refSets.push({ name: rp.split('\\').pop(), list, avgInk: list.reduce((s, x) => s + x.ink, 0) / Math.max(1, list.length) });
  console.log('  ' + rp.split('\\').pop() + ': ' + list.length + ' 字形，平均墨迹 ' + (list.reduce((s, x) => s + x.ink, 0) / Math.max(1, list.length)).toFixed(1));
}

const map = {};
const rows = [];
let okN = 0, weakN = 0;
// ★ 双方都归一到**同一个墨迹目标**（avgInk=密文字形平均墨迹），再模糊；只预处理一次
for (const rs of refSets) {
  for (const c of rs.list) {
    if (!c.bgA) { c.bgA = blur9(c.bm, RES0); c.bgB = blur9(matchInk(c.bm, RES0, avgInk), RES0); }
  }
  console.log('  已预处理 ' + rs.name + '（' + rs.list.length + '）');
}
for (const t of targets) {
  if (!t.bm) { map[t.ch] = null; continue; }
  let best = null, second = null;
  // 两条比较路径，取更优：
  //  A) 不调粗细，直接把两边各自的 blur 结果比对（更保形，适合细笔画字）
  //  B) 把双方墨迹都归一到同一目标再比（消除字体间笔画粗细差，适合密笔画字）
  const tgA = blur9(t.bm, RES0);
  const tgB = blur9(matchInk(t.bm, RES0, avgInk), RES0);
  for (const rs of refSets) {
    for (const c of rs.list) {
      if (!c.bgA) { c.bgA = blur9(c.bm, RES0); c.bgB = blur9(matchInk(c.bm, RES0, avgInk), RES0); }
      let sA = 0, sB = 0;
      for (let i = 0; i < tgA.length; i++) { sA += Math.abs(tgA[i] - c.bgA[i]); sB += Math.abs(tgB[i] - c.bgB[i]); }
      const d = Math.min(sA, sB) / tgA.length / 9;
      if (!best || d < best.d) { second = best; best = { ch: c.ch, d, font: rs.name }; }
      else if (!second || d < second.d) second = { ch: c.ch, d };
    }
  }
  const margin = second ? second.d - best.d : 1;
  map[t.ch] = { ch: best.ch, d: +best.d.toFixed(4), margin: +margin.toFixed(4), alt: second ? second.ch : null, font: best.font };
  if (best.d < 0.06 && margin > 0.01) okN++; else weakN++;
  rows.push({ cipher: t.ch, plain: best.ch, d: best.d, margin, alt: second ? second.ch : '-' });
}
rows.sort((a, b) => a.d - b.d);
for (const r of rows) {
  console.log((r.d < 0.06 && r.margin > 0.01 ? '  ✔ ' : '  ? ') + r.cipher + ' → ' + r.plain + '  d=' + r.d.toFixed(4) + ' margin=' + r.margin.toFixed(4) + ' 2nd=' + r.alt);
}
console.log('高置信 ' + okN + ' / 待确认 ' + weakN);
writeFileSync(OUT, JSON.stringify(map, null, 1), 'utf8');
console.log('已写出: ' + OUT);

if (DEBUG) {
  for (const t of targets.slice(0, 5)) {
    if (!t.bm) continue;
    console.log('--- ' + t.ch + ' → ' + (map[t.ch] ? map[t.ch].ch : '?') + ' ---');
    console.log(ascii(t.bm, RES0));
  }
}
}   // ← IS_MAIN 块结束

