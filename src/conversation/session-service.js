import { randomUUID } from 'node:crypto';

export class SessionService {
  constructor({ database, config, model, logger }) {
    this.database = database;
    this.config = config;
    this.model = model;
    this.logger = logger;
  }

  ensureSession(guildId, channelId, channelConfig, now = new Date()) {
    const channel = this.database.getChannel(guildId, channelId);
    const current = this.database.getSession(channel?.activeSessionId);
    const idleMilliseconds = channelConfig.sessionIdleMinutes * 60 * 1000;
    const expired =
      !current ||
      current.status !== 'active' ||
      now.getTime() - new Date(current.lastActivityAt).getTime() >= idleMilliseconds;

    if (expired) {
      return this.database.createSession({
        sessionId: randomUUID(),
        guildId,
        channelId,
        now,
        retentionHours: this.config.privacy.sessionSummaryRetentionHours,
      });
    }

    this.database.touchSession(
      current.sessionId,
      now,
      this.config.privacy.sessionSummaryRetentionHours,
    );
    return this.database.getSession(current.sessionId);
  }

  reset(guildId, channelId) {
    return this.database.resetSession(guildId, channelId);
  }

  async maybeRefreshSummary(sessionId) {
    const session = this.database.getSession(sessionId);
    if (!session) return null;
    const messageCount = this.database.countSessionMessages(sessionId);
    if (
      messageCount - session.summaryMessageCount <
      this.config.conversation.summaryEveryMessages
    ) {
      return session.summary;
    }

    const messages = this.database.getRecentMessages(
      session.guildId,
      session.channelId,
      sessionId,
      Math.min(this.config.conversation.recentMessageLimit, 80),
    );
    const transcript = messages
      .filter((message) => message.authorType === 'human')
      .map((message) => `${message.authorName}: ${message.content}`)
      .join('\n');

    const format = {
      type: 'object',
      additionalProperties: false,
      required: ['topic', 'factsEstablished', 'openQuestions', 'runningJokes', 'currentTone'],
      properties: {
        topic: { type: 'string' },
        factsEstablished: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        openQuestions: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        runningJokes: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        currentTone: { type: 'string' },
      },
    };

    try {
      const response = await this.model.chat({
        messages: [
          {
            role: 'system',
            content:
              '会話の現在の流れだけを要約してください。個人の性格、属性、人間関係、心理状態を推測してはいけません。認証情報やセンシティブ情報は残さないでください。',
          },
          { role: 'user', content: transcript },
        ],
        format,
        temperature: 0.2,
      });
      const summary = JSON.parse(response.content);
      this.database.saveSessionSummary(
        sessionId,
        summary,
        messageCount,
        new Date(),
        this.config.privacy.sessionSummaryRetentionHours,
      );
      return summary;
    } catch (error) {
      this.logger.warn({ event: 'summary_failed', error: error.name, sessionId }, 'summary failed');
      return session.summary;
    }
  }
}
