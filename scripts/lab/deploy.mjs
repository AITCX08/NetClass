/**
 * deploy.mjs — 一条命令完成：启动调试 Chrome → 装壳脚本进 Tampermonkey → 打开课程页 → 验证脚本生效
 *
 * 用法：
 *   node deploy.mjs --profile test-profile                     # 演练（干净副本，不动真库）
 *   node deploy.mjs --profile b33d3127b601404c8d0f694bb02939fa --url https://edu.shengshengketang.com/
 *
 * 依赖：PC 侧已建立 SSH 隧道（scripts/tunnel.ps1 -Port <port>）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const LAPTOP = 'user@host';
const SSH_KEY = 'C:/Users/YOURNAME/.ssh/id_ed25519';
const CHROME = 'C:\\Users\\YOURNAME\\AppData\\Local\\Programs\\OCS Desktop\\resources\\bin\\chrome\\chrome\\chrome.exe';
const EXT_TM = 'C:/Users/YOURNAME/AppData/Roaming/OCS Desktop/downloads/extensions/tampermonkey';
const PREF_ROOT = 'C:\\Users\\YOURNAME\\AppData\\Roaming\\OCS Desktop\\userDataDirs';
const WORK = 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass';

const SSH = [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.100',
  '-o', 'UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts',
  '-i', SSH_KEY, LAPTOP
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ssh(cmd, timeout = 60000) {
  try {
    return execFileSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe', [...SSH, cmd],
      { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], input: '' });
  } catch (e) { return ('[ssh err] ' + (e.stdout || '') + (e.stderr || '')).trim(); }
}

/** 把一段 PS 脚本分块送上去执行（ASCII base64，避免编码/长度问题） */
function remotePs(code, tag = 'deploy', timeout = 300000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  const chunk = 1200;
  const f = `${WORK}\\${tag}.b64`;
  ssh(`powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${WORK}' | Out-Null; Set-Content -LiteralPath '${f}' -Value '' -Encoding ASCII; 'ok'"`, 30000);
  for (let i = 0; i < b64.length; i += chunk) {
    ssh(`powershell -NoProfile -Command "Add-Content -LiteralPath '${f}' -Value '${b64.slice(i, i + chunk)}' -Encoding ASCII -NoNewline"`, 30000);
  }
  const dec = `powershell -NoProfile -Command "$b=(Get-Content -LiteralPath '${f}' -Raw) -replace '[^A-Za-z0-9+/=]',''; ` +
    `$c=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b)); ` +
    `[IO.File]::WriteAllText('${WORK}\\${tag}-exec.ps1',$c,(New-Object Text.UTF8Encoding($false))); ` +
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '${WORK}\\${tag}-exec.ps1'"`;
  return ssh(dec, timeout);
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  static async browser(port) {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const c = new Cdp(v.webSocketDebuggerUrl); await c.open(); return c;
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', e => rej(new Error('ws err')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify(p));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

// ---------------------------------------------------------------- args
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;

const PORT = Number(A.port || 9224);
const PROFILE = A.profile || 'test-profile';
const IS_TEST = PROFILE === 'test-profile';
const PROFILE_DIR = IS_TEST ? `${WORK}\\test-profile` : `${PREF_ROOT}\\${PROFILE}`;
const TAG = IS_TEST ? 'test' : String(PROFILE).slice(0, 8);
const COURSE_URL = A.url || '';
const SHELL = join(REPO, 'userscript', 'netclass.shell.user.js');

console.log('=== NetClass deploy ===');
console.log(`profile=${PROFILE} port=${PORT} shell=${existsSync(SHELL) ? 'ok' : 'MISSING'}`);

// ---------------------------------------------------------------- 1. launch
console.log('\n[1/5] 启动/重启调试 Chrome（WMI，脱离 ssh 进程树，带油猴扩展）');
const batLines = [
  '@echo off',
  `start "" "${CHROME}" --user-data-dir="${PROFILE_DIR}" --load-extension="${EXT_TM}" --disable-extensions-except="${EXT_TM}" ` +
  `--remote-debugging-port=${PORT} --remote-allow-origins=* --no-first-run --no-default-browser-check ` +
  `--lang=zh-CN --disable-features=Translate --disable-background-timer-throttling --disable-renderer-backgrounding ` +
  `--window-size=1400,900${COURSE_URL ? ` "${COURSE_URL}"` : ''}`,
  `echo launched %DATE% %TIME% > "${WORK}\\chrome-${TAG}.log"`
];
const batB64 = Buffer.from(batLines.join('\r\n') + '\r\n', 'utf8').toString('base64');
const batWin = `${WORK}\\runchrome-${TAG}.bat`;
const launchPs = `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path '${WORK}' | Out-Null
if (-not (Test-Path '${PROFILE_DIR}\\Default')) { New-Item -ItemType Directory -Force -Path '${PROFILE_DIR}\\Default' | Out-Null }
[IO.File]::WriteAllBytes('${batWin}', [Convert]::FromBase64String('${batB64}'))
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${PORT}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${batWin}"' }
Write-Output ('wmi ret=' + $r.ReturnValue)
for ($i=0; $i -lt 18; $i++) { Start-Sleep -Seconds 2; try { $x = Invoke-WebRequest 'http://127.0.0.1:${PORT}/json/version' -UseBasicParsing -TimeoutSec 3; Write-Output 'debug port ready'; break } catch { } }
if ($i -ge 18) { Write-Output 'DEBUG PORT NOT READY' }
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match 'remote-debugging-port=${PORT}' } | ForEach-Object {
  Write-Output ('  main pid=' + $_.ProcessId + ' session=' + (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).SessionId)
}
`;
console.log(remotePs(launchPs, `launch-${TAG}`).trim().split('\n').slice(-4).join('\n'));

// ---------------------------------------------------------------- 2. ensure devmode
console.log('\n[2/5] 确保扩展开发者模式开启（否则 chrome-extension 页面被拦）');
const devPs = `
$ErrorActionPreference='Continue'
$pref = '${PROFILE_DIR}\\Default\\Preferences'
if (-not (Test-Path $pref)) { Write-Output 'no prefs yet'; exit 0 }
$json = Get-Content $pref -Raw | ConvertFrom-Json
if (-not $json.extensions) { $json | Add-Member -NotePropertyName extensions -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $json.extensions.ui) { $json.extensions | Add-Member -NotePropertyName ui -NotePropertyValue ([pscustomobject]@{}) -Force }
$cur = $json.extensions.ui.developer_mode
if ($cur -ne $true) {
  $bak = $pref + '.netclass-bak'
  if (-not (Test-Path $bak)) { Copy-Item $pref $bak -Force }
  $json.extensions.ui | Add-Member -NotePropertyName developer_mode -NotePropertyValue $true -Force
  [IO.File]::WriteAllText($pref, ($json | ConvertTo-Json -Depth 100 -Compress), (New-Object Text.UTF8Encoding($false)))
  Write-Output 'devmode patched -> need restart'
} else { Write-Output 'devmode already on' }
`;
console.log(remotePs(devPs, `dev-${TAG}`).trim());

// 若刚改了 devmode，再重启一次
if (/patched/.test(remotePs(devPs, `dev2-${TAG}`) || '')) {
  console.log('  restart chrome to apply devmode');
  console.log(remotePs(launchPs, `launch2-${TAG}`).trim().split('\n').slice(-3).join('\n'));
}

// ---------------------------------------------------------------- 3. open TM options
console.log('\n[3/5] 打开 Tampermonkey 选项页');
const optUrl = `chrome-extension://${TM_ID}/options.html`;
let optTarget = null;
for (let i = 0; i < 15 && !optTarget; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(optUrl)}`, { method: 'PUT' }); } catch { }
  await sleep(2000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    optTarget = list.find(t => t.type === 'page' && /^chrome-extension:\/\/[a-p]{32}\/options\.html/.test(t.url));
  } catch (e) { }
}
if (!optTarget) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log('  失败，当前页面：');
  list.filter(t => t.type === 'page').forEach(t => console.log('   - ' + t.url.slice(0, 110)));
  process.exit(2);
}
console.log('  ok: ' + optTarget.url);

// ---------------------------------------------------------------- 4. install
console.log('\n[4/5] 提交安装表单');
const shellCode = readFileSync(SHELL, 'utf8');
const jsB64 = Buffer.from(shellCode, 'utf8').toString('base64');
const p = new Cdp(optTarget.webSocketDebuggerUrl); await p.open();
await p.send('Page.enable');
const res = await p.send('Runtime.evaluate', {
  expression: `(() => {
    try {
      const code = atob('${jsB64}');
      const f = document.createElement('form');
      f.method='POST'; f.action='options.html';
      const add=(n,v)=>{const i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i);};
      add('name','netclass'); add('namespace','taskmesh.local/netclass');
      add('source','manual://netclass'); add('origin','manual://netclass');
      add('code', code); add('uuid','nc-shell-0001');
      document.body.appendChild(f); f.submit();
      return 'submitted';
    } catch(e){ return 'err:'+e.message; }
  })()`, returnByValue: true
});
console.log('  ' + (res.result && res.result.value));
await sleep(7000);

// ---------------------------------------------------------------- 5. verify
console.log('\n[5/5] 核对安装结果');
try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(optUrl)}`, { method: 'PUT' }); } catch { }
await sleep(5000);
const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const dash = list2.find(t => t.type === 'page' && t.url.includes('options.html'));
if (dash) {
  const d = new Cdp(dash.webSocketDebuggerUrl); await d.open(); await d.send('Page.enable');
  const txt = await d.send('Runtime.evaluate', {
    expression: `(() => {
      const rows = Array.from(document.querySelectorAll('[class*=script], tr, .card, li')).map(e => (e.innerText||'').replace(/\\s+/g,' ').trim()).filter(x => /netclass|NetClass/.test(x));
      return JSON.stringify({ title: document.title, hits: rows.slice(0,4), body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300) });
    })()`, returnByValue: true
  });
  console.log('  ' + (txt.result && txt.result.value));
  d.close();
}

// 若给了课程 URL，顺便打开并检查脚本是否运行
if (COURSE_URL) {
  console.log('\n[extra] 打开课程页并检查脚本注入');
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(COURSE_URL)}`, { method: 'PUT' }); } catch { }
  await sleep(10000);
  const list3 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list3.find(t => t.type === 'page' && t.url.startsWith(COURSE_URL.slice(0, 30)));
  if (page) {
    const pp = new Cdp(page.webSocketDebuggerUrl); await pp.open(); await pp.send('Page.enable');
    const st = await pp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ url: location.href, shell: !!window.__NETCLASS_SHELL__, module: !!window.NetClass, videos: document.querySelectorAll('video').length, panel: !!document.getElementById('netclass-panel') })`,
      returnByValue: true
    });
    console.log('  ' + (st.result && st.result.value));
    pp.close();
  } else { console.log('  页面没打开'); }
}
p.close();
console.log('\ndone');
