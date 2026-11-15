import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseStore } from '../src/storage/database.js';
import { ContextBuilder } from '../src/conversation/context-builder.js';
import { SessionService } from '../src/conversation/session-service.js';
import { ConversationOrchestrator } from '../src/conversation/orchestrator.js';
import { DiscordBot } from '../src/discord/bot.js';
import { validConfig } from './fixtures.js';

const BOT_ID = '7000000000000000001';
const USER_ID = '7000000000000000002';
const output = (data) => ({
  content: JSON.stringify(data),
  promptTokens: 1,
  outputTokens: 1,
  totalDurationNs: 1000,
});
const decide = (action, targets = [], reasonCode = 'natural_contribution') => ({
  action,
  reasonCode,
  targetMessageIds: targets,
  needsWeb: false,
});

function harness(t, { chat, mode = 'ambient', conversation = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'group-chat-test-'));
  const config = validConfig();
  config.discord.channels[0].mode = mode;
  Object.assign(
    config.conversation,
    {
      semanticTopicBoundaries: false,
      ambientCooldownSeconds: 20,
      ambientMaxAgeSeconds: 45,
      directRequestMaxAgeSeconds: 180,
      maxPendingMessages: 50,
    },
    conversation,
  );
  config.web.enabled = true;
  const database = new DatabaseStore(path.join(directory, 'test.sqlite3'), config);
  database.initializeChannels();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const guildId = config.discord.guildId;
  const channelId = config.discord.channels[0].id;
  const session = database.createSession({
    sessionId: 'session-1',
    guildId,
    channelId,
    now: new Date(),
    retentionHours: 24,
  });
  const calls = { typing: 0, sent: [], queued: [], model: [], search: 0, logs: [] };
  const logger = Object.fromEntries(
    ['info', 'warn', 'error', 'debug'].map((level) => [level, (data) => calls.logs.push(data)]),
  );
  const model = {
    async chat(request) {
      if (request.web) return { ...output({}), content: '回答案', usedWeb: false, sources: [] };
      calls.model.push(request);
      if (chat) return chat(request);
      assert.fail('unexpected model request');
    },
  };
  const searchProvider = {
    async search() {
      calls.search += 1;
      return [];
    },
  };
  const sessionService = new SessionService({ database, config, model, logger });
  const contextBuilder = new ContextBuilder({ database, config });
  const orchestrator = new ConversationOrchestrator({ model, searchProvider, config, logger });
  const discordChannel = {
    isTextBased: () => true,
    async sendTyping() {
      calls.typing += 1;
    },
    async send(payload) {
      calls.sent.push(payload);
      return {
        id: String(9000000000000000000n + BigInt(calls.sent.length)),
        createdAt: new Date(),
      };
    },
  };
  const bot = Object.assign(Object.create(DiscordBot.prototype), {
    config,
    database,
    sessionService,
    contextBuilder,
    orchestrator,
    logger,
    scheduler: { enqueue: (entry) => calls.queued.push(entry) },
    client: {
      user: { id: BOT_ID, username: 'AI' },
      channels: { fetch: async () => discordChannel },
    },
    activeControllers: new Set(),
    stopping: false,
  });
  let nextId = 0;
  function human(content, fields = {}) {
    nextId += 1;
    const message = {
      messageId: String(8000000000000000000n + BigInt(nextId)),
      guildId,
      channelId,
      sessionId: session.sessionId,
      authorId: USER_ID,
      authorName: '利用者',
      authorType: 'human',
      content,
      replyToMessageId: null,
      replyToAuthorType: 'unknown',
      createdAt: new Date(Date.now() - 1000 + nextId).toISOString(),
      ...fields,
    };
    database.ingestMessage(message, 24);
    return message;
  }
  const run = (...messages) =>
    bot.processTurn({ guildId, channelId, messageIds: messages.map((item) => item.messageId) });
  const jobs = () => database.db.prepare('SELECT * FROM response_jobs ORDER BY created_at').all();
  return {
    bot,
    database,
    config,
    calls,
    human,
    run,
    jobs,
    guildId,
    channelId,
    session,
    contextBuilder,
    sessionService,
  };
}

