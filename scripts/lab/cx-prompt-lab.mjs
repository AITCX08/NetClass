/**
 * cx-prompt-lab.mjs — 答题提示词 A/B 台（用真值测试集打分）
 *   node scripts/cx-prompt-lab.mjs --port 9227 --set runs/cx-quiz-testset.json --variants batch,nonrepair
 *
 * 为什么这么做：学习通的成绩单**不回显正确答案**，所以"改提示词有没有用"只能靠真值集对照。
 * 真值集来自已提交测验的成绩单（得分>0 → 我的答案即正确答案；判断题得分=0 → 正确答案是反面）。
 *
 * 模型调用走**页面内**（和产线同一条路：key 在 window.__NC_DS_KEY__，页面直连 api.deepseek.com）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing\.com/.test(t.url));
if (!p) { console.log('没有 chaoxing 页面'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, pr = {}, ms = 180000) => new Promise(res => {
  const id = ++seq;
  const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params: pr }));
  setTimeout(() => res({ timeout: true }), ms);
});
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.timeout) return { __timeout: true }; if (r.result && r.result.exceptionDetails) return { __err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 300) }; return r.result && r.result.result ? r.result.result.value : null; };

const set = JSON.parse(readFileSync(join(REPO, String(A.set || 'runs/cx-quiz-testset.json')), 'utf8'));
console.log('测试集: ' + set.length + ' 题  (judge/single/multiple) = '
  + set.filter(x => x.kind === 'judge').length + '/' + set.filter(x => x.kind === 'single').length + '/' + set.filter(x => x.kind === 'multiple').length);

await ev(readFileSync(join(REPO, 'runs/cx/cx-ask.js'), 'utf8'));
const probe = await ev('JSON.stringify({hasAsk: typeof window.__cxAsk, key: !!(window.__NC_DS_KEY__)})');
console.log('页面模块: ' + probe);

// ---------------------------------------------------------------- 提示词变体
const SYS_REPAIR = [
  '你是中国高校思政类网课（形势与政策、思想道德与法治等）章节测验的答题专家，目标是拿满分。',
  '',
  '【题面有字体反爬造成的错别字，必须先还原再作答】',
  '网页把部分汉字换成了形近字，例如：监→竖、体系→系统、国家→曰家、具有→灵苞、特→持、由→山、',
  '构→枸、面→固、情→清、有效→苞敕。请先在理解上把它们还原成通顺的原文。',
  '',
  '【答题纪律】',
  '1) 判断题：逐项核对题干里的时间、数字、人物、文件名称、范围与绝对化措辞。只要有一处与事实或',
  '   教材原文不符，答案就是「错」；完全相符才答「对」。必须逐题独立判断，不允许因为"像官方表述"',
  '   就一律答「对」。',
  '2) 多选题：逐项独立判断每个选项本身是否正确；正确的都要选。四项都对就选 ABCD（不要为了避险而漏选），',
  '   也不要因为"看着都对"就多选。',
  '3) 单选题：特别注意「不属于／不是／不正确／错误的是」这类反向提问，要选"不符合"的那一项。',
  '',
  '【输出格式】先给一行一题的极简依据（不超过 30 字），最后输出一个 json 代码块：',
  '```json',
  '{"1":"对","2":"ACD","3":"B"}',
  '```',
  '判断题的值只能是「对」或「错」；选择题的值是选项字母串。json 里不要写别的东西。'
].join('\n');

const SYS_NO_REPAIR = SYS_REPAIR.split('【答题纪律】')[0].replace(/\n【题面有字体反爬[\s\S]*?\n\n/, '\n') + '【答题纪律】' + SYS_REPAIR.split('【答题纪律】')[1];

const SYS_STRICT_JUDGE = SYS_REPAIR
  .replace('1) 判断题：逐项核对题干里的时间、数字、人物、文件名称、范围与绝对化措辞。只要有一处与事实或',
    '1) 判断题：**先用「错」作为默认假设**，逐项去找题干里与事实/教材原文不符的地方（时间、数字、人物、文件名称、范围、绝对化措辞、因果方向）。只有在你确认整句与教材原文完全一致时才答「对」。核对要点：')
  .replace('   教材原文不符，答案就是「错」；完全相符才答「对」。必须逐题独立判断，不允许因为"像官方表述"',
    '   这类题的正确率经验上一半对一半错，**不要因为"像官方表述"就答「对」**，也不要因为"读起来别扭"');

function buildUser(paper, style) {
  const L = [];
  L.push('课程：' + (paper.course || '形势与政策') + (paper.chapter ? '　章节：' + paper.chapter : ''));
  L.push('下面是章节测验的全部题目（共 ' + paper.questions.length + ' 题），请按格式作答：');
  paper.questions.forEach((q, i) => {
    L.push('');
    L.push((i + 1) + '. ' + (q.typeText || '') + ' ' + String(q.stem || '').replace(/\s+/g, ' ').slice(0, 400));
    (q.options || []).forEach(o => L.push('   ' + o.letter + '. ' + String(o.text || '').replace(/\s+/g, ' ').slice(0, 160)));
  });
  L.push('');
  L.push('请先给极简判断依据，最后给 json。');
  return L.join('\n');
}

const SYS_JSONONLY = SYS_REPAIR
  .replace('【输出格式】先给一行一题的极简依据（不超过 30 字），最后输出一个 json 代码块：',
    '【输出格式·严格遵守】**只输出一个 json 代码块，不要任何解释、不要任何其它文字**：')
  + '\n（先在心里核对，核对过程不要写出来。）';

const SYS_JSONFIRST = SYS_REPAIR
  .replace('【输出格式】先给一行一题的极简依据（不超过 30 字），最后输出一个 json 代码块：',
    '【输出格式】**第一件事就是输出 json 代码块**，然后（可选）再用一行一题写要点：');

const VARIANTS = {
  batch: { sys: SYS_REPAIR, note: '整卷一问：含错字还原说明 + 判断题逐项核对 + 多选可全选' },
  nonrepair: { sys: SYS_NO_REPAIR, note: '消融：去掉错字还原说明' },
  strictjudge: { sys: SYS_STRICT_JUDGE, note: '整卷一问：判断题改用"默认错、去找不符点"的核对口径' },
  review: { sys: SYS_REPAIR, note: '整卷一问 + 复核一遍（取第二遍结果）', two: true },
  jsononly: { sys: SYS_JSONONLY, maxTokens: 700, note: '整卷一问：只准输出 json（防长回复跑飞/截断）' },
  jsononly2: { sys: SYS_JSONONLY, maxTokens: 700, note: '同上，第二遍采样（看稳定性）' },
  jsonfirst: { sys: SYS_JSONFIRST, maxTokens: 1400, note: 'json 先输出，要点放后面（截断也不丢答案）' },
  prod: { sys: null, note: '产线现状：逐题 NetClass.askDs（对照）' }
};

const want = String(A.variants || 'batch,strictjudge').split(',').map(s => s.trim()).filter(Boolean);

function normLetter(val, kind, avail) {
  const s = String(val === undefined || val === null ? '' : val).trim();
  if (!s) return null;
  if (kind === 'judge') {
    if (/^(对|正确|是|true|t|y|yes|a)$/i.test(s)) return ['A'];
    if (/^(错|错误|否|false|f|n|no|b)$/i.test(s)) return ['B'];
    if (/对|正确|true/i.test(s)) return ['A'];
    if (/错|错误|false/i.test(s)) return ['B'];
    return null;
  }
  let got = (s.toUpperCase().match(/[A-H]/g) || []).filter(l => avail.includes(l));
  got = [...new Set(got)].sort();
  if (!got.length) return null;
  return kind === 'single' ? [got[0]] : got;
}

const report = {};
for (const vname of want) {
  const V = VARIANTS[vname];
  if (!V) { console.log('未知变体: ' + vname); continue; }
  console.log('\n================ 变体 ' + vname + ' —— ' + V.note + ' ================');
  const callQuestions = set.map((x, i) => ({ no: i + 1, kind: x.kind, typeText: '', stem: x.stem, options: x.options }));
  const paper = { course: '形势与政策', chapter: '(测试集)', questions: callQuestions };
  const got = {};
  const t0 = Date.now();
  if (vname === 'prod') {
    // 逐题走产线接口
    for (let i = 0; i < set.length; i++) {
      const x = set[i];
      const optionList = x.options.map(o => ({ name: o.letter, data: o.text }));
      const type = x.kind === 'multiple' ? 2 : (x.kind === 'judge' ? 3 : 1);
      const r = await ev(`(function(){ if(!(window.NetClass&&NetClass.askDs)) return 'NO-MODULE';
        var r = NetClass.askDs({ type: ${type}, name: ${JSON.stringify(x.stem.slice(0, 300))}, optionList: ${JSON.stringify(optionList)} });
        return Promise.resolve(r).then(function(x){ return typeof x === 'string' ? x : JSON.stringify(x); }); })()`);
      got[i] = String(r);
    }
  } else {
    const user = buildUser(paper);
    const r = await ev(`(function(){ var s = ${JSON.stringify(V.sys)}; var u = ${JSON.stringify(user)};
      return window.__cxAsk.chat(s, u, { maxTokens: ${Number(V.maxTokens || 3000)} }).then(function(r){ return JSON.stringify(r); }).catch(function(e){ return 'ERR:' + e.message; }); })()`);
    let R = null; try { R = JSON.parse(String(r)); } catch (e) { }
    if (!R || R.text === undefined) { console.log('  调用失败: ' + String(r).slice(0, 300)); continue; }
    console.log('  模型 tokens=' + R.tokens + '  回复长度=' + R.text.length);
    const obj = await ev(`(function(){ return JSON.stringify(window.__cxAsk.pickJson(${JSON.stringify(R.text)})); })()`);
    let O = null; try { O = JSON.parse(String(obj)); } catch (e) { }
    console.log('  解析出答案: ' + (O ? Object.keys(O).length : 0) + ' / ' + set.length);
    writeFileSync(join(REPO, 'runs', 'cx-lab-' + vname + '-raw.txt'), String(R.text), 'utf8');
    // 第二遍复核：只让模型重新独立判断（专治判断题惯性）
    if (V.two && O) {
      const L2 = [];
      L2.push('下面是同一份章节测验，以及第一次作答的结果。请**完全重新独立判断**每一题：');
      L2.push('先用「错」为默认假设去核对判断题的每一处事实（时间/数字/人物/文件名/范围/绝对化措辞），');
      L2.push('找出与教材原文不符之处；选择题逐项核对每个选项。不要默认沿用第一次的答案。');
      set.forEach((x, i) => {
        L2.push('');
        L2.push((i + 1) + '. ' + x.stem.slice(0, 400));
        x.options.forEach(o => L2.push('   ' + o.letter + '. ' + String(o.text).slice(0, 160)));
        L2.push('   第一次答案：' + JSON.stringify(O[String(i + 1)]));
      });
      L2.push('');
      L2.push('给出最终答案的 json 代码块（键为题号）。');
      const user2 = L2.join('\n');
      const r2 = await ev(`(function(){ var s = ${JSON.stringify(V.sys)}; var u = ${JSON.stringify(user2)};
        return window.__cxAsk.chat(s, u, { maxTokens: 3000 }).then(function(r){ return JSON.stringify(r); }).catch(function(e){ return 'ERR:' + e.message; }); })()`);
      let R2 = null; try { R2 = JSON.parse(String(r2)); } catch (e) { }
      if (R2 && R2.text) {
        const obj2 = await ev(`(function(){ return JSON.stringify(window.__cxAsk.pickJson(${JSON.stringify(R2.text)})); })()`);
        let O2 = null; try { O2 = JSON.parse(String(obj2)); } catch (e) { }
        let same = 0;
        set.forEach((x, i) => { if (JSON.stringify(O2 && O2[String(i + 1)]) === JSON.stringify(O[String(i + 1)])) same++; });
        console.log('  复核 tokens=' + R2.tokens + '  与第一遍一致 ' + same + '/' + set.length);
        writeFileSync(join(REPO, 'runs', 'cx-lab-' + vname + '-raw2.txt'), String(R2.text), 'utf8');
        if (O2) O = O2;
      } else console.log('  复核失败: ' + String(r2).slice(0, 200));
    }
    set.forEach((x, i) => { got[i] = O ? O[String(i + 1)] : null; });
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  // 评分
  const per = { judge: [0, 0], single: [0, 0], multiple: [0, 0] };
  const wrong = [];
  set.forEach((x, i) => {
    const avail = x.options.map(o => o.letter);
    const notLetters = x.kind === 'judge' ? normLetter(got[i], 'judge', avail) : normLetter(got[i], x.kind, avail);
    per[x.kind][1]++;
    let ok = false;
    if (notLetters) {
      const a = [...notLetters].sort().join('');
      const b = [...x.correctLetters].sort().join('');
      ok = (a === b) || (x.kind === 'judge' && (notLetters[0] === x.correctLetters[0]));
    }
    if (ok) per[x.kind][0]++; else wrong.push({ i: i + 1, kind: x.kind, stem: x.stem.slice(0, 70), got: got[i], want: x.correct });
  });
  const tot = set.length, corr = per.judge[0] + per.single[0] + per.multiple[0];
  console.log('  耗时 ' + secs + 's   总分: ' + corr + '/' + tot + ' = ' + (100 * corr / tot).toFixed(1) + '%');
  console.log('  判断 ' + per.judge[0] + '/' + per.judge[1] + '   单选 ' + per.single[0] + '/' + per.single[1] + '   多选 ' + per.multiple[0] + '/' + per.multiple[1]);
  wrong.slice(0, 12).forEach(w => console.log('   ✗ #' + w.i + ' ' + w.kind + ' 得=' + JSON.stringify(w.got) + ' 应=' + w.want + ' | ' + w.stem));
  report[vname] = { total: corr + '/' + tot, judge: per.judge, single: per.single, multiple: per.multiple, secs: Number(secs), wrong: wrong.length };
}
console.log('\n===== 汇总 =====');
for (const k in report) console.log('  ' + k.padEnd(12) + JSON.stringify(report[k]));
writeFileSync(join(REPO, 'runs', 'cx-prompt-lab.json'), JSON.stringify(report, null, 1), 'utf8');
ws.close();
