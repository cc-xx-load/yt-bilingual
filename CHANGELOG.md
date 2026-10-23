# Changelog

## [0.1.0] - 2026-10-24

首个可用版本。

### Added

- Chrome / Edge Manifest V3 扩展：在 YouTube 播放器上叠加原文 + 译文字幕
- MAIN world 读取 `getPlayerResponse()` 字幕轨；支持人工字幕与自动字幕
- 自动字幕碎片按停顿/标点合并成句
- Google 免费翻译接口（默认，无需 Key）
- OpenAI 兼容接口（OpenAI / DeepSeek / Ollama / 自建网关），含「测试连接」
- 按播放进度预取、并发控制、失败退避重试
- IndexedDB 翻译缓存（按 provider/model/目标语言/文本哈希）
- timedtext 被 POT 校验挡住时，hook 播放器的 timedtext 请求复用其正文
- 自动打开 CC；失败时降级为原生字幕逐句翻译
- 可拖动的双语浮层，位置持久化；全屏跟随；广告期隐藏
- 字幕描边 + 渐变底色，亮画面可读
- 设置页 / popup / `Alt+B` 快捷键 / Mock 模式
- 31 个单元测试 + GitHub Actions CI

### Known limitations

- 仅支持 `youtube.com/watch`
- 不支持直播、Shorts、站外嵌入
- 无语音识别，视频必须已有 CC 字幕
- Google 免费端点可能限流