test('GC-01: 人間同士の質問ではtyping・検索・本文・謝罪のいずれも投稿しない', async (t) => {
  const h = harness(t);
  const source = h.human('今日の価格を調べて', { replyToAuthorType: 'human' });
  await h.run(source);
  assert.equal(h.calls.typing, 0);
  assert.equal(h.calls.search, 0);
  assert.equal(h.calls.model.length, 0);
  assert.deepEqual(h.calls.sent, []);
  assert.equal(h.jobs()[0].state, 'silent');
  assert.equal(h.jobs()[0].discord_response_id, null);
  assert.deepEqual(h.database.getUnprocessedMessages(h.guildId, h.channelId), []);
});

test('GC-02/17: 人間への質問を混ぜず、同じ連投内のAI宛依頼へ答える', async (t) => {
  const h = harness(t, {
    chat: async (request) => {
      assert.ok(!request.format.properties.reasonCode);
      return output({ action: 'respond', answer: 'その方法ならできるよ。' });
    },
  });
  const a = h.human('Bさん、この設定どうする？', { replyToAuthorType: 'human' });
  const b = h.human(`<@${BOT_ID}> この方法を説明して`, { authorId: 'u2', mentionedBot: true });
  await h.run(a, b);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.typing, 1);
  assert.equal(h.jobs()[0].state, 'posted');
  const generation = h.calls.model[0].messages[1].content;
  assert.match(generation, new RegExp(`${b.messageId}.*CURRENT`, 'u'));
  assert.doesNotMatch(generation, new RegExp(`${a.messageId}[^\n]*CURRENT`, 'u'));
});

test('GC-06: 自然な自発参加は判定後に本文を作り、日付語だけでは検索しない', async (t) => {
  let source;
  const h = harness(t, {
    chat: async (request) =>
      request.format.properties.reasonCode
        ? output(decide('respond', [source.messageId]))
        : output({ action: 'respond', answer: '太陽も休憩してほしいね。' }),
  });
  source = h.human('今日の太陽、仕事熱心すぎる');
  await h.run(source);
  assert.equal(h.calls.model.length, 2);
  assert.equal(h.calls.search, 0);
  assert.equal(h.calls.sent.length, 1);
});

test('GC-08: 生成中の依頼取り消しで本文を投稿しない', async (t) => {
  let h;
  h = harness(t, {
    chat: async () => {
      h.human('やっぱりいい', { createdAt: new Date().toISOString() });
      return output({ action: 'respond', answer: '取り消し前に作った古い回答' });
    },
  });
  const source = h.human(`<@${BOT_ID}> 説明して`, { mentionedBot: true });
  await h.run(source);
  assert.deepEqual(h.calls.sent, []);
  assert.equal(h.calls.model.length, 1);
  assert.equal(h.jobs()[0].state, 'silent');
});

test('GC-07/09: 新着の人間の回答を再評価へ渡し、解決済みの旧回答を止める', async (t) => {
  let h;
  h = harness(t, {
    chat: async (request) => {
      if (request.format.properties.reasonCode) {
        const data = JSON.parse(request.messages[1].content);
        assert.equal(data.LATEST[0].content, 'その設定はOFFで解決するよ');
        return output(decide('silent', [], 'already_answered'));
      }
      h.human('その設定はOFFで解決するよ', { authorId: 'u2', createdAt: new Date().toISOString() });
      return output({ action: 'respond', answer: '同じ説明を重ねる古い回答' });
    },
  });
  await h.run(h.human(`<@${BOT_ID}> 設定を教えて`, { mentionedBot: true }));
  assert.equal(h.calls.model.length, 2);
  assert.deepEqual(h.calls.sent, []);
});

