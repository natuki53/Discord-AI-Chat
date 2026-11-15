import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextBuilder } from '../src/conversation/context-builder.js';
import { turnStyleInstruction } from '../src/conversation/orchestrator.js';
import { SessionService } from '../src/conversation/session-service.js';
import { speakerLabel, SPEAKER_LABEL_VERSION } from '../src/conversation/speaker-labels.js';
import { DatabaseStore } from '../src/storage/database.js';
import { messageTextForContext } from '../src/discord/bot.js';
import { ParticipationPolicy } from '../src/conversation/participation-policy.js';
import { validConfig } from './fixtures.js';

test('添付だけの発言も未解析と明示し、削除された添付や空本文を古い内容で残さない', () => {
  assert.equal(
    messageTextForContext({ content: '', attachments: new Map([['image', {}]]) }),
    '[添付ファイル1件: 画像やファイルの内容は未解析]',
  );
  assert.equal(
    messageTextForContext({ content: '  これ見て  ', attachments: new Map([['image', {}]]) }),
    'これ見て\n[添付ファイル1件: 画像やファイルの内容は未解析]',
  );
  assert.equal(messageTextForContext({ content: '', attachments: new Map() }), '');
  assert.ok(
    messageTextForContext({ content: '長'.repeat(9000), attachments: new Map([['image', {}]]) })
      .length <= 8000,
  );
});

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-context-'));
  const config = validConfig();
  const database = new DatabaseStore(path.join(directory, 'test.sqlite3'), config);
  database.initializeChannels();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const guildId = config.discord.guildId;
  const channelId = config.discord.channels[0].id;
  const base = Date.now() - 60_000;
  const session = (id, offset = 0) =>
    database.createSession({
      sessionId: id,
      guildId,
      channelId,
      now: new Date(base + offset),
      retentionHours: 24,
    });
  let sequence = 0;
  const message = (sessionId, content, fields = {}) => {
    sequence += 1;
    const value = {
      guildId,
      channelId,
      sessionId,
      messageId: `m${sequence}`,
      authorId: 'user-a',
      authorName: '参加者A',
      authorType: 'human',
      content,
      replyToMessageId: null,
      createdAt: new Date(base + sequence * 1000).toISOString(),
      ...fields,
    };
    database.ingestMessage(value, 24);
    return value;
  };
  const build = (source) =>
    new ContextBuilder({ database, config }).build({
      guildId,
      channelId,
      sourceMessageIds: [source.messageId],
    });
  const seedPrevious = () => {
    session('previous');
    const first = message('previous', 'お前だれや', {
      authorId: 'user-b',
      authorName: '転職準備中',
    });
    message('previous', 'このチャンネルのAIです。', {
      authorId: 'bot',
      authorType: 'bot',
      authorName: 'AI',
    });
    message('previous', 'かわいいやつめ', { authorId: 'user-b', authorName: '転職準備中' });
    session('current', 4000);
    return first;
  };
  return { database, config, guildId, channelId, session, message, build, seedPrevious };
}

test('表示名への言及で別sessionの同じ参加者との会話を参照する', (t) => {
  const h = harness(t);
  h.seedPrevious();
  const context = h.build(h.message('current', 'この転職準備中って人どう思う？'));
  assert.match(context.conversation, /お前だれや/);
  assert.match(context.conversation, /かわいいやつめ/);
  assert.match(context.conversation, /EARLIER/);
  assert.ok(context.participantNames.includes('転職準備中'));
  assert.doesNotMatch(
    turnStyleInstruction('この転職準備中って人どう思う？', context.participantNames),
    /今回は一般的な意見/,
  );
  assert.match(context.system, /「君へのあたり」はAIへの言動/);
});

test('次の指示語だけの発言でも、直前に言及した相手を見失わない', (t) => {
  const h = harness(t);
  h.seedPrevious();
  h.message('current', 'この転職準備中って人うざくない？');
  const context = h.build(h.message('current', '今までの君へのあたり的にね'));
  assert.match(context.conversation, /お前だれや/);
  assert.match(context.conversation, /転職準備中/);
  assert.equal(context.currentMessages.length, 1);
  assert.equal(context.currentMessages[0].content, '今までの君へのあたり的にね');
});

