import type { Settings } from './types.ts';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'google',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: 'zh-CN',
  batchMaxChars: 1200,
  batchMaxItems: 20,
  concurrency: 2,
  prefetchSeconds: 60,
  showOriginal: true,
  hideNativeCaptions: true,
  fontSize: 22,
  textColor: '#ffffff',
  sourceColor: '#dbeafe',
  bgOpacity: 0.75,
  bottomPercent: 8,
};

export const STORAGE_KEY_SETTINGS = 'ytb.settings';

/** 页面 → 内容脚本的消息标识。 */
export const MESSAGE_SOURCE_PAGE = 'ytb-page';
/** 内容脚本 → 页面的消息标识。 */
export const MESSAGE_SOURCE_CONTENT = 'ytb-content';

export const PLAYER_SELECTOR = '.html5-video-player';
export const NATIVE_CAPTION_SELECTOR = '.ytp-caption-segment';
export const NATIVE_CAPTION_BOX = '.ytp-caption-window-container';
export const VIDEO_SELECTOR = 'video';

/** 挂到 <html> 上时隐藏 YouTube 原生字幕。 */
export const HIDE_NATIVE_CLASS = 'ytb-hide-native';

/** 单条字幕最多合并到多少字符 / 多少秒。 */
export const SEGMENT_MAX_CHARS = 220;
export const SEGMENT_MAX_SECONDS = 12;
/** 两条 cue 间隔小于该值才合并。 */
export const SEGMENT_JOIN_GAP = 0.8;

/** 重启 SW 时，若缓存条目超过该数量则裁剪到 CACHE_KEEP。 */
export const CACHE_MAX_ENTRIES = 20000;
export const CACHE_KEEP_ENTRIES = 15000;
