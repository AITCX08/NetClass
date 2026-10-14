/**
 * content-grounding-check.mjs — 成稿是否"落地到这门课"的硬闸门
 *
 *   node scripts/content-grounding-check.mjs --doc <docx或md> --facts <00_课程事实.md> [--min 3] [--json]
 *
 * 做法：从 --facts 里抽取课程专有词（课程名/章节/案例/人名，长度≥4 的中文串），
 *       再数成稿命中几个。命中 < --min 就判"没有课程痕迹"并 **exit 1**（用于生成流程把关，
 *       不合格就重生成，而不是交货）。
 *
 * 背景：2026-10-14 给田蕊交的两份作业，文档里课程专有词命中 0 —— 主题对口但通篇通用话，
 *       根因是生成时只喂了标题没喂课程事实。这个脚本就是防它再发生的闸门。
 */
const fs = await import('node:fs');
const zlib = await import('node:zlib');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const MIN = Number(A.min == null ? 3 : A.min);

/** 读文本：.docx 直接解 zip 里的 word/document.xml；其它按纯文本读 */
function readText(p) {
  if (!/\.docx$/i.test(p)) return fs.readFileSync(p, 'utf8');
  const buf = fs.readFileSync(p);
  // 简易 zip 扫描：找 word/document.xml 的本地文件头并 inflate
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let off = 0, data = null;
  while ((off = buf.indexOf(sig, off)) >= 0) {
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const compr = buf.readUInt16LE(off + 8);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    if (name === 'word/document.xml') {
      const dataStart = off + 30 + nameLen + extraLen;
      // 用下一个文件头（或结束记录）估算压缩数据长度
      let next = buf.indexOf(sig, dataStart);
      const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
      if (cd >= 0 && (next < 0 || cd < next)) next = cd;
      const raw = buf.slice(dataStart, next > 0 ? next : undefined);
      data = compr === 8 ? zlib.inflateRawSync(raw) : raw;
      break;
    }
    off += 1;
  }
  if (!data) return '';
  return data.toString('utf8').replace(/<w:p[ >]/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, '');
}

const docText = readText(String(A.doc || '')).replace(/\s+/g, '');
const factsRaw = fs.readFileSync(String(A.facts || ''), 'utf8');
if (!docText) { console.log('读不到成稿正文: ' + A.doc); process.exit(2); }

// 从事实文件里抽词：中文 4~20 字的连续串（去重、去掉泛词）
const STOP = /^(课程学习|教师专业发展|必修|模块|温故知新|继续学习|课程名称|层次|操作|培训|研修|学习|老师|教师|教育|教学|学生)$/;
const words = new Set();
for (const line of factsRaw.split(/\r?\n/)) {
  const l = line.replace(/^[#*\-\s>|]+/, '').trim();
  if (!l || /^[#*\-|>\s]+$/.test(line)) continue;
  for (const m of l.matchAll(/[\u4e00-\u9fa5A-Za-z0-9．.：:（）()]{4,24}/g)) {
    const w = m[0].replace(/[：:（）()]/g, '');
    if (w.length >= 4 && !STOP.test(w)) words.add(w);
  }
}
const hits = [];
for (const w of words) if (docText.indexOf(w) >= 0) hits.push(w);

const ok = hits.length >= MIN;
const out = {
  doc: A.doc, facts_words: words.size, hits: hits.slice(0, 20), hit_count: hits.length, min: MIN, pass: ok
};
console.log(JSON.stringify(A.json ? out : {
  ...out, sample_words: [...words].slice(0, 8)
}, null, A.json ? 0 : 2));
if (!ok) {
  console.log('\n❌ 未通过落地校验：成稿里课程专有词命中 ' + hits.length + ' < ' + MIN);
  console.log('   → 重生成：把 00_课程事实.md 的内容粘进 paperwriter 的 --requirements，并要求"至少引用 N 个具体章节/案例"');
  process.exit(1);
}
console.log('\n✅ 通过：命中 ' + hits.length + ' 个课程专有词');
