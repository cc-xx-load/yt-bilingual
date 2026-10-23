# 测试指南

这个项目分三层测试：**纯逻辑单测**（自动）→ **扩展加载**（半自动）→ **真实页面行为**（手工）。
建议按顺序做，前一层不过就不用进下一层。

---

## 0. 构建与单测（不用打开浏览器）

```bash
cd yt-bilingual
npm install
npm run typecheck   # TypeScript 类型检查
npm test            # 31 个 node:test 用例
npm run build       # 产物在 dist/
```

一次跑完：`npm run verify`。

单测覆盖的是**不依赖浏览器**的部分：

| 文件 | 覆盖内容 |
| --- | --- |
| `test/captions.test.ts` | json3 / timedtext XML / VTT 解析、实体还原、去重排序、`fmt` 参数替换 |
| `test/segmenter.test.ts` | 碎片合并、句末断开、字符上限、二分查找、切批 |
| `test/parse-reply.test.ts` | 模型回复解析：围栏、夹带说明、纯字符串数组、按行兜底、缺 id 对齐 |
| `test/provider.test.ts` | OpenAI 兼容请求的 URL/鉴权/消息体、漏条补译、mock 不发请求、URL 工具 |
| `test/google.test.ts` | Google 多句 GET、条数不一致回退逐句、HTML 实体还原、HTTP 错误 |

**不覆盖**：DOM 渲染、YouTube 播放器交互、MV3 生命周期、真实接口。

---

## 1. 加载扩展

1. Chrome / Edge 打开 `chrome://extensions`。
2. 右上角打开「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择 `D:\workplace\yt-bilingual\dist`。
4. 确认卡片：
   - 没有红色「错误」按钮（有的话点开看 manifest / 脚本报错）；
   - 「Service Worker」一行是「已激活」，点进去能在 Console 看到上下文。

> 改代码后：`npm run build` → 在扩展卡片点「重新加载」→ 刷新 YouTube 页面。

---

## 2. 档位 A：Google 免费接口（默认，联网）

装好扩展、不做任何配置就是这一档。

1. 打开一个有 CC 字幕的视频（人工字幕或自动字幕都行）。
2. 预期 1~3 秒内：
   - 播放器底部出现双语浮层：上一行原文，下一行中文译文；
   - YouTube 原生字幕被隐藏；
   - popup 状态从「等待」→「正在翻译」→「已就绪」，进度显示 `n/n`。
3. 在页面控制台执行：

```js
document.documentElement.dataset.ytbPhase     // "ready"
document.documentElement.dataset.ytbSegments  // 例如 "128"
document.documentElement.dataset.ytbDone      // 例如 "128"
```

这一档能验证：MAIN world 取轨、timedtext 拉取、解析/分段、浮层、播放同步、队列、Google 翻译、缓存、popup 状态。
**如果这档不过，先别配 OpenAI。**

### 2.1 离线替代：Mock 模式

没有网络或想排除 Google 限流因素时，设置里切到 **Mock** 再跑一遍：译文固定为 `【简体中文】原文`，用来单独验证「字幕抓取 + 渲染」。

---

## 3. 档位 B：OpenAI 兼容接口（可选，质量更好）

1. 设置页切到 **OpenAI 兼容**，填 Base URL / API Key / 模型，点「测试连接」。
   - 成功：显示耗时 + 一条示例译文（此时也会弹出域名授权，允许）。
   - 失败：先按提示排查（401/404/超时/未配置 Key）。
2. 回到视频页刷新，观察：
   - 译文质量是否成句（自动字幕应被合并成句，而不是碎片）；
   - 播放到未翻译区域时能否自动续译（预取）；
   - 回看已翻译片段是否**不再发请求**。

> Google 与 OpenAI 的缓存是分开的（缓存键包含 provider/model），切换后不会串用。

### 验证缓存

打开 **Service Worker 的 DevTools**（扩展卡片 → Service Worker）：

- Network 面板：只应在首次出现 `translate_a/t`（Google）或 `chat/completions`（OpenAI）请求；回看/刷新后同一句不再请求。
- Application → IndexedDB → `ytb-cache` → `translations`：能看到 `{k, v, at}` 记录。
- Console：

```js
chrome.storage.local.get('ytb.settings').then(console.log)
indexedDB.databases().then(console.log)
```

### 验证预取与优先级

1. 暂停在开头，等 popup 显示「已就绪」。
2. 直接拖到 5 分钟处：应在 1~3 秒内看到该处译文（队列按新的 `currentTime` 重新取批）。
3. 关掉网络 10 秒再恢复：原文不消失，恢复后继续翻译。

---

## 4. 档位 C：故障注入（每个都该有明确提示，而不是白屏）