test('GC-13: 黙った会話も要約され、その後の直接依頼で参照できる', async (t) => {
  const h = harness(t, {
    conversation: { summaryEveryMessages: 5 },
    chat: async (request) => {
      if (request.format.properties.topic)
        return output({
          topic: '旅行の相談',
          factsEstablished: ['行先は京都'],
          openQuestions: [],
          runningJokes: [],
          currentTone: '雑談',
        });
      assert.match(request.messages[1].content, /旅行の相談|行先は京都/);
      return output({ action: 'respond', answer: '行き先は京都で決まっているね。' });
    },
  });
  const sources = Array.from({ length: 5 }, (_, index) =>
    h.human(`旅行の相談${index}`, { replyToAuthorType: 'human' }),
  );
  await h.run(...sources);
  assert.equal(h.calls.typing, 0);
  assert.deepEqual(h.calls.sent, []);
  assert.equal(h.database.getSession(h.session.sessionId).summary.topic, '旅行の相談');
  await h.run(h.human(`<@${BOT_ID}> 今の話をまとめて`, { mentionedBot: true }));
  assert.equal(h.calls.sent.length, 1);
});

for (const change of ['delete', 'forget', 'reset', 'pause', 'mention']) {
  test(`GC-15: 生成中の${change}で旧状態の自発参加を投稿しない`, async (t) => {
    let h;
    let source;
    h = harness(t, {
      chat: async (request) => {
        if (request.format.properties.reasonCode)
          return output(decide('respond', [source.messageId]));
        if (change === 'delete') h.database.deleteMessage({ ...source });
        if (change === 'forget') h.database.forgetUser(h.guildId, USER_ID);
        if (change === 'reset') h.sessionService.reset(h.guildId, h.channelId);
        if (change === 'pause') h.database.setChannelMode(h.guildId, h.channelId, 'paused');
        if (change === 'mention') h.database.setChannelMode(h.guildId, h.channelId, 'mention');
        return output({ action: 'respond', answer: '無効になった発言' });
      },
    });
    source = h.human('雑談の続き');
    await h.run(source);
    assert.deepEqual(h.calls.sent, []);
    assert.notEqual(h.jobs()[0].state, 'posted');
  });
}

test('GC-15: 生成中の編集は新しい本文で再評価・再生成する', async (t) => {
  let h;
  let source;
  let generations = 0;
  h = harness(t, {
    chat: async (request) => {
      if (request.format.properties.reasonCode)
        return output(decide('respond', [source.messageId], 'direct_request'));
      generations += 1;
      if (generations === 1) {
        h.database.updateMessage({
          ...source,
          content: `<@${BOT_ID}> 新しい質問`,
          editedAt: new Date().toISOString(),
          mentionedBot: true,
        });
      } else assert.match(request.messages[1].content, /新しい質問/);
      return output({ action: 'respond', answer: generations === 1 ? '古い答え' : '新しい答え' });
    },
  });
  source = h.human(`<@${BOT_ID}> 古い質問`, { mentionedBot: true });
  await h.run(source);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].content, '新しい答え');
});

test('GC-14: 自発参加の生成エラーでは黙り、直接依頼には短い障害通知を返す', async (t) => {
  for (const direct of [false, true]) {
    let source;
    const h = harness(t, {
      chat: async (request) => {
        if (request.format.properties.reasonCode)
          return output(decide('respond', [source.messageId]));
        throw new Error('test failure');
      },
    });
    source = h.human(direct ? `<@${BOT_ID}> 教えて` : '雑談中', { mentionedBot: direct });
    await h.run(source);
    assert.equal(h.calls.sent.length, direct ? 1 : 0);
    assert.equal(h.jobs()[0].state, 'failed_permanent');
  }
});

