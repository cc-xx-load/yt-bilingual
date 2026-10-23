import {
  DEFAULT_SETTINGS,
  HIDE_NATIVE_CLASS,
  MESSAGE_SOURCE_CONTENT,
  MESSAGE_SOURCE_PAGE,
  NATIVE_CAPTION_BOX,
  PLAYER_SELECTOR,
  STORAGE_KEY_SETTINGS,
  VIDEO_SELECTOR,
} from '../shared/constants.ts';
import { getSettings, isLocalEndpoint, saveSettings } from '../shared/settings.ts';
import type {
  ContentPhase,
  ContentState,
  Cue,
  PlayerPayload,
  Segment,
  Settings,
  TrackInfo,
  TranslateResult,
} from '../shared/types.ts';
import { fetchCues, normalizeCues, parseCaptions } from './captions.ts';
import { DomCaptionFallback } from './dom-fallback.ts';
import { Overlay } from './overlay.ts';
import { Translator } from './queue.ts';
import { buildSegments, findSegmentAt } from './segmenter.ts';

let settings: Settings = DEFAULT_SETTINGS;
let overlay: Overlay;
let translator: Translator;
let fallback: DomCaptionFallback | null = null;

let segments: Segment[] = [];
let videoId = '';
let track: TrackInfo | null = null;
let phase: ContentPhase = 'idle';
let detail = '';
let generation = 0;
let lastRendered = -2;
let rafId = 0;
let helloAttempts = 0;
let helloTimer: number | null = null;
let fallbackText = '';
let fallbackToken = 0;
let lastFallbackPositionAt = 0;
let doneCount = 0;
let started = false;
const emptyTrackRetried = new Set<string>();

/** 等待页面 hook 抄回来的 timedtext 正文（播放器带 pot 的请求）。 */
type TimedtextCapture = { url: string; body: string };
let timedtextWaiter: ((value: TimedtextCapture | null) => void) | null = null;
/** 最近一次捕获，覆盖“打开页面时 CC 已经开着、字幕早就加载完”的情况。 */
let lastTimedtext: { videoId: string; url: string; body: string } | null = null;

function videoIdFromUrl(url: string): string {
  try {
    return new URL(url, location.href).searchParams.get('v') ?? '';
  } catch {
    return '';
  }
}

function handleTimedtextCapture(url: string, body: string): void {
  if (!body.trim()) return;
  try {
    // YouTube 的“自动翻译字幕”轨带 tlang 参数，中文视频上会拿到日中/中中结果，丢弃。
    const params = new URL(url, location.href).searchParams;
    if (params.get('tlang')) return;
  } catch {
    // ignore
  }
  const capturedVideoId = videoIdFromUrl(url);
  if (capturedVideoId && videoId && capturedVideoId !== videoId) return;

  lastTimedtext = { videoId: capturedVideoId || videoId, url, body };
  const waiter = timedtextWaiter;
  if (!waiter) return;
  timedtextWaiter = null;
  waiter({ url, body });
}

function postToPage(payload: unknown): void {
  window.postMessage(payload, window.location.origin);
}

function currentTime(): number {
  const video = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
  return video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
}

function isAdPlaying(): boolean {
  return Boolean(document.querySelector(PLAYER_SELECTOR)?.classList.contains('ad-showing'));
}

function translatorOptions() {
  return {
    concurrency: settings.concurrency,
    prefetchSeconds: settings.prefetchSeconds,
    batchMaxItems: settings.batchMaxItems,
    batchMaxChars: settings.batchMaxChars,
  };
}

/** 没填 Key 且不是本地服务时，只显示原文，不去打扰接口。 */
function translationConfigured(): boolean {
  if (settings.provider === 'google' || settings.provider === 'mock') return true;
  return settings.apiKey.trim().length > 0 || isLocalEndpoint(settings.baseURL);
}

/** 根据当前配置启动/暂停翻译；已完成的段落不会被重复请求。 */
function ensureTranslator(): void {
  if (segments.length === 0) return;
  if (!translationConfigured()) {
    translator.stop();
    phase = 'ready';
    detail = '未配置翻译接口：当前只显示原文（到设置页填写 Base URL / API Key）';
    overlay.setStatus('未配置翻译接口，当前只显示原文', 'error', 6000);
    return;
  }
  phase = 'translating';
  detail = '';
  translator.start(segments, translatorContext(), translatorOptions());
  if (segments.every((segment) => segment.state === 'done')) phase = 'ready';
}

