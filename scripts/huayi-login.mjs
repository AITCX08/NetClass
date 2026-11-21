/**
 * login-again.mjs —— 复刻 2026-10-23 成功过的那条路（账号2 D1D6 那次）
 *
 * 成功路径（原始记录）
 * -------------------
 *   login-jcpxkh.mjs fill : clickAt(坐标) + Input.insertText 输入账号密码 → 导出图
 *   人工读图 → login-js.mjs submit D1D6
 *   login-js.mjs submit   : 原生 setter 填验证码 + button.login.click()
 *   结果: +1.1s → /exercise/ExerciseHome/ProjectList  ★★★ 登录成功
 *
 * 所以本脚本严格照抄这个分工：
 *   账号密码 → 真鼠标点击焦点 + Input.insertText（模拟人打字）
 *   验证码   → 原生 value setter + input/change 事件
 *   提交     → button.login.click()
 * 并且提交前回读三个字段（密码会被站点自己清空）。
 *
 * 用法
 *   node runs/login-again.mjs --port 9231 --user <u> --pass <p>
 */
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
function arg(n, d) { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; }
const PORT = Number(arg('port', 9231));
const USER = arg('user') || process.env.HY_USER;
const PASS = arg('pass') || process.env.HY_PASS;
if (!USER || !PASS) { console.error('缺 --user/--pass'); process.exit(2); }

const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
const t = pages.find(p => /VerifySSOCode|jcpxkh/.test(p.url)) || pages[0];
console.log('页面: ' + t.url.slice(0, 95));

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
let id = 0; const pend = new Map();
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (me, pa = {}, to = 30000) => new Promise(res => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const clickAt = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
};
const boxOf = async (elemId) => {
  const s = await ev(`(function(){
    var el = document.getElementById(${JSON.stringify(elemId)});
    if(!el) return 'null';
    el.scrollIntoView({block:'center'});
    var r = el.getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), w: Math.round(r.width), vis: !!el.offsetParent});
  })()`);
  try { return JSON.parse(s); } catch { return null; }
};

await send('Page.enable'); await send('Runtime.enable');
await sleep(500);

// ① 清 layui 遮罩 + 关掉「验证码错误」弹框
console.log('① 清遮罩: ' + await ev(`(function(){
  var k=0;
  Array.from(document.querySelectorAll('[class*="layui-layer-shade"],[class*="layui-layer-page"],[class*="layui-layer-dialog"]')).forEach(function(e){e.remove();k++});
  var b = Array.from(document.querySelectorAll('button,input,a,div,span')).filter(function(e){var t=(e.innerText||e.value||'').trim();return e.offsetParent && /^确定$/.test(t)})[0];
  if(b){ b.click(); k++; }
  return 'removed ' + k;
})()`));

// ② 切密码登录
console.log('② 切密码登录: ' + await ev(`(function(){
  var d = Array.from(document.querySelectorAll('dd,li')).filter(function(e){return (e.innerText||'').trim()==='密码登录'});
  if(!d.length) d = Array.from(document.querySelectorAll('*')).filter(function(e){return (e.innerText||'').trim()==='密码登录' && e.children.length===0});
  if(!d.length) return 'no tab';
  d[0].click(); return 'clicked';
})()`));
await sleep(2000);

// 确认容器可见
let vis = false;
for (let k = 0; k < 15; k++) {
  const j = await boxOf('user_yzm');
  if (j && j.vis && j.w > 0) { vis = true; break; }
  await sleep(600);
}
console.log('   容器可见: ' + vis);
if (!vis) { console.log('❌ 切 tab 失败'); process.exit(1); }

// ③ 用【真鼠标 + Input.insertText】填账号密码（复刻成功路径）
const fillReal = async (elemId, text, label) => {
  const b = await boxOf(elemId);
  if (!b || !b.vis) return label + ': 不可见';
  await clickAt(b.x, b.y);
  await sleep(350);
  // 清空
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await sleep(200);
  await send('Input.insertText', { text });
  await sleep(500);
  const v = await ev(`(function(){var e=document.getElementById(${JSON.stringify(elemId)});return e ? e.value : '?'})()`);
  const shown = await ev(`(function(){var e=document.getElementById(${JSON.stringify(elemId)});return e && e.type==='password' ? '*'.repeat(e.value.length) : (e?e.value:'?')})()`);
  const focus = await ev(`document.activeElement ? document.activeElement.id : 'none'`);
  return label + ': value=' + shown + '  focus=' + focus;
};
console.log('③ ' + await fillReal('user_name', USER, 'user_name'));
console.log('③ ' + await fillReal('password', PASS, 'password'));

