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

## 五、万能脚本（ScriptCat #616）—— 已完成逆向

### 5.1 获取方式（已验证可行）

```powershell
# 直链（注意中文文件名要 URL 编码）
Invoke-WebRequest -Uri 'https://scriptcat.org/scripts/code/616/%E3%80%90%E4%B8%87%E8%83%BD%E3%80%91%E5%85%A8%E5%B9%B3%E5%8F%B0%E8%87%AA%E5%8A%A8%E7%AD%94%E9%A2%98%E8%84%9A%E6%9C%AC.user.js' -OutFile "$env:TEMP\wanneng.user.js"
```
- **605 KB / 11,523 行**（内嵌了一整份 jQuery，所以大）
- ⚠️ 用 `web_fetch` 会被**截断在 100KB**（只拿到头部+jQuery）；**必须直接下载**

### 5.2 核心架构：**题库在服务端**，脚本只是客户端

```js
// 行 6110 附近
async function searchAnswer(data) {
  const uri = token.length === 10 ? "/autoAnswer/" + token : "/autoFreeAnswer";
  //  → 免费题库走 /autoFreeAnswer；付费题库走 /autoAnswer/<10位token>
}
// 行 7054
const formatResult = await formatSearchAnswer(data);
// 行 7063
tip: "准备填充答案," + (formatAns.num === -1 ? "免费题库不扣积分" : "剩余积分:" + formatAns.num)
```

| 事实 | 含义 |
|---|---|
| 答案来自**作者的服务端**（`/autoFreeAnswer` / `/autoAnswer/<token>`）| 与 OCS（客户端 + 题库适配器）**路子完全不同**；它没有本地题库 |
| `@antifeature payment 解锁付费题库需捐助`；token 是 **10 位** | 商业模式：免费题库（易爆「系统繁忙」）+ 付费题库（按积分） |
| 行 6020: `429: "免费题库搜题整体使用人数突增,系统繁忙..."` | 免费接口**限流严重** |
| `@match *://*/*` | 全站注入，靠 `match` 条件逐个平台判定 |

→ **对我们的启示**：我们走的是**用户自配 key**（DeepSeek），不依赖第三方题库 —— 这条路更可控（没有限流、没有积分、没有跑路风险）。**这个方向是对的，不用改。**

### 5.3 ★ 平台适配的写法：`WorkerJSPlus({...})` 一个平台一个配置对象

```js
// 行 10289 附近（真实样例，已简化）
WorkerJSPlus({
  name: "专技天下",
  match: location.host.includes("zgzjzj.com") && location.pathname.includes("/examination/perpar.html"),
  intv: () => $(".question_index").length,          // 触发条件：页面上有题目
  root: ".question_index",                          // 题目容器
  elements: {
    question: "p",                                  // 题干
    options: ".options li p,li>span:last-child",    // 选项文本
    $options: ".options li",                        // 可点击的选项元素
    type: "p span"                                  // 题型文本位置
  },
  ignore_click: $item => $item.hasClass("active"),   // 已选的跳过
  wrap: obj => { /* 题干预处理（去掉序号/括号等）*/ }
});
```

**这个结构非常值得抄**（比我们"每个平台写一个适配器类"更轻）：

| 字段 | 作用 | 我们的对应物 |
|---|---|---|
| `name` | 平台显示名 | `PLATFORM_LABEL` |
| `match` | host+path 判定 | `PLATFORM` 正则 |
| `intv` | "页面有题"的判定 | `hasQuiz` |
| `root` | 题目容器 | 无（我们写死）|
| `elements.question/options/$options/type` | **四件套选择器** | 散落在代码里 |
| `ignore_click` | 跳过已选 | 我们的 `before/after` 检查 |
| `wrap` | 题干清洗 | 无 |

### 5.4 题型映射

```js
const type = getQuestionType(item.ACHType.QuestionTypeName);   // 行 8819
const type = getQuestionType(item.queTypeName);                // 行 9092
```
→ 各平台题型命名不一，**统一映射成内部枚举**再处理。我们 `dsAnswer` 里 `type 1/2/3`（单选/多选/判断）就是同一思路，可以照它补一个"平台题型名 → 内部枚举"的映射表。

### 5.5 ⚠️ 关键发现：**它不支持长春/吉林**

```
grep '长春|吉林|ccjyxy'  →  0 命中
```
它支持 30+ 平台（含"贵州继续教育""专技天下"等继续教育类），但**长春市中小学教师全员培训平台不在列表里**。

→ **结论**：长春这一单没有现成的可抄 —— 但它给了我们**写法模板**（§5.3 的四件套），我们的 `ADAPTER_CCJYXY` 可以直接用这个结构来写。
→ 反过来，这也是我们的**机会点**：把长春这类"小众继续教育平台"做成我们的差异化能力。

---

## 七、两个脚本的路线对比（结论）

| 维度 | OCS 网课助手 | 万能答题脚本 | 我们（netclass） |
|---|---|---|---|
| 开源 | ✅ GitHub（TS，可读） | ❌ 未声明协议（脚本猫托管） | 自有 |
| 题库 | 客户端 + 题库适配器（多源） | **服务端**（免费/付费 token） | **用户自配 key（DeepSeek）** |
| 播放控制 | ✅ `top.currentMedia` + videojs 埋点劫持 | ❌ 只做答题，不碰播放 | ✅ CDP 驱动 + `currentMedia`（待接） |
| 任务点遍历 | ✅ `[onclick^=getTeacherAjax]` + `.jobUnfinishCount` | ❌ 不涉及 | ❌ 待按 OCS 改 |
| 完成判定 | ✅ 读未完成计数字段 | ❌ | ❌ 待按 OCS 改 |
| 平台适配粒度 | 大文件/平台（cx 82KB） | **轻配置/平台（~20 行）** | `ADAPTER_*` 类 |
| 风控认知 | ✅ 明确写了高倍速/夜间风控警告 | ⚠️ 免费接口限流 | 待补 |

**该抄什么**：
1. **OCS** → 学习通的**枚举 + 完成判定 + 倍速/埋点**（§2，直接落到 `cx-auto.mjs` / `App.js`）
2. **万能** → **"四件套选择器"的轻量平台配置结构**（§5.3，用来写长春等新平台，比现在每平台一个类更省事）
3. **两家都别抄** → 服务端题库依赖（我们把答案来源交给用户自己的 key，更稳）


---

## 六、分析产物与清理

- 分析用的 clone 在**临时目录**（`%TEMP%\ocs-re`），**分析完即删**，不进仓库
- 本文档只保留**结论、选择器、接口与思路**，不粘贴第三方大段源码
- 若后续需要复现分析：`git clone --depth 1 https://github.com/ocsjs/ocsjs` → 看 `packages/scripts/src/projects/*.ts`
