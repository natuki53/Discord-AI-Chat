import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { loadConfig } from '../src/config/load-config.js';
import { ContextBuilder } from '../src/conversation/context-builder.js';
import { ConversationOrchestrator } from '../src/conversation/orchestrator.js';
import { DatabaseStore } from '../src/storage/database.js';

// 実際の利用者のログは使わず、表示名と指示語の取り違えを人工会話で確認する。
const { config } = loadConfig();
config.web.enabled = false;
config.discord.channels[0].mode = 'ambient';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-quality-'));
const database = new DatabaseStore(path.join(directory, 'test.sqlite3'), config);
database.initializeChannels();
const guildId = config.discord.guildId;
const channelId = config.discord.channels[0].id;
const base = Date.now() - 8 * 3600_000;
const model = new ClaudeClient(config.llm);
const orchestrator = new ConversationOrchestrator({
  model,
  config,
  searchProvider: null,
  logger: { warn() {}, debug() {} },
});
let sequence = 0;
function session(id, timestamp) {
  database.createSession({
    sessionId: id,
    guildId,
    channelId,
    now: new Date(timestamp),
    retentionHours: 24,
  });
}
function message(sessionId, content, fields = {}) {
  sequence += 1;
  const value = {
    guildId,
    channelId,
    sessionId,
    messageId: `context-${sequence}`,
    authorId: 'synthetic-a',
    authorName: '参加者A',
    authorType: 'human',
    content,
    replyToMessageId: null,
    createdAt: new Date(base + sequence * 1000).toISOString(),
    ...fields,
  };
  database.ingestMessage(value, 24);
  return value;
}
const history = { authorId: 'synthetic-b', authorName: '資格勉強中' };
const bot = { authorId: 'synthetic-bot', authorName: 'AI', authorType: 'bot' };

try {
  session('earlier', base);
  message('earlier', 'お前だれや', history);
  message('earlier', 'このチャンネルで話すAIだよ。', bot);
  message('earlier', 'バカにしてるんか', history);
  message('earlier', 'そんなつもりはないよ。', bot);
  message('earlier', 'かわいいやつめ', history);
  session('current', Date.now() - 10_000);

  const turns = [];
  for (const input of ['この資格勉強中って人うざくない？', '今までの君へのあたり的にね']) {
    const source = message('current', input, {
      createdAt: new Date().toISOString(),
      mentionedBot: turns.length === 0,
    });
    const context = new ContextBuilder({ database, config }).build({
      guildId,
      channelId,
      sourceMessageIds: [source.messageId],
    });
    assert.match(context.conversation, /お前だれや/);
    const result = await orchestrator.respond(context, [source.messageId]);
    assert.equal(result.action, 'respond');
    assert.doesNotMatch(
      result.answer,
      /(?:資格|勉強中|勉強している)(?:の人|人)(?:全体|一般)|あなたに.{0,12}(?:嫌な|不快)|(?:どの|どういう)(?:部分|やり取り).{0,10}教えて/,
    );
    turns.push({ input, answer: result.answer });
    message('current', result.answer, {
      ...bot,
      createdAt: new Date().toISOString(),
      replyToMessageId: source.messageId,
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, turns }, null, 2)}\n`);
} finally {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
