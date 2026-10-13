/**
 * build-loader.mjs — 生成 loader 扩展的 bundled.js（把最新脚本嵌进去作为兜底）
 * 用法：node build-loader.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const code = readFileSync(join(REPO, 'dist', 'netclass.user.js'), 'utf8');

// 嵌入为字符串字面量（JSON.stringify 安全转义）
const out = `// 由 build-loader.mjs 生成，勿手改。来源：dist/netclass.user.js
self.NETCLASS_BUNDLED = ${JSON.stringify(code)};
`;
mkdirSync(join(REPO, 'loader-ext'), { recursive: true });
const file = join(REPO, 'loader-ext', 'bundled.js');
writeFileSync(file, out, 'utf8');
console.log('built: ' + file);
console.log('  bundled bytes = ' + code.length);