test('GC-16/19: 復旧した古い雑談・mentionモードの通常会話を返答として消化しない', async (t) => {
  for (const mode of ['ambient', 'mention']) {
    const h = harness(t, { mode });
    const source = h.human('普通の会話', { createdAt: new Date(Date.now() - 60000).toISOString() });
    h.bot.recoverChannel(h.guildId, h.channelId);
    await h.run(source);
    assert.deepEqual(h.calls.sent, []);
    assert.equal(h.calls.typing, 0);
  }
});

test('GC-20: 停止中・対象外・他Botのイベントを保存しない', async (t) => {
  const h = harness(t, { mode: 'paused' });
  const event = {
    id: '123456789012345678',
    guildId: h.guildId,
    channelId: h.channelId,
    author: { id: USER_ID, bot: false },
    type: 0,
    content: '保存しない',
    createdAt: new Date(),
  };
  for (const variant of [
    event,
    { ...event, guildId: 'other' },
    { ...event, author: { bot: true } },
  ]) {
    await h.bot.onMessageCreate(variant);
  }
  assert.equal(h.database.db.prepare('SELECT count(*) AS count FROM messages').get().count, 0);
});

test('要約API待機中にforgetされても、古い要約を保存し直さない', async (t) => {
  let h;
  h = harness(t, {
    conversation: { summaryEveryMessages: 5 },
    chat: async () => {
      h.database.forgetUser(h.guildId, USER_ID);
      return output({
        topic: '消された話題',
        factsEstablished: [],
        openQuestions: [],
        runningJokes: [],
        currentTone: '',
      });
    },
  });
  const sources = Array.from({ length: 5 }, () =>
    h.human('消す会話', { replyToAuthorType: 'human' }),
  );
  await h.run(...sources);
  assert.equal(h.database.getSession(h.session.sessionId).summary, null);
});

test('新着が二度続いても旧回答を投稿せず、期限内の直接依頼を再キューする', async (t) => {
  let h;
  let source;
  let generated = 0;
  h = harness(t, {
    chat: async (request) => {
      if (request.format.properties.reasonCode)
        return output(decide('respond', [source.messageId], 'direct_request'));
      generated += 1;
      h.human(`追加の条件${generated}`, {
        createdAt: new Date(Date.now() + generated).toISOString(),
      });
      return output({ action: 'respond', answer: 'まだ新着を見ていない回答' });
    },
  });
  source = h.human(`<@${BOT_ID}> 質問です`, { mentionedBot: true });
  await h.run(source);
  assert.equal(generated, 2);
  assert.deepEqual(h.calls.sent, []);
  assert.ok(h.database.getUnprocessedMessages(h.guildId, h.channelId).includes(source.messageId));
  assert.ok(h.calls.queued.some((entry) => entry.messageId === source.messageId && entry.priority));
  h.database.db
    .prepare('UPDATE messages SET created_at = ? WHERE message_id = ?')
    .run(new Date(Date.now() - 181000).toISOString(), source.messageId);
  await h.run(source);
  assert.ok(!h.database.getUnprocessedMessages(h.guildId, h.channelId).includes(source.messageId));
});

test('既存の保存済みモードとpause復帰先を、新しい既定値で上書きしない', async (t) => {
  const h = harness(t, { mode: 'all' });
  h.database.setChannelMode(h.guildId, h.channelId, 'mention');
  h.database.setChannelMode(h.guildId, h.channelId, 'paused');
  h.config.discord.channels[0].mode = 'ambient';
  h.database.initializeChannels();
  assert.equal(h.database.getChannel(h.guildId, h.channelId).mode, 'paused');
  assert.equal(h.database.resumeChannel(h.guildId, h.channelId).mode, 'mention');
});

