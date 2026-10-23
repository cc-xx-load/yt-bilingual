import assert from 'node:assert/strict';
import test from 'node:test';

import { describeError, translateTexts } from '../src/background/provider.ts';
import { isLocalEndpoint, normalizeBaseURL, withV1 } from '../src/shared/settings.ts';

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: { role: string; content: string }[];
  };
}

function installFetch(handler: (request: CapturedRequest, call: number) => unknown): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body'],
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

function completion(content: string) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

test('translateTexts：拼接 URL、带鉴权、按 JSON 解析', async () => {
  const captured = installFetch(() =>
    completion(JSON.stringify([{ id: 0, text: '你好' }, { id: 1, text: '世界' }])),
  );

  const result = await translateTexts(
    {
      settings: {
        provider: 'openai',
        baseURL: 'https://example.com/v1/',
        apiKey: 'test-key',
        model: 'test-model',
      },
      targetLang: 'zh-CN',
      sourceLang: 'en',
    },
    [
      { id: 0, text: 'Hello' },
      { id: 1, text: 'World' },
    ],
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.url, 'https://example.com/v1/chat/completions');
  assert.equal(captured[0]?.headers['Authorization'], 'Bearer test-key');
  assert.equal(captured[0]?.body.model, 'test-model');
  assert.match(captured[0]?.body.messages[0]?.content ?? '', /简体中文/);
  assert.deepEqual(JSON.parse(captured[0]?.body.messages[1]?.content ?? '[]'), [
    { id: 0, text: 'Hello' },
    { id: 1, text: 'World' },
  ]);
  assert.equal(result.get(0), '你好');
  assert.equal(result.get(1), '世界');
});

test('translateTexts：漏条时单独补一次', async () => {
  installFetch((request) => {
    const items = JSON.parse(request.body.messages[1]?.content ?? '[]') as { id: number }[];
    if (items.length === 2) return completion(JSON.stringify([{ id: 0, text: '一' }]));
    return completion(JSON.stringify([{ id: 1, text: '二' }]));
  });

  const result = await translateTexts(
    {
      settings: { provider: 'openai', baseURL: 'https://example.com/v1', apiKey: 'k', model: 'm' },
      targetLang: 'zh-CN',
    },
    [
      { id: 0, text: 'a' },
      { id: 1, text: 'b' },
    ],
  );
  assert.equal(result.get(0), '一');
  assert.equal(result.get(1), '二');
});

test('translateTexts：mock 模式不发网络请求', async () => {
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    throw new Error('should not be called');
  }) as typeof fetch;

  const result = await translateTexts(
    {
      settings: { provider: 'mock', baseURL: '', apiKey: '', model: '' },
      targetLang: 'zh-CN',
    },
    [{ id: 5, text: 'Hello' }],
  );
  assert.equal(called, 0);
  assert.equal(result.get(5), '【简体中文】Hello');
});

test('translateTexts：没 Key 且不是本地服务时给出明确错误', async () => {
  await assert.rejects(
    () =>
      translateTexts(
        {
          settings: { provider: 'openai', baseURL: 'https://api.example.com/v1', apiKey: '', model: 'm' },
          targetLang: 'zh-CN',
        },
        [{ id: 0, text: 'a' }],
      ),
    /未配置 API Key/,
  );
});

test('describeError：HTTP 429 给出限流提示', () => {
  const error = new Error('HTTP 429：请求太频繁，已被限流');
  assert.match(describeError(error), /429/);
});

test('URL 工具：withV1 / normalizeBaseURL / isLocalEndpoint', () => {
  assert.equal(withV1('https://api.openai.com'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://gw.example.com/v1beta'), 'https://gw.example.com/v1beta');
  assert.equal(normalizeBaseURL('  https://x.dev/v1///  '), 'https://x.dev/v1');
  assert.equal(isLocalEndpoint('http://localhost:11434/v1'), true);
  assert.equal(isLocalEndpoint('http://127.0.0.1:8080'), true);
  assert.equal(isLocalEndpoint('https://api.openai.com/v1'), false);
});
