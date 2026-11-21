// cleanup-for-manual.mjs —— 每个端口只留一个 jcpxkh 登录页，供人工登录
const PORTS = [9231, 9250];
const LOGIN_URL = 'https://jcpxkh.91huayi.com/exercise/ExerciseLogin/VerifySSOCode?source=0&classify_id=';

for (const port of PORTS) {
  console.log(`\n=== ${port} ===`);
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
  } catch (e) {
    console.log('  ❌ CDP 不可达: ' + e.message);
    continue;
  }
  const pages = (Array.isArray(list) ? list : []).filter(t => t.type === 'page');
  console.log('  当前标签数: ' + pages.length);

  // 全部关掉
  let closed = 0;
  for (const p of pages) {
    try { await fetch(`http://127.0.0.1:${port}/json/close/${p.id}`); closed++; } catch (_) { }
  }
  console.log('  关闭 ' + closed + ' 个');

  await new Promise(r => setTimeout(r, 1500));

  // 开一个干净的新标签，直接到登录页
  try {
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(LOGIN_URL)}`, { method: 'PUT' });
    console.log('  已开新标签 → 登录页');
  } catch (e) {
    console.log('  ❌ 开标签失败: ' + e.message);
  }

  await new Promise(r => setTimeout(r, 3000));

  try {
    const l2 = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
    const left = (Array.isArray(l2) ? l2 : []).filter(t => t.type === 'page');
    console.log('  现在标签数: ' + left.length);
    left.forEach(p => console.log('    ' + p.url.slice(0, 95)));
  } catch (_) { }
}