function translatorContext() {
  return { videoId, targetLang: settings.targetLang, sourceLang: track?.lang ?? '' };
}

function pickTrack(tracks: TrackInfo[]): TrackInfo {
  const manual = tracks.filter((item) => item.kind !== 'asr');
  const pool = manual.length > 0 ? manual : tracks;
  const english = pool.find((item) => item.lang.toLowerCase().startsWith('en'));
  return english ?? pool[0] ?? tracks[0]!;
}

function snapshot(): ContentState {
  let done = 0;
  for (const segment of segments) if (segment.state === 'done') done += 1;
  return { enabled: settings.enabled, videoId, phase, detail, total: segments.length, done };
}

async function bootstrap(): Promise<void> {
  settings = await getSettings();
  overlay = new Overlay({
    onPositionChange: (percent) => {
      settings = { ...settings, bottomPercent: percent };
      void saveSettings({ bottomPercent: percent });
    },
  });
  overlay.applySettings(settings);
  overlay.setVisible(false);

  translator = new Translator({
    send: async (items, context) => {
      const response = (await chrome.runtime.sendMessage({
        type: 'ytb/translate',
        videoId: context.videoId,
        targetLang: context.targetLang,
        sourceLang: context.sourceLang,
        items,
      })) as TranslateResult | undefined;
      return response ?? { ok: false, error: '后台没有响应，请尝试刷新页面' };
    },
    getTime: currentTime,
    onChange: onTranslatorChange,
    onError: (message) => {
      detail = message;
      overlay.setStatus(`翻译失败：${message}`, 'error', 6000);
    },
  });

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  window.addEventListener('message', onWindowMessage);
  document.addEventListener('yt-navigate-finish', requestPlayer);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) teardown();
  });

  startLoop();
  started = true;
  console.info('[yt-bilingual] content script ready');
  if (settings.enabled) {
    phase = 'waiting';
    requestPlayer();
  }
}

function teardown(): void {
  if (!started) return;
  started = false;
  translator?.stop();
  fallback?.stop();
  document.documentElement.classList.remove(HIDE_NATIVE_CLASS);
  overlay?.destroy();
  if (rafId) cancelAnimationFrame(rafId);
  if (helloTimer !== null) window.clearTimeout(helloTimer);
}

function onWindowMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data as
    | {
        source?: string;
        type?: string;
        href?: string;
        payload?: PlayerPayload;
        url?: string;
        body?: string;
      }
    | null;
  if (!data || data.source !== MESSAGE_SOURCE_PAGE) return;
  if (data.type === 'player' && data.payload) void handlePlayer(data.payload);
  else if (data.type === 'route' && typeof data.href === 'string') handleRoute(data.href);
  else if (data.type === 'timedtext' && typeof data.body === 'string') {
    handleTimedtextCapture(typeof data.url === 'string' ? data.url : '', data.body);
  }
}

/** YouTube 是 SPA：离开 /watch 时清干净，避免旧字幕/浮层留在首页或搜索页。 */
function handleRoute(href: string): void {
  if (href.includes('/watch')) {
    emptyTrackRetried.clear();
    return; // 随后会收到 player 消息，按视频正常加载
  }
  teardownTranslation();
  videoId = '';
  track = null;
  lastTimedtext = null;
  phase = 'idle';
  detail = '';
  overlay.clearCue();
  overlay.setVisible(false);
  overlay.setHideNative(false);
}

async function handlePlayer(payload: PlayerPayload): Promise<void> {
  if (!settings.enabled) return;
  if (helloTimer !== null) {
    window.clearTimeout(helloTimer);
    helloTimer = null;
  }

  if (payload.videoId !== videoId) {
    teardownTranslation();
    videoId = payload.videoId;
    track = null;
  }

  overlay.mount();
  overlay.setVisible(true);

  if (payload.href.includes('/shorts/')) {
    setPhase('unsupported', '暂不支持 Shorts，请打开普通视频页');
    return;
  }
  if (payload.live) {
    setPhase('unsupported', '直播流没有可下载的字幕轨');
    return;
  }
  if (payload.tracks.length === 0) {
    overlay.mount();
    overlay.setVisible(true);
    // 播放器刚初始化时 getPlayerResponse() 可能还没带上 captionTracks，
    // 给一次 1.2 秒后的重试，避免把「有字幕」误判成「无字幕」。
    if (!emptyTrackRetried.has(payload.videoId)) {
      emptyTrackRetried.add(payload.videoId);
      phase = 'waiting';
      detail = '正在读取字幕信息…';
      overlay.setStatus('正在读取字幕信息…', 'info', 3000);
      window.setTimeout(() => {
        if (settings.enabled) requestPlayer();
      }, 1200);
      return;
    }
    setPhase('nosub', '这个视频没有可用字幕');
    return;
  }

  const sameTrack = Boolean(track && payload.tracks.some((item) => item.url === track?.url));
  if (payload.videoId === videoId && sameTrack && segments.length > 0) return;

  await loadVideo(payload);
}

