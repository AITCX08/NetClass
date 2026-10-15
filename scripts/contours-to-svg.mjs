/**
 * contours-to-svg.mjs — 把浏览器导出的字形轮廓点转成 SVG 路径（用来肉眼验证轮廓是否正确）
 *   node scripts/contours-to-svg.mjs --in runs/cx/font-contours.json --chars 恣咭咰 --out runs/cx/glyphs.svg
 */
import { readFileSync, writeFileSync } from 'node:fs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const src = JSON.parse(readFileSync(A.in || 'runs/cx/font-contours.json', 'utf8'));
const chars = A.chars ? Array.from(A.chars) : Object.keys(src).slice(0, 12);
const COLS = 6, CELL = 120;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * CELL}" height="${Math.ceil(chars.length / COLS) * (CELL + 20)}" style="background:#fff">`;
svg += `<defs><marker id="d" markerWidth="6" markerHeight="6" refX="3" refY="3"><circle r="2" fill="red"/></marker></defs>`;
chars.forEach((ch, i) => {
  const g = src[ch]; if (!g) return;
  const upem = g.upem || 1000;
  const col = i % COLS, row = Math.floor(i / COLS);
  const sc = CELL / upem;
  const ox = col * CELL, oy = row * (CELL + 20) + 16;
  let d = '';
  for (const seg of g.contours) {
    if (!seg.length) continue;
    seg.forEach((p, k) => {
      const x = Number((p[0] * sc + 20).toFixed(2));
      const y = Number((upem * sc - p[1] * sc + 6).toFixed(2));
      d += (k === 0 ? 'M' : 'L') + x + ' ' + y + ' ';
    });
    d += 'Z ';
  }
  svg += `<g transform="translate(${ox},${oy})">`;
  svg += `<path d="${d}" fill="#000" fill-rule="evenodd"/>`;
  svg += `<text x="2" y="${CELL - 2}" font-size="11" fill="#c00">${ch} U+${ch.codePointAt(0).toString(16)} pts=${g.contours.reduce((s, x) => s + x.length, 0)}</text>`;
  svg += `</g>`;
});
svg += '</svg>';
writeFileSync(A.out || 'runs/cx/glyphs.svg', svg, 'utf8');
console.log('chars=' + chars.join('') + ' -> ' + (A.out || 'runs/cx/glyphs.svg'));
