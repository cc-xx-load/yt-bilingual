# 沉浸式翻译（Immersive Translate）拆解

> 分析对象：<https://github.com/immersive-translate/immersive-translate>（v1.34.4，2026-10）
> 参考源码：<https://github.com/immersive-translate/old-immersive-translate>（MPL-2.0，2023-01 归档）
> 目的：为「本地 YouTube 双语字幕扩展」提炼可复用的架构，而不是复刻功能矩阵。

---

## 0. 一个必须先知道的事实

主仓库**不包含源代码**，README 写得很明确：

> 沉浸式翻译并非开源软件，本仓库**不包含沉浸式翻译的源代码**。旧版的[沉浸式翻译开源项目](https://github.com/immersive-translate/old-immersive-translate)已于 2023 年 1 月 17 日归档。

主仓库里只有三类东西：

| 路径 | 内容 | 对分析的价值 |
| --- | --- | --- |
| `dist/chrome/` | 打包好的 MV3 扩展 | 架构、权限、字幕链路、CSS 主题 |
| `dist/firefox/`、`dist/userscript/` | 其他形态产物 | 多端复用同一套 bundle |
| `docs/` | 官网文档页产物 | 功能清单 |

所以本文的证据分两档：**新版产物**用来看「现在怎么做的」，**旧版开源源码**用来看「引擎的完整实现」。旧仓库是 MPL-2.0，我们只借鉴思路，不复制代码。

---

## 1. 极薄内容脚本 + 按需加载

`dist/chrome/manifest.json` 只在 `document_start` 注入一个 33KB 的 `content_guard.js`，且 `all_frames: true`、`match_about_blank: true`：

```json
"content_scripts": [{
  "matches": ["<all_urls>", "file:///*", "*://*/*"],
  "js": ["content_guard.js"],
  "run_at": "document_start",
  "all_frames": true
}]
```

真正的 4.2MB 主包是运行时才加载的：

```js
// content_guard.js（压缩后）
let e = globalThis.immersiveTranslateBrowserAPI.runtime.getURL("content_main.js")
import(e).then(n => { n.runContentMain() })
```

**为什么重要**：<all_urls> + 所有 iframe 的固定开销必须接近 0，否则会拖慢每一个网页。`content_guard.js` 还负责黑名单、Cloudflare 挑战页识别、iframe 可见性判定、为字幕站点注入页面脚本。

**我们借什么**：内容脚本只做路由与编排，大块逻辑按需加载；我们项目只有一个站点，因此简化为「两个内容脚本（MAIN + ISOLATED）」，但同样保持入口轻量。

---

## 2. 页面主世界与内容脚本分离

内容脚本跑在 ISOLATED world，**拿不到 YouTube 播放器对象上的 JS 方法**（`getPlayerResponse()` 之类）。沉浸式翻译的解法是往页面注入 `<script>`：

- `video-subtitle/inject.js`（28KB）：字幕站点适配器
- `browser-bridge/inject.js`（18KB）：通用页面桥
- `image/inject.js`：图片/漫画

两边用 `window.postMessage` 通信，协议自带命名空间和请求-应答 id：

```js
var R = "imt-subtitle-inject"
class E {
  constructor(from, to) { this.from = from; this.to = to }
  sendMessages(type, data) {
    postMessage({ eventType: R, to: this.to, from: this.from, type, data, id, isAsync: false })
  }
  sendAsyncMessages(...) { /* 带 id + AbortSignal 的请求-应答 */ }
}
```

**我们借什么**：`src/page/main.ts` 用 MV3 的 `content_scripts[].world: "MAIN"` 直接跑在页面主世界（Chrome 111+，比动态插 `<script>` 干净），通过带 `source: "ytb-page"` 的 `postMessage` 把字幕轨交给内容脚本 A。**但读取 `<video>.currentTime`、挂载浮层都在 ISOLATED 侧完成**，MAIN 侧只负责它独有的能力——访问播放器 JS 对象。

---

## 3. 字幕适配器：配置驱动 + 直取官方字幕轨

`video-subtitle/inject.js` 是一套「站点适配器」框架：

```js
function at(t) {
  let n = {
    youtube: L, netflix: w, webvtt: g, khanacademy: g, udemy: D,
    general: g, ebutt: g, hulu: U, mubi: N, edx: g, disneyplus: O,
    "fmp4.xml": g, multi_attach_vtt: B, twitter: g, subsrt: g, xml: g,
    text_track_dynamic: g, av: g
  }[t.type || ""]
  ...
}
```

每个适配器关心三件事：

1. `videoPlayerSelector` / `videoSelector` / `subtitleButtonSelector`：怎么找到播放器；
2. `getVideoMeta()`：怎么拿到字幕清单（YouTube 走 `#movie_player.getPlayerResponse()`，Netflix 走 hook `JSON.parse`）；
3. `getCurrentTime()` / `getDuration()`：时间轴从哪来。

两个非常实用的细节：

- **hook 播放器接口**：`hookJSON()` 包一层 `JSON.parse`，从播放器接口响应里捡 `timedtexttracks` / `captions`，比等 DOM 出现可靠。
- **广告时钟**：`contentTimeSource: "google_dai"` 时用 `#movie_player.imaDai.getStreamManager()` 把 `streamTime` 映射成内容时间，广告播完字幕不会整体错位。还按 `429` 记录限流。

**我们借什么**：直接取 `captionTracks[].baseUrl`（json3），站点差异只放 `src/page/main.ts` + `src/shared/constants.ts` 两处；广告期用 `.ad-showing` 隐藏浮层这一简化方案（V1 不做 DAI 时钟）。

---

## 4. 自绘字幕层，而不是改原生字幕

新版 `content_main.js` 里的字幕 UI（可直接对照产物）：

```css
.imt-caption-container { position:absolute; inset:0; pointer-events:none; z-index:2147483647 }
.imt-caption-window    { position:absolute; width:90%; left:5%; bottom:30px; cursor:move }
.imt-captions-text     { padding:8px 16px; border-radius:12px; background:rgba(0,0,0,.7); text-align:center }
.imt-cue.source-cue    /* 原文 */
.imt-cue.target-cue    /* 译文 */
```

对应的渲染结构（压缩产物里可直接读到）：

```jsx
<div class="imt-caption-container imt-notranslate">
  <div class="imt-caption-window">
    <div class="imt-captions-text">
      <span class="source-cue imt-cue" ... />
      <span class="target-cue imt-cue" ... />
    </div>
  </div>
</div>
```

位置不是写死的：`subtitlePositions[hostname] = {topPercent|bottomPercent}` 存在设置里，窗口可以拖动。

**为什么重要**：往 YouTube 原生 `.ytp-caption-segment` 里塞译文会和它的滚动/换行/隐藏逻辑打架；自绘一层，YouTube 只负责视频，字幕完全归我们。

**我们借什么**：`src/content/overlay.ts` 用同一套结构（`.ytb-caption-window/.ytb-caption-box/.ytb-source/.ytb-target`），挂载在 `.html5-video-player` 内，拖动后的位置按百分比持久化。

---

## 5. 页面翻译引擎：按「块」而不是按「节点」

旧版 `pageTranslator.js` 是最好读的完整实现。核心数据结构是 **piece**：由内联标签连起来的一段话。

- 递归遍历含 Shadow DOM，跳过 `notranslate` / `translate="no"` / `contenteditable` / `script/style`；
- 单段超过 1000 字符自动切块；
- 动态内容用 `MutationObserver` + 2 秒节流的 `translateNewNodes()`，页面不可见时暂停；
- 只翻译视口附近的块（`isInScreen`）；
- 译文写回时用 `<font>` 包住文本节点，`showOriginal` 负责还原；
- 自定义词典用 `@%n#$` 占位符保护词条，翻完再还原（Google 会把占位符打乱，所以要容错）。

（对应源码：[pageTranslator.js#L394-L535](https://github.com/immersive-translate/old-immersive-translate/blob/main/src/contentScript/pageTranslator.js#L394-L535)、[#L314-L350](https://github.com/immersive-translate/old-immersive-translate/blob/main/src/contentScript/pageTranslator.js#L314-L350)、[#L658-L708](https://github.com/immersive-translate/old-immersive-translate/blob/main/src/contentScript/pageTranslator.js#L658-L708)。）

**我们借什么**：页面 DOM 我们不动，但「按语义块、按视口、增量」的思想完整搬到字幕上：`src/content/segmenter.ts` 把 3~5 秒的自动字幕碎片按停顿/标点合并成**句级 Segment**，`src/content/queue.ts` 只翻译当前时间附近的一个窗口。

---

## 6. 翻译服务层：批量、去重、缓存

旧版 `Service` 基类只要求实现三个回调：

```js
new Service(
  "google",
  "https://translate.googleapis.com/translate_a/single",
  "GET",
  cbTransformRequest,   // 文本数组 -> 请求串
  cbParseResponse,      // HTTP 响应 -> [{text, detectedLanguage}]
  cbTransformResponse,  // 响应串 -> 译文数组
)
```

`getRequests()` 做了三件关键的事：

1. 用 `sourceLang + targetLang + 请求串` 的哈希合并**进行中的相同请求**，返回带 `status` 和 `waitTranslate` 的 `TranslationInfo`；
2. 每 800 字符切一个 HTTP 请求；
3. 先查 IndexedDB，命中直接置 `complete`。

缓存 key 是 `SHA-1(service, sourceLang, targetLang, text)`（[translationCache.js#L115](https://github.com/immersive-translate/old-immersive-translate/blob/main/src/background/translationCache.js#L115)）。

**我们借什么**：`src/background/provider.ts` 的批处理 + 重试，`src/background/cache.ts` 的 `sha1(model|target|text)` 键与 IndexedDB 存储；由于字幕是顺序播放，我们把「按视口」换成「按播放进度预取」。

---

## 7. 把「规则」做成数据

旧版 `specialRules.js` 就是一张表：

```js
{
  "hostname": ["twitter.com", "mobile.twitter.com"],
  "selectors": ["[data-testid=\"tweetText\"]", ".tweet-text"],
  "detectLanguage": true
}
```

支持 `hostname` / `regex`、`selectors`、`containerSelectors`、`detectLanguage`，新版把字幕站点适配配置放到了远端 `config-latest.json`，改规则不用发版；本地 `default_config.json` 只放 feature flag（大量 `add_v.[1.30.2]` 这种版本化 key）。

**我们借什么**：只保留一张本地常量表（`src/shared/constants.ts` 里的选择器与默认值），不做远端配置——个人项目不需要灰度，但「选择器集中管理」在 YouTube 改版时能救命。

---

## 8. 权限与网络层的工程细节

`manifest.json` 的权限组合很有信息量：

```
storage, activeTab, contextMenus, webRequest,
declarativeNetRequest(+WithHostAccess/Feedback), offscreen, sidePanel
host_permissions: <all_urls>
```

- `request_modifier_rule.json`（DNR）按 `initiatorDomains` + `urlFilter` 改写 `Referer/origin`、删 `cookie`，让 DeepL / Bing 这类接口在扩展里可用；
- `offscreen` 文档专门跑 tesseract OCR（wasm），避免把重活塞进 Service Worker；
- `web_accessible_resources` 把 `content_main.js`、`default_config*.json`、`video-subtitle/inject.js` 暴露给页面上下文。

**我们借什么**：Service Worker 只做网络与缓存（`src/background/sw.ts`），重活不往 SW 塞；因为只接用户自己的 OpenAI 兼容接口，我们不需要 DNR 改头，但需要**可选域名权限**：`optional_host_permissions` + 保存设置时 `chrome.permissions.request()`。

---

## 9. 双语渲染的状态模型

新版把「显示模式 + 主题」做成了 CSS 状态机：

```css
[imt-state="dual"] .immersive-translate-target-wrapper { ... }
[imt-state="translation"] .immersive-translate-target-wrapper > br { display:none }
[imt-state="dual"] .immersive-translate-target-translation-theme-underline-inner { ... }
```

根节点一个 `imt-state` 属性切换「双语/仅译文」，主题类名控制下划线、高亮、模糊、透明度等（[inject.css#L27-L120](https://github.com/immersive-translate/immersive-translate/blob/main/dist/chrome/styles/inject.css#L27-L120)）。

**我们借什么**：`showOriginal` 用 CSS 变量/类控制，而不是重建 DOM；字号、颜色、背景透明度、位置全部走 CSS 自定义属性（`--ytb-*`），设置变更零重排。

---

## 10. 一张对照表：哪些抄，哪些不抄

| 设计 | 沉浸式翻译 | 我们的项目 | 理由 |
| --- | --- | --- | --- |
| 极薄入口 + 懒加载 | ✅ | ✅（简化版） | 单站点，但仍保持内容脚本轻量 |
| MAIN/ISOLATED 双世界 | ✅ `<script>` 注入 | ✅ `world: "MAIN"` | 读 `getPlayerResponse()` 必须 |
| 站点适配器表 | ✅ 18 种 | ✅ 只做 YouTube | 结构保留，规模缩小 |
| 自绘字幕层 + 拖动 | ✅ | ✅ | 唯一稳的双语方案 |
| 页面 DOM 块翻译 | ✅ | ❌ | 目标只有视频字幕 |
| 多引擎 + 免费接口 | ✅ | ❌ 只做 OpenAI 兼容 + mock | 个人项目，避免逆向维护 |
| 远端规则配置 | ✅ | ❌ | 不需要灰度 |
| DNR 改请求头 | ✅ | ❌ | 自己的接口不需要绕 |
| PDF/EPUB/OCR/漫画 | ✅ | ❌ | 与目标无关 |
| 4MB 全量 bundle | ✅ | ❌ 目标 < 60KB | 可读、可改 |

---

## 11. 结论

沉浸式翻译真正值得学的不是「支持多少种翻译服务」，而是四件工程决策：

1. **页面上下文隔离**：只有主世界能碰播放器对象，就用一层消息桥把能力借出来；
2. **自绘覆盖层**：字幕 UI 与宿主播放器解耦；
3. **句级批处理 + 缓存 + 预取**：把「实时翻译」变成「提前翻译」；
4. **选择器/规则集中管理**：对抗宿主站点改版的唯一现实手段。

这四点构成了本项目 `yt-bilingual` 的骨架，其余全部砍掉。
