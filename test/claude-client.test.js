import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { validConfig } from './fixtures.js';

const apiKey = 'test-api-key';
const makeClient = (overrides = {}) =>
  new ClaudeClient({ ...validConfig().llm, ...overrides }, apiKey);
const jsonResponse = (body) => ({ ok: true, json: async () => body });

test('APIキー未設定と公式以外の接続先を通信前に拒否する', () => {
  assert.throws(() => new ClaudeClient(validConfig().llm, ''), /ANTHROPIC_API_KEY/);
  assert.throws(() => new ClaudeClient(validConfig().llm, '  '), /ANTHROPIC_API_KEY/);
  assert.throws(() => makeClient({ baseUrl: 'https://example.com' }), /baseUrl/);
});

test('Messages APIへsystemを分離し、本文・usage・所要時間を返す', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(options.headers['anthropic-version'], '2026-10-21');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.system, '規則1\n\n規則2');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'こんにちは' }]);
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.deepEqual(body.output_config, { effort: 'medium' });
    for (const key of ['temperature', 'top_p', 'top_k', 'options', 'keep_alive', 'format']) {
      assert.equal(key in body, false, key);
    }
    assert.equal(body.stream, false);
    assert.equal(options.signal.aborted, false);
    return jsonResponse({
      content: [
        { type: 'thinking', thinking: '内部思考' },
        { type: 'text', text: 'こんにちは' },
        { type: 'text', text: '！' },
      ],
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        output_tokens: 5,
      },
    });
  });
  const response = await makeClient().chat({
    messages: [
      { role: 'system', content: '規則1' },
      { role: 'system', content: '規則2' },
      { role: 'user', content: 'こんにちは' },
    ],
  });
  assert.equal(response.content, 'こんにちは！');
  assert.equal(response.promptTokens, 19);
  assert.equal(response.outputTokens, 5);
  assert.ok(response.totalDurationNs > 0);
  assert.deepEqual(response.toolCalls, []);
  assert.equal(JSON.stringify(makeClient()).includes(apiKey), false);
});

test('会話・話題判定・プロフィール・要約用schemaの未対応制約を再帰的に説明へ移す', async (t) => {
  const format = {
    type: 'object',
    required: ['answer', 'confidence', 'facts', 'maxLength'],
    properties: {
      answer: { type: 'string', maxLength: 800 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      facts: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', maxLength: 120 } },
      maxLength: { type: 'object', properties: { value: { type: 'string' } } },
    },
  };
  const original = JSON.parse(JSON.stringify(format));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal('system' in body, false);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.effort, 'medium');
    const schema = body.output_config.format.schema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, format.required);
    assert.equal(schema.properties.answer.maxLength, undefined);
    assert.match(schema.properties.answer.description, /maxLength: 800/);
    assert.equal(schema.properties.confidence.minimum, undefined);
    assert.equal(schema.properties.confidence.maximum, undefined);
    assert.match(schema.properties.confidence.description, /minimum: 0, maximum: 1/);
    assert.equal(schema.properties.facts.maxItems, undefined);
    assert.equal(schema.properties.facts.minItems, undefined);
    assert.match(schema.properties.facts.description, /maxItems: 6, minItems: 2/);
    assert.match(schema.properties.facts.items.description, /maxLength: 120/);
    assert.equal(schema.properties.maxLength.additionalProperties, false);
    return jsonResponse({ content: [{ type: 'text', text: '{"answer":"こんにちは"}' }] });
  });
  const result = await makeClient().chat({
    messages: [{ role: 'user', content: 'テスト' }],
    format,
  });
  assert.equal(JSON.parse(result.content).answer, 'こんにちは');
  assert.deepEqual(format, original);
  assert.equal(result.promptTokens, 0);
  assert.equal(result.outputTokens, 0);
});

test('Haiku/Sonnetの全effortを次のリクエストへ反映する', async (t) => {
  let expected;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, expected.model);
    assert.equal(body.output_config.effort, expected.effort);
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    return jsonResponse({ content: [{ type: 'text', text: 'OK' }] });
  });
  const client = makeClient();
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expected = { model, effort };
      client.configure(expected);
      await client.chat({ messages: [{ role: 'user', content: 'テスト' }] });
    }
  }
});

test('画像用の生成上限を通常の会話へ持ち越さない', async (t) => {
  const limits = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    limits.push(JSON.parse(options.body).max_tokens);
    return jsonResponse({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
  });
  const client = makeClient();
  const first = await client.chat({
    messages: [],
    maxOutputTokens: 8192,
    timeoutMs: 180000,
    thinking: { type: 'between_tools' },
  });
  await client.chat({ messages: [] });
  assert.deepEqual(limits, [8192, 1024]);
  assert.equal(first.stopReason, 'end_turn');
});

test('モデルの稼働確認は生成を行わずModels APIを使う', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/models/claude-sonnet-5-5');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return jsonResponse({ id: 'claude-sonnet-5-5' });
  });
  assert.deepEqual(await makeClient().health(), { ok: true, models: ['claude-sonnet-5-5'] });
});

test('API障害はHTTP statusを維持しエラー本文を公開しない', async (t) => {
  for (const status of [401, 404, 429, 500, 529]) {
    let canceled = false;
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status,
      body: {
        cancel: async () => {
          canceled = true;
        },
      },
      text: async () => `秘密の会話 ${apiKey}`,
    }));
    await assert.rejects(
      makeClient().chat({ messages: [{ role: 'user', content: '会話' }] }),
      (error) => {
        assert.equal(error.status, status);
        assert.equal(error.message, `Claude API request failed: HTTP ${status}`);
        return true;
      },
    );
    assert.equal(canceled, true);
  }
});

test('呼び出し元の中断とtimeoutをfetchへ伝える', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    await delay(100, undefined, { signal });
    return jsonResponse({});
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(makeClient().chat({ messages: [], signal: controller.signal }), {
    name: 'AbortError',
  });
  await assert.rejects(makeClient({ timeoutMs: 5 }).chat({ messages: [] }), { name: 'AbortError' });
});
