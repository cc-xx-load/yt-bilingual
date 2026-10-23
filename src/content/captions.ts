import type { Cue } from '../shared/types.ts';

const XML_ENTITIES: Record<string, string> = {
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
    return XML_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ');
}

function clean(input: string): string {
  return decodeEntities(stripTags(input)).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 给 timedtext 地址加/替换 fmt 参数。 */
export function withFmt(rawUrl: string, fmt: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('fmt', fmt);
    return url.toString();
  } catch {
    const separator = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${separator}fmt=${fmt}`;
  }
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

export function parseJson3(body: string): Cue[] {
  let data: { events?: Json3Event[] } | null = null;
  try {
    data = JSON.parse(body) as { events?: Json3Event[] };
  } catch {
    return [];
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  const cues: Cue[] = [];
  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    const text = event.segs
      .map((seg) => (typeof seg?.utf8 === 'string' ? seg.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = Number(event.tStartMs ?? 0) / 1000;
    const duration = Number(event.dDurationMs ?? 0) / 1000;
    cues.push({ start, end: start + (duration > 0 ? duration : 2), text });
  }
  return cues;
}

function readAttr(attrs: string, name: string): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  const value = Number(match?.[1] ?? '');
  return Number.isFinite(value) ? value : 0;
}

export function parseTimedTextXml(body: string): Cue[] {
  const cuePattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  const cues: Cue[] = [];
  let match: RegExpExecArray | null;
  while ((match = cuePattern.exec(body)) !== null) {
    const attrs = match[1] ?? '';
    const text = clean(match[2] ?? '');
    if (!text) continue;
    const start = readAttr(attrs, 'start');
    const duration = readAttr(attrs, 'dur');
    cues.push({ start, end: start + (duration > 0 ? duration : 2), text });
  }
  return cues;
}

function readSeconds(match: RegExpExecArray, offset: number): number {
  const hours = Number(match[offset] ?? 0);
  const minutes = Number(match[offset + 1] ?? 0);
  const seconds = Number(match[offset + 2] ?? 0);
  const millis = Number(match[offset + 3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function parseVtt(body: string): Cue[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const timePattern =
    /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/;
  const cues: Cue[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = timePattern.exec((lines[index] ?? '').trim());
    if (!match) {
      index += 1;
      continue;
    }
    const start = readSeconds(match, 1);
    const end = readSeconds(match, 5);
    index += 1;
    const textLines: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() !== '') {
      const text = clean(lines[index] ?? '');
      if (text) textLines.push(text);
      index += 1;
    }
    const text = textLines.join(' ').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start, end: end > start ? end : start + 2, text });
  }
  return cues;
}

/** 按内容猜测格式并解析。 */
export function parseCaptions(body: string): Cue[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    const cues = parseJson3(trimmed);
    if (cues.length) return cues;
  }
  if (trimmed.includes('<transcript') || trimmed.includes('<text')) {
    const cues = parseTimedTextXml(trimmed);
    if (cues.length) return cues;
  }
  if (trimmed.startsWith('WEBVTT')) return parseVtt(trimmed);
  return parseVtt(trimmed);
}

/** 排序、丢弃空字幕、修正零长度 cue、合并完全重复项。 */
export function normalizeCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
    const text = cue.text.trim();
    if (!text) continue;
    const start = Math.max(0, cue.start);
    const end = Math.max(start + 0.4, cue.end);
    const last = out.length ? out[out.length - 1] : undefined;
    if (last && last.text === text && Math.abs(last.start - start) < 0.25) {
      last.end = Math.max(last.end, end);
      continue;
    }
    out.push({ start, end, text });
  }
  return out;
}

/** 从 YouTube 的 timedtext 地址拉取字幕；json3 为空时退回 vtt。 */
export async function fetchCues(url: string): Promise<Cue[]> {
  const primary = await fetch(withFmt(url, 'json3'), { credentials: 'include' });
  if (primary.ok) {
    const cues = normalizeCues(parseCaptions(await primary.text()));
    if (cues.length) return cues;
  }
  const fallback = await fetch(withFmt(url, 'vtt'), { credentials: 'include' });
  if (!fallback.ok) throw new Error(`字幕请求失败：HTTP ${fallback.status}`);
  return normalizeCues(parseCaptions(await fallback.text()));
}
