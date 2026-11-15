import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { loadConfig } from '../src/config/load-config.js';
import { ContextBuilder } from '../src/conversation/context-builder.js';
import { ConversationOrchestrator } from '../src/conversation/orchestrator.js';
import { SessionService } from '../src/conversation/session-service.js';
import { createLogger } from '../src/observability/logger.js';
import { DatabaseStore } from '../src/storage/database.js';
import { SearxngSearchProvider } from '../src/tools/web-search.js';

const { config } = loadConfig();
const logger = createLogger('warn');
const model = new ClaudeClient(config.llm);
const databasePath = path.join(os.tmpdir(), `discord-ai-quality-${randomUUID()}.sqlite3`);
const database = new DatabaseStore(databasePath, config);
database.initializeChannels();
const channelId = config.discord.channels[0].id;
const guildId = config.discord.guildId;
const userId = 'quality-user';
database.createSession({
  sessionId: randomUUID(),
  guildId,
  channelId,
  now: new Date(),
  retentionHours: config.privacy.sessionSummaryRetentionHours,
});
database.setProfile(guildId, userId, {
  selfDescription: 'VRChatで遊び、個人開発をしています',
  links: [],
  sourceSummary: 'VRChat向けツールを開発している',
});
const contextBuilder = new ContextBuilder({ database, config });
const sessionService = new SessionService({ database, config, model, logger });
const searchProvider = config.web.enabled ? new SearxngSearchProvider(config.web) : null;
const orchestrator = new ConversationOrchestrator({ model, searchProvider, config, logger });

let sequence = 0;
async function turn(content) {
  sequence += 1;
  const messageId = `quality-user-${sequence}`;
  const createdAt = new Date(Date.now() + sequence * 1000).toISOString();
  const activeSession = database.getSession(
    database.getChannel(guildId, channelId).activeSessionId,
  );
  database.ingestMessage(
    {
      messageId,
      guildId,
      channelId,
      sessionId: activeSession.sessionId,
      authorId: userId,
      authorName: 'natuki.',
      authorType: 'human',
      content,
      replyToMessageId: null,
      createdAt,
    },
    config.privacy.messageRetentionHours,
  );
  await sessionService.maybeStartNewTopic(guildId, channelId, [messageId]);
  const context = contextBuilder.build({ guildId, channelId, sourceMessageIds: [messageId] });
  const result = await orchestrator.respond(context, [messageId]);
  const responseId = `quality-bot-${sequence}`;
  database.ingestMessage(
    {
      messageId: responseId,
      guildId,
      channelId,
      sessionId: context.sessionId,
      authorId: 'quality-bot',
      authorName: 'AI Chat',
      authorType: 'bot',
      content: result.answer,
      replyToMessageId: null,
      createdAt: new Date(Date.now() + sequence * 1000 + 500).toISOString(),
    },
    config.privacy.messageRetentionHours,
  );
  return { answer: result.answer.trim(), usedWeb: result.usedWeb, sessionId: context.sessionId };
}

try {
  const turns = [];
  turns.push({ input: 'こんにちは', ...(await turn('こんにちは')) });
  turns.push({ input: '私ってどんな人だと思う？', ...(await turn('私ってどんな人だと思う？')) });
  turns.push({
    input: 'ギャンブルしてる人ってどう思う？',
    ...(await turn('ギャンブルしてる人ってどう思う？')),
  });
  turns.push({ input: 'www', ...(await turn('www')) });
  turns.push({ input: '今日の運勢を占って', ...(await turn('今日の運勢を占って')) });

  try {
    if (turns[0].answer !== 'こんにちは！') throw new Error('greeting_mismatch');
    if (
      /断定でき|AIだから|はっきり言え|プロフィールから|性格.{0,8}(?:わから|わかりま)/u.test(
        turns[1].answer,
      )
    ) {
      throw new Error('profile_answer_has_meta_disclaimer');
    }
    if (turns[3].answer.length > 40) throw new Error('laughter_response_too_long');
    if (/意味|おそらく|説明/u.test(turns[3].answer)) throw new Error('laughter_overexplained');
    if (/それより|ところで|VRChat|ツール|開発/u.test(turns[3].answer)) {
      throw new Error('laughter_changed_topic');
    }
    if (/VRChat|ツール|開発/u.test(turns[2].answer)) throw new Error('unrelated_profile_leak');
    if (turns[2].answer.includes('\n')) throw new Error('general_opinion_added_side_topic');
    if (turns[1].sessionId === turns[2].sessionId) throw new Error('new_topic_not_split');
    if (turns[2].sessionId !== turns[3].sessionId) throw new Error('reaction_lost_context');
    if (turns[4].usedWeb) throw new Error('fortune_used_web_search');
    if (/https?:\/\/|参照/u.test(turns[4].answer)) throw new Error('fortune_included_sources');
    if (/明日|あした|翌日/u.test(turns[4].answer)) throw new Error('fortune_changed_timeframe');
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error.message, turns }, null, 2)}\n`,
    );
    throw error;
  }

  process.stdout.write(`${JSON.stringify({ ok: true, turns }, null, 2)}\n`);
} finally {
  database.close();
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(`${databasePath}${suffix}`, { force: true });
}
