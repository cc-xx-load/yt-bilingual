import { DEFAULT_SETTINGS, STORAGE_KEY_SETTINGS } from './constants.ts';
import type { Settings } from './types.ts';

/** 读取设置，缺失字段用默认值补齐（便于后续加字段不迁移）。 */
export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
  const value = stored[STORAGE_KEY_SETTINGS] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(value ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: next });
  return next;
}

/** 去掉 baseURL 末尾的斜杠，避免拼出 //chat/completions。 */
export function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** 判断是否本地推理服务（Ollama 之类通常不需要 API Key）。 */
export function isLocalEndpoint(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** 把 OpenAI 兼容地址规范成 https://host/v1 形式（允许用户只填 https://api.openai.com）。 */
export function withV1(baseURL: string): string {
  const base = normalizeBaseURL(baseURL);
  if (!base) return base;
  if (/\/v\d+(?:beta)?$/i.test(base)) return base;
  return `${base}/v1`;
}
