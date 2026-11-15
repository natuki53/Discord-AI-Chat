import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionService } from '../src/conversation/session-service.js';
import { DatabaseStore } from '../src/storage/database.js';
import { validConfig } from './fixtures.js';

function withDatabase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-ai-chat-'));
  const database = new DatabaseStore(path.join(directory, 'test.sqlite3'), validConfig());
  database.initializeChannels();
  try {
    return callback(database);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function withAsyncDatabase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-ai-chat-'));
  const database = new DatabaseStore(path.join(directory, 'test.sqlite3'), validConfig());
  database.initializeChannels();
  try {
    return await callback(database);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createSession(database) {
  return database.createSession({
    sessionId: randomUUID(),
    guildId: '123456789012345678',
    channelId: '123456789012345679',
    now: new Date('2026-08-04T00:00:00Z'),
    retentionHours: 24,
  });
}

test('message ingestはmessage IDに対して冪等である', () => {
  withDatabase((database) => {
    const session = createSession(database);
    const input = {
      messageId: '223456789012345678',
      guildId: session.guildId,
      channelId: session.channelId,
      sessionId: session.sessionId,
      authorId: '323456789012345678',
      authorName: 'U1',
      authorType: 'human',
      content: 'こんにちは',
      replyToMessageId: null,
      createdAt: '2026-08-04T00:00:00Z',
    };
    assert.equal(database.ingestMessage(input, 24).isNew, true);
    assert.equal(database.ingestMessage(input, 24).isNew, false);
    assert.equal(
      database.getRecentMessages(session.guildId, session.channelId, session.sessionId, 10).length,
      1,
    );
  });
});

test('forgetUserは本文と本人設定を削除する', () => {
  withDatabase((database) => {
    const session = createSession(database);
    const authorId = '323456789012345678';
    database.ingestMessage(
      {
        messageId: '223456789012345678',
        guildId: session.guildId,
        channelId: session.channelId,
        sessionId: session.sessionId,
        authorId,
        authorName: 'U1',
        authorType: 'human',
        content: '削除対象',
        replyToMessageId: null,
        createdAt: '2026-08-04T00:00:00Z',
      },
      24,
    );
    database.setPreference(session.guildId, authorId, {
      preferredName: 'テスト',
      tone: 'casual',
      responseLength: 'short',
      banterLevel: 'high',
    });
    database.setProfile(session.guildId, authorId, {
      selfDescription: '本人の自己紹介',
      links: ['https://example.com/me'],
      sourceSummary: '公開ページに明記された活動',
    });
    const result = database.forgetUser(session.guildId, authorId);
    assert.equal(result.messages, 1);
    assert.equal(result.preferences, 1);
    assert.equal(result.profiles, 1);
    assert.equal(
      database.getRecentMessages(session.guildId, session.channelId, session.sessionId, 10).length,
      0,
    );
    assert.equal(database.getPreference(session.guildId, authorId), null);
    assert.equal(database.getProfile(session.guildId, authorId), null);
  });
});

test('本人profileを保存・取得・resetできる', () => {
  withDatabase((database) => {
    const guildId = '123456789012345678';
    const userId = '323456789012345678';
    const saved = database.setProfile(guildId, userId, {
      selfDescription: 'VRChatで遊んでいます',
      links: ['https://example.com/me'],
      sourceSummary: 'VRChat向けツールを開発している',
    });
    assert.equal(saved.selfDescription, 'VRChatで遊んでいます');
    assert.deepEqual(saved.links, ['https://example.com/me']);
    assert.equal(saved.sourceSummary, 'VRChat向けツールを開発している');
    assert.equal(database.resetProfile(guildId, userId), true);
    assert.equal(database.getProfile(guildId, userId), null);
  });
});

test('旧allをambientへ一度だけ移行し、停止中・呼びかけ限定は維持する', () => {
  withDatabase((database) => {
    const guild = '123456789012345678';
    const channel = '123456789012345679';
    database.db
      .prepare(
        "UPDATE channels SET configured_mode='all', mode_override='all', previous_mode='all'",
      )
      .run();
    database.initializeChannels();
    const migrated = database.getChannel(guild, channel);
    assert.equal(migrated.mode, 'ambient');
    assert.equal(migrated.configuredMode, 'ambient');
    assert.equal(migrated.previousMode, 'ambient');
    database.initializeChannels();
    assert.equal(database.getChannel(guild, channel).contextRevision, migrated.contextRevision);
    database.db.prepare("UPDATE channels SET mode_override='paused', previous_mode='all'").run();
    database.initializeChannels();
    assert.equal(database.getChannel(guild, channel).mode, 'paused');
    assert.equal(database.getChannel(guild, channel).previousMode, 'ambient');
    database.setChannelMode(guild, channel, 'mention');
    database.initializeChannels();
    assert.equal(database.getChannel(guild, channel).mode, 'mention');
  });
});

test('本人設定とprofileの変更・削除で生成中の文脈を無効化する', () => {
  withDatabase((database) => {
    const session = createSession(database);
    const user = '323456789012345678';
    database.ingestMessage(
      {
        messageId: '223456789012345670',
        guildId: session.guildId,
        channelId: session.channelId,
        sessionId: session.sessionId,
        authorId: user,
        authorName: '本人',
        authorType: 'human',
        content: '私のことについて',
        replyToMessageId: null,
        createdAt: new Date().toISOString(),
      },
      24,
    );
    let revision = database.getChannel(session.guildId, session.channelId).contextRevision;
    const changes = [
      () =>
        database.setPreference(session.guildId, user, {
          preferredName: 'なまえ',
          tone: 'formal',
          responseLength: 'short',
          banterLevel: 'normal',
        }),
      () =>
        database.setProfile(session.guildId, user, {
          selfDescription: '自己紹介',
          links: [],
          sourceSummary: '自己紹介',
        }),
      () => database.resetPreference(session.guildId, user),
      () => database.resetProfile(session.guildId, user),
    ];
    for (const change of changes) {
      change();
      const next = database.getChannel(session.guildId, session.channelId).contextRevision;
      assert.ok(next > revision);
      revision = next;
    }
  });
});

test('topic reset後の発言は新しいsessionになる', () => {
  withDatabase((database) => {
    const config = validConfig();
    const current = createSession(database);
    const service = new SessionService({ database, config, model: null, logger: null });
    assert.equal(service.reset(current.guildId, current.channelId), true);
    assert.equal(database.getSession(current.sessionId).status, 'deleted');

    const next = service.ensureSession(
      current.guildId,
      current.channelId,
      config.discord.channels[0],
      new Date('2026-08-04T00:00:01Z'),
    );
    assert.notEqual(next.sessionId, current.sessionId);
    assert.equal(next.status, 'active');
  });
});

test('話題境界では今回の発言だけを新しいsessionへ移す', () => {
  withDatabase((database) => {
    const session = createSession(database);
    const base = {
      guildId: session.guildId,
      channelId: session.channelId,
      sessionId: session.sessionId,
      authorId: '323456789012345678',
      authorName: 'U1',
      authorType: 'human',
      replyToMessageId: null,
    };
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345671',
        content: '昨日の競馬は惜しかったね',
        createdAt: '2026-08-04T00:00:00Z',
      },
      24,
    );
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345672',
        content: 'RTX 2060で動くモデルを教えて',
        createdAt: '2026-08-04T00:00:01Z',
      },
      24,
    );
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345673',
        content: 'VRAMは6GBです',
        createdAt: '2026-08-04T00:00:02Z',
      },
      24,
    );

    const next = database.splitSession({
      guildId: session.guildId,
      channelId: session.channelId,
      previousSessionId: session.sessionId,
      newSessionId: randomUUID(),
      messageIds: ['223456789012345672'],
      now: new Date('2026-08-04T00:00:02Z'),
      retentionHours: 24,
    });

    assert.ok(next);
    assert.equal(database.getSession(session.sessionId).status, 'closed');
    assert.deepEqual(
      database
        .getRecentMessages(session.guildId, session.channelId, session.sessionId, 10)
        .map((message) => message.content),
      ['昨日の競馬は惜しかったね'],
    );
    assert.deepEqual(
      database
        .getRecentMessages(session.guildId, session.channelId, next.sessionId, 10)
        .map((message) => message.content),
      ['RTX 2060で動くモデルを教えて', 'VRAMは6GBです'],
    );
    assert.equal(
      database.getChannel(session.guildId, session.channelId).activeSessionId,
      next.sessionId,
    );
  });
});

