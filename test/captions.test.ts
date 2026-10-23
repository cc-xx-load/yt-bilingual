import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCues,
  parseCaptions,
  parseJson3,
  parseTimedTextXml,
  parseVtt,
  withFmt,
} from '../src/content/captions.ts';

test('parseJson3：拼接 segs 并把毫秒换算成秒', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '\n' }] },
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'Again' }] },
    ],
  });
  const cues = parseJson3(body);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0, end: 2, text: 'Hello world' });
  assert.deepEqual(cues[1], { start: 3, end: 4, text: 'Again' });
});

test('parseJson3：坏 JSON 返回空数组', () => {
  assert.deepEqual(parseJson3('not json'), []);
});

test('parseTimedTextXml：解析属性并还原实体', () => {
  const body =
    '<transcript><text start="1.5" dur="2.25">Tom &amp; Jerry &lt;3</text><text start="4" dur="1">   </text></transcript>';
  const cues = parseTimedTextXml(body);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0], { start: 1.5, end: 3.75, text: 'Tom & Jerry <3' });
});

test('parseVtt：跳过 NOTE、解析时间轴与多行文本', () => {
  const body = [
    'WEBVTT',
    '',
    'NOTE 这是注释',
    '',
    '00:00:01.000 --> 00:00:03.000 align:start position:10%',
    'Hello',
    'world',
    '',
    '00:00:04.500 --> 00:00:06.000',
    '<i>Second</i>',
    '',
  ].join('\n');
  const cues = parseVtt(body);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 3, text: 'Hello world' });
  assert.equal(cues[1]?.text, 'Second');
});

test('parseCaptions：按内容自动识别格式', () => {
  const json = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] });
  const xml = '<transcript><text start="0" dur="1">hi</text></transcript>';
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n';
  assert.equal(parseCaptions(json)[0]?.text, 'hi');
  assert.equal(parseCaptions(xml)[0]?.text, 'hi');
  assert.equal(parseCaptions(vtt)[0]?.text, 'hi');
});

test('normalizeCues：排序、修零长度、合并重复项', () => {
  const cues = normalizeCues([
    { start: 5, end: 5, text: ' later ' },
    { start: 1, end: 2, text: 'same' },
    { start: 1.1, end: 2.4, text: 'same' },
    { start: 3, end: 4, text: '   ' },
  ]);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 2.4, text: 'same' });
  assert.deepEqual(cues[1], { start: 5, end: 5.4, text: 'later' });
});

test('withFmt：替换已有 fmt 参数', () => {
  const url = withFmt('https://www.youtube.com/api/timedtext?v=abc&fmt=srv3&lang=en', 'json3');
  assert.match(url, /fmt=json3/);
  assert.doesNotMatch(url, /fmt=srv3/);
});
