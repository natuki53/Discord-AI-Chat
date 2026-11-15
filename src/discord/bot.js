import { randomUUID } from 'node:crypto';
import { Client, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import { channelConfig } from '../config/load-config.js';
import { sanitizeDisplayName, splitDiscordMessage } from '../shared/text.js';
import { handleCommand } from './commands.js';

const ACCEPTED_MESSAGE_TYPES = new Set([MessageType.Default, MessageType.Reply]);

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

  async onMessageCreate(message) {
    if (this.stopping || !this.isConfiguredMessage(message)) return;
    if (message.author.bot || message.webhookId || !ACCEPTED_MESSAGE_TYPES.has(message.type))
      return;
    const configured = channelConfig(this.config, message.channelId);
    const channel = this.database.getChannel(message.guildId, message.channelId);
    if (channel?.mode === 'paused') return;
    const content = message.content.trim().slice(0, 8000);
    if (!content) return;

    const session = this.sessionService.ensureSession(
      message.guildId,
      message.channelId,
      configured,
      message.createdAt,
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
        createdAt: message.createdAt.toISOString(),
      },
      this.config.privacy.messageRetentionHours,
    );
    if (!result.isNew) return;

    const effectiveMode = this.database.getChannel(message.guildId, message.channelId).mode;
    if (effectiveMode === 'mention') {
      let isReplyToBot = false;
      if (message.reference?.messageId) {
        try {
          const referenced = await message.channel.messages.fetch(message.reference.messageId);
          isReplyToBot = referenced.author.id === this.client.user.id;
        } catch {
          isReplyToBot = false;
        }
      }
      if (!message.mentions.has(this.client.user) && !isReplyToBot) {
        this.database.markMessagesProcessed([message.id]);
        return;
      }
    }

    this.scheduler.enqueue({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
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
      if (message.author?.bot || !message.content) return;
      this.database.updateMessage({
        messageId: message.id,
        content: message.content.trim().slice(0, 8000),
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
      const channel = this.database.getChannel(this.config.discord.guildId, configured.id);
      if (channel?.mode === 'paused') continue;
      const ids = this.database.getUnprocessedMessages(this.config.discord.guildId, configured.id);
      for (const messageId of ids) {
        this.scheduler.enqueue({
          guildId: this.config.discord.guildId,
          channelId: configured.id,
          messageId,
        });
      }
    }
  }

  async processTurn({ guildId, channelId, messageIds }) {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let jobId;
    let typingTimer;
    try {
      await this.sessionService.maybeStartNewTopic(
        guildId,
        channelId,
        messageIds,
        controller.signal,
      );
      let context = this.contextBuilder.build({ guildId, channelId, sourceMessageIds: messageIds });
      if (context.mode === 'paused') {
        this.database.markMessagesProcessed(messageIds);
        return;
      }
      jobId = randomUUID();
      this.database.createJob({
        jobId,
        guildId,
        channelId,
        sessionId: context.sessionId,
        sourceMessageIds: messageIds,
        snapshotVersion: context.snapshotVersion,
      });

      const discordChannel = await this.client.channels.fetch(channelId);
      if (!discordChannel?.isTextBased() || !('send' in discordChannel)) {
        throw new Error('discord_channel_not_sendable');
      }
      await discordChannel.sendTyping();
      typingTimer = setInterval(() => discordChannel.sendTyping().catch(() => {}), 8000);

      let result = await this.orchestrator.respond(context, messageIds, controller.signal);
      let currentChannel = this.database.getChannel(guildId, channelId);
      if (
        currentChannel.mode === 'paused' ||
        currentChannel.activeSessionId !== context.sessionId
      ) {
        this.database.finishJob(jobId, 'superseded');
        this.database.markMessagesProcessed(messageIds);
        return;
      }
      if (currentChannel.version !== context.snapshotVersion) {
        context = this.contextBuilder.build({ guildId, channelId, sourceMessageIds: messageIds });
        result = await this.orchestrator.respond(context, messageIds, controller.signal);
        currentChannel = this.database.getChannel(guildId, channelId);
        if (
          currentChannel.mode === 'paused' ||
          currentChannel.activeSessionId !== context.sessionId
        ) {
          this.database.finishJob(jobId, 'superseded');
          this.database.markMessagesProcessed(messageIds);
          return;
        }
      }

      if (result.action === 'silent' || !result.answer.trim()) {
        this.database.finishJob(jobId, 'posted');
        this.database.markMessagesProcessed(messageIds);
        return;
      }

      const chunks = splitDiscordMessage(
        result.answer,
        Math.min(this.config.conversation.maxResponseCharacters, 1900),
      );
      let firstResponseId = null;
      for (const chunk of chunks) {
        const sent = await discordChannel.send({ content: chunk, allowedMentions: { parse: [] } });
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
            replyToMessageId: null,
            createdAt: sent.createdAt.toISOString(),
          },
          this.config.privacy.messageRetentionHours,
        );
      }
      this.database.finishJob(jobId, 'posted', { discordResponseId: firstResponseId });
      this.database.markMessagesProcessed(messageIds);
      this.logger.info(
        {
          event: 'response_posted',
          guildId,
          channelId,
          sourceMessageCount: messageIds.length,
          usedWeb: result.usedWeb,
          promptTokens: result.promptTokens,
          outputTokens: result.outputTokens,
          latencyMs: Math.round(result.totalDurationNs / 1_000_000),
        },
        'response posted',
      );
      await this.sessionService.maybeRefreshSummary(context.sessionId);
    } catch (error) {
      if (jobId) this.database.finishJob(jobId, 'failed_permanent', { errorCategory: error.name });
      this.database.markMessagesProcessed(messageIds);
      this.logger.error(
        { event: 'turn_failed', guildId, channelId, error: error.message },
        'turn failed',
      );
      try {
        const discordChannel = await this.client.channels.fetch(channelId);
        if (discordChannel?.isTextBased() && 'send' in discordChannel) {
          await discordChannel.send({
            content: 'ごめん、今ちょっと応答を作れなかった。少ししてからもう一度話しかけてみて。',
            allowedMentions: { parse: [] },
          });
        }
      } catch {
        // Discord側も失敗している場合はログだけに留める。
      }
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      this.activeControllers.delete(controller);
    }
  }
}
