import { MESSAGE_SOURCE_CONTENT, MESSAGE_SOURCE_PAGE } from '../shared/constants.ts';
import type { PlayerPayload, TrackInfo } from '../shared/types.ts';

/**
 * 运行在页面主世界（world: "MAIN"）的脚本。
 * 唯一职责：从 YouTube 播放器对象里取字幕轨信息，通过 postMessage 交给内容脚本。
 * 内容脚本（ISOLATED world）拿不到 #movie_player 上的 JS 方法，所以必须走这一层。
 */

interface YouTubePlayer {
  getPlayerResponse?: () => PlayerResponse | undefined;
}

interface RawCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text?: string }[] };
}

interface PlayerResponse {
  videoDetails?: {
    videoId?: string;
    isLive?: boolean;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: RawCaptionTrack[];
    };
  };
}

type WindowWithPlayerData = Window & { ytInitialPlayerResponse?: PlayerResponse };

let lastSignature = '';

function getPlayer(): YouTubePlayer | null {
  return document.getElementById('movie_player') as YouTubePlayer | null;
}

function readPlayerResponse(): PlayerResponse | null {
  const player = getPlayer();
  if (player?.getPlayerResponse) {
    try {
      const response = player.getPlayerResponse();
      if (response?.videoDetails?.videoId) return response;
    } catch {
      // 播放器还没初始化完成时会抛错，走下面的兜底。
    }
  }
  const initial = (window as WindowWithPlayerData).ytInitialPlayerResponse;
  return initial ?? null;
}

function extractTrack(raw: RawCaptionTrack): TrackInfo {
  return {
    lang: String(raw.languageCode ?? ''),
    kind: String(raw.kind ?? ''),
    name: String(raw.name?.simpleText ?? raw.name?.runs?.[0]?.text ?? raw.languageCode ?? ''),
    url: String(raw.baseUrl ?? ''),
  };
}

function extract(response: PlayerResponse | null): PlayerPayload | null {
  if (!response) return null;
  const urlVideoId = new URLSearchParams(location.search).get('v');
  // SPA 刚跳转时 #movie_player 可能还返回上一个视频的响应，先用 URL 里的 v 过滤掉。
  if (urlVideoId && response.videoDetails?.videoId && response.videoDetails.videoId !== urlVideoId) {
    return null;
  }
  const videoId = String(response.videoDetails?.videoId ?? urlVideoId ?? '');
  if (!videoId) return null;

  const rawTracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const tracks = (Array.isArray(rawTracks) ? rawTracks : [])
    .map(extractTrack)
    .filter((track) => track.url.length > 0);

  return {
    videoId,
    live: Boolean(response.videoDetails?.isLive),
    href: location.href,
    tracks,
  };
}

function signatureOf(payload: PlayerPayload): string {
  const tracks = payload.tracks
    .map((track) => `${track.lang}:${track.kind}:${track.url.slice(-32)}`)
    .join(',');
  return `${payload.videoId}|${payload.live ? 1 : 0}|${tracks}`;
}

function emit(force = false): void {
  const payload = extract(readPlayerResponse());
  if (!payload) return;
  const signature = signatureOf(payload);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  window.postMessage({ source: MESSAGE_SOURCE_PAGE, type: 'player', payload }, location.origin);
}

document.addEventListener('yt-navigate-finish', () => {
  lastSignature = '';
  window.postMessage(
    { source: MESSAGE_SOURCE_PAGE, type: 'route', href: location.href },
    location.origin,
  );
  emit(true);
});
document.addEventListener('yt-page-data-updated', () => emit());

// ---------------------------------------------------------------------------
// timedtext 抓包 + 自动打开 CC
//
// 2024 之后 YouTube 对 /api/timedtext 加了 POT 校验：第三方直接 fetch 会得到
// HTTP 200 + 空 body（本项目的测试视频就是这种，只有自动字幕）。
// 播放器自己请求时是带 pot 的，所以这里 hook fetch/XHR，把播放器拿到的
// 字幕正文抄一份给内容脚本 —— 既绕过 POT，又能拿到完整时间轴。
// ---------------------------------------------------------------------------

const TIMEDTEXT_MARK = '/api/timedtext';

function post(payload: unknown): void {
  window.postMessage(payload, location.origin);
}

function reportTimedtext(url: string, body: string): void {
  if (!body) return;
  post({ source: MESSAGE_SOURCE_PAGE, type: 'timedtext', url, body });
}

function installTimedtextHooks(): void {
  const nativeFetch = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const promise = nativeFetch(input, init);
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(TIMEDTEXT_MARK)) {
        promise
          .then((response) => {
            if (!response.ok) return;
            response
              .clone()
              .text()
              .then((text) => reportTimedtext(url, text))
              .catch(() => undefined);
          })
          .catch(() => undefined);
      }
    } catch {
      // 绝不影响页面自己的请求
    }
    return promise;
  }) as typeof fetch;

  const nativeOpen = XMLHttpRequest.prototype.open as (...args: unknown[]) => void;
  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest & { __ytbUrl?: string },
    ...args: unknown[]
  ) {
    this.__ytbUrl = String(args[1] ?? '');
    return nativeOpen.apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;

  const nativeSend = XMLHttpRequest.prototype.send as (...args: unknown[]) => void;
  XMLHttpRequest.prototype.send = function patchedSend(
    this: XMLHttpRequest & { __ytbUrl?: string },
    ...args: unknown[]
  ) {
    if (this.__ytbUrl && this.__ytbUrl.includes(TIMEDTEXT_MARK)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            reportTimedtext(this.__ytbUrl ?? '', this.responseText);
          }
        } catch {
          // ignore
        }
      });
    }
    return nativeSend.apply(this, args);
  } as typeof XMLHttpRequest.prototype.send;
}

interface PlayerWithCaptions extends HTMLElement {
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
}

function enableCaptions(preferredLang: string): void {
  const player = document.getElementById('movie_player') as PlayerWithCaptions | null;

  if (preferredLang && player?.setOption) {
    try {
      player.setOption('captions', 'track', { languageCode: preferredLang });
    } catch {
      // 字幕模块可能还没初始化，下面点按钮同样能触发加载
    }
  }

  const button = document.querySelector<HTMLElement>('.ytp-subtitles-button');
  if (button) {
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
    return;
  }
  const fallbackButton = document.querySelector<HTMLElement>(
    'button[aria-label*="Subtitles"], button[aria-label*="字幕"], button[aria-label*="CC"]',
  );
  if (fallbackButton && fallbackButton.getAttribute('aria-pressed') !== 'true') {
    fallbackButton.click();
  }
}

installTimedtextHooks();

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as { source?: string; type?: string; lang?: string } | null;
  if (data?.source !== MESSAGE_SOURCE_CONTENT) return;
  if (data.type === 'hello') emit(true);
  else if (data.type === 'enable-cc') enableCaptions(typeof data.lang === 'string' ? data.lang : '');
});

// YouTube 是 SPA：轮询兜底，保证换视频 / 播放器重建后都能重新上报。
window.setInterval(() => emit(), 1000);
emit(true);