async function loadVideo(payload: PlayerPayload): Promise<void> {
  teardownTranslation();
  const runGeneration = generation;
  videoId = payload.videoId;
  track = pickTrack(payload.tracks);
  overlay.mount();
  overlay.setVisible(true);
  setPhase('loading', '正在加载字幕…');
  overlay.setStatus('正在加载字幕…', 'info', 0);

  try {
    let cues: Cue[] = [];
    try {
      cues = await fetchCues(track.url);
    } catch (error) {
      console.warn('[yt-bilingual] 直接拉取 timedtext 失败：', error);
    }
    if (runGeneration !== generation) return;

    if (cues.length === 0) {
      // 服务端 POT 校验会让 timedtext 返回 200 + 空 body；转而读取播放器自己的请求。
      overlay.setStatus('字幕接口返回空，正在通过播放器读取…', 'info', 0);
      cues = await capturePlayerCaptions(track.lang);
      if (runGeneration !== generation) return;
    }

    if (cues.length === 0) throw new Error('字幕内容为空');
    segments = buildSegments(cues);
    if (segments.length === 0) throw new Error('字幕内容为空');

    overlay.setFallbackMode(false);
    overlay.setHideNative(settings.hideNativeCaptions);
    overlay.setStatus(`已加载 ${segments.length} 段字幕`, 'info', 3000);
    phase = 'translating';
    detail = '';
    lastRendered = -2;
    ensureTranslator();
  } catch (error) {
    if (runGeneration !== generation) return;
    console.warn('[yt-bilingual] 字幕轨不可用，切换到原生字幕兜底：', error);
    startFallback();
  }
}

function capturedLangMatches(url: string): boolean {
  if (!track) return true;
  try {
    const lang = new URL(url, location.href).searchParams.get('lang');
    if (!lang) return true;
    return (
      lang === track.lang ||
      track.lang.startsWith(`${lang}-`) ||
      lang.startsWith(`${track.lang}-`)
    );
  } catch {
    return true;
  }
}

/** 让播放器自己去请求 timedtext（带 pot），hook 会把正文抄回来。 */
async function capturePlayerCaptions(lang: string): Promise<Cue[]> {
  if (
    lastTimedtext &&
    (!lastTimedtext.videoId || lastTimedtext.videoId === videoId) &&
    capturedLangMatches(lastTimedtext.url)
  ) {
    const cached = normalizeCues(parseCaptions(lastTimedtext.body));
    if (cached.length > 0) return cached;
  }

  const captured = new Promise<TimedtextCapture | null>((resolve) => {
    timedtextWaiter = resolve;
    window.setTimeout(() => {
      if (timedtextWaiter === resolve) {
        timedtextWaiter = null;
        resolve(null);
      }
    }, 5000);
  });
  postToPage({ source: MESSAGE_SOURCE_CONTENT, type: 'enable-cc', lang });
  const result = await captured;
  if (!result || !capturedLangMatches(result.url)) return [];
  return normalizeCues(parseCaptions(result.body));
}

function startFallback(): void {
  if (!overlay.mount()) {
    setPhase('error', '找不到 YouTube 播放器');
    return;
  }
  overlay.setVisible(true);
  overlay.setFallbackMode(true);
  overlay.setHideNative(false);
  if (!translationConfigured()) {
    phase = 'ready';
    detail = '字幕接口不可用，且未配置翻译接口：当前只显示原生字幕';
    overlay.setStatus('未配置翻译接口，当前只显示原生字幕', 'error', 6000);
    return;
  }
  // DOM 兜底必须让原生字幕显示出来，所以这里主动打开 CC。
  postToPage({ source: MESSAGE_SOURCE_CONTENT, type: 'enable-cc', lang: track?.lang ?? '' });
  overlay.setStatus('已自动打开 CC，使用原生字幕逐句翻译', 'error', 8000);
  phase = 'fallback';
  detail = '请在播放器里打开 CC 字幕：已切换为「原生字幕 + 逐句翻译」兜底';
  if (!fallback) {
    fallback = new DomCaptionFallback(
      (text) => void onFallbackCaption(text),
      () => settings.enabled && phase === 'fallback',
    );
  }
  fallback.start();
}

