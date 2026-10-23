/** 页面上下文（MAIN world）识别到的一条字幕轨。 */
export interface TrackInfo {
  lang: string;
  /** "asr" 表示 YouTube 自动生成字幕，空串表示人工字幕。 */
  kind: string;
  name: string;
  url: string;
}

/** 原始字幕 cue（来自 json3 / xml / vtt）。 */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export type SegmentState = 'idle' | 'loading' | 'done' | 'error';

/** 合并后的"句级"字幕单元，也是翻译与显示的最小单位。 */
export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
  translation: string;
  state: SegmentState;
  attempts: number;
  /** 失败退避：早于该时间戳不再重试。 */
  nextRetryAt: number;
}

export type ProviderKind = 'google' | 'openai' | 'mock';

export interface Settings {
  enabled: boolean;
  provider: ProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
  targetLang: string;
  batchMaxChars: number;
  batchMaxItems: number;
  concurrency: number;
  prefetchSeconds: number;
  showOriginal: boolean;
  hideNativeCaptions: boolean;
  fontSize: number;
  textColor: string;
  sourceColor: string;
  bgOpacity: number;
  bottomPercent: number;
}

export interface PlayerPayload {
  videoId: string;
  live: boolean;
  href: string;
  tracks: TrackInfo[];
}

export type PageMessage =
  | { source: 'ytb-page'; type: 'player'; payload: PlayerPayload }
  | { source: 'ytb-page'; type: 'route'; href: string };

export type ContentMessage = { source: 'ytb-content'; type: 'hello' };

export interface TranslateItem {
  id: number;
  text: string;
}

export interface TranslateRequest {
  type: 'ytb/translate';
  videoId: string;
  targetLang: string;
  sourceLang: string;
  items: TranslateItem[];
}

export type TranslateResult =
  | { ok: true; results: { id: number; text: string }[] }
  | { ok: false; error: string };

export interface TestConnectionRequest {
  type: 'ytb/test-connection';
  settings: Pick<Settings, 'provider' | 'baseURL' | 'apiKey' | 'model'>;
  targetLang: string;
  text: string;
}

export type TestConnectionResult = { ok: true; text: string; ms: number } | { ok: false; error: string };

export interface ClearCacheRequest {
  type: 'ytb/clear-cache';
}

export type ContentPhase =
  | 'idle'
  | 'waiting'
  | 'loading'
  | 'translating'
  | 'ready'
  | 'nosub'
  | 'unsupported'
  | 'fallback'
  | 'error';

/** 内容脚本汇报给 popup 的状态快照。 */
export interface ContentState {
  enabled: boolean;
  videoId: string;
  phase: ContentPhase;
  detail: string;
  total: number;
  done: number;
}

export type ContentCommand =
  | { type: 'ytb/state' }
  | { type: 'ytb/enable'; enabled: boolean }
  | { type: 'ytb/toggle' };
