import { randomUUID } from 'node:crypto';
import {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { sanitizeDisplayName } from '../shared/text.js';
import {
  channelMenu,
  confirmationMenu,
  helpMenu,
  homeMenu,
  LENGTHS,
  MODEL_PRESETS,
  personalMenu,
  privacyMenu,
  profileModal,
  reportModal,
  RESPONSE_MODES,
  TONES,
} from './command-menu.js';

const ephemeral = { flags: MessageFlags.Ephemeral };
const profileOperations = new WeakMap();
const confirmations = new WeakMap();
const adminActions = new Set(['channel', 'mode', 'quality', 'topic-reset', 'diagnostics']);
const buttonActions = new Set([
  'home',
  'personal',
  'help',
  'privacy',
  'channel',
  'profile-edit',
  'profile-refresh',
  'personal-reset',
  'personal-reset-confirm',
  'forget',
  'forget-confirm',
  'report',
  'topic-reset',
  'diagnostics',
]);
const selectActions = new Set(['mode', 'quality', 'tone', 'length']);
const modalActions = new Set(['profile-save', 'report-save']);

export function commandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName('ai')
      .setDescription('使い方・自分の設定・チャンネル設定を開きます'),
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
          .setDescription('画像の形（省略すると正方形）')
          .addChoices(
            { name: '正方形', value: 'square' },
            { name: '横長', value: 'landscape' },
            { name: '縦長', value: 'portrait' },
          ),
      ),
  ].map((command) => command.toJSON());
}
function isAdmin(interaction, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleIds =
    interaction.member?.roles?.cache?.map((role) => role.id) ??
    (Array.isArray(interaction.member?.roles) ? interaction.member.roles : []);
  return config.discord.adminRoleIds.some((roleId) => roleIds.includes(roleId));
}
function menuState(interaction, services) {
  return {
    userId: interaction.user.id,
    channel: services.database.getChannel(interaction.guildId, interaction.channelId),
    preference: services.database.getPreference(interaction.guildId, interaction.user.id),
    profile: services.database.getProfile(interaction.guildId, interaction.user.id),
    settings: services.modelSettings.current(),
    admin: isAdmin(interaction, services.config),
    imageAvailable: Boolean(services.imageService?.available),
  };
}
function operationMap(services) {
  if (!profileOperations.has(services)) profileOperations.set(services, new Map());
  return profileOperations.get(services);
}
function cancelProfileOperation(interaction, services) {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  const operations = operationMap(services);
  operations.get(key)?.abort();
  operations.delete(key);
}
function audit(interaction, services, action, metadata = {}) {
  services.database.addAuditEvent({
    eventId: randomUUID(),
    actorId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    action,
    metadata,
  });
}
function auditChange(interaction, services, action, metadata) {
  try {
    audit(interaction, services, action, metadata);
  } catch (error) {
    services.logger.warn({ event: 'settings_audit_failed', error: error.name });
  }
}
async function display(interaction, payload) {
  if (interaction.deferred) return interaction.editReply(payload);
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.())
    return interaction.update(payload);
  return interaction.reply({ ...payload, ...ephemeral });
}
function preferences(interaction, services) {
  return (
    services.database.getPreference(interaction.guildId, interaction.user.id) ?? {
      preferredName: null,
      tone: 'auto',
      responseLength: 'normal',
      banterLevel: 'normal',
    }
  );
}
async function saveProfile(interaction, services, refresh) {
  const existing = services.database.getProfile(interaction.guildId, interaction.user.id);
  if (refresh && !existing?.links.length) {
    await display(
      interaction,
      personalMenu(menuState(interaction, services), '更新する公開リンクがありません。'),
    );
    return;
  }
  const requestedName = refresh ? null : interaction.fields.getTextInputValue('name').trim();
  const description = refresh
    ? existing.selfDescription
    : interaction.fields.getTextInputValue('description').trim();
  const links = refresh
    ? existing.links
    : interaction.fields
        .getTextInputValue('links')
        .split(/\r?\n/u)
        .map((link) => link.trim())
        .filter(Boolean);
  if (requestedName && !sanitizeDisplayName(requestedName)) {
    await interaction.reply({ content: '呼び名に使用できる文字がありません。', ...ephemeral });
    return;
  }
  cancelProfileOperation(interaction, services);
  const controller = new AbortController();
  const key = `${interaction.guildId}:${interaction.user.id}`;
  const operations = operationMap(services);
  operations.set(key, controller);
  if (refresh) await interaction.deferUpdate();
  else await interaction.deferReply(ephemeral);
  try {
    const prepared =
      description || links.length
        ? await services.profileService.prepare({
            selfDescription: description,
            links,
            signal: controller.signal,
          })
        : null;
    if (controller.signal.aborted || operations.get(key) !== controller) {
      await interaction.editReply({
        content: '別の操作が行われたため、プロフィールは保存しませんでした。',
        components: [],
        embeds: [],
      });
      return;
    }
    if (prepared) services.database.setProfile(interaction.guildId, interaction.user.id, prepared);
    else services.database.resetProfile(interaction.guildId, interaction.user.id);
    if (!refresh)
      services.database.setPreference(interaction.guildId, interaction.user.id, {
        ...preferences(interaction, services),
        preferredName: sanitizeDisplayName(requestedName) || null,
      });
    const warning = prepared?.failedHosts?.length ? ' 一部のリンクは取得できませんでした。' : '';
    await interaction.editReply(
      personalMenu(menuState(interaction, services), `自分の情報を保存しました。${warning}`),
    );
  } catch (error) {
    services.logger.warn({ event: 'profile_update_failed', error: error.name });
    await interaction.editReply(
      personalMenu(
        menuState(interaction, services),
        controller.signal.aborted
          ? 'プロフィールの保存を取り消しました。'
          : error.userFacing
            ? error.message
            : 'プロフィールを取得できませんでした。設定は変更していません。',
      ),
    );
  } finally {
    if (operations.get(key) === controller) operations.delete(key);
  }
}

