import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { extractWebResponse } from '../src/ai/web-response.js';
import { ConversationOrchestrator } from '../src/conversation/orchestrator.js';
import { validConfig } from './fixtures.js';

const client = () => new ClaudeClient(validConfig().llm, 'test-key');
const json = (body) => ({ ok: true, json: async () => body });
const usage = { input_tokens: 10, output_tokens: 2, server_tool_use: { web_search_requests: 1 } };
const citation = (url, title = '資料') => ({ type: 'web_search_result_location', url, title });

test('検索候補・実況・thinkingは出さず、最終本文の引用を重複なしで取り出す', () => {
  const result = extractWebResponse([
    { type: 'text', text: '検索します。' },
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'web_search_tool_result', content: [{ url: 'https://unused.example/' }] },
    { type: 'thinking', thinking: '非公開' },
    { type: 'text', text: '確認した事実。', citations: [citation('https://official.example/')] },
    {
      type: 'text',
      text: '\n\n補足。',
      citations: [citation('https://official.example/'), citation('javascript:alert(1)')],
    },
  ]);
  assert.equal(result.content, '確認した事実。[1]\n\n補足。[1]');
  assert.deepEqual(result.sources, [{ url: 'https://official.example/', title: '資料' }]);
});

test('ページ取得の文書引用をURLへ対応させ、HTTP 200内のツール障害も報告する', () => {
  const result = extractWebResponse([
    {
      type: 'web_fetch_tool_result',
      content: {
        type: 'web_fetch_result',
        url: 'https://official.example/guide',
        content: { title: '公式ガイド' },
      },
    },
    {
      type: 'web_search_tool_result',
      content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    },
    { type: 'text', text: '手順。', citations: [{ type: 'char_location', document_index: 0 }] },
  ]);
  assert.equal(result.content, '手順。[1]');
  assert.deepEqual(result.sources, [
    { url: 'https://official.example/guide', title: '公式ガイド' },
  ]);
  assert.deepEqual(result.webErrors, [{ tool: 'web_search_tool_result', code: 'unavailable' }]);
});

test('Claude公式の検索・取得だけを渡し、厳密なJSONとの同時利用を通信前に拒否する', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.output_config.format, undefined);
    assert.deepEqual(
      body.tools.map((tool) => [tool.name, tool.max_uses]),
      [
        ['web_search', 2],
        ['web_fetch', 1],
      ],
    );
    assert.equal(body.tools[1].citations.enabled, true);
    assert.equal(body.tools[1].max_content_tokens, 4000);
    return json({ content: [{ type: 'text', text: '回答' }], usage, stop_reason: 'end_turn' });
  });
  const result = await client().chat({
    messages: [],
    web: { maxSearches: 2, maxFetches: 1, maxContentTokens: 4000 },
  });
  assert.equal(result.usedWeb, true);
  assert.equal(result.webSearchRequests, 1);
  await assert.rejects(client().chat({ messages: [], web: {}, format: {} }), /separate structured/);
  assert.equal(calls, 1);
});

test('pause_turnは署名・暗号化結果をそのまま返し、全リクエストの利用量を加算する', async (t) => {
  const paused = [
    { type: 'thinking', thinking: '秘密', signature: 'signature' },
    { type: 'web_search_tool_result', content: [{ encrypted_content: 'opaque' }] },
  ];
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    count += 1;
    const body = JSON.parse(options.body);
    if (count === 1) return json({ content: paused, usage, stop_reason: 'pause_turn' });
    assert.deepEqual(body.messages.at(-1), { role: 'assistant', content: paused });
    return json({ content: [{ type: 'text', text: '最終回答' }], usage, stop_reason: 'end_turn' });
  });
  const result = await client().chat({ messages: [{ role: 'user', content: '質問' }], web: {} });
  assert.equal(result.content, '最終回答');
  assert.equal(result.promptTokens, 20);
  assert.equal(result.outputTokens, 4);
  assert.equal(result.webSearchRequests, 2);
});

test('無限のpause_turnと途中打ち切りは実況や途中回答を返さず失敗する', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1;
    return json({ content: [{ type: 'text', text: '途中' }], stop_reason: 'pause_turn' });
  });
  await assert.rejects(client().chat({ messages: [], web: {} }), /continuation limit/);
  assert.equal(count, 3);
  t.mock.method(globalThis, 'fetch', async () =>
    json({ content: [{ type: 'text', text: '途中' }], stop_reason: 'max_tokens' }),
  );
  await assert.rejects(client().chat({ messages: [], web: {} }), /incomplete/);
});

