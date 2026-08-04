import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextBuilder, shouldUseProfileContext } from '../src/conversation/context-builder.js';
import { normalizeProfileLinks, ProfileService } from '../src/profile/profile-service.js';
import { validConfig } from './fixtures.js';

const logger = { debug() {} };

test('profile linkはHTTPSだけを受理して重複を除く', () => {
  assert.deepEqual(
    normalizeProfileLinks(['https://example.com/me#about', 'https://example.com/me']),
    ['https://example.com/me'],
  );
  assert.throws(() => normalizeProfileLinks(['http://example.com/me']), /HTTPS URL/);
});

test('本人指定ページから明記された活動だけを要約する', async () => {
  const calls = [];
  const service = new ProfileService({
    config: validConfig(),
    logger,
    fetchPage: async (url) => ({
      url,
      title: '作者プロフィール',
      text: 'VRChat向けツールをJavaScriptで開発しています。',
      fetchedAt: new Date().toISOString(),
    }),
    model: {
      async chat(input) {
        calls.push(input);
        return {
          content: JSON.stringify({ facts: ['VRChat向けツールを開発している'] }),
        };
      },
    },
  });

  const result = await service.prepare({
    selfDescription: '個人開発をしています',
    links: ['https://example.com/me'],
  });
  assert.equal(result.sourceSummary, 'VRChat向けツールを開発している');
  assert.deepEqual(result.links, ['https://example.com/me']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /性格/);
  assert.match(calls[0].messages[0].content, /推測/);
});

test('ContextBuilderは今回の発言者の本人登録profileだけを渡す', () => {
  const config = validConfig();
  const database = {
    getChannel: () => ({ activeSessionId: 'session-1', mode: 'all', version: 1 }),
    getSession: () => ({ sessionId: 'session-1', summary: null }),
    getRecentMessages: () => [
      {
        messageId: 'm1',
        authorId: 'u1',
        authorName: 'User1',
        authorType: 'human',
        content: '私ってどんな人だと思う？',
        replyToMessageId: null,
        createdAt: '2026-08-04T09:00:00.000Z',
      },
      {
        messageId: 'm2',
        authorId: 'u2',
        authorName: 'User2',
        authorType: 'human',
        content: '私もいるよ',
        replyToMessageId: null,
        createdAt: '2026-08-04T09:00:01.000Z',
      },
    ],
    getPreferences: () => new Map(),
    getProfiles: (_guildId, userIds) => {
      assert.deepEqual(userIds, ['u1']);
      return new Map([
        [
          'u1',
          {
            selfDescription: 'VRChatで遊んでいます',
            sourceSummary: 'VRChat向けツールを開発している',
          },
        ],
      ]);
    },
  };
  const context = new ContextBuilder({ database, config }).build({
    guildId: config.discord.guildId,
    channelId: config.discord.channels[0].id,
    sourceMessageIds: ['m1'],
  });
  assert.match(context.conversation, /VRChat向けツールを開発している/);
  assert.match(context.system, /人物評価や性格判断へ変換しない/);
  assert.match(context.system, /古い話題へ突然戻らない/);
  assert.match(context.system, /毎回答で名前を呼ばない/);
  assert.doesNotMatch(context.conversation, /私もいるよ/);
});

test('本人情報と無関係な質問ではprofileを参照しない', () => {
  assert.equal(shouldUseProfileContext('私ってどんな人だと思う？'), true);
  assert.equal(shouldUseProfileContext('私向けのゲームをおすすめして'), true);
  assert.equal(shouldUseProfileContext('ギャンブルしてる人ってどう思う？'), false);
  assert.equal(shouldUseProfileContext('www'), false);
});