// ④ 勾协议
console.log('④ 勾协议: ' + await ev(`(function(){
  var b = Array.from(document.querySelectorAll('input[type=checkbox]')).filter(function(e){return e.offsetParent})[0];
  if(!b) return 'no cb';
  if(!b.checked) b.click();
  return b.checked ? 'checked' : 'false';
})()`));

// ⑤ 导出验证码（不刷新，用当前这张）
let hash = '';
for (let k = 0; k < 15; k++) {
  await sleep(500);
  const b64 = await ev(`(function(){
    var i = document.getElementById('user_yzm');
    if(!i || !i.complete || !i.naturalWidth) return null;
    var c = document.createElement('canvas'); c.width=i.naturalWidth; c.height=i.naturalHeight;
    c.getContext('2d').drawImage(i,0,0);
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    hash = createHash('sha1').update(buf).digest('hex').slice(0, 10);
    writeFileSync(`${OUT}/captcha-again-${PORT}.png`, buf);
    break;
  }
}
if (!hash) { console.log('❌ 图拿不到'); process.exit(1); }
console.log('⑤ 📸 captcha-again-' + PORT + '.png  hash=' + hash);

// ⑥ 等码
const codeFile = `runs/code-${PORT}.txt`;
try { if (existsSync(codeFile)) unlinkSync(codeFile); } catch (_) { }
console.log('\n⑥ 等验证码 → 写 ' + codeFile);
let code = '';
const dl = Date.now() + 10 * 60 * 1000;
while (Date.now() < dl) {
  if (existsSync(codeFile)) { try { code = readFileSync(codeFile, 'utf8').trim(); unlinkSync(codeFile); break; } catch (_) { } }
  await sleep(600);
}
if (!code) { console.log('超时'); process.exit(1); }
console.log('   码 = ' + code);

// ⑦ 原生 setter 填验证码（复刻成功路径）
console.log('⑦ 填码(setter): ' + await ev(`(function(){
  var el = document.getElementById('userCode');
  if(!el) return 'no userCode';
  el.focus();
  var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(el, ${JSON.stringify(code)});
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return 'value=' + el.value;
})()`));

// ⑧ 提交前回读三字段（密码可能被清空）
const beforeSubmit = await ev(`(function(){
  function rd(id){var e=document.getElementById(id);return e?(e.type==='password'?'*'.repeat(e.value.length):e.value):null;}
  return JSON.stringify({user_name:rd('user_name'), password:rd('password'), userCode:rd('userCode'),
    tab:(function(){var c=Array.from(document.querySelectorAll('dd,li')).filter(function(e){return /cur|act/i.test((e.className||'').toString())})[0];return c?(c.innerText||'').trim():'?';})()});
})()`);
console.log('⑧ 提交前: ' + beforeSubmit);

const st = JSON.parse(beforeSubmit || '{}');
if (!st.password || st.password.length !== PASS.length) {
  console.log('   ⚠ 密码被清空，用真鼠标+insertText 补填');
  console.log('   ' + await fillReal('password', PASS, 'password'));
} else if (!st.userCode) {
  console.log('   ⚠ 验证码空，补填');
  await ev(`(function(){
    var el=document.getElementById('userCode'); el.focus();
    var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(el, ${JSON.stringify(code)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return 1;
  })()`);
}

// ⑨ button.login.click()
console.log('⑨ 点登录: ' + await ev(`(function(){
  var b = document.querySelector('button.login');
  if(!b) b = Array.from(document.querySelectorAll('button')).filter(function(e){return /^登\\s*录$/.test((e.innerText||'').trim())})[0];
  if(!b) return 'no button';
  b.click(); return 'clicked';
})()`));

for (let k = 1; k <= 15; k++) {
  await sleep(1100);
  const u = String(await ev('location.href'));
  const err = String(await ev(`/验证码错误/.test(document.body.innerText||'')`));
  const pwdErr = String(await ev(`/密码错误|密码不正确|账户不存在|用户不存在/.test(document.body.innerText||'')`));
  if (!/VerifySSOCode/.test(u)) { console.log('★★★ 登录成功 → ' + u.slice(0, 100)); break; }
  if (err === 'true') { console.log('✗ 验证码错误'); break; }
  if (pwdErr === 'true') { console.log('✗ 密码/账号错误'); break; }
  if (k === 15) console.log('… 仍在登录页');
}
const s = await send('Page.captureScreenshot', { format: 'png' });
if (s.result?.data) { writeFileSync(`${OUT}/login-again-${PORT}.png`, Buffer.from(s.result.data, 'base64')); console.log('📸 login-again-' + PORT + '.png'); }
ws.close();
