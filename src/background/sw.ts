import { getSettings } from '../shared/settings.ts';
import type {
  ClearCacheRequest,
  TestConnectionRequest,
  TestConnectionResult,
  TranslateItem,
  TranslateRequest,
  TranslateResult,
} from '../shared/types.ts';
import { cacheGetMany, cachePutMany, clearCache, pruneCache, sha1 } from './cache.ts';
import { describeError, translateTexts } from './provider.ts';

chrome.runtime.onInstalled.addListener(() => {
  void pruneCache().catch((error) => console.warn('[yt-bilingual] 缓存裁剪失败', error));
});

chrome.runtime.onStartup.addListener(() => {
  void pruneCache().catch((error) => console.warn('[yt-bilingual] 缓存裁剪失败', error));
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const type = (message as { type?: string } | null)?.type;
  if (type === 'ytb/translate') {
    void handleTranslate(message as TranslateRequest).then(sendResponse);
    return true;
  }
  if (type === 'ytb/test-connection') {
    void handleTestConnection(message as TestConnectionRequest).then(sendResponse);
    return true;
  }
  if (type === 'ytb/clear-cache') {
    void handleClearCache(message as ClearCacheRequest).then(sendResponse);
    return true;
  }
  return undefined;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-bilingual') void toggleActiveTab();
});

async function toggleActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'ytb/toggle' });
  } catch {
    // 当前标签页不是 YouTube，或内容脚本还没加载，忽略即可。
  }
}

async function handleTranslate(request: TranslateRequest): Promise<TranslateResult> {
  try {
    if (!Array.isArray(request.items) || request.items.length === 0) {
      return { ok: true, results: [] };
    }
    const settings = await getSettings();
    const cachePrefix =
      settings.provider === 'google'
        ? `google|${request.targetLang}`
        : `${settings.model}|${request.targetLang}`;
    const keys = await Promise.all(
      request.items.map((item) => sha1(`${cachePrefix}|${item.text}`)),
    );
    const cached = await cacheGetMany(keys);

    const results: { id: number; text: string }[] = [];
    const missing: TranslateItem[] = [];
    const keyById = new Map<number, string>();

    request.items.forEach((item, index) => {
      const key = keys[index];
      if (!key) return;
      const hit = cached.get(key);
      if (hit) results.push({ id: item.id, text: hit });
      else {
        missing.push(item);
        keyById.set(item.id, key);
      }
    });

    if (missing.length > 0) {
      const translated = await translateTexts(
        {
          settings,
          targetLang: request.targetLang,
          sourceLang: request.sourceLang || undefined,
        },
        missing,
      );
      const toStore = new Map<string, string>();
      for (const [id, text] of translated) {
        results.push({ id, text });
        const key = keyById.get(id);
        if (key) toStore.set(key, text);
      }
      if (toStore.size > 0) {
        await cachePutMany(toStore).catch((error) =>
          console.warn('[yt-bilingual] 写缓存失败', error),
        );
      }
    }

    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

async function handleTestConnection(request: TestConnectionRequest): Promise<TestConnectionResult> {
  const started = Date.now();
  try {
    const translated = await translateTexts(
      { settings: request.settings, targetLang: request.targetLang || 'zh-CN', sourceLang: 'en' },
      [{ id: 0, text: request.text.trim() || 'Hello, world! This is a subtitle translation test.' }],
    );
    const text = translated.get(0);
    if (!text) return { ok: false, error: '接口没有返回译文' };
    return { ok: true, text, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

async function handleClearCache(_request: ClearCacheRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    await clearCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
