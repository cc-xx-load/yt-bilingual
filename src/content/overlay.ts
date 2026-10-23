import { HIDE_NATIVE_CLASS, PLAYER_SELECTOR } from '../shared/constants.ts';
import type { Settings } from '../shared/types.ts';

export interface OverlayCallbacks {
  onPositionChange(percent: number): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/**
 * YouTube 播放器上的双语字幕浮层。
 * 挂在 .html5-video-player 内部，全屏时会随播放器一起放大。
 */
export class Overlay {
  private readonly root: HTMLDivElement;
  private readonly windowEl: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private readonly sourceEl: HTMLDivElement;
  private readonly targetEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;

  private host: HTMLElement | null = null;
  private bottomPercent = 8;
  private bottomPx: number | null = null;
  private fallback = false;
  private dragging = false;
  private dragStartY = 0;
  private dragStartBottom = 8;
  private statusTimer: number | null = null;

  private lastSource = '';
  private lastTarget = '';
  private lastLoading = false;

  constructor(private readonly callbacks: OverlayCallbacks) {
    this.root = element('div', 'ytb-root');
    this.root.setAttribute('data-ytb-root', '');

    this.windowEl = element('div', 'ytb-caption-window');
    this.box = element('div', 'ytb-caption-box');
    this.sourceEl = element('div', 'ytb-source');
    this.targetEl = element('div', 'ytb-target');
    this.box.append(this.sourceEl, this.targetEl);
    this.windowEl.append(this.box);

    this.statusEl = element('div', 'ytb-status');
    this.statusEl.style.display = 'none';

    this.root.append(this.windowEl, this.statusEl);
    this.windowEl.style.display = 'none';
    this.windowEl.addEventListener('pointerdown', this.onPointerDown);
    this.windowEl.addEventListener('pointermove', this.onPointerMove);
    this.windowEl.addEventListener('pointerup', this.onPointerUp);
    this.windowEl.addEventListener('pointercancel', this.onPointerUp);
  }

  /** 找到播放器并挂载；播放器还没出现时返回 false。 */
  mount(): boolean {
    const player = document.querySelector<HTMLElement>(PLAYER_SELECTOR);
    if (!player) return false;
    if (this.host !== player || !this.root.isConnected) {
      this.host = player;
      player.append(this.root);
    }
    return true;
  }

  isMounted(): boolean {
    return this.root.isConnected;
  }

  applySettings(settings: Settings): void {
    this.root.style.setProperty('--ytb-font-size', `${settings.fontSize}px`);
    this.root.style.setProperty('--ytb-color', settings.textColor);
    this.root.style.setProperty('--ytb-src-color', settings.sourceColor);
    this.root.style.setProperty('--ytb-bg', String(settings.bgOpacity));
    this.sourceEl.style.display = settings.showOriginal ? '' : 'none';
    this.bottomPercent = settings.bottomPercent;
    this.applyBottom();
  }

  setHideNative(hide: boolean): void {
    document.documentElement.classList.toggle(HIDE_NATIVE_CLASS, hide);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  setFallbackMode(on: boolean): void {
    this.fallback = on;
    this.root.classList.toggle('ytb-fallback', on);
    this.windowEl.style.cursor = on ? 'default' : 'move';
    this.applyBottom();
  }

  /** 兜底模式：贴在原生字幕上方，用像素定位。 */
  setBottomPx(px: number | null): void {
    this.bottomPx = px;
    this.applyBottom();
  }

  render(source: string, target: string, loading: boolean): void {
    if (this.lastSource !== source) {
      this.sourceEl.textContent = source;
      this.lastSource = source;
    }
    const display = target || (loading ? '…' : '');
    if (this.lastTarget !== display) {
      this.targetEl.textContent = display;
      this.lastTarget = display;
    }
    if (this.lastLoading !== loading) {
      this.box.classList.toggle('ytb-loading', loading);
      this.lastLoading = loading;
    }
    this.windowEl.style.display = source || display ? '' : 'none';
  }

  clearCue(): void {
    this.render('', '', false);
  }

  setStatus(text: string, kind: 'info' | 'error' = 'info', autoHideMs = 4000): void {
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('ytb-status--error', kind === 'error');
    this.statusEl.style.display = text ? '' : 'none';
    if (text && autoHideMs > 0) {
      this.statusTimer = window.setTimeout(() => {
        this.statusEl.style.display = 'none';
        this.statusTimer = null;
      }, autoHideMs);
    }
  }

  destroy(): void {
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
    this.setHideNative(false);
    this.root.remove();
    this.host = null;
  }

  private applyBottom(): void {
    if (this.fallback && this.bottomPx !== null) {
      this.windowEl.style.bottom = `${Math.round(this.bottomPx)}px`;
      return;
    }
    this.windowEl.style.bottom = `${this.bottomPercent}%`;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.fallback || event.button !== 0) return;
    this.dragging = true;
    this.dragStartY = event.clientY;
    this.dragStartBottom = this.bottomPercent;
    this.windowEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const player = this.host;
    if (!player) return;
    const height = player.getBoundingClientRect().height || 1;
    const delta = ((this.dragStartY - event.clientY) / height) * 100;
    this.bottomPercent = Math.min(90, Math.max(2, this.dragStartBottom + delta));
    this.applyBottom();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.windowEl.hasPointerCapture(event.pointerId)) {
      this.windowEl.releasePointerCapture(event.pointerId);
    }
    this.callbacks.onPositionChange(Math.round(this.bottomPercent));
  };
}
