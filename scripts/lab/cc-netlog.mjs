/** cc-netlog.mjs — 抓某标签的 console + 网络请求（诊断视频流为何 load 不动）
 *  node scripts/cc-netlog.mjs --tab 0 --secs 30 [--reload]
 */
import { Tab, listCcTabs, sleep } from './cc-lib.mjs';
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), TAB = Number(A.tab || 0), SECS = Number(A.secs || 30);

const tabs = await listCcTabs(PORT);
const t = tabs[TAB] || tabs[0];
const tab = new Tab(t, PORT);
await tab.connect();

const seen = new Set();
tab.ws.addEventListener('message', ev => {
  let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/(m3u8|\.ts\b|\.mp4|\.m4s|\.flv|media|video|stream|play|progress|report|heart)/i.test(u)) {
      const k = m.params.request.method + ' ' + u.slice(0, 150);
      if (!seen.has(k)) { seen.add(k); console.log('REQ ' + k); }
    }
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/(m3u8|\.ts\b|\.m4s|media|video|progress|report)/i.test(u)) {
      const k = 'RESP ' + m.params.response.status + ' ' + u.slice(0, 130);
      if (!seen.has(k)) { seen.add(k); console.log(k); }
    }
  }
  if (m.method === 'Network.loadingFailed') {
    console.log('FAIL ' + String(m.params.errorText).slice(0, 80) + ' ' + String(m.params.requestId).slice(0, 10));
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    console.log('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 200));
  }
  if (m.method === 'Log.entryAdded') console.log('[log:' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 200));
  if (m.method === 'Runtime.exceptionThrown') console.log('[EXC] ' + String(m.params.exceptionDetails.text || '').slice(0, 200));
});
await tab.send('Network.enable', {});
await tab.send('Runtime.enable', {});
await tab.send('Log.enable', {});
if (A.reload) await tab.reload();
console.log('监听 ' + SECS + 's（tab=' + t.id.slice(0, 6) + '）');
await sleep(SECS * 1000);
const v = await tab.ev(`(function(){var v=document.querySelector('video');return JSON.stringify(v?{cur:v.currentTime,rs:v.readyState,ns:v.networkState,buf:v.buffered.length?v.buffered.end(0):0,src:String(v.currentSrc).slice(0,50)}:{novideo:true})})()`);
console.log('终态: ' + v);
process.exit(0);