async function generateImage(interaction, services) {
  const { config, database, imageService, logger } = services;
  const channel = database.getChannel(interaction.guildId, interaction.channelId);
  let problem;
  if (!config.discord.channels.some((item) => item.id === interaction.channelId))
    problem = 'このチャンネルはAI Botの対象外です。';
  else if (channel?.mode === 'paused') problem = 'このチャンネルではAI応答を停止しています。';
  else if (!imageService?.available)
    problem = '画像生成は現在利用できません。管理者に確認してください。';
  else if (
    interaction.appPermissions &&
    !interaction.appPermissions.has(PermissionFlagsBits.AttachFiles)
  )
    problem = 'Botに「ファイルを添付」権限を付与してください。';
  if (problem) {
    await interaction.reply({ content: problem, ...ephemeral });
    return;
  }
  await interaction.deferReply();
  try {
    const generated = await imageService.generate({
      userId: interaction.user.id,
      prompt: interaction.options.getString('prompt', true),
      aspect: interaction.options.getString('aspect') ?? 'square',
      maxBytes: interaction.attachmentSizeLimit ?? 10 * 1024 * 1024,
    });
    await interaction.editReply({
      content: 'イラストを生成しました。PNGと編集用のSVGを添付します。',
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
  } catch (error) {
    logger.warn({ event: 'image_generation_failed', error: error.name, status: error.status });
    await interaction.editReply({
      content: error.userFacing
        ? error.message
        : '画像を生成できませんでした。時間を置いて再試行してください。',
      allowedMentions: { parse: [] },
    });
  }
}

async function routeInteraction(interaction, services) {
  const chat = interaction.isChatInputCommand?.();
  const button = interaction.isButton?.();
  const select = interaction.isStringSelectMenu?.();
  const modal = interaction.isModalSubmit?.();
  if (!chat && !(button || select || modal)) return;
  if (!chat && !interaction.customId?.startsWith('ai:')) return;
  if (interaction.guildId !== services.config.discord.guildId) {
    await interaction.reply({ content: 'このサーバーは対象外です。', ...ephemeral });
    return;
  }
  if (chat && interaction.commandName === 'ai-image') return generateImage(interaction, services);
  if (chat && interaction.commandName !== 'ai') {
    if (interaction.commandName.startsWith('ai-'))
      await interaction.reply({
        content: '操作は `/ai` のメニューにまとまりました。`/ai` を開いてください。',
        ...ephemeral,
      });
    return;
  }
  const [, action = 'home', ownerId, nonce] = chat
    ? ['ai', 'home', interaction.user.id]
    : interaction.customId.split(':');
  if (ownerId !== interaction.user.id) {
    await interaction.reply({
      content: '自分の `/ai` メニューを開いて操作してください。',
      ...ephemeral,
    });
    return;
  }
  if (!chat && !(button ? buttonActions : select ? selectActions : modalActions).has(action)) {
    await interaction.reply({
      content: 'このメニューは使えなくなりました。`/ai` を開き直してください。',
      ...ephemeral,
    });
    return;
  }
  if (adminActions.has(action)) {
    if (!isAdmin(interaction, services.config)) {
      await interaction.reply({
        content: 'この操作にはサーバー管理権限が必要です。',
        ...ephemeral,
      });
      return;
    }
    if (!services.config.discord.channels.some((item) => item.id === interaction.channelId)) {
      await interaction.reply({ content: 'このチャンネルはAI Botの対象外です。', ...ephemeral });
      return;
    }
  }
  const state = () => menuState(interaction, services);
  const { database, config } = services;
  if (!action.endsWith('-confirm')) {
    for (const kind of ['forget', 'personal-reset'])
      confirmations.get(services)?.delete(`${interaction.guildId}:${interaction.user.id}:${kind}`);
  }
  if (action === 'home') return display(interaction, homeMenu(state()));
  if (action === 'personal') return display(interaction, personalMenu(state()));
  if (action === 'help') return display(interaction, helpMenu(interaction.user.id));
  if (action === 'privacy')
    return display(
      interaction,
      privacyMenu(interaction.user.id, config.privacy.messageRetentionHours),
    );
  if (action === 'channel') return display(interaction, channelMenu(state()));
  if (action === 'profile-edit')
    return interaction.showModal(
      profileModal(interaction.user.id, state().preference, state().profile),
    );
  if (action === 'report') return interaction.showModal(reportModal(interaction.user.id));
  if (['profile-save', 'profile-refresh'].includes(action))
    return saveProfile(interaction, services, action === 'profile-refresh');
  if (['forget', 'personal-reset'].includes(action)) {
    if (!confirmations.has(services)) confirmations.set(services, new Map());
    const pending = confirmations.get(services);
    for (const [key, entry] of pending)
      if (Date.now() - entry.createdAt > 300_000) pending.delete(key);
    const token = randomUUID();
    pending.set(`${interaction.guildId}:${interaction.user.id}:${action}`, {
      token,
      createdAt: Date.now(),
    });
    return display(interaction, confirmationMenu(interaction.user.id, action, token));
  }
  if (action === 'forget-confirm' || action === 'personal-reset-confirm') {
    const key = `${interaction.guildId}:${interaction.user.id}:${action.replace(/-confirm$/u, '')}`;
    const pending = confirmations.get(services);
    const confirmation = pending?.get(key);
    if (
      !confirmation ||
      confirmation.token !== nonce ||
      Date.now() - confirmation.createdAt > 300_000
    ) {
      await interaction.reply({
        content: '確認の有効期限が切れました。`/ai` から操作し直してください。',
        ...ephemeral,
      });
      return;
    }
    pending.delete(key);
    cancelProfileOperation(interaction, services);
    if (action === 'forget-confirm') {
      const result = database.forgetUser(interaction.guildId, interaction.user.id);
      auditChange(interaction, services, 'forget_completed', result);
      return display(
        interaction,
        privacyMenu(
          interaction.user.id,
          config.privacy.messageRetentionHours,
          'このサーバーで保存中のあなたのデータを削除しました。',
        ),
      );
    }
    database.resetPreference(interaction.guildId, interaction.user.id);
    database.resetProfile(interaction.guildId, interaction.user.id);
    return display(interaction, personalMenu(state(), '自分の設定を初期状態へ戻しました。'));
  }
  if (action === 'tone' || action === 'length') {
    const value = interaction.values?.[0];
    if (!Object.hasOwn(action === 'tone' ? TONES : LENGTHS, value ?? ''))
      throw new Error('invalid preference');
    database.setPreference(interaction.guildId, interaction.user.id, {
      ...preferences(interaction, services),
      [action === 'tone' ? 'tone' : 'responseLength']: value,
    });
    return display(interaction, personalMenu(state(), '次の会話から反映します。'));
  }
  if (action === 'mode') {
    const mode = interaction.values?.[0];
    if (!Object.hasOwn(RESPONSE_MODES, mode ?? '')) throw new Error('invalid response mode');
    database.setChannelMode(interaction.guildId, interaction.channelId, mode);
    auditChange(interaction, services, 'response_mode_changed', { mode });
    return display(
      interaction,
      channelMenu(state(), `応答を「${RESPONSE_MODES[mode].label}」に変更しました。`),
    );
  }
  if (action === 'quality') {
    const key = interaction.values?.[0];
    if (!Object.hasOwn(MODEL_PRESETS, key ?? '')) throw new Error('invalid model preset');
    await interaction.deferUpdate();
    try {
      const { family, effort } = MODEL_PRESETS[key];
      const settings = await services.modelSettings.update({ family, effort });
      auditChange(interaction, services, 'model_preset_changed', settings);
      return display(
        interaction,
        channelMenu(state(), `サーバー全体の返答を「${MODEL_PRESETS[key].label}」に変更しました。`),
      );
    } catch (error) {
      services.logger.warn({ event: 'model_settings_failed', error: error.name });
      return display(
        interaction,
        channelMenu(state(), '変更できませんでした。これまでの設定を維持しています。'),
      );
    }
  }
  if (action === 'topic-reset') {
    services.sessionService.reset(interaction.guildId, interaction.channelId);
    auditChange(interaction, services, 'topic_reset');
    return display(interaction, channelMenu(state(), '次の発言から、新しい話題として扱います。'));
  }
  if (action === 'diagnostics') {
    await interaction.deferUpdate();
    const [ai, web] = await Promise.allSettled([
      services.model.health(),
      config.web.enabled ? services.model.webHealth() : Promise.resolve(null),
    ]);
    const aiOk = ai.status === 'fulfilled' && ai.value.ok;
    const webStatus = !config.web.enabled
      ? '無効'
      : web.status === 'fulfilled' && web.value?.ok
        ? '利用可能（Claude）'
        : '確認できませんでした';
    return display(
      interaction,
      channelMenu(
        state(),
        `AI接続：${aiOk ? '正常' : '確認できませんでした'} ／ Web検索：${webStatus}`,
      ),
    );
  }
  if (action === 'report-save') {
    const description = interaction.fields.getTextInputValue('description').trim().slice(0, 500);
    if (!description) throw new Error('empty report');
    audit(interaction, services, 'user_report', { description });
    services.logger.warn({
      event: 'user_report',
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    return interaction.reply({
      content: '報告を運用ログに記録しました。ありがとうございます。',
      ...ephemeral,
    });
  }
}

export async function handleCommand(interaction, services) {
  try {
    await routeInteraction(interaction, services);
  } catch (error) {
    services.logger.warn({ event: 'menu_operation_failed', error: error.name });
    const payload = {
      content: '操作を完了できませんでした。`/ai` を開き直してお試しください。',
      components: [],
      embeds: [],
      allowedMentions: { parse: [] },
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, ...ephemeral });
  }
}
