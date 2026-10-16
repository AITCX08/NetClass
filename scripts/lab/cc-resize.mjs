/**
 * cc-resize.mjs — 把目标标签的视口恢复到可用尺寸（关闭多标签后窗口常被压到 ~237px 高）
 *   node scripts/cc-resize.mjs --port 9228 [--w 1200 --h 1000]
 */
import { listCcTabs, Tab, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), W = Number(A.w || 1200), H = Number(A.h || 1000);

const tabs = await listCcTabs(PORT);
if (!tabs || !tabs.length) { console.log('没有 ccjyxy 标签'); process.exit(1); }
const tab = new Tab(tabs[0], PORT);
await tab.connect();
const before = await tab.ev(`JSON.stringify({iw:window.innerWidth,ih:window.innerHeight})`);
console.log('原视口: ' + before);
try {
  await tab.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  console.log('已 setDeviceMetricsOverride ' + W + 'x' + H);
} catch (e) { console.log('override 失败: ' + e.message); }
await sleep(1500);
const after = await tab.ev(`JSON.stringify({iw:window.innerWidth,ih:window.innerHeight})`);
console.log('新视口: ' + after);
process.exit(0);
