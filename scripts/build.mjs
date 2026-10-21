/**
 * build.mjs — 把壳 + 实现模块打包成「自包含单文件用户脚本」dist/netclass.user.js
 *   自包含 = 不依赖本机 HTTP 服务也能跑；如果本机服务在，则优先热加载最新实现（方便我这边改）。
 * 用法：node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const shell = readFileSync(join(REPO, 'userscript', 'netclass.shell.user.js'), 'utf8');
// ★ 2026-10-20：品牌/引流配置（brand.js）内联到 App.js 之前。
//   userscript 注入在页面里读不到本地文件，二维码必须 base64 内联；
//   单独一个文件方便换图/关闭，不碰主逻辑。文件缺失时用空实现兜底。
let brandSrc = '';
try {
  brandSrc = readFileSync(join(REPO, 'userscript', 'brand.js'), 'utf8');
} catch (_) {
  console.log('  ⚠ userscript/brand.js 缺失 → 品牌区块将不显示');
}
const appRaw = readFileSync(join(REPO, 'userscript', 'App.js'), 'utf8');
// ★ 只剥掉 Node 侧的 module.exports 那段（浏览器/页面里跑会 ReferenceError）。
//   ⚠️ 不能从 "// 供 App.js" 那个注释开始剥 —— 它出现在 window.NETCLASS_BRAND = BRAND 之前，
//      会把赋值语句一起删掉，导致 App.js 里读到 undefined（实测踩过）。
const brandClean = brandSrc.replace(/\n\/\/ Node 侧[\s\S]*$/, '\n');
const app = (brandClean ? brandClean + '\n' : '') + appRaw;

const version = (app.match(/const VERSION = '([\d.]+)'/) || [, '0.4.0'])[1];

// 1) 把 App.js 作为内联兜底嵌进壳：INLINE 分支直接注入，不再依赖 17800
const marker = "const MODULE = 'App.js';";
if (!shell.includes(marker)) throw new Error('shell marker not found');
let out = shell.replace(marker, `${marker}\n  // === 内联实现（构建时嵌入；运行时若本机服务可用会用服务上的最新版）===\n  const INLINE_APP = ${JSON.stringify(app)};`);

// 2) 壳里 loadModule 失败分支：改用内联
const fallbackCall = "        warn('本机模块服务不可用（status=' + status + '）：' + BASE + MODULE + '，进入兜底模式', reason);\n        return inlineFallback();";
if (!out.includes(fallbackCall)) throw new Error('fallback marker not found');
out = out.replace(fallbackCall,
  `        const inlineH = 'inline-' + hash(INLINE_APP);
        if (currentHash === inlineH) return;   // 内联版已在跑，别每轮重复注入
        warn('本机模块服务不可用（status=' + status + '），使用内联实现', reason);
        try {
          if (window.NetClass && window.NetClass.dispose) window.NetClass.dispose();
          const ok = inject(INLINE_APP, 'inline-App');
          if (ok) { currentHash = inlineH; say('内联实现已加载'); }
          else inlineFallback();
        } catch (e) { warn('内联注入失败', e && e.message); inlineFallback(); }
        return;`);

// 3) 同步版本号
out = out.replace(/@version\s+[\d.]+/, '@version      ' + version);
out = out.replace(/const VERSION = '[\d.]+';/, `const VERSION = '${version}';`);

// 4) 头部信息补全（OCS 列表里显示更清楚）
out = out.replace('// @name         NetClass 网课自动处理（壳）', '// @name         NetClass 网课自动处理');
out = out.replace('// @description  两站网课自动处理引导壳：从本机 127.0.0.1:17800 热加载实现模块（不停机更新），并保留内嵌兜底实现。',
  '// @description  自动处理 shengshengketang / bjqiyang 两站网课：自动播放·静音·倍速·掉速纠正·自动下一节·随堂弹题自动作答·本地题库。自研实现。');

// 5) 加入 bjqiyang 的 match（若有遗漏）
if (!/@match\s+https:\/\/study\.bjqiyang\.com/.test(out)) {
  out = out.replace('// @match        https://edu.shengshengketang.com/*',
    '// @match        https://edu.shengshengketang.com/*\n// @match        https://study.bjqiyang.com/*');
}

const distDir = join(REPO, 'dist');
mkdirSync(distDir, { recursive: true });
const outFile = join(distDir, 'netclass.user.js');
writeFileSync(outFile, out, 'utf8');

console.log('built: ' + outFile);
console.log('  version = ' + version);
console.log('  size    = ' + out.length + ' bytes');
console.log('  inline  = ' + app.length + ' bytes');
console.log('  matches = ' + (out.match(/\/\/ @match.*/g) || []).join(' | '));
