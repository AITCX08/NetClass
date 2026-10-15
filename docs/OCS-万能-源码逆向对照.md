# OCS / 万能脚本 —— 源码逆向对照（网课处理逻辑）

> 用途：把两个主流网课脚本的**处理逻辑**逆向出来，逐条对照我们的 `netclass` 驱动，用来修我们卡住的地方。
> 来源：**OCS 网课助手** = [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)（GitHub，开源）；**【万能】全平台自动答题脚本** = [ScriptCat #616](https://scriptcat.org/zh-CN/script-show-page/616)（作者 zmq656）。
> 分析方式：`git clone --depth 1` 到临时目录 → 直接读源码（TypeScript，未混淆）。
> ⚠️ **合规**：本文档只记录**思路与关键选择器/接口**，正文代码为自有实现；第三方仓库不入库、不复制整段代码。

---

## 一、OCS 的工程结构

```
ocsjs/ocsjs  (pnpm monorepo)
├── packages/core/        核心（消息总线/事件/存储）
├── packages/utils/       工具
└── packages/scripts/     ★ 用户脚本本体
    ├── entry.js / entry.common.js / entry.dev.js
    ├── src/index.ts      入口
    ├── src/render.ts     面板渲染
    ├── src/elements/     UI 组件（含 search.infos.ts）
    ├── src/utils/        app / configs / answerer-connect / answerer-env / font-decrypt …
    └── src/projects/     ★ 各平台实现（按体积排序）
        ├── zhs.ts      113 KB  智慧树
        ├── cx.ts        82 KB  超星/学习通   ← 本文重点
        ├── common.ts    68 KB  公共逻辑（答题/题库/接口）
        ├── yuketang.ts  50 KB  雨课堂
        ├── icve.ts      37 KB  智慧职教
        ├── icourse.ts   27 KB  中国大学MOOC
        ├── zjy.ts       24 KB  职教云
        └── background.ts 41 KB 后台
```

**结论**：它把"平台差异"全部收敛到 `src/projects/<平台>.ts`，公共部分（答题、题库、UI、配置）在 `utils/` 与 `common.ts`。我们要仿的是**每个平台一个文件**这个结构（我们的 `ADAPTER_*` 已经是这个思路）。

---

## 二、`cx.ts`（学习通/超星）核心逻辑 —— 逐条对照我们的实现

### 2.1 ★ 任务点枚举：从 `onclick` 取，不是 `href`（**直接解决我们的枚举 bug**）

```js
// OCS 原文（逻辑等价改写）
getChapterInfos() {
  return Array.from(top.document.querySelectorAll('[onclick^="getTeacherAjax"]')).map(el => ({
    element: el,
    chapterId: el.getAttribute('onclick')?.match(/\('(.*)','(.*)','(.*)'\)/)?.[3],
    unFinishCount: parseInt(el.parentElement.querySelector('.jobUnfinishCount')?.value || '0')
  }));
}
```

**三个关键点**：
| # | 事实 | 我们的问题 |
|---|---|---|
| 1 | 枚举用 **`[onclick^="getTeacherAjax"]`** | 我们用 `a[href*="studentstudy"]` → **任务点页面的目录没有 href，所以枚举到 0**（正是卡住的原因）|
| 2 | `chapterId` 从 **onclick 参数正则取第 3 个** | 我们依赖 href 里的 `chapterId=` |
| 3 | 未完成数读 **`.jobUnfinishCount` 的 `value`**（隐藏 input）| 我们在 DOM class 上瞎猜（`noJob`/`jobCount`），猜不准 |

### 2.2 ★ 完成判定：`unFinishCount === 0`

```js
isFinishedAllChapters() {
  return this.getChapterInfos().every(ch => ch.unFinishCount === 0);
}
```
- **不是**看页面文字「任务点已完成」，也不是看 class，而是读**每个章节节点的未完成计数**（`.jobUnfinishCount` 的 value）。
- 我们目前用「跨 iframe 找『任务点已完成』文字」→ 能用但脆；应改成读这个字段。

### 2.3 ★ 倍速设置：用平台的 `top.currentMedia`，不是 `document.querySelector('video')`

```js
if (/\/knowledge\/cards/.test(location.href)) {      // 只在任务点页
  const updateMediaState = () => {
    if (top.currentMedia) {
      top.currentMedia.playbackRate = cfg.playbackRate;   // ← 平台自己的播放器对象
      top.currentMedia.volume = cfg.volume;
    }
  };
  this.onConfigChange('playbackRate', updateMediaState);
  this.onConfigChange('volume', updateMediaState);
}
```
- 超星页面暴露了全局 `top.currentMedia`（播放器实例），**直接改它的属性**比改 `<video>` 更"合法"（播放器会同步自己的状态，不触发"外部篡改"重置）。
- 这也解释了为什么我们改 `video.playbackRate` 会被打回 —— 播放器持有自己的状态并在 `timeupdate` 里回写。

### 2.4 ★ 倍速/拖动限制屏蔽：劫持 videojs 的 `seekBarControl` 插件

```js
// 只在 /ananas/modules/video/ 页面（超星播放器模块）注入
function rateHack() {
  let dragCount = 0;
  const hack = () => {
    const videojs = unsafeWindow.videojs, Ext = unsafeWindow.Ext;
    if (typeof videojs === 'undefined' || typeof Ext === 'undefined' || hacked) return;
    const _origin = videojs.getPlugin('seekBarControl');
    const plugin = videojs.extend(videojs.getPlugin('plugin'), {
      constructor: function (videoExt, data) {
        const _sendLog = data.sendLog;
        data.sendLog = (...args) => {
          if (args[1] === 'drag') {                 // ★ 吞掉"拖动"埋点
            dragCount++;
            if (dragCount > 100) document.querySelector('video')?.pause();  // 卡顿 BUG 自愈
          } else {
            _sendLog.apply(data, args);             // 其它埋点照常上报
          }
        };
        _origin.apply(_origin.prototype, [videoExt, data]);
      }
    });
    // 然后注册替换原插件
  };
  hack(); document.addEventListener('readystatechange', hack); window.addEventListener('load', hack);
}
```
**机制**：超星用 videojs + 自定义插件把"拖动/倍速"作为**埋点**上报给服务端。OCS 的做法是**包一层 `sendLog`**，把 `drag` 这类敏感埋点**吞掉**，其余照常 → 服务端认为你没跳过。
→ 这解释了平台为什么能"检测到跳看"，也给出了**绕过的正确层面**（埋点层，而不是 DOM 层）。

### 2.5 页面类型判定（照抄可用）

```js
['任务点页面',  '/knowledge/cards'],
['阅读任务点',  '/readsvr/book/mooc'],
// 阅读任务点容器：#ReadWeb；2026 上半年新增"计时翻页"型（需停留够时间才能翻页）
```

### 2.6 其它可借鉴的开关

| 开关 | 作用 |
|---|---|
| `job` | **完成后自动跳转"未完成任务点"**；找不到任务点则结束脚本（标注为"试验阶段"）|
| `自动前往首个任务点` | 进入学习界面后自动跳到第一个未完成任务点（**积分课/智慧课程建议关闭**）|
| `学习非任务点视频` | 区分"非任务点 / 任务点 / 已完成任务点"三类视频 |
| 闯关模式判定 | 当前章节卡在"最后一个待完成任务点"时有专门分支 |

---

## 三、⚠️ 最重要的运营知识：**高倍速风控**（OCS 自己写的警告）

```
⚠️ 高倍速、夜间、白天大量运行 等情况 可能导致学习记录清空/回退
⚠️ 如已清空/回退，请降低倍速至 1-2 倍
⚠️ 目前超星倍速风控严重，如果高倍速被平台清空进度，请调到 1-2 倍速学习！
（配置项里还对 ≥2 倍速弹二次警告）
```

**对我们的直接影响**：
1. 学习通**不建议**用 2x 以上硬拉；我们之前实测 shengsheng 的 1.5x 上限、以及"2x 被拉回 1.5"其实是**平台的主动风控**，不是 bug
2. 「夜间大量运行」也在风控特征里 → **别让驱动 24 小时连轴跑**，建议按人类作息分段
3. 一旦发现进度回退/清空 → 立刻降到 1–2x

---

## 四、对我们的改造清单（按优先级）

| # | 改什么 | 依据 | 落到哪个文件 |
|---|---|---|---|
| 1 | **任务点枚举改用 `[onclick^="getTeacherAjax"]`**，chapterId 从 onclick 正则取 | §2.1 | `scripts/cx-auto.mjs` 的 `loadList()` |
| 2 | **完成判定改用 `.jobUnfinishCount` 的 value（=0 即完成）** | §2.2 | `cx-auto.mjs` 的树统计 + `App.js` 的 `progressInfo()` |
| 3 | **倍速优先改 `top.currentMedia`**，失败再退回 `video.playbackRate` | §2.3 | `App.js` 的倍速设置逻辑 |
| 4 | 需要硬拉倍速时，学 §2.4 的**埋点层拦截**（videojs `seekBarControl` → `sendLog`） | §2.4 | `App.js` 平台适配器 |
| 5 | 加"**高倍速/夜间风控**"提醒与限速策略（>2x 弹警告） | §3 | 面板 + 文档 |
| 6 | 补"**自动跳转未完成任务点**"开关 | §2.6 | `ADAPTER_CHAOXING` |

---

## 五、万能脚本（ScriptCat #616）—— 待取的现状与取法

- **页面**：https://scriptcat.org/zh-CN/script-show-page/616
- **作者** zmq656；v5.0.4.1；支持【超星学习通】【智慧树】【职教云】【雨课堂】【考试星】【186网校】【继续教育类】【神呼云课堂】【九江系列】
- **取源码方式**（下轮执行，二选一）：
  1. ScriptCat 脚本页 → 「查看源码/安装」链接直取 `.user.js`（页面里有 `scripts/code/616/...` 形式的直链）
  2. 浏览器打开该页 → 用 CDP 抓 `document` 里的源码块（页面自带代码视图）
- **重点看**：
  - 它支持**继续教育类平台**（我们正在做的长春教师培训就属于这一类）→ 可能直接有可复用的选择器/接口
  - 它的**答题**部分（题库对接、选项匹配）与我们 `dsAnswer` 的差异
  - 多平台**统一抽象**的写法（它一个脚本覆盖 9 类平台，抽象层次值得抄）

---

## 六、分析产物与清理

- 分析用的 clone 在**临时目录**（`%TEMP%\ocs-re`），**分析完即删**，不进仓库
- 本文档只保留**结论、选择器、接口与思路**，不粘贴第三方大段源码
- 若后续需要复现分析：`git clone --depth 1 https://github.com/ocsjs/ocsjs` → 看 `packages/scripts/src/projects/*.ts`
