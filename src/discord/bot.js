import { randomUUID } from 'node:crypto';
import { Client, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import { channelConfig } from '../config/load-config.js';
import { sanitizeDisplayName, splitDiscordMessage } from '../shared/text.js';
import { handleCommand } from './commands.js';
import { hasExplicitBotMention, isDirectMessage } from '../conversation/participation-policy.js';

const ACCEPTED_MESSAGE_TYPES = new Set([MessageType.Default, MessageType.Reply]);

export function messageTextForContext(message) {
  const attachmentCount = message.attachments?.size ?? 0;
  const attachmentNote =
    attachmentCount > 0 ? `[添付ファイル${attachmentCount}件: 画像やファイルの内容は未解析]` : '';
  // 添付だけの発言も残し、「これ」への反応を存在しないテキストに結び付けない。
  return [
    String(message.content ?? '')
      .trim()
      .slice(0, attachmentNote ? 7900 : 8000),
    attachmentNote,
  ]
    .filter(Boolean)
    .join('\n');
}

export class DiscordBot {
  constructor(services) {
    if (!services.profileService) {
      throw new Error('profileServiceがDiscord commandへ接続されていません');
    }
    this.services = services;
    this.config = services.config;
    this.database = services.database;
    this.logger = services.logger;
    this.scheduler = services.scheduler;
    this.sessionService = services.sessionService;
    this.contextBuilder = services.contextBuilder;
    this.orchestrator = services.orchestrator;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
      allowedMentions: { parse: [] },
    });
    this.stopping = false;
    this.activeControllers = new Set();
    this.bindEvents();
  }

  bindEvents() {
    this.client.once('clientReady', (client) => {
      this.logger.info(
        { event: 'discord_ready', botUserId: client.user.id, guildId: this.config.discord.guildId },
        'discord connected',
      );
      this.runEvent('ready_recovery', () => this.recoverUnprocessed());
    });
    this.client.on('messageCreate', (message) =>
      this.runEvent('message_create', () => this.onMessageCreate(message)),
    );
    this.client.on('messageUpdate', (_oldMessage, newMessage) =>
      this.runEvent('message_update', () => this.onMessageUpdate(newMessage)),
    );
    this.client.on('messageDelete', (message) =>
      this.runEvent('message_delete', () => this.onMessageDelete(message)),
    );
    this.client.on('interactionCreate', (interaction) =>
      handleCommand(interaction, this.services).catch((error) => {
        this.logger.error({ event: 'command_failed', error: error.message }, 'command failed');
      }),
    );
    this.client.on('error', (error) => {
      this.logger.error({ event: 'discord_error', error: error.message }, 'discord error');
    });
  }

  runEvent(event, callback) {
    Promise.resolve()
      .then(callback)
      .catch((error) => {
        this.logger.error(
          { event: 'discord_event_failed', discordEvent: event, error: error.message },
          'discord event failed',
        );
      });
  }

  async start(token) {
    await this.client.login(token);
  }

  async stop() {
    this.stopping = true;
    this.services.imageService?.stop();
    await this.scheduler.shutdown(30_000);
    for (const controller of this.activeControllers) controller.abort();
    this.client.destroy();
  }

  isConfiguredMessage(message) {
    return (
      message.guildId === this.config.discord.guildId &&
      Boolean(channelConfig(this.config, message.channelId))
    );
  }

  async addressingFor(message) {
    let replyToAuthorType = 'unknown';
    if (message.reference?.messageId) {
      const [stored] = this.database.getMessagesByIds(message.guildId, message.channelId, [
        message.reference.messageId,
      ]);
      if (stored) replyToAuthorType = stored.authorType === 'bot' ? 'bot' : 'human';
      else {
        try {
          const referenced = await message.channel.messages.fetch(message.reference.messageId);
          replyToAuthorType =
            referenced.author.id === this.client.user.id
              ? 'bot'
              : referenced.author.bot
                ? 'other'
                : 'human';
        } catch {
          // 参照できない宛先は不明として参加判定へ渡す。
        }
      }
    }
    return {
      mentionedBot: hasExplicitBotMention(message.content, this.client.user.id),
      replyToAuthorType,
    };
  }

  async onMessageCreate(message) {
    if (this.stopping || !this.isConfiguredMessage(message)) return;
    if (message.author.bot || message.webhookId || !ACCEPTED_MESSAGE_TYPES.has(message.type))
      return;
    const configured = channelConfig(this.config, message.channelId);
    const channel = this.database.getChannel(message.guildId, message.channelId);
    if (channel?.mode === 'paused') return;
    const content = messageTextForContext(message);
    if (!content) return;
    const addressing = await this.addressingFor(message);
    if (
      this.stopping ||
      this.database.getChannel(message.guildId, message.channelId)?.mode === 'paused'
    )
      return;

    const session = this.sessionService.ensureSession(
      message.guildId,
      message.channelId,
      configured,
      message.createdAt,
      { content, replyToMessageId: message.reference?.messageId ?? null },
    );
    const result = this.database.ingestMessage(
      {
        messageId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        sessionId: session.sessionId,
        authorId: message.author.id,
        authorName:
          sanitizeDisplayName(message.member?.displayName ?? message.author.username) || 'user',
        authorType: 'human',
        content,
        replyToMessageId: message.reference?.messageId ?? null,
        ...addressing,
        createdAt: message.createdAt.toISOString(),
      },
      this.config.privacy.messageRetentionHours,
    );
    if (!result.isNew) return;

    this.scheduler.enqueue({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      priority: isDirectMessage(addressing),
    });
    this.logger.debug(
      { event: 'message_ingested', guildId: message.guildId, channelId: message.channelId },
      'message ingested',
    );
  }

  async onMessageUpdate(message) {
    if (!this.isConfiguredMessage(message)) return;
    try {
      if (message.partial) message = await message.fetch();
      if (message.author?.bot) return;
      this.database.updateMessage({
        messageId: message.id,
        content: messageTextForContext(message),
        mentionedBot: hasExplicitBotMention(message.content, this.client.user.id),
        editedAt: message.editedAt?.toISOString() ?? new Date().toISOString(),
        guildId: message.guildId,
        channelId: message.channelId,
      });
    } catch (error) {
      this.logger.warn(
        { event: 'message_update_failed', error: error.message },
        'message update failed',
      );
    }
  }

  async onMessageDelete(message) {
    if (!this.isConfiguredMessage(message)) return;
    this.database.deleteMessage({
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
    });
  }

  async recoverUnprocessed() {
    for (const configured of this.config.discord.channels) {
      this.recoverChannel(this.config.discord.guildId, configured.id);
    }
  }

  recoverChannel(guildId, channelId) {
    if (this.stopping || this.database.getChannel(guildId, channelId)?.mode === 'paused') return;
    const ids = this.database.getUnprocessedMessages(guildId, channelId);
    for (const message of this.database.getMessagesByIds(guildId, channelId, ids)) {
      this.restoreAddressing(guildId, channelId, message);
      this.scheduler.enqueue({
        guildId,
        channelId,
        messageId: message.messageId,
        priority: isDirectMessage(message),
      });
    }
  }

  restoreAddressing(guildId, channelId, message) {
    const mentionedBot = hasExplicitBotMention(message.content, this.client.user.id);
    let replyToAuthorType = message.replyToAuthorType;
    if (replyToAuthorType === 'unknown' && message.replyToMessageId) {
      const [reference] = this.database.getMessagesByIds(guildId, channelId, [
        message.replyToMessageId,
      ]);
      if (reference) replyToAuthorType = reference.authorType === 'bot' ? 'bot' : 'human';
    }
    if (message.mentionedBot !== mentionedBot || message.replyToAuthorType !== replyToAuthorType) {
      Object.assign(message, { mentionedBot, replyToAuthorType });
      this.database.updateMessageAddressing(message.messageId, message);
    }
  }

  async processTurn({ guildId, channelId, messageIds }) {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let jobId;
    let typingTimer;
    let context;
    let decision;
    let solicited = false;
    let retryPending = false;
    let firstResponseId = null;
    const complete = (state, reasonCode) => {
      if (jobId) this.database.finishJob(jobId, state, { discordResponseId: firstResponseId });
      this.logger.info(
        { event: 'participation_completed', guildId, channelId, state, reasonCode },
        'participation completed',
      );
    };
    try {
      if (this.stopping) {
        retryPending = true;
        return;
      }
      const initialChannel = this.database.getChannel(guildId, channelId);
      if (!initialChannel?.activeSessionId || initialChannel.mode === 'paused') return;
      const records = this.database
        .getMessagesByIds(guildId, channelId, messageIds, { unprocessedOnly: true })
        .filter((message) => message.sessionId === initialChannel.activeSessionId);
      for (const message of records) this.restoreAddressing(guildId, channelId, message);
      const fresh = records.filter((message) => {
        const age = Date.now() - Date.parse(message.createdAt);
        const ttl = isDirectMessage(message)
          ? (this.config.conversation.directRequestMaxAgeSeconds ?? 180)
          : (this.config.conversation.ambientMaxAgeSeconds ?? 45);
        return age <= ttl * 1000;
      });
      if (!fresh.length) return;
      const sourceMessageIds = fresh.map((message) => message.messageId);
      solicited = fresh.some(isDirectMessage);
      let expectedSessionId = initialChannel.activeSessionId;
      let discordChannel;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const channel = this.database.getChannel(guildId, channelId);
        if (
          this.stopping ||
          channel.mode === 'paused' ||
          channel.activeSessionId !== expectedSessionId
        ) {
          if (this.stopping) retryPending = solicited;
          complete('superseded', 'inactive');
          return;
        }
        const remaining = this.database.getMessagesByIds(guildId, channelId, sourceMessageIds);
        if (remaining.length !== sourceMessageIds.length) {
          complete('superseded', 'source_removed');
          return;
        }
        context = this.contextBuilder.build({
          guildId,
          channelId,
          sourceMessageIds,
          includeNewer: true,
        });
        decision = await this.orchestrator.decideParticipation(
          context,
          sourceMessageIds,
          controller.signal,
          {
            revalidate: attempt > 0,
            previousDecision: decision,
          },
        );
        solicited ||= decision.solicited;

        // 別宛先の発言が混在するときは、一括で別sessionへ移さない。
        if (
          attempt === 0 &&
          decision.action === 'respond' &&
          !context.laterMessages.length &&
          decision.targetMessageIds.length === sourceMessageIds.length
        ) {
          await this.sessionService.maybeStartNewTopic(
            guildId,
            channelId,
            sourceMessageIds,
            controller.signal,
          );
          const afterTopic = this.database.getChannel(guildId, channelId);
          if (afterTopic.activeSessionId !== expectedSessionId) {
            const moved = this.database.getMessagesByIds(guildId, channelId, sourceMessageIds);
            if (
              moved.length !== sourceMessageIds.length ||
              !moved.every((message) => message.sessionId === afterTopic.activeSessionId)
            ) {
              complete('superseded', 'session_changed');
              return;
            }
            expectedSessionId = afterTopic.activeSessionId;
            context = this.contextBuilder.build({
              guildId,
              channelId,
              sourceMessageIds,
              includeNewer: true,
            });
            decision = await this.orchestrator.decideParticipation(
              context,
              sourceMessageIds,
              controller.signal,
              { previousDecision: decision },
            );
          }
        }
        if (!jobId) {
          jobId = randomUUID();
          this.database.createJob({
            jobId,
            guildId,
            channelId,
            sessionId: context.sessionId,
            sourceMessageIds,
            snapshotVersion: context.snapshotVersion,
          });
        }
        if (decision.action === 'silent') {
          retryPending = decision.solicited && decision.reasonCode === 'uncertain';
          complete(retryPending ? 'superseded' : 'silent', decision.reasonCode);
          return;
        }

        const latest = this.database.getChannel(guildId, channelId);
        if (latest.version !== context.snapshotVersion) {
          if (attempt === 0) continue;
          retryPending = solicited;
          complete('superseded', 'activity_changed');
          return;
        }
        context = this.contextBuilder.build({
          guildId,
          channelId,
          sourceMessageIds: decision.targetMessageIds,
          includeNewer: true,
        });
        discordChannel ??= await this.client.channels.fetch(channelId);
        if (!discordChannel?.isTextBased() || !('send' in discordChannel))
          throw new Error('discord_channel_not_sendable');
        if (!typingTimer) {
          await discordChannel.sendTyping();
          typingTimer = setInterval(() => discordChannel.sendTyping().catch(() => {}), 8000);
        }

        const result = await this.orchestrator.respond(
          context,
          decision.targetMessageIds,
          controller.signal,
          decision,
        );
        const current = this.database.getChannel(guildId, channelId);
        if (
          this.stopping ||
          current.mode === 'paused' ||
          current.activeSessionId !== expectedSessionId ||
          this.database.getMessagesByIds(guildId, channelId, decision.targetMessageIds).length !==
            decision.targetMessageIds.length
        ) {
          if (this.stopping) retryPending = solicited;
          complete('superseded', 'inactive');
          return;
        }
        if (
          current.version !== context.snapshotVersion ||
          current.contextRevision !== context.snapshotRevision
        ) {
          if (attempt === 0) continue;
          retryPending = solicited;
          complete('superseded', 'activity_changed');
          return;
        }
        if (result.action === 'silent' || !result.answer.trim()) {
          complete('silent', 'no_contribution');
          return;
        }

        const chunks = splitDiscordMessage(
          result.answer,
          Math.min(this.config.conversation.maxResponseCharacters, 1900),
        );
        let postVersion = current.version;
        for (const chunk of chunks) {
          const beforeSend = this.database.getChannel(guildId, channelId);
          if (
            this.stopping ||
            beforeSend.version !== postVersion ||
            beforeSend.mode !== context.mode ||
            beforeSend.activeSessionId !== context.sessionId
          ) {
            complete(firstResponseId ? 'posted' : 'superseded', 'activity_changed');
            return;
          }
          const sent = await discordChannel.send({
            content: chunk,
            allowedMentions: { parse: [] },
          });
          firstResponseId ??= sent.id;
          this.database.ingestMessage(
            {
              messageId: sent.id,
              guildId,
              channelId,
              sessionId: context.sessionId,
              authorId: this.client.user.id,
              authorName: this.client.user.username,
              authorType: 'bot',
              content: chunk,
              replyToMessageId:
                decision.targetMessageIds.length === 1 ? decision.targetMessageIds[0] : null,
              createdAt: sent.createdAt.toISOString(),
            },
            this.config.privacy.messageRetentionHours,
          );
          // 送信待ち中の人間の新着まで「自分の更新」として受け入れない。
          postVersion += 1;
        }
        complete('posted', decision.reasonCode);
        this.logger.info(
          {
            event: 'response_posted',
            guildId,
            channelId,
            sourceMessageCount: sourceMessageIds.length,
            usedWeb: result.usedWeb,
            promptTokens: result.promptTokens,
            outputTokens: result.outputTokens,
            latencyMs: Math.round(result.totalDurationNs / 1_000_000),
          },
          'response posted',
        );
        return;
      }
    } catch (error) {
      if (this.stopping && solicited && !firstResponseId) retryPending = true;
      if (jobId)
        this.database.finishJob(jobId, firstResponseId ? 'posted' : 'failed_permanent', {
          discordResponseId: firstResponseId,
          errorCategory: error.name,
        });
      this.logger.error(
        { event: 'turn_failed', guildId, channelId, error: error.message },
        'turn failed',
      );
      try {
        const latest = this.database.getChannel(guildId, channelId);
        if (
          !solicited ||
          firstResponseId ||
          this.stopping ||
          !context ||
          latest.mode === 'paused' ||
          latest.activeSessionId !== context.sessionId ||
          latest.version !== context.snapshotVersion ||
          latest.contextRevision !== context.snapshotRevision
        )
          return;
        this.lastFailureNotices ??= new Map();
        if (Date.now() - (this.lastFailureNotices.get(channelId) ?? 0) < 60000) return;
        const discordChannel = await this.client.channels.fetch(channelId);
        if (discordChannel?.isTextBased() && 'send' in discordChannel) {
          await discordChannel.send({
            content: 'ごめん、今ちょっと応答を作れなかった。少ししてからもう一度話しかけてみて。',
            allowedMentions: { parse: [] },
          });
          this.lastFailureNotices.set(channelId, Date.now());
        }
      } catch {
        // Discord側も失敗している場合はログだけに留める。
      }
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (!retryPending) this.database.markMessagesProcessed(messageIds);
      try {
        const active = this.database.getChannel(guildId, channelId);
        if (!this.stopping && active?.activeSessionId && active.mode !== 'paused') {
          await this.sessionService.maybeRefreshSummary(active.activeSessionId, controller.signal);
        }
        this.recoverChannel(guildId, channelId);
      } catch (error) {
        this.logger.warn(
          { event: 'turn_maintenance_failed', reason: error.name },
          'turn maintenance failed',
        );
      } finally {
        this.activeControllers.delete(controller);
      }
    }
  }
}
