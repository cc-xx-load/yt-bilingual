import { getSettings, saveSettings } from '../shared/settings.ts';
import type { ContentState } from '../shared/types.ts';

const PHASE_TEXT: Record<ContentState['phase'], string> = {
  idle: '待机（未在视频页）',
  waiting: '等待 YouTube 视频…',
  loading: '正在加载字幕…',
  translating: '正在翻译…',
  ready: '已就绪',
  nosub: '该视频没有字幕',
  unsupported: '当前页面暂不支持',
  fallback: '兜底模式（原生字幕 + 翻译）',
  error: '出错了',
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup 缺少元素 #${id}`);
  return node as T;
}

let tabId: number | null = null;
let refreshTimer: number | null = null;

async function refresh(): Promise<void> {
  const settings = await getSettings();
  const enabledEl = el<HTMLInputElement>('enabled');
  const targetEl = el<HTMLSelectElement>('targetLang');
  if (document.activeElement !== enabledEl) enabledEl.checked = settings.enabled;
  if (document.activeElement !== targetEl) targetEl.value = settings.targetLang;

  let state: ContentState | null = null;
  if (tabId !== null) {
    try {
      state = (await chrome.tabs.sendMessage(tabId, { type: 'ytb/state' })) as ContentState;
    } catch {
      state = null;
    }
  }
  if (!state) {
    renderInactive();
    return;
  }
  renderState(state);
}

function renderInactive(): void {
  el<HTMLSpanElement>('status').textContent = '当前页不是 YouTube 视频页';
  el<HTMLSpanElement>('videoId').textContent = '';
  el<HTMLSpanElement>('progress').textContent = '';
  el<HTMLSpanElement>('hint').textContent = '打开一个 YouTube 视频，字幕会自动出现。';
  el<HTMLSpanElement>('dot').className = 'dot';
}

function renderState(state: ContentState): void {
  el<HTMLSpanElement>('status').textContent = PHASE_TEXT[state.phase] ?? state.phase;
  el<HTMLSpanElement>('videoId').textContent = state.videoId ? `视频 ${state.videoId}` : '';
  el<HTMLSpanElement>('progress').textContent = state.total > 0 ? `${state.done}/${state.total}` : '';

  const dot = el<HTMLSpanElement>('dot');
  if (state.phase === 'ready') dot.className = 'dot ok';
  else if (state.phase === 'error' || state.phase === 'nosub' || state.phase === 'unsupported') {
    dot.className = 'dot err';
  } else if (state.phase === 'idle') dot.className = 'dot';
  else dot.className = 'dot busy';

  let hint = state.detail;
  if (!hint) {
    if (state.phase === 'ready') hint = '拖动词幕可调整位置，Alt + B 可关闭。';
    else if (state.phase === 'nosub') hint = '可以换一个带 CC 字幕的视频试试。';
    else if (state.phase === 'translating') hint = '译文会随播放进度逐批出现。';
    else if (state.phase === 'idle') hint = '打开一个视频，或开启右上角开关。';
  }
  el<HTMLSpanElement>('hint').textContent = hint;
}

async function onToggle(enabled: boolean): Promise<void> {
  await saveSettings({ enabled });
  if (tabId !== null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ytb/enable', enabled });
    } catch {
      // 当前标签页没有内容脚本，忽略。
    }
  }
  await refresh();
}

function init(): void {
  el<HTMLInputElement>('enabled').addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    void onToggle(target.checked);
  });

  el<HTMLSelectElement>('targetLang').addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    void saveSettings({ targetLang: target.value }).then(() => refresh());
  });

  el<HTMLButtonElement>('options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    tabId = tabs[0]?.id ?? null;
    void refresh();
    refreshTimer = window.setInterval(() => void refresh(), 1000);
  });

  window.addEventListener('unload', () => {
    if (refreshTimer !== null) window.clearInterval(refreshTimer);
  });
}

init();
