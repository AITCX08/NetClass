/**
 * userscript/brand.js —— 品牌与引流位（私人信息集中在这里，方便替换/关闭）
 *
 * ★ 为什么单独抽一个文件：
 *   1. 二维码是 base64 内联的（userscript 注入环境读不到本地文件）
 *   2. 商业信息不该散落在几千行 App.js 里，换图/换文案只改这一个文件
 *   3. 开源出去时，别人把自己的二维码填进来即可，不用碰主逻辑
 *
 * 填图方式（推荐）：
 *   node scripts/set-qr.mjs --wechat 我的微信.png --donate 捐赠码.png
 *   → 自动转 base64 并写回本文件的 WECHAT_QR / DONATE_QR 字段
 *
 * 也可以手填：把图片转成 data:image/png;base64,xxxx 直接粘进下面的字符串。
 *
 * 留空 = 该位置不显示（不会出现破图）。两者都空 = 整个品牌区块不渲染。
 */

const BRAND = {
  // ── 品牌标识 ────────────────────────────────
  name: 'NetClass',
  // 作者署名（面板底部一行小字）
  author: 'AITCX08',
  // 仓库地址（点开新窗口）
  repo: 'https://github.com/AITCX08/NetClass',

  // ── 引流位：二维码（base64 data URI，留空不显示）────────
  // 微信：个人号 / 公众号 / 交流群，任选一张
  wechatQr: '',
  wechatLabel: '微信交流',
  wechatHint: '扫码加我，进群交流',

  // 捐赠：微信赞赏码 / 支付宝 / GitHub Sponsors 收款码
  donateQr: '',
  donateLabel: '赞赏支持',
  donateHint: '扫码支持持续维护',

  // GitHub Sponsors 链接（有的话填，和 donateQr 二选一或都填）
  sponsorUrl: '',

  // ── 商业化入口（付费功能预告）─────────────────
  // 点「自动答题」时如果本地没配 LLM，就弹这个引导
  proTitle: '自动答题（Pro）',
  proDesc: '接入大模型自动作答随堂题 / 章节测验，支持题库缓存与自建题库',
  proUrl: '',          // 付费/开通页地址，留空则只显示"敬请期待"
  proEnabled: false,   // 置 true 才在面板显示入口

  // ── 行为开关 ────────────────────────────────
  // 面板收起后是否仍显示右上角 +/− 按钮（建议 true）
  keepToggleWhenCollapsed: true,
  // 品牌区块是否可折叠（true = 默认收起，点一下展开，减少打扰）
  brandCollapsedByDefault: true,
};

// 供 App.js 读取（window 上挂一份，避免改 App.js 的模块边界）
if (typeof window !== 'undefined') {
  window.NETCLASS_BRAND = BRAND;
}

// Node 侧（scripts/set-qr.mjs 改写本文件时用）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BRAND;
}
