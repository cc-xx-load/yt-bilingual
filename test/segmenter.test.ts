import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSegments, findSegmentAt, takeBatch } from '../src/content/segmenter.ts';
import type { Cue, Segment } from '../src/shared/types.ts';

function cue(start: number, end: number, text: string): Cue {
  return { start, end, text };
}

function segment(id: number, text: string, start = id): Segment {
  return {
    id,
    start,
    end: start + 1,
    text,
    translation: '',
    state: 'idle',
    attempts: 0,
    nextRetryAt: 0,
  };
}

test('buildSegments：把同句碎片合并成一句', () => {
  const segments = buildSegments([
    cue(0, 1.2, 'I think'),
    cue(1.4, 2.5, 'we should go.'),
    cue(3.5, 4.5, 'Next'),
  ]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.text, 'I think we should go.');
  assert.equal(segments[0]?.start, 0);
  assert.equal(segments[0]?.end, 2.5);
  assert.equal(segments[1]?.text, 'Next');
});

test('buildSegments：句末标点强制断开', () => {
  const segments = buildSegments([
    cue(0, 1, '第一句。'),
    cue(1.1, 2, '第二句。'),
  ]);
  assert.equal(segments.length, 2);
});

test('buildSegments：间隔过大不合并', () => {
  const segments = buildSegments([cue(0, 1, 'hello'), cue(3, 4, 'world')]);
  assert.equal(segments.length, 2);
});

test('buildSegments：超过字符上限自动切段', () => {
  const long = 'a'.repeat(150);
  const segments = buildSegments([cue(0, 1, long), cue(1.1, 2, long)]);
  assert.equal(segments.length, 2);
});

test('buildSegments：清理句首的 >> 与空白', () => {
  const segments = buildSegments([cue(0, 1, '  >>  Hello   world  ')]);
  assert.equal(segments[0]?.text, 'Hello world');
});

test('findSegmentAt：命中、容差与空隙', () => {
  const segments = [segment(0, 'a', 0), segment(1, 'b', 5)];
  segments[0]!.end = 2;
  segments[1]!.end = 7;
  assert.equal(findSegmentAt(segments, 1), 0);
  assert.equal(findSegmentAt(segments, 2.1), 0, '允许 0.2s 容差');
  assert.equal(findSegmentAt(segments, 3.5), -1);
  assert.equal(findSegmentAt(segments, 5), 1);
  assert.equal(findSegmentAt([], 1), -1);
});

test('takeBatch：同时受条数和字符数限制', () => {
  const pending = [segment(0, 'aaaaa'), segment(1, 'bbbbb'), segment(2, 'ccccc')];
  assert.equal(takeBatch(pending, 2, 1000).length, 2);
  assert.equal(takeBatch(pending, 10, 12).length, 2);
  assert.equal(takeBatch(pending, 10, 1000).length, 3);
  assert.equal(takeBatch([], 10, 1000).length, 0);
});
