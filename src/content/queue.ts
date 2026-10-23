import { takeBatch } from './segmenter.ts';
import type { Segment, TranslateItem, TranslateResult } from '../shared/types.ts';

export interface TranslatorContext {
  videoId: string;
  targetLang: string;
  sourceLang: string;
}

export interface TranslatorOptions {
  concurrency: number;
  prefetchSeconds: number;
  batchMaxItems: number;
  batchMaxChars: number;
}

export interface TranslatorCallbacks {
  send(items: TranslateItem[], context: TranslatorContext): Promise<TranslateResult>;
  getTime(): number;
  onChange(): void;
  onError(message: string): void;
}

const DEFAULT_OPTIONS: TranslatorOptions = {
  concurrency: 2,
  prefetchSeconds: 60,
  batchMaxItems: 20,
  batchMaxChars: 1200,
};

/**
 * 字幕翻译调度器：
 * - 只翻译 [当前时间 - 5s, 当前时间 + 预取窗口] 内的段落，按时间顺序；
 * - 最多 concurrency 个并发批次；失败按 1.5s/3s/6s 退避，最多 3 次；
 * - 每次 stop/start 递增 generation，旧请求返回后直接丢弃（拖动进度条/切视频时不会串台）。
 */
export class Translator {
  private segments: Segment[] = [];
  private context: TranslatorContext = { videoId: '', targetLang: '', sourceLang: '' };
  private options: TranslatorOptions = { ...DEFAULT_OPTIONS };
  private generation = 0;
  private active = false;
  private running = 0;
  private timer: number | null = null;

  constructor(private readonly callbacks: TranslatorCallbacks) {}

  start(segments: Segment[], context: TranslatorContext, options: TranslatorOptions): void {
    this.stop();
    this.segments = segments;
    this.context = context;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.active = true;
    this.generation += 1;
    this.pump();
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  updateOptions(options: TranslatorOptions): void {
    this.options = { ...this.options, ...options };
  }

  private pump = (): void => {
    this.timer = null;
    if (!this.active) return;

    const now = Date.now();
    const time = this.callbacks.getTime();
    const windowEnd = time + this.options.prefetchSeconds;

    const queue = this.segments
      .filter(
        (segment) =>
          segment.state === 'idle' &&
          segment.nextRetryAt <= now &&
          segment.end >= time - 5 &&
          segment.start <= windowEnd,
      )
      .sort((a, b) => a.start - b.start);

    while (this.running < this.options.concurrency && queue.length > 0) {
      const batch = takeBatch(queue, this.options.batchMaxItems, this.options.batchMaxChars);
      if (batch.length === 0) break;
      queue.splice(0, batch.length);
      for (const segment of batch) segment.state = 'loading';
      void this.run(batch, this.generation);
    }

    this.schedule(500);
  };

  private schedule(delay: number): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(this.pump, delay);
  }

  private async run(batch: Segment[], generation: number): Promise<void> {
    this.running += 1;
    try {
      const result = await this.callbacks.send(
        batch.map((segment) => ({ id: segment.id, text: segment.text })),
        this.context,
      );
      if (generation !== this.generation) return;
      if (result.ok) {
        const translated = new Map(result.results.map((item) => [item.id, item.text]));
        for (const segment of batch) {
          const text = translated.get(segment.id);
          if (text) {
            segment.translation = text;
            segment.state = 'done';
          } else {
            this.retryLater(segment);
          }
        }
      } else {
        for (const segment of batch) this.retryLater(segment);
        this.callbacks.onError(result.error);
      }
    } catch (error) {
      if (generation === this.generation) {
        for (const segment of batch) this.retryLater(segment);
        this.callbacks.onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.running = Math.max(0, this.running - 1);
      if (generation === this.generation) this.callbacks.onChange();
    }
  }

  private retryLater(segment: Segment): void {
    segment.attempts += 1;
    segment.nextRetryAt = Date.now() + Math.min(30000, 1500 * 2 ** segment.attempts);
    segment.state = segment.attempts >= 3 ? 'error' : 'idle';
  }
}