test('参加判断へも表示名と要約に対応する話者ラベルを渡す', async (t) => {
  const h = harness(t);
  h.seedPrevious();
  const source = h.message('current', 'この転職準備中って人どう思う？', {
    createdAt: new Date().toISOString(),
  });
  const context = h.build(source);
  context.mode = 'ambient';
  const policy = new ParticipationPolicy({
    config: h.config,
    logger: { warn() {} },
    model: {
      async chat(input) {
        const data = JSON.parse(input.messages[1].content);
        const participant = data.RECENT.find((message) => message.authorName === '転職準備中');
        assert.ok(participant);
        assert.equal(
          participant.speaker,
          speakerLabel('current', { authorId: 'user-b', authorType: 'human' }),
        );
        return {
          content: JSON.stringify({
            action: 'respond',
            reasonCode: 'natural_contribution',
            targetMessageIds: [source.messageId],
            needsWeb: false,
          }),
        };
      },
    },
  });
  assert.equal((await policy.decide(context, [source.messageId])).action, 'respond');
});

test('以前の会話と直近の会話が多くても、追加する履歴を文脈予算に収める', (t) => {
  const h = harness(t);
  h.seedPrevious();
  for (let index = 0; index < 40; index += 1)
    h.message('current', `別の話${index} ${'雑談が続いている。'.repeat(30)}`);
  const source = h.message('current', 'さっきの転職準備中の言い方について');
  const context = h.build(source);
  assert.match(context.conversation, /さっきの転職準備中の言い方について/);
  assert.match(context.conversation, /お前だれや/);
  assert.ok(context.estimatedTokens <= h.config.llm.contextTokens);
});

test('無関係な新しい質問に別sessionの会話を混ぜない', (t) => {
  const h = harness(t);
  h.seedPrevious();
  const context = h.build(h.message('current', '夕食の献立を考えて'));
  assert.doesNotMatch(context.conversation, /お前だれや|転職準備中|かわいいやつめ/);
});

test('過去snapshotの参照先を、対象より後の発言から選ばない', (t) => {
  const h = harness(t);
  h.seedPrevious();
  const source = h.message('current', '夕食の献立を考えて');
  h.message('current', '転職準備中の話をしよう');
  assert.doesNotMatch(h.build(source).conversation, /転職準備中|お前だれや/);
});

for (const change of ['delete', 'forget', 'expiry', 'reset']) {
  test(`以前の会話の${change}を参照とreplyから復活させない`, (t) => {
    const h = harness(t);
    const first = h.seedPrevious();
    if (change === 'delete') h.database.deleteMessage(first);
    if (change === 'forget') h.database.forgetUser(h.guildId, 'user-b');
    if (change === 'expiry')
      h.database.db
        .prepare('UPDATE messages SET expires_at = ? WHERE session_id = ?')
        .run('2000-01-01T00:00:00Z', 'previous');
    if (change === 'reset') {
      h.database.resetSession(h.guildId, h.channelId);
      h.session('after-reset', 5000);
    }
    const sessionId = change === 'reset' ? 'after-reset' : 'current';
    const context = h.build(
      h.message(sessionId, 'さっきの転職準備中の発言について', {
        replyToMessageId: first.messageId,
      }),
    );
    assert.doesNotMatch(context.conversation, /お前だれや/);
    if (change === 'expiry' || change === 'reset')
      assert.doesNotMatch(context.conversation, /かわいいやつめ/);
  });
}

test('他チャンネルの同名参加者の会話は参照しない', (t) => {
  const h = harness(t);
  h.seedPrevious();
  h.config.discord.channels.push({ ...h.config.discord.channels[0], id: '123456789012345680' });
  h.database.initializeChannels();
  const otherChannel = h.config.discord.channels[1].id;
  h.database.createSession({
    sessionId: 'other',
    guildId: h.guildId,
    channelId: otherChannel,
    now: new Date(),
    retentionHours: 24,
  });
  h.message('other', '他チャンネル限定の発言', {
    channelId: otherChannel,
    authorName: '転職準備中',
  });
  assert.doesNotMatch(
    h.build(h.message('current', '転職準備中の話を覚えてる？')).conversation,
    /他チャンネル限定/,
  );
});

test('AIへのreplyから、履歴窓外にある元の質問もたどる', (t) => {
  const h = harness(t);
  h.config.conversation.recentMessageLimit = 2;
  h.session('current');
  const original = h.message('current', '青い案と赤い案を比較して');
  const answer = h.message('current', '青い案がよさそう。', {
    authorId: 'bot',
    authorType: 'bot',
    replyToMessageId: original.messageId,
  });
  h.message('current', '別の会話');
  const source = h.message('current', 'なんでそっち？', { replyToMessageId: answer.messageId });
  assert.match(h.build(source).conversation, /青い案と赤い案を比較して/);
});

