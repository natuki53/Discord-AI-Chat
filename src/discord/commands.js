import { randomUUID } from 'node:crypto';
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { sanitizeDisplayName } from '../shared/text.js';

const ephemeral = { flags: MessageFlags.Ephemeral };

export function commandDefinitions() {
  return [
    new SlashCommandBuilder().setName('ai-status').setDescription('AI Botの稼働状態を表示します'),
    new SlashCommandBuilder()
      .setName('ai-privacy')
      .setDescription('AI Botが保存するデータと削除方法を表示します'),
    new SlashCommandBuilder()
      .setName('ai-preferences')
      .setDescription('自分向けの明示設定を管理します')
      .addSubcommand((subcommand) =>
        subcommand.setName('show').setDescription('現在の設定を表示します'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('自分向けの設定を変更します')
          .addStringOption((option) =>
            option.setName('name').setDescription('Botから呼ばれたい名前（32文字以内）'),
          )
          .addStringOption((option) =>
            option
              .setName('tone')
              .setDescription('口調')
              .addChoices(
                { name: '自動', value: 'auto' },
                { name: 'カジュアル', value: 'casual' },
                { name: '普通', value: 'neutral' },
                { name: '丁寧', value: 'formal' },
              ),
          )
          .addStringOption((option) =>
            option
              .setName('length')
              .setDescription('回答の長さ')
              .addChoices(
                { name: '短め', value: 'short' },
                { name: '普通', value: 'normal' },
                { name: '詳しく', value: 'detailed' },
              ),
          )
          .addStringOption((option) =>
            option
              .setName('banter')
              .setDescription('ネタへの乗り方')
              .addChoices(
                { name: '控えめ', value: 'low' },
                { name: '普通', value: 'normal' },
                { name: '積極的', value: 'high' },
              ),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName('reset').setDescription('自分の設定を削除します'),
      ),
    new SlashCommandBuilder()
      .setName('ai-profile')
      .setDescription('本人が提供するプロフィール情報を管理します')
      .addSubcommand((subcommand) =>
        subcommand.setName('show').setDescription('現在のプロフィール情報を表示します'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('自己紹介と自分の公開リンクを登録します')
          .addBooleanOption((option) =>
            option
              .setName('consent')
              .setDescription('本人の情報であり、回答調整への利用に同意します')
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('description')
              .setDescription('本人による自己紹介（300文字以内）')
              .setMaxLength(300),
          )
          .addStringOption((option) =>
            option.setName('link-1').setDescription('自分の公開プロフィールURL').setMaxLength(500),
          )
          .addStringOption((option) =>
            option
              .setName('link-2')
              .setDescription('自分の公開プロフィールURL（2件目）')
              .setMaxLength(500),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName('refresh').setDescription('登録済み公開リンクを再取得します'),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName('reset').setDescription('プロフィール情報を削除します'),
      ),
    new SlashCommandBuilder()
      .setName('ai-forget')
      .setDescription('このサーバー内で保存中の自分のデータを削除します')
      .addBooleanOption((option) =>
        option.setName('confirm').setDescription('削除を確認する').setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('ai-mode')
      .setDescription('このチャンネルのAI応答モードを変更します')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('応答モード')
          .setRequired(true)
          .addChoices(
            { name: '全会話ターンへ応答', value: 'all' },
            { name: '自然に参加', value: 'ambient' },
            { name: 'メンション時だけ', value: 'mention' },
            { name: '停止', value: 'paused' },
          ),
      ),
    new SlashCommandBuilder()
      .setName('ai-pause')
      .setDescription('このチャンネルのAI応答を停止します')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('ai-resume')
      .setDescription('このチャンネルのAI応答を再開します')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('ai-context-reset')
      .setDescription('このチャンネルの現在の会話文脈をリセットします')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('ai-topic-reset')
      .setDescription('このチャンネルの話題の流れをここで区切ります')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('ai-report')
      .setDescription('AI Botの問題を運用者へ報告します')
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('問題の内容（メッセージ本文は自動収集しません）')
          .setRequired(true)
          .setMaxLength(500),
      ),
  ].map((command) => command.toJSON());
}

function isAdmin(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleIds = interaction.member?.roles?.cache?.map((role) => role.id) ?? [];
  return config.discord.adminRoleIds.some((roleId) => roleIds.includes(roleId));
}

function preferenceText(preference) {
  if (!preference) return '明示設定はありません。現在の会話に合わせて自動調整します。';
  return [
    `呼び名: ${preference.preferredName ?? '自動'}`,
    `口調: ${preference.tone}`,
    `回答の長さ: ${preference.responseLength}`,
    `ネタへの反応: ${preference.banterLevel}`,
  ].join('\n');
}

function profileText(profile) {
  if (!profile) return '本人が登録したプロフィール情報はありません。';
  return [
    `自己紹介: ${profile.selfDescription ?? '未設定'}`,
    `公開リンク: ${profile.links.length ? profile.links.join('\n') : '未設定'}`,
    `明記情報の要約: ${profile.sourceSummary ?? '取得できる情報なし'}`,
    `最終更新: ${profile.refreshedAt}`,
    'この情報から性格・保護属性・人間関係は推測しません。',
  ].join('\n');
}

export async function handleCommand(interaction, services) {
  if (!interaction.isChatInputCommand()) return;
  const {
    config,
    database,
    model,
    searchProvider,
    profileService,
    scheduler,
    sessionService,
    logger,
  } = services;
  if (interaction.guildId !== config.discord.guildId) {
    await interaction.reply({ content: 'このサーバーは対象外です。', ...ephemeral });
    return;
  }

  const name = interaction.commandName;
  if (name === 'ai-status') {
    const channel = database.getChannel(interaction.guildId, interaction.channelId);
    const [llmHealth, webHealth] = await Promise.allSettled([
      model.health(),
      config.web.enabled && searchProvider
        ? searchProvider.health()
        : Promise.resolve({ ok: false }),
    ]);
    const llmOk = llmHealth.status === 'fulfilled' && llmHealth.value.ok;
    const webOk = webHealth.status === 'fulfilled' && webHealth.value.ok;
    await interaction.reply({
      content: [
        `状態: ${llmOk ? '稼働中' : 'LLM異常'}`,
        `モード: ${channel?.mode ?? '対象外チャンネル'}`,
        `モデル: ${config.llm.model}`,
        `Web検索: ${config.web.enabled ? (webOk ? '利用可能' : '一時利用不可') : '無効'}`,
        `待機メッセージ: ${scheduler.queueLength(interaction.channelId)}`,
        `保存期間: ${config.privacy.messageRetentionHours}時間`,
      ].join('\n'),
    });
    return;
  }

  if (name === 'ai-privacy') {
    await interaction.reply({
      content: [
        `会話の流れを保つため、対象チャンネルの本文と会話要約を最大${config.privacy.messageRetentionHours}時間保存します。`,
        '過去ログから個人の性格・属性・人間関係を分析または保存しません。メッセージをAIの学習にも使いません。',
        '最新情報を調べる場合は、個人情報を除いた検索語を検索サービスへ送ります。',
        '本人が /ai-profile で任意登録した自己紹介と自分の公開リンクは、明記された活動・興味だけを回答調整へ利用します。',
        '自分の設定は /ai-preferences と /ai-profile、保存中データの削除は /ai-forget で行えます。',
      ].join('\n'),
    });
    return;
  }

  if (name === 'ai-preferences') {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'show') {
      await interaction.reply({
        content: preferenceText(database.getPreference(interaction.guildId, interaction.user.id)),
        ...ephemeral,
      });
      return;
    }
    if (subcommand === 'reset') {
      const removed = database.resetPreference(interaction.guildId, interaction.user.id);
      await interaction.reply({
        content: removed
          ? '自分向けの明示設定を削除しました。'
          : '削除する設定はありませんでした。',
        ...ephemeral,
      });
      return;
    }

    const previous = database.getPreference(interaction.guildId, interaction.user.id) ?? {
      preferredName: null,
      tone: 'auto',
      responseLength: 'normal',
      banterLevel: 'normal',
    };
    const requestedName = interaction.options.getString('name');
    const preferredName =
      requestedName === null ? previous.preferredName : sanitizeDisplayName(requestedName);
    if (requestedName !== null && !preferredName) {
      await interaction.reply({ content: '呼び名に使用できる文字がありません。', ...ephemeral });
      return;
    }
    const saved = database.setPreference(interaction.guildId, interaction.user.id, {
      preferredName,
      tone: interaction.options.getString('tone') ?? previous.tone,
      responseLength: interaction.options.getString('length') ?? previous.responseLength,
      banterLevel: interaction.options.getString('banter') ?? previous.banterLevel,
    });
    await interaction.reply({ content: `設定しました。\n${preferenceText(saved)}`, ...ephemeral });
    return;
  }

  if (name === 'ai-profile') {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'show') {
      await interaction.reply({
        content: profileText(database.getProfile(interaction.guildId, interaction.user.id)),
        ...ephemeral,
      });
      return;
    }
    if (subcommand === 'reset') {
      const removed = database.resetProfile(interaction.guildId, interaction.user.id);
      await interaction.reply({
        content: removed
          ? '本人登録のプロフィール情報を削除しました。'
          : '削除するプロフィール情報はありませんでした。',
        ...ephemeral,
      });
      return;
    }

    const existing = database.getProfile(interaction.guildId, interaction.user.id);
    if (subcommand === 'refresh' && !existing) {
      await interaction.reply({
        content: '先に /ai-profile set で本人の情報を登録してください。',
        ...ephemeral,
      });
      return;
    }
    if (subcommand === 'set' && !interaction.options.getBoolean('consent', true)) {
      await interaction.reply({
        content: '同意がないため登録しませんでした。',
        ...ephemeral,
      });
      return;
    }

    await interaction.deferReply(ephemeral);
    try {
      const prepared = await profileService.prepare({
        selfDescription:
          subcommand === 'set'
            ? interaction.options.getString('description')
            : existing.selfDescription,
        links:
          subcommand === 'set'
            ? [interaction.options.getString('link-1'), interaction.options.getString('link-2')]
            : existing.links,
      });
      const saved = database.setProfile(interaction.guildId, interaction.user.id, prepared);
      const warning = prepared.failedHosts.length
        ? `\n取得できなかったリンク: ${prepared.failedHosts.join(', ')}`
        : '';
      await interaction.editReply(`登録しました。\n${profileText(saved)}${warning}`);
    } catch (error) {
      logger.warn(
        { event: 'profile_update_failed', error: error.message },
        'profile update failed',
      );
      await interaction.editReply(
        error.userFacing
          ? error.message
          : 'プロフィールの取得または要約に失敗しました。時間を置いて再試行してください。',
      );
    }
    return;
  }

  if (name === 'ai-forget') {
    if (!interaction.options.getBoolean('confirm', true)) {
      await interaction.reply({ content: '削除はキャンセルされました。', ...ephemeral });
      return;
    }
    const result = database.forgetUser(interaction.guildId, interaction.user.id);
    database.addAuditEvent({
      eventId: randomUUID(),
      actorId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      action: 'forget_completed',
      metadata: result,
    });
    await interaction.reply({
      content: `保存中の本文${result.messages}件、設定${result.preferences}件、プロフィール${result.profiles}件を削除しました。`,
      ...ephemeral,
    });
    return;
  }

  if (['ai-mode', 'ai-pause', 'ai-resume', 'ai-context-reset', 'ai-topic-reset'].includes(name)) {
    if (!isAdmin(interaction, config)) {
      await interaction.reply({
        content: 'この操作にはサーバー管理権限が必要です。',
        ...ephemeral,
      });
      return;
    }
    const configured = config.discord.channels.some(
      (channel) => channel.id === interaction.channelId,
    );
    if (!configured) {
      await interaction.reply({ content: 'このチャンネルはAI Botの対象外です。', ...ephemeral });
      return;
    }

    let message;
    if (name === 'ai-resume') {
      const channel = database.resumeChannel(interaction.guildId, interaction.channelId);
      message = `応答を再開しました。モード: ${channel.mode}`;
    } else if (name === 'ai-context-reset' || name === 'ai-topic-reset') {
      sessionService.reset(interaction.guildId, interaction.channelId);
      message = '話題の流れをリセットしました。次の発言から新しい会話として扱います。';
    } else {
      const mode = name === 'ai-pause' ? 'paused' : interaction.options.getString('mode', true);
      const channel = database.setChannelMode(interaction.guildId, interaction.channelId, mode);
      message = `モードを ${channel.mode} に変更しました。`;
    }
    database.addAuditEvent({
      eventId: randomUUID(),
      actorId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      action: name,
      metadata: {},
    });
    await interaction.reply({ content: message });
    return;
  }

  if (name === 'ai-report') {
    const description = interaction.options.getString('description', true);
    database.addAuditEvent({
      eventId: randomUUID(),
      actorId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      action: 'user_report',
      metadata: { description: description.slice(0, 500) },
    });
    logger.warn({
      event: 'user_report',
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    await interaction.reply({
      content: '報告を記録しました。ありがとうございます。',
      ...ephemeral,
    });
  }
}
