/**
 * build-glyph-lib.mjs — 离线生成"字形指纹库"（把系统 CJK 字体的字形转成位图指纹）
 *   产物：runs/cx/glyph-lib.json   { res, chars:"...", bitmaps:["....", ...] }
 *   运行时（浏览器）拿它跟密文字体的字形轮廓比对，就能把密文字还原成明文。
 *
 *   node scripts/build-glyph-lib.mjs [--limit 6000] [--res 24] [--out runs/cx/glyph-lib.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const RES = Number(A.res || 24);
const SUPER = 96;
const LIMIT = Number(A.limit || 0);          // 0 = 全部常用区
// ★ 只收 **GB2312 汉字**（6763 个）：CJK 统一区里包含大量日文汉字/异体字，
//   它们字形跟目标更接近（如 恣→俧 而真值 法），把匹配带偏 —— 实测准确率只有 27%。
const WHITELIST = (() => { try { return new Set(Array.from(readFileSync(A.whitelist || 'runs/cx/gb2312.txt', 'utf8').trim())); } catch (e) { console.log('（未加载白名单，使用全 CJK）'); return null; } })();
const OUT = A.out || 'runs/cx/glyph-lib.json';
const REFS = (A.ref ? [A.ref] : ['C:\\Windows\\Fonts\\Deng.ttf', 'C:\\Windows\\Fonts\\simkai.ttf']).filter(existsSync);

// ---------------------------------------------------------------- TrueType（与 glyph-decode.mjs 同构）
function parseFont(buf, faceIndex = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let base = 0;
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === 'ttcf') base = dv.getUint32(12 + faceIndex * 4);
  const numTables = dv.getUint16(base + 4);
  const tables = {};
  for (let t = 0; t < numTables; t++) {
    const o = base + 12 + t * 16;
    tables[String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
  }
  const head = tables.head, maxp = tables.maxp, loca = tables.loca, glyf = tables.glyf, cmap = tables.cmap;
  const indexToLocFormat = dv.getInt16(head.off + 50);
  const numGlyphs = dv.getUint16(maxp.off + 4);
  const locaAt = g => indexToLocFormat === 0 ? dv.getUint16(loca.off + g * 2) * 2 : dv.getUint32(loca.off + g * 4);
  const cn = dv.getUint16(cmap.off + 2);
  let best = null, bestScore = -1;
  for (let s = 0; s < cn; s++) {
    const pid = dv.getUint16(cmap.off + 4 + s * 8), eid = dv.getUint16(cmap.off + 6 + s * 8);
    const sub = cmap.off + dv.getUint32(cmap.off + 8 + s * 8), fmt = dv.getUint16(sub);
    const score = (fmt === 12 ? 100 : fmt === 4 ? 50 : 0) + (pid === 3 ? 10 : 0);
    if (score > bestScore) { bestScore = score; best = { sub, fmt }; }
  }
  const c2g = new Map();
  if (best.fmt === 4) {
    const segX2 = dv.getUint16(best.sub + 6), seg = segX2 / 2;
    const endO = best.sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let i = 0; i < seg; i++) {
      const end = dv.getUint16(endO + i * 2), start = dv.getUint16(startO + i * 2);
      const delta = dv.getInt16(deltaO + i * 2), ro = dv.getUint16(rangeO + i * 2);
      for (let c = start; c <= end && c !== 0xFFFF; c++) {
        let g = 0;
        if (ro === 0) g = (c + delta) & 0xFFFF;
        else { const gOff = rangeO + i * 2 + ro + (c - start) * 2; if (gOff + 1 < dv.byteLength) { g = dv.getUint16(gOff); if (g) g = (g + delta) & 0xFFFF; } }
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
  return { dv, glyf, locaAt, c2g };
}
function glyphContours(F, gi) {
  const { dv, glyf } = F;
  const start = F.locaAt(gi), end = F.locaAt(gi + 1);
  if (end <= start) return null;
  const o = glyf.off + start;
  const nc = dv.getInt16(o);
  if (nc <= 0) return null;
  let p = o + 10;
  const endPts = [];
  for (let i = 0; i < nc; i++) { endPts.push(dv.getUint16(p)); p += 2; }
  const nPts = endPts[nc - 1] + 1;
  const insLen = dv.getUint16(p); p += 2 + insLen;
  const flags = [];
  while (flags.length < nPts) { const f = dv.getUint8(p++); flags.push(f); if (f & 8) { const rep = dv.getUint8(p++); for (let r = 0; r < rep; r++) flags.push(f); } }
  const xs = []; let x = 0;
  for (let i = 0; i < nPts; i++) { const fl = flags[i]; if (fl & 2) { const dx = dv.getUint8(p++); x += (fl & 16) ? dx : -dx; } else if (!(fl & 16)) { x += dv.getInt16(p); p += 2; } xs.push(x); }
  const ys = []; let y = 0;
  for (let i = 0; i < nPts; i++) { const fl = flags[i]; if (fl & 4) { const dy = dv.getUint8(p++); y += (fl & 32) ? dy : -dy; } else if (!(fl & 32)) { y += dv.getInt16(p); p += 2; } ys.push(y); }
  const out = [];
  let s = 0;
  for (let c = 0; c < nc; c++) { const e = endPts[c]; const seg = []; for (let i = s; i <= e; i++) seg.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 }); out.push(seg); s = e + 1; }
  return out;
}
function flatten(contours, steps = 8) {
  const polys = [];
  for (const seg of contours) {
    if (seg.length < 2) continue;
    let si = seg.findIndex(p => p.on); if (si < 0) si = 0;
    const seq = seg.slice(si).concat(seg.slice(0, si));
    let cur = seq[0].on ? { x: seq[0].x, y: seq[0].y } : { x: (seq[0].x + seq[seq.length - 1].x) / 2, y: (seq[0].y + seq[seq.length - 1].y) / 2 };
    if (!seq[0].on) seq.unshift({ x: cur.x, y: cur.y, on: true });
    const pl = [[cur.x, cur.y]];
    let i = 1;
    while (i < seq.length) {
      const p0 = seq[i];
      if (p0.on) { pl.push([p0.x, p0.y]); i++; continue; }
      const p1 = seq[i + 1]; if (!p1) break;
      const ex = p1.on ? p1.x : (p0.x + p1.x) / 2, ey = p1.on ? p1.y : (p0.y + p1.y) / 2;
      const sx = pl[pl.length - 1][0], sy = pl[pl.length - 1][1];
      for (let t = 1; t <= steps; t++) { const u = t / steps, iu = 1 - u; pl.push([iu * iu * sx + 2 * iu * u * p0.x + u * u * ex, iu * iu * sy + 2 * iu * u * p0.y + u * u * ey]); }
      i += p1.on ? 2 : 1;
    }
    if (pl.length > 2) polys.push(pl);
  }
  return polys;
}
function rasterize(polys) {
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (const pl of polys) for (const [x, y] of pl) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  const w = maxx - minx, h = maxy - miny;
  if (!(w > 0) || !(h > 0)) return null;
  const S = SUPER, pad = 2;
  const sc = (S - pad * 2) / Math.max(w, h);
  const bm = new Uint8Array(S * S);
  const ox = pad + (S - pad * 2 - w * sc) / 2, oy = pad + (S - pad * 2 - h * sc) / 2;
  const tx = x => (x - minx) * sc + ox, ty = y => (y - miny) * sc + oy;
  const edges = [];
  for (const pl of polys) for (let i = 0; i < pl.length; i++) {
    const a = pl[i], b = pl[(i + 1) % pl.length];
    if (a[1] === b[1]) continue;
    edges.push([tx(a[0]), ty(a[1]), tx(b[0]), ty(b[1])]);
  }
  for (let y = 0; y < S; y++) {
    const cy = y + 0.5, xs = [];
    for (const [x1, y1, x2, y2] of edges) if ((cy >= y1 && cy < y2) || (cy >= y2 && cy < y1)) xs.push(x1 + (cy - y1) / (y2 - y1) * (x2 - x1));
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(S - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = xa; x <= xb; x++) bm[y * S + x] = 1;
    }
  }
  return { bm, S };
}
function downBin(bmObj, res) {
  const { bm, S } = bmObj, f = S / res;
  const out = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    let c = 0, n = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const yy = Math.floor(y * f + dy), xx = Math.floor(x * f + dx); if (yy < S && xx < S) { c += bm[yy * S + xx]; n++; } }
    out[y * res + x] = (c / n) > 0.3 ? 1 : 0;
  }
  return out;
}
function blur9(bm, res) {
  const out = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= res || xx >= res) continue; s += bm[yy * res + xx]; n++; }
    out[y * res + x] = Math.round(s / n * 9);
  }
  return out;
}
function toStr(bm) { let s = ''; for (let i = 0; i < bm.length; i++) s += String.fromCharCode(48 + bm[i]); return s; }

// ---------------------------------------------------------------- 生成
console.log('参考字体: ' + REFS.join(', ') + '  res=' + RES);
const chars = [];
const bitmaps = [];
for (const rp of REFS) {
  const F = parseFont(new Uint8Array(readFileSync(rp)), 0);
  let n = 0;
  for (const [cp, gi] of F.c2g) {
    const ch0 = String.fromCharCode(cp);
    if (cp < 0x4E00 || cp > 0x9FA5) continue;
    if (WHITELIST && !WHITELIST.has(ch0)) continue;
    const cs = glyphContours(F, gi); if (!cs) continue;
    const polys = flatten(cs); if (!polys.length) continue;
    const r = rasterize(polys); if (!r) continue;
    const bm = downBin(r, RES);   // ★ 存"二值"位图：解码端要用同一套 matchInk+blur，存模糊值会把墨迹归一搞坏
    chars.push(ch0);
    bitmaps.push(toStr(bm));
    n++;
    if (LIMIT && chars.length >= LIMIT) break;
  }
  console.log('  ' + rp.split('\\').pop() + ': ' + n);
  if (LIMIT && chars.length >= LIMIT) break;
}
const out = { res: RES, n: chars.length, chars: chars.join(''), bitmaps };
const json = JSON.stringify(out);
writeFileSync(OUT, json, 'utf8');
console.log('字形数=' + chars.length + '  文件=' + (json.length / 1024 / 1024).toFixed(2) + 'MB  → ' + OUT);