test('高信頼度の別話題判定で自動的にsessionを分ける', async () => {
  await withAsyncDatabase(async (database) => {
    const config = validConfig();
    const session = createSession(database);
    const base = {
      guildId: session.guildId,
      channelId: session.channelId,
      sessionId: session.sessionId,
      authorId: '323456789012345678',
      authorName: 'U1',
      authorType: 'human',
      replyToMessageId: null,
    };
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345671',
        content: '昨日の競馬は惜しかったね',
        createdAt: '2026-08-04T00:00:00Z',
      },
      24,
    );
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345672',
        content: 'RTX 2060で動くモデルを教えて',
        createdAt: '2026-08-04T00:00:01Z',
      },
      24,
    );
    let modelCalls = 0;
    const service = new SessionService({
      database,
      config,
      logger: { debug() {}, info() {}, warn() {} },
      model: {
        async chat() {
          modelCalls += 1;
          return {
            content: JSON.stringify({
              relation: 'new_topic',
              confidence: 0.94,
              currentTopic: 'ローカルAIモデル',
            }),
          };
        },
      },
    });
    const next = await service.maybeStartNewTopic(session.guildId, session.channelId, [
      '223456789012345672',
    ]);
    assert.equal(modelCalls, 1);
    assert.ok(next);
    assert.notEqual(next.sessionId, session.sessionId);
  });
});

