import { SEGMENT_JOIN_GAP, SEGMENT_MAX_CHARS, SEGMENT_MAX_SECONDS } from '../shared/constants.ts';
import type { Cue, Segment } from '../shared/types.ts';

const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/;

export function cleanText(input: string): string {
  return input
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*>>\s*/, '')
    .replace(/^\s*[-–—]\s+/, '')
    .trim();
}

function isSentenceEnd(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

function newSegment(id: number, cue: Cue, text: string): Segment {
  return {
    id,
    start: cue.start,
    end: cue.end,
    text,
    translation: '',
    state: 'idle',
    attempts: 0,
    nextRetryAt: 0,
  };
}

/**
 * 把碎片化的原始 cue 合并成"句级"单元：
 * 相邻间隔 < 0.8s、未超过 220 字符 / 12 秒、且当前句还没结束时继续拼接。
 * 这对自动字幕（3~5 秒一条的碎片）尤其重要，LLM 拿到整句才能译得通顺。
 */
export function buildSegments(
  cues: Cue[],
  maxChars: number = SEGMENT_MAX_CHARS,
  maxSeconds: number = SEGMENT_MAX_SECONDS,
): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let nextId = 0;

  const flush = (): void => {
    if (current && current.text) segments.push(current);
    current = null;
  };

  for (const cue of cues) {
    const text = cleanText(cue.text);
    if (!text) continue;

    let appended = false;
    if (current) {
      const gap = cue.start - current.end;
      const nextLength = current.text.length + 1 + text.length;
      if (
        gap <= SEGMENT_JOIN_GAP &&
        nextLength <= maxChars &&
        cue.end - current.start <= maxSeconds &&
        !isSentenceEnd(current.text)
      ) {
        current.text = `${current.text} ${text}`;
        current.end = cue.end;
        appended = true;
      }
    }

    if (!appended) {
      flush();
      current = newSegment(nextId, cue, text);
      nextId += 1;
    }

    if (current && isSentenceEnd(current.text)) flush();
  }
  flush();
  return segments;
}

/** 二分查找当前时间对应的字幕段；超过 end 0.2s 视为无字幕。 */
export function findSegmentAt(segments: Segment[], time: number): number {
  if (!segments.length) return -1;
  let low = 0;
  let high = segments.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (!segment) break;
    if (segment.start <= time + 0.05) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return -1;
  const found = segments[candidate];
  if (!found) return -1;
  return time <= found.end + 0.2 ? candidate : -1;
}

/** 按条数 / 字符数从队首切一批。 */
export function takeBatch(pending: Segment[], maxItems: number, maxChars: number): Segment[] {
  const batch: Segment[] = [];
  let chars = 0;
  for (const segment of pending) {
    if (batch.length >= maxItems) break;
    if (batch.length > 0 && chars + segment.text.length > maxChars) break;
    batch.push(segment);
    chars += segment.text.length;
  }
  return batch;
}