test('明示replyは以前の会話の通常参照窓より古くても保持期間内なら取得する', (t) => {
  const h = harness(t);
  h.seedPrevious();
  for (let index = 0; index < 205; index += 1) h.message('previous', `途中の会話${index}`);
  const source = h.message('current', 'この発言はどういう意味？', { replyToMessageId: 'm1' });
  assert.match(h.build(source).conversation, /お前だれや/);
});

test('要約と回答で話者ラベルを共有し、履歴窓やAI発言で番号を振り直さない', async (t) => {
  const h = harness(t);
  h.config.conversation.recentMessageLimit = 2;
  h.config.conversation.summaryEveryMessages = 1;
  h.session('current');
  h.message('current', '私は青を選ぶ');
  const b = h.message('current', '私は赤を選ぶ', { authorId: 'user-b', authorName: '参加者B' });
  const label = speakerLabel('current', b);
  assert.match(h.build(b).conversation, new RegExp(`\\[${label}:参加者B\\]`));
  h.message('current', '了解', { authorId: 'bot', authorType: 'bot' });
  const source = h.message('current', '赤のままで', { authorId: 'user-b', authorName: '参加者B' });
  const service = new SessionService({
    database: h.database,
    config: h.config,
    logger: { warn() {} },
    model: {
      async chat(input) {
        assert.match(
          JSON.parse(input.messages[1].content).conversation,
          new RegExp(`${label}: 赤のままで`),
        );
        return {
          content: JSON.stringify({
            topic: '色の選択',
            factsEstablished: [`${label}は赤を選ぶ`],
            openQuestions: [],
            runningJokes: [],
            currentTone: '相談',
          }),
        };
      },
    },
  });
  await service.maybeRefreshSummary('current');
  assert.match(h.build(source).conversation, new RegExp(`\\[${label}:参加者B\\]`));
  assert.match(h.build(source).conversation, new RegExp(`${label}は赤を選ぶ`));
  assert.notEqual(speakerLabel('other-session', b), label);
});

test('話者対応が不明な旧要約を利用せず、件数未満でも再作成する', async (t) => {
  const h = harness(t);
  h.session('current');
  const source = h.message('current', '続きです');
  h.database.saveSessionSummary(
    'current',
    { topic: '旧要約', factsEstablished: ['U1が青を選んだ'] },
    1,
    new Date(),
    24,
  );
  assert.doesNotMatch(h.build(source).conversation, /U1が青を選んだ/);
  const service = new SessionService({
    database: h.database,
    config: h.config,
    logger: { warn() {} },
    model: {
      async chat(input) {
        assert.equal(JSON.parse(input.messages[1].content).previousSummary, null);
        return {
          content: JSON.stringify({
            topic: '再作成',
            factsEstablished: [],
            openQuestions: [],
            runningJokes: [],
            currentTone: '雑談',
          }),
        };
      },
    },
  });
  await service.maybeRefreshSummary('current');
  assert.equal(h.database.getSession('current').summary.speakerLabelVersion, SPEAKER_LABEL_VERSION);
});

for (const continuation of [{ content: 'さっきの続きだけど' }, { replyToMessageId: 'reference' }]) {
  test(`15分空いても保持期間内の明示的な続きは同じsessionを使う: ${JSON.stringify(continuation)}`, (t) => {
    const h = harness(t);
    h.session('current');
    h.message('current', '元の質問', { messageId: 'reference' });
    const old = new Date(Date.now() - 30 * 60_000);
    h.database.touchSession('current', old, 24);
    const service = new SessionService({ database: h.database, config: h.config });
    const current = service.ensureSession(
      h.guildId,
      h.channelId,
      h.config.discord.channels[0],
      new Date(),
      continuation,
    );
    assert.equal(current.sessionId, 'current');
  });
}

test('保持期限を過ぎたsessionは続きの表現でも再開しない', (t) => {
  const h = harness(t);
  h.session('current');
  h.database.touchSession('current', new Date(Date.now() - 25 * 3600_000), 24);
  const service = new SessionService({ database: h.database, config: h.config });
  assert.notEqual(
    service.ensureSession(h.guildId, h.channelId, h.config.discord.channels[0], new Date(), {
      content: 'さっきの続き',
    }).sessionId,
    'current',
  );
});
