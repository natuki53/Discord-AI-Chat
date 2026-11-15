import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationOrchestrator } from '../src/conversation/orchestrator.js';
import {
  hasExplicitBotMention,
  ParticipationPolicy,
} from '../src/conversation/participation-policy.js';

const logger = { warn() {}, debug() {} };
const reply = (value) => ({
  content: JSON.stringify(value),
  promptTokens: 1,
  outputTokens: 1,
  totalDurationNs: 1,
});
const message = (content, fields = {}) => ({
  messageId: 'm1',
  authorId: 'u1',
  authorType: 'human',
  content,
  replyToAuthorType: 'unknown',
  createdAt: new Date().toISOString(),
  ...fields,
});
const context = (messages, fields = {}) => ({
  mode: 'ambient',
  system: 'test',
  conversation: '人工会話',
  recent: messages,
  currentMessages: messages,
  laterMessages: [],
  ...fields,
});

test('GC-01/05: 人間へのreplyは除外し、笑いへの沈黙はClaudeで判断する', async () => {
  const orchestrator = new ConversationOrchestrator({
    config: { web: { enabled: true } },
    logger,
    model: {
      chat() {
        return reply({ action: 'silent', reasonCode: 'no_contribution', targetMessageIds: [] });
      },
    },
    searchProvider: {
      search() {
        assert.fail('search must not run');
      },
    },
  });
  for (const source of [
    message('今日の価格を調べて', { replyToAuthorType: 'human' }),
    message('www'),
  ]) {
    const result = await orchestrator.respond(context([source]), ['m1']);
    assert.equal(result.action, 'silent');
    assert.equal(result.answer, '');
  }
});

test('GC-02/03/11: Bot宛の依頼・replyは自発参加のcooldownを受けない', async () => {
  const policy = new ParticipationPolicy({
    config: {},
    logger,
    model: {
      chat() {
        assert.fail();
      },
    },
  });
  for (const metadata of [{ mentionedBot: true }, { replyToAuthorType: 'bot' }]) {
    const source = message('最新情報を調べて', metadata);
    const result = await policy.decide(
      context([source], { lastBotMessageAt: new Date().toISOString() }),
      ['m1'],
    );
    assert.equal(result.action, 'respond');
    assert.equal(result.solicited, true);
    assert.equal('needsWeb' in result, false);
  }
});

test('GC-06: 呼ばれていなくても自然な冗談で参加でき、日時語だけでは検索しない', async () => {
  const calls = [];
  const orchestrator = new ConversationOrchestrator({
    config: { web: { enabled: true } },
    logger,
    searchProvider: {
      search() {
        assert.fail('unnecessary search');
      },
    },
    model: {
      async chat(request) {
        calls.push(request);
        return request.format?.properties.reasonCode
          ? reply({
              action: 'respond',
              reasonCode: 'natural_contribution',
              targetMessageIds: ['m1'],
              needsWeb: false,
            })
          : reply({ action: 'respond', answer: '太陽も残業しすぎだね。' });
      },
    },
  });
  const result = await orchestrator.respond(context([message('今日の太陽、仕事しすぎ')]), ['m1']);
  assert.equal(result.action, 'respond');
  assert.equal(result.usedWeb, false);
  assert.equal(calls.length, 3);
  assert.match(result.answer, /太陽/);
});

test('GC-10: 自発参加はcooldown中に本文生成へ進まない', async () => {
  const policy = new ParticipationPolicy({
    config: {},
    logger,
    model: {
      chat() {
        return reply({
          action: 'respond',
          reasonCode: 'natural_contribution',
          targetMessageIds: ['m1'],
        });
      },
    },
  });
  const result = await policy.decide(
    context([message('またサーバーが寝てる')], {
      lastBotMessageAt: new Date().toISOString(),
    }),
    ['m1'],
  );
  assert.equal(result.reasonCode, 'cooldown');
});