function setup(chat) {
  const config = validConfig();
  config.web.enabled = true;
  const warnings = [];
  const orchestrator = new ConversationOrchestrator({
    config,
    model: { chat },
    logger: { warn: (event) => warnings.push(event) },
  });
  const context = {
    mode: 'ambient',
    system: '日本語で回答',
    conversation: 'この会社の営業時間は？',
    recent: [{ messageId: 'm1', content: 'この会社の営業時間は？' }],
  };
  const run = (signal) =>
    orchestrator.respond(context, ['m1'], signal, {
      action: 'respond',
      targetMessageIds: ['m1'],
      solicited: true,
    });
  return { run, warnings };
}

const reply = (content) => ({ content, promptTokens: 1, outputTokens: 1, totalDurationNs: 1 });
test('最新などの固定語がなくてもClaudeへ検索判断を渡し、最終回答で使った引用だけ表示する', async () => {
  const requests = [];
  const { run } = setup(async (request) => {
    requests.push(request);
    if (request.web)
      return {
        ...reply('営業日は平日。[2]'),
        usedWeb: true,
        sources: [
          { title: '別の資料', url: 'https://unused.example/' },
          { title: '公式', url: 'https://official.example/' },
        ],
      };
    return reply(JSON.stringify({ action: 'respond', answer: '平日です。[2][99]' }));
  });
  const result = await run();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].format, undefined);
  assert.ok(requests[1].format);
  assert.equal(result.usedWeb, true);
  assert.equal(result.promptTokens, 2);
  assert.match(result.answer, /\[2\] \[公式\]/u);
  assert.doesNotMatch(result.answer, /unused\.example|\[99\]/u);
});

test('検索失敗を整形処理へ渡し、別の検索基盤へ黙って切り替えない', async () => {
  const { run, warnings } = setup(async (request) => {
    if (request.web) throw new Error('Claude API request failed: HTTP 429');
    assert.match(request.messages[1].content, /情報確認に失敗|推測せず/u);
    return reply(JSON.stringify({ action: 'respond', answer: '確認できませんでした。' }));
  });
  assert.equal((await run()).usedWeb, false);
  assert.equal(warnings[0].event, 'claude_web_failed');
});

test('調査中に中断されたら返答整形を開始しない', async () => {
  const controller = new AbortController();
  let calls = 0;
  const { run } = setup(async () => {
    calls += 1;
    controller.abort();
    throw new Error('aborted');
  });
  await assert.rejects(run(controller.signal), /aborted/);
  assert.equal(calls, 1);
});

test('整形担当が本文に番号を残さなくても、選択した既知の出典だけを表示する', async () => {
  const { run } = setup(async ({ web }) =>
    web
      ? {
          ...reply('平日です。[1]'),
          usedWeb: true,
          sources: [{ title: '公式', url: 'https://official.example/' }],
        }
      : reply(
          JSON.stringify({ action: 'respond', answer: '平日です。', sourceIndices: [1, 99, -1] }),
        ),
  );
  const result = await run();
  assert.match(result.answer, /\[1\] \[公式\]/u);
  assert.doesNotMatch(result.answer, /\[99\]|\[-1\]/u);
});

test('検索対応の診断はHTTP成功だけで正常にせず、Models APIの機能情報を読む', async (t) => {
  for (const supported of [true, false, undefined]) {
    t.mock.method(globalThis, 'fetch', async () =>
      json({ capabilities: { server_tools: { web_search: { supported } } } }),
    );
    assert.deepEqual(await client().webHealth(), {
      ok: supported === true,
      supported: supported ?? null,
    });
  }
});

test('取得回数0の設定ではweb_fetchを提供しない', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.deepEqual(
      JSON.parse(options.body).tools.map((tool) => tool.name),
      ['web_search'],
    );
    return json({ content: [{ type: 'text', text: '検索不要の回答' }], stop_reason: 'end_turn' });
  });
  const result = await client().chat({ messages: [], web: { maxFetches: 0 } });
  assert.equal(result.usedWeb, false);
});
