import assert from 'node:assert/strict';
import test from 'node:test';

import { translateTexts } from '../src/background/provider.ts';

interface Captured {
  url: string;
  q: string[];
  client: string | null;
}

function installFetch(handler: (request: Captured, call: number) => unknown): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const request: Captured = {
      url: url.toString(),
      q: url.searchParams.getAll('q'),
      client: url.searchParams.get('client'),
    };
    captured.push(request);
    const payload = handler(request, captured.length);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return captured;
}

const googleSettings = {
  provider: 'google' as const,
  baseURL: '',
  apiKey: '',
  model: '',
};

test('Google：多句 GET 一次返回，保持顺序', async () => {
  const captured = installFetch(() => [
    ['你好', 'en'],
    ['世界', 'en'],
  ]);

  const result = await translateTexts(
    { settings: googleSettings, targetLang: 'zh-CN', sourceLang: 'en' },
    [
      { id: 0, text: 'Hello' },
      { id: 1, text: 'World' },
    ],
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.client, 'dict-chrome-ex');
  assert.deepEqual(captured[0]?.q, ['Hello', 'World']);
  assert.match(captured[0]?.url ?? '', /sl=en/);
  assert.match(captured[0]?.url ?? '', /tl=zh-CN/);
  assert.equal(result.get(0), '你好');
  assert.equal(result.get(1), '世界');
});

test('Google：多句条数不一致时退回逐句接口', async () => {
  const captured = installFetch((request, call) => {
    if (request.client === 'dict-chrome-ex') return [['只有一条', 'en']];
    // 逐句接口：gtx 单句返回 [[["译文","原文",...]], ...]
    return [[[`单句${call}`, request.q[0], null, null, 3]]];
  });

  const result = await translateTexts(
    { settings: googleSettings, targetLang: 'zh-CN', sourceLang: 'auto' },
    [
      { id: 0, text: 'a' },
      { id: 1, text: 'b' },
    ],
  );

  assert.equal(result.get(0), '单句2');
  assert.equal(result.get(1), '单句3');
  assert.equal(captured.filter((item) => item.client === 'gtx').length, 2);
});

test('Google：还原 HTML 实体', async () => {
  installFetch(() => [['Tom &amp; Jerry &#39;test&#39;', 'en']]);
  const result = await translateTexts(
    { settings: googleSettings, targetLang: 'zh-CN' },
    [{ id: 0, text: 'Tom & Jerry' }],
  );
  assert.equal(result.get(0), "Tom & Jerry 'test'");
});

test('Google：HTTP 400 给出可读错误', async () => {
  globalThis.fetch = (async () =>
    new Response('bad request', { status: 400 })) as typeof fetch;
  await assert.rejects(
    () =>
      translateTexts(
        { settings: googleSettings, targetLang: 'zh-CN' },
        [{ id: 0, text: 'x' }],
      ),
    /HTTP 400/,
  );
});
