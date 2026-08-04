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