test('続きの表現もClaudeに判定させ、継続ならsessionを保つ', async () => {
  await withAsyncDatabase(async (database) => {
    const config = validConfig();
    const session = createSession(database);
    const base = {
      guildId: session.guildId,
      channelId: session.channelId,
      sessionId: session.sessionId,
      authorId: '323456789012345678',
      authorName: 'U1',
      authorType: 'human',
    };
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345671',
        content: '昨日の競馬は惜しかったね',
        replyToMessageId: null,
        createdAt: '2026-08-04T00:00:00Z',
      },
      24,
    );
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345672',
        content: 'それで次はどうする？',
        replyToMessageId: null,
        createdAt: '2026-08-04T00:00:01Z',
      },
      24,
    );
    let modelCalls = 0;
    const service = new SessionService({
      database,
      config,
      logger: { debug() {}, info() {}, warn() {} },
      model: {
        async chat() {
          modelCalls += 1;
          return {
            content: JSON.stringify({
              relation: 'continuation',
              confidence: 0.99,
              currentTopic: '競馬',
            }),
          };
        },
      },
    });
    const result = await service.maybeStartNewTopic(session.guildId, session.channelId, [
      '223456789012345672',
    ]);
    assert.equal(result, null);
    assert.equal(modelCalls, 1);
    assert.equal(
      database.getChannel(session.guildId, session.channelId).activeSessionId,
      session.sessionId,
    );
  });
});

test('明示的な話題転換もClaudeの高信頼度判定でsessionを分ける', async () => {
  await withAsyncDatabase(async (database) => {
    const config = validConfig();
    const session = createSession(database);
    const base = {
      guildId: session.guildId,
      channelId: session.channelId,
      sessionId: session.sessionId,
      authorId: '323456789012345678',
      authorName: 'U1',
      authorType: 'human',
      replyToMessageId: null,
    };
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345671',
        content: '昨日の競馬は惜しかったね',
        createdAt: '2026-08-04T00:00:00Z',
      },
      24,
    );
    database.ingestMessage(
      {
        ...base,
        messageId: '223456789012345672',
        content: 'ところでRTX 2060で動くモデルは？',
        createdAt: '2026-08-04T00:00:01Z',
      },
      24,
    );
    let modelCalls = 0;
    const service = new SessionService({
      database,
      config,
      logger: { debug() {}, info() {}, warn() {} },
      model: {
        async chat() {
          modelCalls += 1;
          return {
            content: JSON.stringify({
              relation: 'new_topic',
              confidence: 0.99,
              currentTopic: 'AIモデル',
            }),
          };
        },
      },
    });
    const next = await service.maybeStartNewTopic(session.guildId, session.channelId, [
      '223456789012345672',
    ]);
    assert.ok(next);
    assert.equal(modelCalls, 1);
    assert.notEqual(next.sessionId, session.sessionId);
  });
});

test('cleanupは保持期限後の本文を消す', () => {
  withDatabase((database) => {
    const session = createSession(database);
    database.ingestMessage(
      {
        messageId: '223456789012345678',
        guildId: session.guildId,
        channelId: session.channelId,
        sessionId: session.sessionId,
        authorId: '323456789012345678',
        authorName: 'U1',
        authorType: 'human',
        content: '期限切れ',
        replyToMessageId: null,
        createdAt: '2026-08-04T00:00:00Z',
      },
      1,
    );
    const result = database.cleanup(new Date(Date.now() + 2 * 60 * 60 * 1000));
    assert.equal(result.messages, 1);
  });
});
