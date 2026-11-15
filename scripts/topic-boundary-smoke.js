import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { loadConfig } from '../src/config/load-config.js';
import { ContextBuilder } from '../src/conversation/context-builder.js';
import { SessionService } from '../src/conversation/session-service.js';
import { createLogger } from '../src/observability/logger.js';
import { DatabaseStore } from '../src/storage/database.js';

const { config } = loadConfig();
const logger = createLogger('warn');
const model = new ClaudeClient(config.llm);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-ai-topic-'));
const database = new DatabaseStore(path.join(directory, 'topic.sqlite3'), config);
database.initializeChannels();
const service = new SessionService({ database, config, model, logger });
const builder = new ContextBuilder({ database, config });
const guildId = config.discord.guildId;
const channelId = config.discord.channels[0].id;
const userId = 'topic-smoke-user';
let sequence = 0;

function ingest(sessionId, content, authorType = 'human', replyToMessageId = null) {
  sequence += 1;
  const messageId = `topic-smoke-${sequence}`;
  database.ingestMessage(
    {
      messageId,
      guildId,
      channelId,
      sessionId,
      authorId: authorType === 'bot' ? 'topic-smoke-bot' : userId,
      authorName: authorType === 'bot' ? 'AI' : '利用者',
      authorType,
      content,
      replyToMessageId,
      createdAt: new Date(Date.now() + sequence * 1000).toISOString(),
    },
    config.privacy.messageRetentionHours,
  );
  return messageId;
}

try {
  const first = database.createSession({
    sessionId: randomUUID(),
    guildId,
    channelId,
    now: new Date(),
    retentionHours: config.privacy.sessionSummaryRetentionHours,
  });
  ingest(first.sessionId, '昨日の競馬は最後で外れて惜しかったね');
  ingest(first.sessionId, '最後で外れるのは悔しいね', 'bot');
  database.saveSessionSummary(
    first.sessionId,
    {
      topic: '昨日の競馬',
      factsEstablished: ['最後で外れた'],
      openQuestions: [],
      runningJokes: [],
      currentTone: '雑談',
    },
    1,
    new Date(),
    config.privacy.sessionSummaryRetentionHours,
  );

  const newTopicId = ingest(first.sessionId, 'RTX 2060で動かすAIモデルは何がいい？');
  const second = await service.maybeStartNewTopic(guildId, channelId, [newTopicId]);
  if (!second) throw new Error('semantic_topic_was_not_split');
  const context = builder.build({ guildId, channelId, sourceMessageIds: [newTopicId] });
  if (/競馬|最後で外れ/u.test(context.conversation)) {
    throw new Error('old_topic_leaked_into_new_context');
  }
  if (!context.conversation.includes('RTX 2060')) throw new Error('current_topic_missing');

  const sameTopicId = ingest(second.sessionId, 'VRAMはどれくらい余る？');
  const sameTopic = await service.maybeStartNewTopic(guildId, channelId, [sameTopicId]);
  if (sameTopic) throw new Error('same_topic_was_split');

  const explicitId = ingest(second.sessionId, 'ところで明日の天気はどう？');
  const explicitStartedAt = Date.now();
  const third = await service.maybeStartNewTopic(guildId, channelId, [explicitId]);
  const explicitDurationMs = Date.now() - explicitStartedAt;
  if (!third) throw new Error('explicit_topic_was_not_split');

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        model: config.llm.model,
        semanticSplit: true,
        oldContextExcluded: true,
        sameTopicPreserved: true,
        explicitSplit: true,
        explicitDurationMs,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
