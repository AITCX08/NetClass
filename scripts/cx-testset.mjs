/**
 * cx-testset.mjs — 从「已提交测验的成绩单」生成答题测试集（带真值）
 *   node scripts/cx-testset.mjs
 *
 * 输入：runs/cx-quiz-scores.json（由 scripts/cx-quiz-lab.mjs --scores 生成，含每题 bodyText）
 * 输出：runs/cx-quiz-testset.json
 *
 * 真值规则（学习通成绩单只回显"我的答案 + 得分"，不回显正确答案）：
 *   · 得分 > 0  → 我的答案 = 正确答案（直接可用）
 *   · 判断题 得分 = 0 → 正确答案必为"我的答案"的反面（判断题只有对/错两解）
 *   · 单选/多选 得分 = 0 → 正确答案未知，**不收录**（避免用弱标签污染测试集）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const rows = JSON.parse(readFileSync(join(REPO, 'runs', 'cx-quiz-scores.json'), 'utf8'));

const KIND2 = { '判断题': 'judge', '单选题': 'single', '多选题': 'multiple', '填空题': 'blank' };
const out = [];
let skipped = 0;

for (const row of rows) {
  const t = String(row.bodyText || '').replace(/\s+/g, ' ').trim();
  if (!t) continue;
  const re = /(\d+)\s*【(判断题|单选题|多选题|填空题)】([\s\S]*?)(?=(?:\d+\s*【(?:判断题|单选题|多选题|填空题)】)|$)/g;
  let m;
  while ((m = re.exec(t))) {
    const kind = KIND2[m[2]];
    let body = m[3].trim();
    const mineM = body.match(/我的答案：([\s\S]*?)得分：\s*([0-9.]+)分/);
    if (!mineM) { skipped++; continue; }
    const mineRaw = mineM[1].trim();
    const score = Number(mineM[2]);
    const qtext = body.slice(0, body.indexOf('我的答案：')).trim();
    // 题干：到第一个选项标记（A、 / A. ）为止
    const optStart = qtext.search(/ A[、.．]/);
    const stem = (optStart >= 0 ? qtext.slice(0, optStart) : qtext).trim();
    // 选项（★ 前面必须先补一个空格：split 的第一个分隔符要求有前置空白，否则会丢掉 A 选项）
    const options = [];
    if (optStart >= 0) {
      const tail = qtext.slice(optStart).trim();
      const parts = (' ' + tail).split(/\s+([A-H])[、.．]\s*/);
      for (let i = 1; i < parts.length; i += 2) options.push({ letter: parts[i], text: (parts[i + 1] || '').trim() });
    } else {
      options.push({ letter: 'A', text: '对' }, { letter: 'B', text: '错' });
    }
    // 我的答案字母（★ 只取开头的连续字母，"我的答案：ABC :A; xx ;B; yy" 里后面的 A/B 是选项标号）
    let mine = '';
    if (kind === 'judge') mine = /^对/.test(mineRaw) ? 'A' : (/^错/.test(mineRaw) ? 'B' : '');
    else mine = (mineRaw.match(/^\s*([A-H]+)/) || [null, ''])[1];
    if (!mine) { skipped++; continue; }
    let correct = null, why = '';
    if (score > 0) { correct = mine; why = 'score>0'; }
    else if (kind === 'judge') { correct = (mine === 'A') ? 'B' : 'A'; why = 'judge-binary'; }
    if (!correct) { skipped++; continue; }
    out.push({ chapter: row.title, id: row.id, kind, stem, options, correct, correctLetters: correct.split(''), why, mine, score });
  }
}

const byKind = {};
out.forEach(x => { byKind[x.kind] = (byKind[x.kind] || 0) + 1; });
writeFileSync(join(REPO, 'runs', 'cx-quiz-testset.json'), JSON.stringify(out, null, 1), 'utf8');
console.log('测试集条目: ' + out.length + '  ' + JSON.stringify(byKind) + '   跳过(弱标签): ' + skipped);
console.log('已落盘 runs/cx-quiz-testset.json');
out.filter(x => x.kind === 'judge').forEach((x, i) => console.log('  J' + (i + 1) + ' 真值=' + (x.correct === 'A' ? '对' : '错') + ' [' + x.chapter + '] ' + x.stem.slice(0, 60)));
