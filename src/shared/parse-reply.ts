import type { TranslateItem } from './types.ts';

/** 去掉模型偶尔包裹的 ```json 围栏。 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/** 从任意文本里截出第一个完整 JSON 数组（字符串内的括号不算）。 */
export function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function readId(entry: Record<string, unknown>): string | null {
  const raw = entry['id'] ?? entry['ID'] ?? entry['index'];
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

function readText(entry: Record<string, unknown>): string {
  const raw = entry['text'] ?? entry['translation'] ?? entry['target'] ?? entry['zh'];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 把模型回复解析成 id → 译文。
 * 兼容：JSON 数组 / ```json 围栏 / 前后夹带说明文字 / 纯字符串数组 / 逐行文本。
 */
export function parseTranslations(reply: string, items: TranslateItem[]): Map<number, string> {
  const result = new Map<number, string>();
  if (!reply || !items.length) return result;

  const body = stripCodeFence(reply);
  const json = extractJsonArray(body);
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      const byId = new Map<string, number>(items.map((item) => [String(item.id), item.id]));
      let positional = 0;
      for (const entry of parsed) {
        if (typeof entry === 'string') {
          const item = items[positional];
          positional += 1;
          if (item && entry.trim()) result.set(item.id, entry.trim());
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const id = readId(record);
        const text = readText(record);
        if (id === null || !text) continue;
        const mapped = byId.get(id);
        if (mapped !== undefined) result.set(mapped, text);
      }
      if (result.size) return result;

      // 有些弱模型只给 {"text": ...} 不给 id：数量对得上就按位置对齐。
      if (parsed.length === items.length) {
        parsed.forEach((entry, index) => {
          if (!entry || typeof entry !== 'object') return;
          const text = readText(entry as Record<string, unknown>);
          const item = items[index];
          if (text && item) result.set(item.id, text);
        });
        if (result.size) return result;
      }
    }
  }

  // 兜底：模型忽略 JSON 要求、按行返回译文时，按顺序对齐。
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === items.length) {
    items.forEach((item, index) => {
      const line = lines[index];
      if (line) result.set(item.id, line);
    });
  }
  return result;
}