| 注入方式 | 操作 | 预期 |
| --- | --- | --- |
| API Key 错误 | 设置里填 `sk-invalid` | 浮层顶部红色胶囊 `翻译失败：HTTP 401…`；原文正常；popup 显示错误 |
| Base URL 错误 | 改成 `https://api.openai.com/v2` | `HTTP 404：Base URL 路径不对…` |
| 域名未授权 | 拒绝授权弹窗 | `无法连接翻译接口…到设置页重新保存以授予域名权限` |
| 接口超时/断网 | DevTools → Network → Offline，或 Request blocking 加 `*chat/completions*` / `*translate_a*` | 原文保留；重试后标记失败，不影响其他段 |
| Google 限流 | 连续拖进度条快速触发多次翻译，或 Request blocking 后取消 | `Google 翻译被限流（HTTP 429）`，稍等或切接口 |
| 无字幕视频 | 打开一个没有 CC 的视频 | 浮层提示「这个视频没有可用字幕」 |
| 直播 | 打开任意直播 | 提示「直播流没有可下载的字幕轨」 |
| Shorts | 打开 `/shorts/...` | 提示「暂不支持 Shorts」 |
| 未配置接口 | 清空 API Key 保存 | 只显示原文，提示「未配置翻译接口」，且**不产生网络请求** |
| timedtext 被挡（练兜底） | 页面 DevTools → Network → Request blocking 加 `*timedtext*`，刷新视频 | 提示「已自动打开 CC，使用原生字幕逐句翻译」；译文逐句出现在原生字幕上方 |
| 只有自动字幕的视频（如新闻/访谈） | 打开一个只有 `English (auto-generated)` 的视频 | 直接拉取会返回空 body（POT），扩展应自动打开 CC 并通过播放器请求拿到完整字幕，最终仍显示双语 |

> 兜底模式（fallback）是 YouTube POT 校验失败时的保险，值得专门练一次。

---

## 5. 手工用例清单

打开视频后逐条打勾：

- [ ] 原文 1~2 秒出现，译文随播放补齐
- [ ] 自动字幕（ASR）译文成句、不断裂
- [ ] 原生字幕隐藏；`Alt + B` 关闭后原生字幕恢复
- [ ] 拖动字幕后刷新页面，位置保持
- [ ] 设置里改字号/颜色/距底部，页面即时生效（无需刷新）
- [ ] 全屏 / 剧场模式下字幕位置正确
- [ ] 拖动进度条后字幕跟得上，不串台
- [ ] 切换视频（SPA）后字幕重置并重新加载
- [ ] 回到 YouTube 首页，浮层消失、不残留
- [ ] popup 在非 YouTube 页显示「当前页不是 YouTube 视频页」
- [ ] 回看已翻译片段：Service Worker Network 无新请求
- [ ] 广告播放期间浮层隐藏，广告结束恢复（需要遇到广告）
- [ ] 目标语言切换后重新翻译（进度归零再涨）
- [ ] Google / OpenAI / Mock / 未配置 四种状态切换都即时生效

---

## 6. 调试入口速查

| 想确认 | 在哪看 |
| --- | --- |
| 内容脚本是否注入 | 页面 Console 有 `[yt-bilingual] content script ready` |
| 当前阶段/段数 | 页面 Console：`document.documentElement.dataset.ytbPhase` / `ytbSegments` / `ytbDone` |
| 重新握手取字幕 | 页面 Console：`window.postMessage({source:'ytb-content',type:'hello'}, location.origin)` |
| 后台请求与报错 | 扩展卡片 → Service Worker → Console / Network |
| 内容脚本日志 | 页面 DevTools Console，上下文切到扩展（`[yt-bilingual]` 前缀） |
| 设置内容 | SW Console：`chrome.storage.local.get('ytb.settings').then(console.log)` |
| 缓存内容/大小 | SW DevTools → Application → IndexedDB → `ytb-cache` |
| 强制触发兜底 | 页面 Network → Request blocking → `*timedtext*` |
| 清缓存 | 设置页「清空翻译缓存」，或 SW Console 里重载扩展 |

---

## 7. 自动化现状与缺口

已自动化：解析、分段、批处理、回复解析、provider 请求构造（27 例）。

未自动化（需要浏览器）：MV3 加载、MAIN/ISOLATED 通信、YouTube 播放器时序、浮层布局与全屏。
如果后续要补，最划算的顺序是：

1. Playwright + `--load-extension` 跑本地 mock 页面（把 manifest 的 matches 临时加 `http://localhost/*`）；
2. 用固定时长的假字幕 JSON 驱动 overlay，断言文本与时间轴；
3. 用 `chrome.runtime` 的 mock 驱动内容脚本状态机。

在补自动化之前，**第 5 节的手工清单就是回归标准**。