test('本文の編集と削除で要約を無効化し、他チャンネルの更新は拒否する', async (t) => {
  const h = harness(t);
  const source = h.human('以前の本文');
  h.database.saveSessionSummary(h.session.sessionId, { topic: '以前の要約' }, 1, new Date(), 24);
  assert.equal(
    h.database.updateMessage({
      ...source,
      channelId: 'other',
      content: '無効',
      editedAt: new Date().toISOString(),
    }),
    false,
  );
  assert.equal(h.database.getSession(h.session.sessionId).summary.topic, '以前の要約');
  h.database.updateMessage({ ...source, content: '訂正済み', editedAt: new Date().toISOString() });
  assert.equal(h.database.getSession(h.session.sessionId).summary, null);
  h.database.saveSessionSummary(h.session.sessionId, { topic: '訂正後の要約' }, 1, new Date(), 24);
  h.database.deleteMessage(source);
  assert.equal(h.database.getSession(h.session.sessionId).summary, null);
});

test('宛先追加前のDBを開き直しても本文を保持し、古いBotメンションを復旧する', async (t) => {
  const h = harness(t, { mode: 'mention' });
  const source = h.human(`<@${BOT_ID}> 以前の依頼`);
  for (const column of ['mentioned_bot', 'reply_to_author_type'])
    h.database.db.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
  h.database.db.exec('ALTER TABLE channels DROP COLUMN context_revision');
  const migrated = new DatabaseStore(
    path.join(path.dirname(h.database.db.name), 'test.sqlite3'),
    h.config,
  );
  try {
    const [restored] = migrated.getMessagesByIds(h.guildId, h.channelId, [source.messageId]);
    assert.equal(restored.content, source.content);
    assert.equal(restored.mentionedBot, false);
    h.bot.database = migrated;
    h.bot.recoverChannel(h.guildId, h.channelId);
    assert.ok(
      h.calls.queued.some((entry) => entry.messageId === source.messageId && entry.priority),
    );
    assert.equal(
      migrated.getMessagesByIds(h.guildId, h.channelId, [source.messageId])[0].mentionedBot,
      true,
    );
  } finally {
    migrated.close();
  }
});

test('ambientでも受信時にBotへのreplyと人間へのreplyを保存して区別する', async (t) => {
  const h = harness(t);
  for (const [index, author] of [
    { id: BOT_ID, bot: true },
    { id: USER_ID, bot: false },
  ].entries()) {
    const id = String(6000000000000000000n + BigInt(index));
    await h.bot.onMessageCreate({
      id,
      guildId: h.guildId,
      channelId: h.channelId,
      type: 19,
      content: 'それはなぜ？',
      author: { id: USER_ID, username: 'user', bot: false },
      reference: { messageId: `reference-${index}` },
      createdAt: new Date(),
      channel: { messages: { fetch: async () => ({ author }) } },
    });
    const [stored] = h.database.getMessagesByIds(h.guildId, h.channelId, [id]);
    assert.equal(stored.replyToAuthorType, index === 0 ? 'bot' : 'human');
    assert.equal(h.calls.queued.at(-1).priority, index === 0);
  }
});

test('直接依頼が続いても同じ障害の通知をチャンネルへ連投しない', async (t) => {
  const h = harness(t, {
    chat: async () => {
      throw new Error('model unavailable');
    },
  });
  await h.run(h.human(`<@${BOT_ID}> 質問1`, { mentionedBot: true }));
  await h.run(h.human(`<@${BOT_ID}> 質問2`, { mentionedBot: true }));
  assert.equal(h.calls.sent.length, 1);
});

for (const interrupted of [false, true]) {
  test(`終了中の直接依頼を保持して再起動へ引き継ぐ（API中断=${interrupted}）`, async (t) => {
    let h;
    h = harness(t, {
      chat: async () => {
        h.bot.stopping = true;
        if (interrupted) throw new Error('aborted during shutdown');
        return output({ action: 'respond', answer: '停止後には投稿しない回答' });
      },
    });
    const source = h.human(`<@${BOT_ID}> 説明して`, { mentionedBot: true });
    await h.run(source);
    assert.deepEqual(h.calls.sent, []);
    assert.ok(h.database.getUnprocessedMessages(h.guildId, h.channelId).includes(source.messageId));
    assert.equal(h.bot.activeControllers.size, 0);
  });
}
