import { parseTranslations } from '../shared/parse-reply.ts';
import { isLocalEndpoint, withV1 } from '../shared/settings.ts';
import type { ProviderKind, TranslateItem } from '../shared/types.ts';

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  zh: '中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
  pt: 'Português',
  it: 'Italiano',
  ar: 'العربية',
  hi: 'हिन्दी',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
  tr: 'Türkçe',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES[code.split('-')[0] ?? ''] ?? code;
}

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}

export interface ProviderSettings {
  provider: ProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface TranslateOptions {
  settings: ProviderSettings;
  targetLang: string;
  sourceLang?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemPrompt(targetLang: string, sourceLang?: string): string {
  const lines = [
    `你是专业的影视字幕译者。把用户给出的每条字幕翻译成${languageName(targetLang)}。`,
    '要求：',
    '1. 口语化、简洁，符合字幕阅读节奏，不要添加解释、注释或旁白；',
    '2. 保留人名、品牌、术语、数字与专有名词；',
    '3. 不要合并、拆分或遗漏条目，逐条一一对应；',
    '4. 只输出 JSON 数组，每个元素形如 {"id": 原始id, "text": "译文"}，顺序与输入一致；',
    '5. 不要输出 Markdown 代码块、前后缀说明或任何额外文字。',
  ];
  if (sourceLang) lines.push(`源语言：${sourceLang}`);
  return lines.join('\n');
}

function isLocalHost(url: string): boolean {
  return isLocalEndpoint(url);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function httpMessage(status: number, body: string): string {
  if (status === 401) return 'HTTP 401：API Key 无效或未授权';
  if (status === 403) return 'HTTP 403：接口拒绝访问（检查 Key 或模型权限）';
  if (status === 404) return 'HTTP 404：Base URL 路径不对（通常应以 /v1 结尾）';
  if (status === 429) return 'HTTP 429：请求太频繁，已被限流';
  if (status >= 500) return `HTTP ${status}：翻译服务暂时不可用`;
  const snippet = body.trim().slice(0, 160);
  return `HTTP ${status}${snippet ? `：${snippet}` : ''}`;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (error instanceof TypeError) return true; // 网络失败 / 域名未授权
  return false;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

async function requestBatch(
  options: TranslateOptions,
  items: TranslateItem[],
): Promise<Map<number, string>> {
  const { settings } = options;
  const endpoint = `${withV1(settings.baseURL)}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey.trim()) headers['Authorization'] = `Bearer ${settings.apiKey.trim()}`;

  const body = {
    model: settings.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSystemPrompt(options.targetLang, options.sourceLang) },
      { role: 'user', content: JSON.stringify(items) },
    ],
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new ProviderError(httpMessage(response.status, await safeText(response)), response.status === 429 || response.status >= 500);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError('接口返回的不是 JSON，检查 Base URL 是否指向 OpenAI 兼容服务', false);
  }

  const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== 'string') {
    throw new ProviderError('接口返回格式不符合 OpenAI Chat Completions', false);
  }
  return parseTranslations(content, items);
}

async function requestWithRetry(
  options: TranslateOptions,
  items: TranslateItem[],
  attempts = 3,
): Promise<Map<number, string>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestBatch(options, items);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) break;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw toError(lastError);
}

// ---------------------------------------------------------------------------
// Google 免费接口
//
// 用的是网页版自带的两个地址，不需要 Key：
//   多句：https://clients5.google.com/translate_a/t?client=dict-chrome-ex&q=..&q=..
//   单句：https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&q=..
// 多句是 GET（POST 会被 429），所以按 URL 长度切块；多句失败时退回逐句。
// 非官方接口，可能被限流，长期使用建议换 OpenAI 兼容接口。
// ---------------------------------------------------------------------------

const GOOGLE_MULTI_ENDPOINT = 'https://clients5.google.com/translate_a/t';
const GOOGLE_SINGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const GOOGLE_MAX_ITEMS = 12;
const GOOGLE_MAX_ENCODED_CHARS = 3600;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** 把 YouTube 的语言代码换成 Google 认识的形式。 */
function googleLang(code: string, fallback: string): string {
  if (!code) return fallback;
  const map: Record<string, string> = {
    'zh-hans': 'zh-CN',
    'zh-hant': 'zh-TW',
    'zh-cn': 'zh-CN',
    'zh-tw': 'zh-TW',
    'pt-br': 'pt',
    'pt-pt': 'pt',
  };
  return map[code.toLowerCase()] ?? code;
}

function googleHttpMessage(status: number): string {
  if (status === 429) return 'Google 翻译被限流（HTTP 429）：等几分钟，或到设置里改用 OpenAI 兼容接口';
  if (status === 403) return 'Google 拒绝了请求（HTTP 403）：换网络/IP，或改用 OpenAI 兼容接口';
  if (status >= 500) return `Google 翻译暂时不可用（HTTP ${status}）`;
  return `Google 翻译请求失败（HTTP ${status}）`;
}

function chunkForGoogle(items: TranslateItem[]): TranslateItem[][] {
  const chunks: TranslateItem[][] = [];
  let current: TranslateItem[] = [];
  let encoded = 0;
  for (const item of items) {
    const size = encodeURIComponent(item.text).length + 3;
    if (current.length > 0 && (current.length >= GOOGLE_MAX_ITEMS || encoded + size > GOOGLE_MAX_ENCODED_CHARS)) {
      chunks.push(current);
      current = [];
      encoded = 0;
    }
    current.push(item);
    encoded += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function parseGoogleMulti(data: unknown): string[] | null {
  if (!Array.isArray(data)) return null;
  const out: string[] = [];
  for (const entry of data) {
    if (Array.isArray(entry) && typeof entry[0] === 'string') out.push(entry[0]);
    else if (typeof entry === 'string') out.push(entry);
    else return null;
  }
  return out;
}

function parseGoogleSingle(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  const segments = data[0];
  if (!Array.isArray(segments)) return null;
  const parts: string[] = [];
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === 'string') parts.push(segment[0]);
  }
  return parts.length > 0 ? parts.join('') : null;
}

function buildGoogleUrl(base: string, options: TranslateOptions, texts: string[]): string {
  const url = new URL(base);
  url.searchParams.set('client', base === GOOGLE_MULTI_ENDPOINT ? 'dict-chrome-ex' : 'gtx');
  url.searchParams.set('sl', googleLang(options.sourceLang ?? '', 'auto'));
  url.searchParams.set('tl', googleLang(options.targetLang, options.targetLang));
  if (base === GOOGLE_SINGLE_ENDPOINT) url.searchParams.set('dt', 't');
  for (const text of texts) url.searchParams.append('q', text);
  return url.toString();
}

async function googleMulti(options: TranslateOptions, items: TranslateItem[]): Promise<string[]> {
  const url = buildGoogleUrl(
    GOOGLE_MULTI_ENDPOINT,
    options,
    items.map((item) => item.text),
  );
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new ProviderError(googleHttpMessage(response.status), response.status === 429 || response.status >= 500);
  }
  const data: unknown = await response.json().catch(() => null);
  const list = parseGoogleMulti(data);
  if (!list || list.length !== items.length) {
    throw new ProviderError('Google 返回的条数与请求不一致', false);
  }
  return list.map(decodeEntities);
}

async function googleSingle(options: TranslateOptions, text: string): Promise<string> {
  const url = buildGoogleUrl(GOOGLE_SINGLE_ENDPOINT, options, [text]);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new ProviderError(googleHttpMessage(response.status), response.status === 429 || response.status >= 500);
  }
  const data: unknown = await response.json().catch(() => null);
  const translated = parseGoogleSingle(data);
  if (translated === null) throw new ProviderError('Google 返回格式无法解析', false);
  return decodeEntities(translated);
}

async function googleWithRetry<T>(action: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) break;
      await sleep(1200);
    }
  }
  throw toError(lastError);
}

async function translateGoogle(
  options: TranslateOptions,
  items: TranslateItem[],
): Promise<Map<number, string>> {
  const translated = new Map<number, string>();
  for (const chunk of chunkForGoogle(items)) {
    let list: string[] | null = null;
    let lastError: unknown = null;
    try {
      list = await googleWithRetry(() => googleMulti(options, chunk));
    } catch (error) {
      // 多句接口不可用（限流会抛可重试错误，交给上层退避）
      if (error instanceof ProviderError && error.retryable) throw error;
      lastError = error;
      list = null;
    }

    if (list) {
      chunk.forEach((item, index) => {
        const text = list?.[index];
        if (text) translated.set(item.id, text);
      });
      continue;
    }

    // 多句失败时逐句兜底；单句之间稍微间隔，降低被限流的概率。
    let translatedInChunk = 0;
    for (const item of chunk) {
      try {
        const text = await googleWithRetry(() => googleSingle(options, item.text));
        if (text) {
          translated.set(item.id, text);
          translatedInChunk += 1;
        }
      } catch (error) {
        if (error instanceof ProviderError && error.retryable) throw error;
        lastError = error;
      }
      await sleep(120);
    }
    if (translatedInChunk === 0 && lastError) throw toError(lastError);
  }
  return translated;
}

/** 翻译一批字幕；返回 id → 译文，缺失的 id 表示模型漏了（由上层兜底）。 */
export async function translateTexts(
  options: TranslateOptions,
  items: TranslateItem[],
): Promise<Map<number, string>> {
  if (items.length === 0) return new Map();
  const { settings } = options;

  if (settings.provider === 'mock') {
    await sleep(200);
    return new Map(
      items.map((item) => [item.id, `【${languageName(options.targetLang)}】${item.text}`]),
    );
  }
  if (settings.provider === 'google') {
    return translateGoogle(options, items);
  }
  if (!settings.baseURL.trim()) {
    throw new ProviderError('未配置 Base URL，请到扩展设置里填写', false);
  }
  if (!settings.model.trim()) {
    throw new ProviderError('未配置模型名称', false);
  }
  if (!settings.apiKey.trim() && !isLocalEndpoint(settings.baseURL)) {
    throw new ProviderError('未配置 API Key', false);
  }

  const translated = await requestWithRetry(options, items);

  // 模型偶尔会漏条：把漏掉的单独补一次，避免整批作废。
  const missing = items.filter((item) => !translated.has(item.id));
  if (missing.length > 0 && missing.length < items.length) {
    try {
      const extra = await requestBatch(options, missing);
      for (const [id, text] of extra) translated.set(id, text);
    } catch {
      // 补译失败就保留缺失，上层会显示原文并退避重试。
    }
  }
  return translated;
}

export function describeError(error: unknown): string {
  const normalized = toError(error);
  if (normalized instanceof ProviderError) return normalized.message;
  if (normalized instanceof TypeError) {
    return '无法连接翻译接口：检查 Base URL、网络，或到设置页重新保存以授予域名权限';
  }
  if (normalized instanceof DOMException && normalized.name === 'TimeoutError') {
    return '翻译接口超时（60 秒），可尝试调小批次或更换模型';
  }
  return normalized.message || '未知错误';
}
