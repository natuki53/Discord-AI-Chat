import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConversationOrchestrator,
  greetingText,
  isLaughterOnly,
  turnStyleInstruction,
} from '../src/conversation/orchestrator.js';
import {
  neutralizeMentions,
  sanitizeDisplayName,
  splitDiscordMessage,
} from '../src/shared/text.js';
import { __testing } from '../src/tools/safe-web-fetch.js';
import { needsFreshInformation, sanitizeSearchQuery } from '../src/tools/web-search.js';

test('Discord mentionを無効化する', () => {
  assert.equal(neutralizeMentions('@everyone <@&123456789012345678>'), '@ everyone [mention]');
});

test('表示名から制御文字とmention記号を除く', () => {
  assert.equal(sanitizeDisplayName(' @test\u0000:name '), 'testname');
});

test('長文を上限内へ分割する', () => {
  const chunks = splitDiscordMessage('あ'.repeat(220), 100);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test('最新情報が必要な表現を検出する', () => {
  assert.equal(needsFreshInformation('今日のニュースを検索して'), true);
  assert.equal(needsFreshInformation('しりとりしよう'), false);
  assert.equal(needsFreshInformation('今日の運勢を占って'), false);
  assert.equal(needsFreshInformation('私をタロットで占ってみて'), false);
  assert.equal(needsFreshInformation('架空の最新ニュースを創作して'), false);
  assert.equal(needsFreshInformation('今日の星座ランキングを検索して'), true);
});

test('占い会話ではsearch providerを呼ばない', async () => {
  let searchCalls = 0;
  const orchestrator = new ConversationOrchestrator({
    config: {
      timezone: 'Asia/Tokyo',
      web: { enabled: true, maxFetchesPerTurn: 2, timeoutMs: 1000, maxBytesPerPage: 65536 },
    },
    logger: { warn() {}, debug() {} },
    searchProvider: {
      async search() {
        searchCalls += 1;
        return [];
      },
    },
    model: {
      async chat() {
        return {
          content: JSON.stringify({ action: 'respond', answer: 'カードを1枚引くね。' }),
          promptTokens: 1,
          outputTokens: 1,
          totalDurationNs: 1,
        };
      },
    },
  });
  const context = {
    mode: 'all',
    currentDate: '2026-08-04',
    system: 'test',
    conversation: 'U1: 今日の運勢を占って',
    recent: [{ messageId: 'm1', content: '今日の運勢を占って' }],
  };
  const result = await orchestrator.respond(context, ['m1']);
  assert.equal(searchCalls, 0);
  assert.equal(result.usedWeb, false);
  assert.doesNotMatch(result.answer, /参照/u);
});

test('検索queryからDiscord IDとemailとtokenを除く', () => {
  const cleaned = sanitizeSearchQuery(
    'user@example.com 123456789012345678 token=secret-value Nodeの最新情報',
  );
  assert.doesNotMatch(cleaned, /example\.com|123456789012345678|secret-value/);
  assert.match(cleaned, /Node/);
});

test('SSRF対象addressを拒否する', () => {
  assert.equal(__testing.isPublicAddress('127.0.0.1'), false);
  assert.equal(__testing.isPublicAddress('192.168.1.20'), false);
  assert.equal(__testing.isPublicAddress('169.254.169.254'), false);
  assert.equal(__testing.isPublicAddress('::1'), false);
  assert.equal(__testing.isPublicAddress('8.8.8.8'), true);
});

test('挨拶と短い笑いを会話用に識別する', () => {
  assert.equal(greetingText('こんにちは！'), 'こんにちは');
  assert.equal(greetingText('ギャンブルしてる人ってどう思う？'), null);
  assert.equal(isLaughterOnly('www'), true);
  assert.equal(isLaughterOnly('www それは違う'), false);
  assert.match(turnStyleInstruction('www'), /20文字程度/);
  assert.match(turnStyleInstruction('今日の運勢を占って'), /会話遊び/);
  assert.match(turnStyleInstruction('ギャンブルしてる人ってどう思う？'), /一般的な意見/);
});
