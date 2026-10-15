/**
 * build-check.mjs — 生成"密文字形 vs 解码结果"对照图（浏览器里渲染，肉眼校验解码正确性）
 *   node scripts/build-check.mjs
 * 左：密文字符用 font-cxsecret 渲染（= 正确字形）
 * 右：解码出的汉字用 SimSun 渲染（顺序错位就是解错了）
 */
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('runs/cx/quiz-decoded.html', 'utf8');
const map = JSON.parse(readFileSync('runs/cx/font-map.json', 'utf8'));
const fontCSS = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];

const rows = Object.keys(map).filter(k => map[k]);
// 按解码距离排序（好的在前）
rows.sort((a, b) => (map[a].d || 9) - (map[b].d || 9));

let table = '';
const COLS = 10;
for (let i = 0; i < rows.length; i += COLS) {
  const chunk = rows.slice(i, i + COLS);
  table += '<tr>';
  for (const c of chunk) {
    const m = map[c];
    table += `<td><div class="cell"><span class="cipher">${c}</span><span class="plain">${m.ch}</span><span class="meta">d=${m.d} m=${m.margin}</span></div></td>`;
  }
  table += '</tr>';
}

const out = `<!doctype html><html><head><meta charset="utf-8"><style>${fontCSS}
body{font-family:"SimSun",serif;margin:14px;background:#fff}
table{border-collapse:collapse}
td{border:1px solid #ddd;padding:4px}
.cell{display:flex;flex-direction:column;align-items:center;width:78px}
.cipher{font-family:"font-cxsecret","SimSun",serif;font-size:38px;line-height:1.05}
.plain{font-family:"SimSun",serif;font-size:38px;line-height:1.05;color:#0a0}
.meta{font-size:9px;color:#999}
h3{font-family:"SimSun";margin:6px 0}
</style></head><body>
<h3>每组：上=密文字形（渲染正确的字） / 下=解码结果 — 两个字一样就是对</h3>
<table>${table}</table>
</body></html>`;
writeFileSync('runs/cx/decode-check.html', out, 'utf8');
console.log('rows=' + rows.length + ' -> runs/cx/decode-check.html');