function onFallbackCaption(text: string): void {
  if (!text) {
    fallbackText = '';
    fallbackToken += 1;
    overlay.render('', '', false);
    return;
  }
  overlay.render('', fallbackText, true);
  void translateFallback(text);
}

async function translateFallback(text: string): Promise<void> {
  const token = (fallbackToken += 1);
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'ytb/translate',
      videoId,
      targetLang: settings.targetLang,
      sourceLang: '',
      items: [{ id: 0, text }],
    })) as TranslateResult | undefined;
    if (token !== fallbackToken) return;
    if (response?.ok) {
      fallbackText = response.results.find((item) => item.id === 0)?.text ?? '';
      overlay.render('', fallbackText, false);
    } else {
      overlay.render('', '', false);
    }
  } catch {
    if (token === fallbackToken) overlay.render('', '', false);
  }
}

function positionFallback(): void {
  const player = document.querySelector<HTMLElement>(PLAYER_SELECTOR);
  const captionBox = document.querySelector<HTMLElement>(NATIVE_CAPTION_BOX);
  if (!player || !captionBox) {
    overlay.setBottomPx(null);
    return;
  }
  const playerRect = player.getBoundingClientRect();
  const boxRect = captionBox.getBoundingClientRect();
  if (boxRect.height <= 1) {
    overlay.setBottomPx(null);
    return;
  }
  overlay.setBottomPx(Math.max(8, playerRect.bottom - boxRect.top + 10));
}

/**
 * 把状态写到 <html data-ytb-*> 上，方便在页面控制台直接排查：
 *   document.documentElement.dataset.ytbPhase     // waiting / loading / translating / ready / nosub / fallback / error
 *   document.documentElement.dataset.ytbSegments  // 字幕段总数
 *   document.documentElement.dataset.ytbDone      // 已翻译段数
 */
function syncDebugState(): void {
  const root = document.documentElement;
  if (root.dataset.ytbPhase !== phase) root.dataset.ytbPhase = phase;
  const total = String(segments.length);
  if (root.dataset.ytbSegments !== total) root.dataset.ytbSegments = total;
  const done = String(doneCount);
  if (root.dataset.ytbDone !== done) root.dataset.ytbDone = done;
  const captured = lastTimedtext ? '1' : '0';
  if (root.dataset.ytbCaptured !== captured) root.dataset.ytbCaptured = captured;
}

function startLoop(): void {
  if (rafId) return;
  const tick = (): void => {
    rafId = requestAnimationFrame(tick);
    try {
      onFrame();
    } catch (error) {
      console.warn('[yt-bilingual]', error);
    }
  };
  rafId = requestAnimationFrame(tick);
}

function onFrame(): void {
  syncDebugState();
  if (!settings.enabled) return;

  if (phase === 'fallback') {
    const now = performance.now();
    if (now - lastFallbackPositionAt > 250) {
      lastFallbackPositionAt = now;
      positionFallback();
    }
    return;
  }
  if (phase !== 'translating' && phase !== 'ready') return;
  if (segments.length === 0) return;
  if (!overlay.isMounted() && !overlay.mount()) return;
  if (isAdPlaying()) {
    overlay.clearCue();
    lastRendered = -2;
    return;
  }

  const index = findSegmentAt(segments, currentTime());
  if (index === lastRendered) return;
  lastRendered = index;
  if (index < 0) {
    overlay.clearCue();
    return;
  }
  const segment = segments[index];
  if (!segment) {
    overlay.clearCue();
    return;
  }
  overlay.render(segment.text, segment.translation, segment.state === 'loading');
}

