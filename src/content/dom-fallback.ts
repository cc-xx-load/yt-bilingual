import { NATIVE_CAPTION_SELECTOR } from '../shared/constants.ts';

/**
 * 兜底方案：timedtext 接口被 YouTube 的 POT 校验挡住时，
 * 改为盯住原生字幕 DOM，把当前这句送去翻译，译文显示在原生字幕上方。
 * 原生字幕保持可见（原文由它负责），我们只叠加译文，所以不追求逐句时间轴。
 */
export class DomCaptionFallback {
  private timer: number | null = null;
  private lastText = '';
  private lastSent = '';

  constructor(
    private readonly onCaption: (text: string) => void,
    private readonly isEnabled: () => boolean,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(this.poll, 200);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.lastText = '';
    this.lastSent = '';
  }

  private poll = (): void => {
    if (!this.isEnabled()) return;
    const nodes = document.querySelectorAll(NATIVE_CAPTION_SELECTOR);
    const text = Array.from(nodes)
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text === this.lastText) return;
    this.lastText = text;
    if (!text) {
      this.onCaption('');
      return;
    }
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.onCaption(text);
  };
}
