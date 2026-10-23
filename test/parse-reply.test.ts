import assert from 'node:assert/strict';
import test from 'node:test';

import { extractJsonArray, parseTranslations } from '../src/shared/parse-reply.ts';
import type { TranslateItem } from '../src/shared/types.ts';

const items: TranslateItem[] = [
  { id: 3, text: 'Hello' },
  { id: 7, text: 'World' },
  { id: 9, text: 'Again' },
];

test('extractJsonArray：忽略字符串里的括号', () => {
  const text = 'prefix ["a]b", "c"] suffix';
  assert.equal(extractJsonArray(text), '["a]b", "c"]');
  assert.equal(extractJsonArray('no array here'), null);
});

test('parseTranslations：解析 ```json 围栏', () => {
  const reply = ['```json', '[{"id": 3, "text": "你好"}, {"id": 7, "text": "世界"}]', '```'].join('\n');
  const result = parseTranslations(reply, items);
  assert.equal(result.get(3), '你好');
  assert.equal(result.get(7), '世界');
  assert.equal(result.has(9), false);
});

test('parseTranslations：允许前后夹带说明文字', () => {
  const reply = 'Here is the result:\n[{"id":"7","text":"世界"}]\nDone.';
  const result = parseTranslations(reply, items);
  assert.equal(result.get(7), '世界');
});

test('parseTranslations：纯字符串数组按位置对齐', () => {
  const result = parseTranslations('["一","二","三"]', items);
  assert.equal(result.get(3), '一');
  assert.equal(result.get(7), '二');
  assert.equal(result.get(9), '三');
});

test('parseTranslations：模型没给 JSON 时按行兜底', () => {
  const result = parseTranslations('1. 一\n2. 二\n3. 三', items);
  assert.equal(result.size, 3);
  assert.equal(result.get(9), '三');
});

test('parseTranslations：忽略空译文和未知 id', () => {
  const reply = JSON.stringify([
    { id: 3, text: '   ' },
    { id: 999, text: 'out of range' },
    { id: 7, text: 'ok' },
  ]);
  const result = parseTranslations(reply, items);
  assert.equal(result.size, 1);
  assert.equal(result.get(7), 'ok');
});

test('parseTranslations：对象缺 id 时按位置对齐', () => {
  const reply = JSON.stringify([{ text: '一' }, { text: '二' }, { text: '三' }]);
  const result = parseTranslations(reply, items);
  assert.equal(result.size, 3);
  assert.equal(result.get(7), '二');
});
