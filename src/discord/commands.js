import { randomUUID } from 'node:crypto';
import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { sanitizeDisplayName } from '../shared/text.js';
import { CLAUDE_MODELS, EFFORT_LEVELS } from '../ai/model-settings.js';

const ephemeral = { flags: MessageFlags.Ephemeral };

function changeCallout(title, description, { color = 0x5865f2, fields = [] } = {}) {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
  if (fields.length) embed.addFields(fields);
  return { embeds: [embed] };
}

export function commandDefinitions() {
  return [
    new SlashCommandBuilder().setName('ai-status').setDescription('AI Botの稼働状態を表示します'),
    new SlashCommandBuilder()
      .setName('ai-image')
      .setDescription('描いてほしい内容からイラストを1枚生成します')
      .addStringOption((option) =>
        option
          .setName('prompt')
          .setDescription('描いてほしい内容')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(2000),
      )
      .addStringOption((option) =>
        option
          .setName('aspect')
          .setDescription('画像の形')
          .addChoices(
            { name: '正方形', value: 'square' },
            { name: '横長', value: 'landscape' },
            { name: '縦長', value: 'portrait' },
          ),
      ),
    new SlashCommandBuilder()
      .setName('ai-model')
      .setDescription('サーバー全体のClaudeモデルとeffortを確認・変更します')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName('model')
          .setDescription('使用するモデル（省略すると維持）')
          .addChoices(
            { name: 'Claude Haiku 5.5', value: 'haiku' },
            { name: 'Claude Sonnet 5.5', value: 'sonnet' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('effort')
          .setDescription('推論の強さ（省略すると維持）')
          .addChoices(...EFFORT_LEVELS.map((value) => ({ name: value, value }))),
      ),
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
    modelSettings,
    imageService,
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
        `Effort: ${config.llm.effort}`,
        `画像生成: ${imageService?.available ? '利用可能' : '未設定・無効'}`,
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
        '返答・要約・話題判定・プロフィール抽出のため、必要な会話文脈と本人登録情報、参照したWeb資料をAnthropicのClaude APIへ送信します。API側の保持・削除はAnthropicの契約・設定に従います。',
        '過去ログから個人の性格・属性・人間関係を分析または保存しません。メッセージをAIの学習にも使いません。',
        '最新情報を調べる場合は、個人情報を除いた検索語を検索サービスへ送ります。',
        '/ai-imageの依頼文はSVGイラストを描くためClaude APIへ送信します。この処理に会話履歴やプロフィールは含めません。PNG画像とSVGファイルはDiscordへ添付し、BotのDBやディスクには保存しません。',
        '本人が /ai-profile で任意登録した自己紹介と自分の公開リンクは、明記された活動・興味だけを回答調整へ利用します。',
        '自分の設定は /ai-preferences と /ai-profile、保存中データの削除は /ai-forget で行えます。',
      ].join('\n'),
    });
    return;
  }

  if (name === 'ai-image') {
    const channel = database.getChannel(interaction.guildId, interaction.channelId);
    if (!config.discord.channels.some((configured) => configured.id === interaction.channelId)) {
      await interaction.reply({ content: 'このチャンネルはAI Botの対象外です。', ...ephemeral });
      return;
    }
    if (channel?.mode === 'paused') {
      await interaction.reply({
        content: 'このチャンネルではAI応答を停止しています。',
        ...ephemeral,
      });
      return;
    }
    if (!imageService?.available) {
      await interaction.reply({
        content: '画像生成の接続設定がまだ完了していません。管理者に確認してください。',
        ...ephemeral,
      });
      return;
    }
    if (
      interaction.appPermissions &&
      !interaction.appPermissions.has(PermissionFlagsBits.AttachFiles)
    ) {
      await interaction.reply({
        content: 'Botに「ファイルを添付」権限を付与してください。',
        ...ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    let generated;
    try {
      generated = await imageService.generate({
        userId: interaction.user.id,
        prompt: interaction.options.getString('prompt', true),
        aspect: interaction.options.getString('aspect') ?? 'square',
        maxBytes: interaction.attachmentSizeLimit ?? 10 * 1024 * 1024,
      });
    } catch (error) {
      logger.warn(
        { event: 'image_generation_failed', error: error.name, status: error.status },
        'image generation failed',
      );
      await interaction.editReply({
        content: error.userFacing
          ? error.message
          : '画像を生成できませんでした。時間を置いて再試行してください。',
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.editReply({
      content: 'Claudeが描いたSVGイラストです。プレビュー用のPNGと編集用のSVGを添付しました。',
      files: [
        new AttachmentBuilder(generated.data, {
          name: generated.filename,
          description: '依頼に基づいてAIで生成したイラスト',
        }),
        ...(generated.source
          ? [new AttachmentBuilder(generated.source.data, { name: generated.source.filename })]
          : []),
      ],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (name === 'ai-model') {
    if (!isAdmin(interaction, config)) {
      await interaction.reply({
        content: 'この操作にはサーバー管理権限が必要です。',
        ...ephemeral,
      });
      return;
    }
    const family = interaction.options.getString('model');
    const effort = interaction.options.getString('effort');
    if (family === null && effort === null) {
      const current = modelSettings.current();
      await interaction.reply({
        content: `モデル: ${current.model}\nEffort: ${current.effort}\nこのサーバーの全対象チャンネルへ適用します。`,
      });
      return;
    }
    if (
      (family !== null && !Object.hasOwn(CLAUDE_MODELS, family)) ||
      (effort !== null && !EFFORT_LEVELS.includes(effort))
    ) {
      await interaction.reply({
        content: 'モデルはhaiku/sonnet、effortはlow/medium/high/xhigh/maxから選んでください。',
        ...ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    let settings;
    try {
      settings = await modelSettings.update({ family, effort });
    } catch (error) {
      logger.warn(
        { event: 'model_settings_failed', error: error.message },
        'model settings failed',
      );
      await interaction.editReply(
        '設定を変更できませんでした。現在のモデルとeffortを維持しています。時間を置いて再試行してください。',
      );
      return;
    }
    try {
      database.addAuditEvent({
        eventId: randomUUID(),
        actorId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        action: 'ai-model',
        metadata: settings,
      });
    } catch (error) {
      logger.warn(
        { event: 'model_settings_audit_failed', error: error.message },
        'model settings audit failed',
      );
    }
    await interaction.editReply(
      changeCallout(
        '⚙️ Claudeの設定を変更しました',
        '次のAPI呼び出しから、サーバー内の全対象チャンネルへ適用します。再起動後も引き継ぎます。',
        {
          fields: [
            { name: 'モデル', value: settings.model, inline: true },
            { name: 'Effort', value: settings.effort, inline: true },
          ],
        },
      ),
    );
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
      await interaction.reply(
        removed
          ? {
              ...changeCallout(
                '🗑️ 個人設定を削除しました',
                '呼び名・口調・回答長・ネタへの反応を初期状態へ戻しました。',
                { color: 0xed4245 },
              ),
              ...ephemeral,
            }
          : { content: '削除する設定はありませんでした。', ...ephemeral },
      );
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
    await interaction.reply({
      ...changeCallout('✅ 個人設定を更新しました', '次の会話から反映します。', {
        color: 0x57f287,
        fields: [
          { name: '呼び名', value: saved.preferredName ?? '自動', inline: true },
          { name: '口調', value: saved.tone, inline: true },
          { name: '回答の長さ', value: saved.responseLength, inline: true },
          { name: 'ネタへの反応', value: saved.banterLevel, inline: true },
        ],
      }),
      ...ephemeral,
    });
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
      await interaction.reply(
        removed
          ? {
              ...changeCallout(
                '🗑️ プロフィール情報を削除しました',
                '登録した自己紹介・公開リンク・明記情報の要約を削除しました。',
                { color: 0xed4245 },
              ),
              ...ephemeral,
            }
          : { content: '削除するプロフィール情報はありませんでした。', ...ephemeral },
      );
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
      await interaction.editReply({
        ...changeCallout(
          subcommand === 'refresh'
            ? '🔄 プロフィール情報を更新しました'
            : '✅ プロフィール情報を登録しました',
          `次の本人情報が必要な会話から反映します。${warning}`,
          {
            color: 0x57f287,
            fields: [
              { name: '自己紹介', value: saved.selfDescription ?? '未設定' },
              {
                name: '公開リンク',
                value: saved.links.length ? saved.links.join('\n') : '未設定',
              },
              { name: '明記情報の要約', value: saved.sourceSummary ?? '取得できる情報なし' },
            ],
          },
        ),
      });
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
      ...changeCallout(
        '🗑️ 保存データを削除しました',
        'このサーバー内の本人データを削除しました。',
        {
          color: 0xed4245,
          fields: [
            { name: 'メッセージ本文', value: `${result.messages}件`, inline: true },
            { name: '個人設定', value: `${result.preferences}件`, inline: true },
            { name: 'プロフィール', value: `${result.profiles}件`, inline: true },
          ],
        },
      ),
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

    let response;
    if (name === 'ai-resume') {
      const channel = database.resumeChannel(interaction.guildId, interaction.channelId);
      response = changeCallout(
        '▶️ AI応答を再開しました',
        `現在の応答モードは **${channel.mode}** です。`,
        { color: 0x57f287 },
      );
    } else if (name === 'ai-context-reset' || name === 'ai-topic-reset') {
      sessionService.reset(interaction.guildId, interaction.channelId);
      response = changeCallout(
        '🔄 話題の流れをリセットしました',
        '次の発言から新しい会話として扱います。',
        { color: 0xfee75c },
      );
    } else {
      const mode = name === 'ai-pause' ? 'paused' : interaction.options.getString('mode', true);
      const channel = database.setChannelMode(interaction.guildId, interaction.channelId, mode);
      response = changeCallout(
        channel.mode === 'paused' ? '⏸️ AI応答を停止しました' : '⚙️ 応答モードを変更しました',
        `現在の応答モードは **${channel.mode}** です。`,
        { color: channel.mode === 'paused' ? 0xed4245 : 0x5865f2 },
      );
    }
    database.addAuditEvent({
      eventId: randomUUID(),
      actorId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      action: name,
      metadata: {},
    });
    await interaction.reply(response);
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