function onTranslatorChange(): void {
  const total = segments.length;
  if (total === 0) return;
  let done = 0;
  let failed = 0;
  for (const segment of segments) {
    if (segment.state === 'done') done += 1;
    else if (segment.state === 'error') failed += 1;
  }
  doneCount = done;
  if (done + failed >= total) {
    phase = done > 0 ? 'ready' : 'error';
    detail = failed > 0 ? `${failed} 段翻译失败（已保留原文）` : '';
  } else {
    phase = 'translating';
  }
}

function setPhase(next: ContentPhase, message = ''): void {
  phase = next;
  detail = message;
  if (message && overlay) {
    const kind = next === 'error' || next === 'unsupported' || next === 'nosub' ? 'error' : 'info';
    overlay.setStatus(message, kind, 6000);
  }
}

function requestPlayer(): void {
  postToPage({ source: MESSAGE_SOURCE_CONTENT, type: 'hello' });
  if (helloTimer !== null) window.clearTimeout(helloTimer);
  helloAttempts = 0;
  const retry = (): void => {
    if (!started || !settings.enabled) return;
    if (phase !== 'waiting' && phase !== 'idle') return;
    helloAttempts += 1;
    if (helloAttempts > 20) return;
    postToPage({ source: MESSAGE_SOURCE_CONTENT, type: 'hello' });
    helloTimer = window.setTimeout(retry, 500);
  };
  helloTimer = window.setTimeout(retry, 500);
}

function teardownTranslation(): void {
  generation += 1;
  translator?.stop();
  fallback?.stop();
  overlay?.setFallbackMode(false);
  overlay?.setBottomPx(null);
  overlay?.clearCue();
  segments = [];
  doneCount = 0;
  lastRendered = -2;
  fallbackToken += 1;
  fallbackText = '';
  const waiter = timedtextWaiter;
  timedtextWaiter = null;
  waiter?.(null);
}

function stopEnabled(): void {
  teardownTranslation();
  overlay.clearCue();
  overlay.setVisible(false);
  overlay.setHideNative(false);
  phase = 'idle';
  detail = '';
}

function startEnabled(): void {
  overlay.setVisible(true);
  startLoop();
  phase = 'waiting';
  detail = '';
  requestPlayer();
}

async function setEnabled(enabled: boolean): Promise<void> {
  if (settings.enabled === enabled) return;
  settings = { ...settings, enabled };
  await saveSettings({ enabled });
  if (enabled) startEnabled();
  else stopEnabled();
}

function onRuntimeMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  const data = message as { type?: string; enabled?: boolean } | null;
  if (!data || typeof data.type !== 'string') return undefined;
  if (data.type === 'ytb/state') {
    sendResponse(snapshot());
    return undefined;
  }
  if (data.type === 'ytb/enable') {
    void setEnabled(data.enabled !== false);
    sendResponse({ ok: true });
    return undefined;
  }
  if (data.type === 'ytb/toggle') {
    void setEnabled(!settings.enabled);
    sendResponse({ ok: true });
    return undefined;
  }
  return undefined;
}

function onStorageChanged(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string,
): void {
  if (areaName !== 'local' || !changes[STORAGE_KEY_SETTINGS]) return;
  const next = changes[STORAGE_KEY_SETTINGS]?.newValue as Partial<Settings> | undefined;
  const previous = settings;
  settings = { ...DEFAULT_SETTINGS, ...(next ?? {}) };
  overlay.applySettings(settings);

  if (settings.enabled !== previous.enabled) {
    if (settings.enabled) startEnabled();
    else stopEnabled();
    return;
  }
  if (!settings.enabled) return;

  overlay.setHideNative(settings.hideNativeCaptions && phase !== 'fallback');
  translator.updateOptions(translatorOptions());

  const providerChanged =
    settings.provider !== previous.provider ||
    settings.baseURL !== previous.baseURL ||
    settings.apiKey !== previous.apiKey ||
    settings.model !== previous.model;

  if (settings.targetLang !== previous.targetLang) {
    if (phase === 'translating' || phase === 'ready' || phase === 'error') {
      for (const segment of segments) {
        segment.translation = '';
        segment.state = 'idle';
        segment.attempts = 0;
        segment.nextRetryAt = 0;
      }
      lastRendered = -2;
      ensureTranslator();
    } else if (phase === 'fallback') {
      fallbackText = '';
      fallbackToken += 1;
      overlay.clearCue();
    }
    return;
  }

  if (providerChanged && segments.length > 0) ensureTranslator();
}

void bootstrap().catch((error) => {
  console.error('[yt-bilingual] 初始化失败', error);
});
