import { normalizeBaseURL, getSettings, saveSettings, withV1 } from '../shared/settings.ts';
import type { Settings, TestConnectionResult } from '../shared/types.ts';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`设置页缺少元素 #${id}`);
  return node as T;
}

let settings: Settings;

function fillForm(current: Settings): void {
  el<HTMLSelectElement>('provider').value = current.provider;
  el<HTMLInputElement>('baseURL').value = current.baseURL;
  el<HTMLInputElement>('apiKey').value = current.apiKey;
  el<HTMLInputElement>('model').value = current.model;
  el<HTMLSelectElement>('targetLang').value = current.targetLang;
  el<HTMLInputElement>('batchMaxChars').value = String(current.batchMaxChars);
  el<HTMLInputElement>('prefetchSeconds').value = String(current.prefetchSeconds);
  el<HTMLInputElement>('concurrency').value = String(current.concurrency);
  el<HTMLInputElement>('showOriginal').checked = current.showOriginal;
  el<HTMLInputElement>('hideNativeCaptions').checked = current.hideNativeCaptions;
  el<HTMLInputElement>('fontSize').value = String(current.fontSize);
  el<HTMLInputElement>('bottomPercent').value = String(current.bottomPercent);
  el<HTMLInputElement>('bgOpacity').value = String(current.bgOpacity);
  el<HTMLInputElement>('textColor').value = current.textColor;
  el<HTMLInputElement>('sourceColor').value = current.sourceColor;
}

function numberValue(id: string, fallback: number, min: number, max: number): number {
  const value = Number(el<HTMLInputElement>(id).value);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readForm(): Settings {
  const providerValue = el<HTMLSelectElement>('provider').value;
  return {
    ...settings,
    provider:
      providerValue === 'google' ? 'google' : providerValue === 'mock' ? 'mock' : 'openai',
    baseURL: el<HTMLInputElement>('baseURL').value.trim(),
    apiKey: el<HTMLInputElement>('apiKey').value.trim(),
    model: el<HTMLInputElement>('model').value.trim(),
    targetLang: el<HTMLSelectElement>('targetLang').value,
    batchMaxChars: Math.round(numberValue('batchMaxChars', settings.batchMaxChars, 200, 6000)),
    prefetchSeconds: Math.round(numberValue('prefetchSeconds', settings.prefetchSeconds, 10, 600)),
    concurrency: Math.round(numberValue('concurrency', settings.concurrency, 1, 4)),
    showOriginal: el<HTMLInputElement>('showOriginal').checked,
    hideNativeCaptions: el<HTMLInputElement>('hideNativeCaptions').checked,
    fontSize: Math.round(numberValue('fontSize', settings.fontSize, 12, 60)),
    bottomPercent: Math.round(numberValue('bottomPercent', settings.bottomPercent, 2, 90)),
    bgOpacity: numberValue('bgOpacity', settings.bgOpacity, 0, 1),
    textColor: el<HTMLInputElement>('textColor').value,
    sourceColor: el<HTMLInputElement>('sourceColor').value,
  };
}

function setResult(id: string, text: string): void {
  el<HTMLSpanElement>(id).textContent = text;
}

function validate(draft: Settings): string | null {
  if (draft.provider !== 'openai') return null;
  if (!draft.baseURL) return '请填写 Base URL';
  try {
    new URL(withV1(draft.baseURL));
  } catch {
    return 'Base URL 不是合法地址（需要包含 http:// 或 https://）';
  }
  if (!draft.model) return '请填写模型名称';
  if (!draft.apiKey) return '请填写 API Key（本地模型可留空，但服务端通常会鉴权）';
  return null;
}

/**
 * 扩展默认只有 youtube.com 的权限；用户填了别的 API 域名时，保存会触发一次授权询问。
 * 注意：必须在用户点击的事件里同步调用 request，await 之后会丢失手势导致静默失败。
 */
async function ensureHostPermission(baseURL: string): Promise<void> {
  try {
    const origin = new URL(withV1(baseURL)).origin;
    await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch (error) {
    console.warn('[yt-bilingual] 申请接口域名权限失败', error);
  }
}

async function onSave(): Promise<void> {
  const draft = readForm();
  const problem = validate(draft);
  if (problem) {
    setResult('saveResult', problem);
    return;
  }
  draft.baseURL = normalizeBaseURL(draft.baseURL);
  if (draft.provider === 'openai') await ensureHostPermission(draft.baseURL);
  settings = await saveSettings(draft);
  fillForm(settings);
  syncProviderFields();
  setResult('saveResult', '已保存，已打开的 YouTube 页面会自动生效');
}

async function onTest(): Promise<void> {
  const draft = readForm();
  const problem = validate(draft);
  if (problem) {
    setResult('testResult', problem);
    return;
  }
  draft.baseURL = normalizeBaseURL(draft.baseURL);
  if (draft.provider === 'openai') await ensureHostPermission(draft.baseURL);
  settings = await saveSettings(draft);
  setResult('testResult', '测试中…');
  try {
    const result = (await chrome.runtime.sendMessage({
      type: 'ytb/test-connection',
      settings: {
        provider: draft.provider,
        baseURL: draft.baseURL,
        apiKey: draft.apiKey,
        model: draft.model,
      },
      targetLang: draft.targetLang,
      text: 'Hello, world! This is a subtitle translation test.',
    })) as TestConnectionResult | undefined;
    if (!result) {
      setResult('testResult', '后台无响应，尝试重新加载扩展');
      return;
    }
    if (result.ok) setResult('testResult', `成功（${result.ms}ms）：${result.text}`);
    else setResult('testResult', `失败：${result.error}`);
  } catch (error) {
    setResult('testResult', `失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function onClearCache(): Promise<void> {
  setResult('saveResult', '正在清空缓存…');
  try {
    await chrome.runtime.sendMessage({ type: 'ytb/clear-cache' });
    setResult('saveResult', '翻译缓存已清空');
  } catch (error) {
    setResult('saveResult', `清空失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function syncProviderFields(): void {
  const provider = el<HTMLSelectElement>('provider').value;
  const needsOpenAI = provider === 'openai';
  for (const id of ['baseURL', 'apiKey', 'model']) {
    el<HTMLInputElement>(id).disabled = !needsOpenAI;
  }
  if (provider === 'google') {
    setResult('testResult', 'Google 免费接口：无需配置，可直接保存或点「测试连接」。');
  } else if (provider === 'mock') {
    setResult('testResult', 'Mock 模式不请求网络，译文形如「【简体中文】原文」。');
  } else {
    setResult('testResult', '');
  }
}

async function init(): Promise<void> {
  settings = await getSettings();
  fillForm(settings);
  syncProviderFields();
  el<HTMLButtonElement>('save').addEventListener('click', () => void onSave());
  el<HTMLButtonElement>('test').addEventListener('click', () => void onTest());
  el<HTMLButtonElement>('clearCache').addEventListener('click', () => void onClearCache());
  el<HTMLSelectElement>('provider').addEventListener('change', () => syncProviderFields());
}

void init().catch((error) => {
  console.error('[yt-bilingual] 设置页初始化失败', error);
  setResult('saveResult', '初始化失败，尝试重新加载扩展');
});
