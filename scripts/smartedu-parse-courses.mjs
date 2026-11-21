#!/usr/bin/env node
/**
 * scripts/smartedu-parse-courses.mjs
 *
 * 从「附件3：顺德·区域定制课程」的 HTML 里抽出课程清单，产出结构化 courses.json。
 *
 * 为什么解析而不手抄
 * ------------------
 * 每门课都带 5~7 个 query 参数（courseId/tag/channelId/libraryId/breadcrumb/
 * firstLevel/secondLevel），14 门就是上百个 UUID。手抄一个字符错，课程页直接 404，
 * 而且错在 UUID 里肉眼看不出来。原文件的 <script> 里就是合法 JS 字面量，
 * 直接求值最可靠。
 *
 * 用法：
 *   node scripts/smartedu-parse-courses.mjs <附件3.html> [-o courses.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('用法: node scripts/smartedu-parse-courses.mjs <附件3.html> [-o out.json]');
  process.exit(1);
}
const outIdx = process.argv.indexOf('-o');
const out = outIdx > 0 ? process.argv[outIdx + 1] : 'courses.json';

const html = readFileSync(resolve(src), 'utf8');

// 抓 <script> 里的两个数据字面量。用标记定位，不依赖缩进。
function sliceBetween(text, startMark, endMark) {
  const i = text.indexOf(startMark);
  if (i < 0) throw new Error('找不到起点标记: ' + startMark);
  const j = text.indexOf(endMark, i);
  if (j < 0) throw new Error('找不到终点标记: ' + endMark);
  return text.slice(i + startMark.length, j);
}

const coreLit = sliceBetween(html, 'const coreCourse =', ';\n\n    const hotCourses');
const hotLit = sliceBetween(html, 'const hotCourses =', ';\n\n    function escapeHtml');

// 只在本地求值这两个字面量；不是执行页面脚本。
const coreCourse = new Function('return (' + coreLit + ')')();
const hotCourses = new Function('return (' + hotLit + ')')();

// ---- 关键课程（幼教）分类页 URL 从徽章按钮里取 ----
const keyCategoryUrls = {};
const catRe = /<a class="btn-cat-mini" href="([^"]+)"[^>]*><i class="fas ([^"]+)"><\/i>\s*([^<]+)<\/a>/g;
let m;
while ((m = catRe.exec(html))) {
  keyCategoryUrls[m[3].trim()] = m[1].replace(/&amp;/g, '&');
}

// ---- 关键课程四类人员卡片 ----
// 不能用非贪婪正则在嵌套 div 里找结尾：key-card 里套了 key-card-header /
// key-title-box / key-body / rec-row / rec-actions，`([\s\S]*?)</div></div></div>`
// 会在第一个三层闭合处停下，把后面的 btn-play / btn-category 全部切掉。
// 改为按 key-card 起点切块，块尾就是下一个起点（或 key-grid 结束）。
const keyCards = [];
const cardStarts = [];
const startMark = '<div class="key-card">';
let from = 0;
for (;;) {
  const i = html.indexOf(startMark, from);
  if (i < 0) break;
  cardStarts.push(i);
  from = i + startMark.length;
}
const gridEnd = html.indexOf('<div class="remark-note">', cardStarts[0] ?? 0);
for (let k = 0; k < cardStarts.length; k++) {
  const a = cardStarts[k];
  const b = k + 1 < cardStarts.length ? cardStarts[k + 1] : (gridEnd > a ? gridEnd : html.length);
  const block = html.slice(a, b);

  const title = (block.match(/<div class="key-title">([^<]+)<\/div>/) || [])[1];
  const sub = (block.match(/<div class="key-sub">([^<]+)<\/div>/) || [])[1];
  const recName = (block.match(/<div class="rec-name">(?:<i[^>]*><\/i>)?\s*([^<]+)<\/div>/) || [])[1];
  const recPath = (block.match(/<div class="rec-path">(?:<i[^>]*><\/i>)?\s*([^<]+)<\/div>/) || [])[1];
  const playUrl = (block.match(/<a class="btn-play" href="([^"]+)"/) || [])[1];
  const catUrl = (block.match(/<a class="btn-category" href="([^"]+)"/) || [])[1];
  if (!title) continue;
  keyCards.push({
    group: title.trim(),
    note: (sub || '').trim(),
    recommended: recName
      ? {
          name: recName.trim(),
          path: (recPath || '').trim(),
          url: (playUrl || '').replace(/&amp;/g, '&'),
          courseId: ((playUrl || '').match(/courseId=([^&]+)/) || [])[1] || null,
        }
      : null,
    categoryUrl: catUrl ? catUrl.replace(/&amp;/g, '&') : null,
  });
}

const u = (s) => (s || '').replace(/&amp;/g, '&');

const result = {
  _source: src,
  _parsed_at: new Date().toISOString(),
  platform: {
    name: '国家中小学智慧教育平台（智慧中小学）',
    origin: 'https://basic.smartedu.cn',
    login: 'https://basic.smartedu.cn/',
    realNameRequired: true,
  },
  requirement: {
    core: { count: 1, need: '全部学完，截图 100%已学习' },
    hot: { count: 10, need: '全部 10 门学完，截图需同屏显示 10 门' },
    key: { count: 3, need: '幼儿园教师，从幼教研修自选，至少 3 门' },
    screenshotRule: '每类一张「100%已学习」截图，桌面端或网页端二选一',
    deadline: '11月20日前',
  },
  core: [
    {
      index: 1,
      name: coreCourse.name,
      subtitle: coreCourse.subtitle,
      path: coreCourse.path,
      url: u(coreCourse.url),
      courseId: (u(coreCourse.url).match(/courseId=([^&]+)/) || [])[1] || null,
    },
  ],
  hot: hotCourses.map((h, i) => ({
    index: i + 1,
    name: h.name,
    path: h.path,
    url: u(h.url),
    courseId: (u(h.url).match(/courseId=([^&]+)/) || [])[1] || null,
  })),
  key: keyCards,
  keyCategoryUrls,
};

writeFileSync(resolve(out), JSON.stringify(result, null, 2), 'utf8');

console.log('core = ' + result.core.length);
console.log('hot  = ' + result.hot.length);
console.log('key  = ' + result.key.length + ' 组 (幼教/小学初中高中/特教/教科研)');
for (const k of result.key) {
  console.log('  - ' + k.group + ' | 推荐: ' + (k.recommended ? k.recommended.name : '(无)'));
}
console.log('-> ' + out);