test('GC-03: 同じ人の暗黙の続きはcooldown中でも文脈から判断する', async () => {
  const source = message('それなら別の方法はある？');
  const policy = new ParticipationPolicy({
    config: {},
    logger,
    model: {
      async chat() {
        return reply({
          action: 'respond',
          reasonCode: 'bot_conversation_continues',
          targetMessageIds: ['m1'],
          needsWeb: false,
        });
      },
    },
  });
  const result = await policy.decide(
    context([message('前の答え', { messageId: 'bot', authorType: 'bot' }), source], {
      lastBotMessageAt: new Date().toISOString(),
      lastBotTargetAuthorIds: ['u1'],
    }),
    ['m1'],
  );
  assert.equal(result.action, 'respond');
  assert.equal(result.solicited, true);
});

test('GC-14: 判定失敗・不正な対象IDでは自発参加を投稿へ変換しない', async () => {
  for (const content of [
    'not JSON',
    JSON.stringify({
      action: 'respond',
      reasonCode: 'natural_contribution',
      targetMessageIds: ['other'],
      needsWeb: false,
    }),
  ]) {
    const policy = new ParticipationPolicy({
      config: {},
      logger,
      model: {
        async chat() {
          return { content };
        },
      },
    });
    assert.equal((await policy.decide(context([message('雑談中')]), ['m1'])).action, 'silent');
  }
});

test('GC-08/17: 一人の依頼取り消しで別の人の直接依頼まで取り消さない', async () => {
  const messages = [
    message('お願い', { mentionedBot: true }),
    message('やっぱりいい', { messageId: 'm2' }),
    message('私の質問に答えて', { messageId: 'm3', authorId: 'u2', mentionedBot: true }),
  ];
  const policy = new ParticipationPolicy({
    config: {},
    logger,
    model: {
      chat() {
        assert.fail();
      },
    },
  });
  const result = await policy.decide(
    context(messages),
    messages.map((item) => item.messageId),
  );
  assert.deepEqual(result.targetMessageIds, ['m3']);
});

test('GC-16/19: 古い発言とmentionモードの通常会話は復旧しても返答しない', async () => {
  const policy = new ParticipationPolicy({
    config: {},
    logger,
    model: {
      chat() {
        assert.fail();
      },
    },
  });
  const old = message('質問', {
    mentionedBot: true,
    createdAt: new Date(Date.now() - 181000).toISOString(),
  });
  assert.equal((await policy.decide(context([old]), ['m1'])).reasonCode, 'expired');
  assert.equal(
    (await policy.decide(context([message('普通の会話')], { mode: 'mention' }), ['m1'])).action,
    'silent',
  );
});

test('引用・コード・everyoneを明示的なBotへの呼びかけと取り違えない', () => {
  const id = '123456789012345678';
  assert.equal(hasExplicitBotMention(`<@${id}> 教えて`, id), true);
  assert.equal(hasExplicitBotMention(`<@!${id}> 教えて`, id), true);
  for (const content of [`> <@${id}>`, `\`<@${id}>\``, `\`\`\`\n<@${id}>\n\`\`\``, '@everyone']) {
    assert.equal(hasExplicitBotMention(content, id), false);
  }
});

test('全返答互換モードでもモデルのsilentを定型相づちへ変換しない', async () => {
  const orchestrator = new ConversationOrchestrator({
    config: { web: { enabled: false } },
    logger,
    model: {
      async chat() {
        return reply({ action: 'silent', answer: '' });
      },
    },
  });
  const result = await orchestrator.respond(context([message('うん')], { mode: 'all' }), ['m1']);
  assert.equal(result.action, 'silent');
  assert.equal(result.answer, '');
});

test('AIへのreplyでも笑いやお礼だけなら、返答を必須にせず文脈で判断する', async () => {
  let decisions = 0;
  const orchestrator = new ConversationOrchestrator({
    config: { web: { enabled: true } },
    logger,
    model: {
      async chat(request) {
        assert.ok(request.format.properties.reasonCode, '本文生成をしない');
        decisions += 1;
        return reply({
          action: 'silent',
          reasonCode: 'no_contribution',
          targetMessageIds: [],
          needsWeb: false,
        });
      },
    },
    searchProvider: {
      search() {
        assert.fail();
      },
    },
  });
  for (const content of ['www', 'ありがとう']) {
    const result = await orchestrator.respond(
      context([message(content, { replyToAuthorType: 'bot' })]),
      ['m1'],
    );
    assert.equal(result.action, 'silent');
  }
  assert.equal(decisions, 2);
});
