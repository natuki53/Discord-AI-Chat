import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { DiscordBot } from '../src/discord/bot.js';
import { commandDefinitions, handleCommand } from '../src/discord/commands.js';
import {
  channelMenu,
  confirmationMenu,
  helpMenu,
  homeMenu,
  personalMenu,
  privacyMenu,
  profileModal,
  reportModal,
} from '../src/discord/command-menu.js';

function createServices() {
  const state = {
    channel: { mode: 'ambient' },
    preference: null,
    profile: null,
    settings: { model: 'claude-haiku-5-5', effort: 'medium' },
  };
  const calls = {
    preferences: [],
    profiles: [],
    modes: [],
    model: [],
    audits: [],
    logs: [],
    reset: 0,
    forget: 0,
  };
  return {
    state,
    calls,
    config: {
      discord: { guildId: 'guild-1', adminRoleIds: [], channels: [{ id: 'channel-1' }] },
      llm: { model: 'claude-haiku-5-5', effort: 'medium' },
      web: { enabled: false },
      privacy: { messageRetentionHours: 24 },
    },
    database: {
      getChannel: () => state.channel,
      getPreference: () => state.preference,
      getProfile: () => state.profile,
      setPreference: (guild, user, value) => {
        calls.preferences.push({ guild, user, value });
        state.preference = value;
        return value;
      },
      setProfile: (guild, user, value) => {
        calls.profiles.push({ guild, user, value });
        state.profile = value;
        return value;
      },
      resetPreference: () => {
        state.preference = null;
      },
      resetProfile: () => {
        state.profile = null;
      },
      setChannelMode: (guild, channel, mode) => {
        calls.modes.push({ guild, channel, mode });
        state.channel.mode = mode;
        return state.channel;
      },
      forgetUser: (guild, user) => {
        calls.forget += 1;
        state.preference = null;
        state.profile = null;
        return { guild, user, messages: 2, preferences: 1, profiles: 1 };
      },
      addAuditEvent: (event) => calls.audits.push(event),
    },
    model: { health: async () => ({ ok: true }) },
    modelSettings: {
      current: () => state.settings,
      update: async (changes) => {
        calls.model.push(changes);
        state.settings = { model: `claude-${changes.family}-5-5`, effort: changes.effort };
        return state.settings;
      },
    },
    profileService: {
      prepare: async ({ selfDescription, links }) => ({
        selfDescription,
        links,
        sourceSummary: selfDescription,
        failedHosts: [],
      }),
    },
    imageService: { available: true },
    searchProvider: null,
    sessionService: {
      reset: () => {
        calls.reset += 1;
      },
    },
    logger: { warn: (event) => calls.logs.push(event), error: (event) => calls.logs.push(event) },
  };
}
function interaction(
  action = 'home',
  {
    type = 'button',
    admin = true,
    owner = 'user-1',
    values = [],
    strings = {},
    fields = {},
    customId,
    commandName = 'ai',
  } = {},
) {
  return {
    commandName,
    customId: customId ?? `ai:${action}:${owner}`,
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'user-1' },
    values,
    memberPermissions: { has: () => admin },
    member: { roles: { cache: { map: () => [] } } },
    options: { getString: (key) => strings[key] ?? null },
    fields: { getTextInputValue: (key) => fields[key] ?? '' },
    isChatInputCommand: () => type === 'chat',
    isButton: () => type === 'button',
    isStringSelectMenu: () => type === 'select',
    isModalSubmit: () => type === 'modal',
    deferred: false,
    replied: false,
    replies: [],
    updates: [],
    edits: [],
    deferrals: [],
    modals: [],
    async reply(payload) {
      this.replied = true;
      this.replies.push(payload);
    },
    async update(payload) {
      this.replied = true;
      this.updates.push(payload);
    },
    async editReply(payload) {
      this.edits.push(payload);
    },
    async deferReply(payload) {
      this.deferred = true;
      this.deferrals.push(payload);
    },
    async deferUpdate() {
      this.deferred = true;
      this.deferrals.push({ update: true });
    },
    async showModal(payload) {
      this.replied = true;
      this.modals.push(payload);
    },
  };
}
const data = (component) => component.toJSON();
const text = (payload) =>
  `${payload.content ?? ''}\n${payload.embeds?.map((item) => data(item).description).join('\n') ?? ''}`;
async function confirm(services, action) {
  const first = interaction(action);
  await handleCommand(first, services);
  const customId = data(first.updates[0].components[0]).components[0].custom_id;
  return interaction(`${action}-confirm`, { customId });
}

test('登録するコマンドはaiとai-imageだけで、必須引数は画像の依頼文だけ', () => {
  const definitions = commandDefinitions();
  assert.deepEqual(
    definitions.map((item) => item.name),
    ['ai', 'ai-image'],
  );
  assert.ok(!definitions[0].options?.length);
  assert.deepEqual(
    definitions[1].options.filter((item) => item.required).map((item) => item.name),
    ['prompt'],
  );
  assert.equal(definitions[1].options[0].required, true);
});
test('各画面と入力フォームをDiscord用にserializeでき、応答の選択肢は3つだけ', () => {
  const state = {
    userId: 'user-1',
    channel: { mode: 'ambient' },
    settings: { model: 'claude-haiku-5-5', effort: 'medium' },
    admin: true,
  };
  const pages = [
    homeMenu(state),
    personalMenu(state),
    channelMenu(state),
    helpMenu(state.userId),
    privacyMenu(state.userId, 24),
    confirmationMenu(state.userId, 'forget', 'test-nonce'),
  ];
  for (const page of pages) {
    assert.ok(page.components.length <= 5);
    for (const row of page.components) {
      const value = data(row);
      assert.ok(value.components.length <= 5);
      for (const component of value.components) assert.ok(component.custom_id.includes('user-1'));
    }
  }
  assert.deepEqual(
    data(channelMenu(state).components[0]).components[0].options.map((item) => item.label),
    ['おまかせ', '呼んだときだけ', '停止'],
  );
  assert.equal(data(profileModal('user-1')).components.length, 3);
  assert.equal(data(reportModal('user-1')).components[0].components[0].required, true);
});
test('aiはすぐに本人だけのメニューを開き、APIの疎通確認を待たない', async () => {
  const services = createServices();
  services.model.health = () => assert.fail('通常メニューでは通信しない');
  const item = interaction('home', { type: 'chat', admin: false });
  await handleCommand(item, services);
  assert.equal(item.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(data(item.replies[0].components[0]).components.length, 2);
  assert.match(text(item.replies[0]), /おまかせ/);
});
test('本人のメニューからヘルプとデータ説明へ進める', async () => {
  const services = createServices();
  for (const action of ['personal', 'help', 'privacy', 'home', 'channel']) {
    const item = interaction(action);
    await handleCommand(item, services);
    assert.equal(item.updates.length, 1, action);
  }
  const item = interaction('privacy');
  await handleCommand(item, services);
  assert.match(text(item.updates[0]), /AnthropicのClaude APIへ送信/);
  assert.match(text(item.updates[0]), /API側の保持・削除/);
  assert.doesNotMatch(text(item.updates[0]), /ai-forget|ai-profile|ai-preferences/);
});
test('他人のメニュー、対象外サーバー、古いコマンドでは設定を書き換えない', async () => {
  const services = createServices();
  const other = interaction('mode', { type: 'select', owner: 'user-2', values: ['paused'] });
  const guild = interaction('mode', { type: 'select', values: ['paused'] });
  guild.guildId = 'outside';
  const old = interaction('home', { type: 'chat', commandName: 'ai-pause' });
  for (const item of [other, guild, old]) {
    await handleCommand(item, services);
    assert.equal(item.replies[0].flags, MessageFlags.Ephemeral);
  }
  assert.equal(services.calls.modes.length, 0);
  assert.match(old.replies[0].content, /\/ai/);
});
test('すべての管理操作で権限を再確認し、対象外チャンネルも拒否する', async () => {
  for (const [action, type, values] of [
    ['channel', 'button', []],
    ['mode', 'select', ['paused']],
    ['quality', 'select', ['thoughtful']],
    ['topic-reset', 'button', []],
    ['diagnostics', 'button', []],
  ]) {
    const services = createServices();
    const item = interaction(action, { type, values, admin: false });
    await handleCommand(item, services);
    assert.match(item.replies[0].content, /権限/);
    assert.equal(
      services.calls.modes.length + services.calls.model.length + services.calls.reset,
      0,
    );
    const outside = interaction(action, { type, values });
    outside.channelId = 'outside';
    await handleCommand(outside, services);
    assert.match(outside.replies[0].content, /対象外/);
  }
});
test('応答変更、停止からの再開、話題の区切りを同じ画面で操作する', async () => {
  const services = createServices();
  for (const mode of ['mention', 'paused', 'ambient']) {
    const item = interaction('mode', { type: 'select', values: [mode] });
    await handleCommand(item, services);
    assert.equal(services.state.channel.mode, mode);
    assert.equal(item.updates.length, 1);
  }
  await handleCommand(interaction('topic-reset'), services);
  assert.equal(services.calls.reset, 1);
});
test('モデルは2つのプリセットで変更し、失敗時は既存設定を維持する', async () => {
  const services = createServices();
  for (const value of ['thoughtful', 'quick']) {
    const item = interaction('quality', { type: 'select', values: [value] });
    await handleCommand(item, services);
    assert.equal(item.deferrals[0].update, true);
    assert.equal(item.edits.length, 1);
  }
  assert.deepEqual(services.calls.model, [
    { family: 'sonnet', effort: 'high' },
    { family: 'haiku', effort: 'medium' },
  ]);
  services.modelSettings.update = async () => {
    throw new Error('private key');
  };
  const item = interaction('quality', { type: 'select', values: ['thoughtful'] });
  await handleCommand(item, services);
  assert.match(text(item.edits[0]), /維持/);
  assert.doesNotMatch(text(item.edits[0]), /private key/);
});
test('未定義の選択値や違う種類のinteractionからの更新は受理しない', async () => {
  for (const action of ['mode', 'quality', 'tone', 'length']) {
    const services = createServices();
    for (const value of ['all', '__proto__', 'invalid'])
      await handleCommand(interaction(action, { type: 'select', values: [value] }), services);
    await handleCommand(interaction(action, { type: 'button', values: ['ambient'] }), services);
    assert.equal(
      services.calls.preferences.length + services.calls.modes.length + services.calls.model.length,
      0,
    );
  }
});
test('個人の話し方と長さは、他の本人設定を維持して変更する', async () => {
  const services = createServices();
  services.state.preference = {
    preferredName: '名前',
    tone: 'auto',
    responseLength: 'normal',
    banterLevel: 'high',
  };
  await handleCommand(interaction('tone', { type: 'select', values: ['formal'] }), services);
  await handleCommand(interaction('length', { type: 'select', values: ['short'] }), services);
  assert.deepEqual(services.state.preference, {
    preferredName: '名前',
    tone: 'formal',
    responseLength: 'short',
    banterLevel: 'high',
  });
  assert.ok(services.calls.preferences.every((call) => call.user === 'user-1'));
});
test('プロフィールは同意を示す編集ボタンからフォームを開き、本人にだけ結果を表示する', async () => {
  const services = createServices();
  const edit = interaction('profile-edit');
  await handleCommand(edit, services);
  assert.equal(data(edit.modals[0]).custom_id, 'ai:profile-save:user-1');
  const save = interaction('profile-save', {
    type: 'modal',
    fields: {
      name: 'なまえ',
      description: 'ツールを作っています',
      links: 'https://example.com/me',
    },
  });
  await handleCommand(save, services);
  assert.equal(save.deferrals[0].flags, MessageFlags.Ephemeral);
  assert.equal(services.state.preference.preferredName, 'なまえ');
  assert.deepEqual(services.state.profile.links, ['https://example.com/me']);
  assert.ok(services.calls.profiles.every((call) => call.user === 'user-1'));
});
test('公開リンク更新・空欄によるプロフィール削除・取得失敗を処理する', async () => {
  const services = createServices();
  services.state.profile = { selfDescription: '自己紹介', links: ['https://example.com'] };
  const refresh = interaction('profile-refresh');
  await handleCommand(refresh, services);
  assert.equal(refresh.deferrals[0].update, true);
  services.profileService.prepare = async () => {
    throw new Error('secret');
  };
  const failed = interaction('profile-save', {
    type: 'modal',
    fields: { description: '変更予定' },
  });
  await handleCommand(failed, services);
  assert.equal(services.state.profile.selfDescription, '自己紹介');
  assert.doesNotMatch(text(failed.edits[0]), /secret/);
  const clear = interaction('profile-save', { type: 'modal' });
  await handleCommand(clear, services);
  assert.equal(services.state.profile, null);
  assert.equal(services.state.preference.preferredName, null);
});
test('削除には本人の直前の確認が必要で、キャンセル・確認の再送では削除しない', async () => {
  const services = createServices();
  await handleCommand(interaction('forget-confirm'), services);
  assert.equal(services.calls.forget, 0);
  const cancelled = await confirm(services, 'forget');
  await handleCommand(interaction('privacy'), services);
  await handleCommand(cancelled, services);
  assert.equal(services.calls.forget, 0);
  const accepted = await confirm(services, 'forget');
  await handleCommand(accepted, services);
  assert.equal(services.calls.forget, 1);
  await handleCommand(interaction('forget-confirm', { customId: accepted.customId }), services);
  assert.equal(services.calls.forget, 1);
});
test('プロフィール取得中の削除・リセットで古い取得結果を保存し直さない', async () => {
  for (const action of ['forget', 'personal-reset']) {
    const services = createServices();
    let complete;
    let started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    services.profileService.prepare = async ({ signal }) => {
      started();
      return new Promise((resolve) => {
        complete = () => resolve({ selfDescription: '古い自己紹介', links: [], failedHosts: [] });
        signal.addEventListener('abort', () => {});
      });
    };
    const save = interaction('profile-save', {
      type: 'modal',
      fields: { description: '古い自己紹介' },
    });
    const work = handleCommand(save, services);
    await waiting;
    await handleCommand(await confirm(services, action), services);
    complete();
    await work;
    assert.equal(services.calls.profiles.length, 0, action);
    assert.equal(services.state.profile, null);
  }
});
test('接続確認は操作を先に受け付け、個人向け画面に結果を戻す', async () => {
  const services = createServices();
  const item = interaction('diagnostics');
  await handleCommand(item, services);
  assert.equal(item.deferrals[0].update, true);
  assert.match(text(item.edits[0]), /AI接続：正常/);
});
test('問題報告は入力フォームから記録し、本文を通常ログへ出さない', async () => {
  const services = createServices();
  const open = interaction('report');
  await handleCommand(open, services);
  assert.equal(open.modals.length, 1);
  const item = interaction('report-save', {
    type: 'modal',
    fields: { description: '固有の報告内容' },
  });
  await handleCommand(item, services);
  assert.equal(item.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(services.calls.audits[0].metadata.description, '固有の報告内容');
  assert.doesNotMatch(JSON.stringify(services.calls.logs), /固有の報告内容/);
});
test('Botのinteractionイベントからボタン操作を処理できる', async () => {
  const services = createServices();
  const client = new EventEmitter();
  const bot = Object.assign(Object.create(DiscordBot.prototype), {
    client,
    services,
    logger: services.logger,
    config: services.config,
  });
  bot.bindEvents();
  const item = interaction('personal');
  client.emit('interactionCreate', item);
  await flush();
  assert.equal(item.updates.length, 1);
});
test('profile serviceの配線漏れは起動時に検出する', () => {
  assert.throws(() => new DiscordBot({}), /profileService/);
});
test('画像生成は公開のPNG/SVG添付を維持し、依頼文を回答へ繰り返さない', async () => {
  const services = createServices();
  let request;
  services.imageService.generate = async (input) => {
    request = input;
    return {
      data: Buffer.from('image'),
      filename: 'illustration.png',
      source: { data: Buffer.from('<svg/>'), filename: 'illustration.svg' },
    };
  };
  const item = interaction('home', {
    type: 'chat',
    commandName: 'ai-image',
    strings: { prompt: '猫のイラスト', aspect: 'portrait' },
  });
  item.attachmentSizeLimit = 1024;
  await handleCommand(item, services);
  assert.deepEqual(request, {
    userId: 'user-1',
    prompt: '猫のイラスト',
    aspect: 'portrait',
    maxBytes: 1024,
  });
  assert.equal(item.deferrals[0], undefined);
  assert.equal(item.edits[0].files.length, 2);
  assert.deepEqual(item.edits[0].allowedMentions, { parse: [] });
  assert.doesNotMatch(item.edits[0].content, /猫のイラスト/);
});
test('画像の未設定・対象外・停止中・添付権限不足・API失敗を安全に扱う', async () => {
  for (const reason of ['unconfigured', 'outside', 'paused', 'no-attachments', 'api']) {
    const services = createServices();
    services.imageService.available = reason !== 'unconfigured';
    services.imageService.generate = async () => {
      if (reason !== 'api') assert.fail('must not generate');
      throw new Error('private API key');
    };
    const item = interaction('home', {
      type: 'chat',
      commandName: 'ai-image',
      strings: { prompt: '猫' },
    });
    if (reason === 'outside') item.channelId = 'outside';
    if (reason === 'paused') services.state.channel.mode = 'paused';
    if (reason === 'no-attachments') item.appPermissions = { has: () => false };
    await handleCommand(item, services);
    if (reason === 'api') {
      assert.match(item.edits[0].content, /生成できませんでした/);
      assert.doesNotMatch(item.edits[0].content, /private/);
    } else assert.equal(item.replies[0].flags, MessageFlags.Ephemeral, reason);
  }
});
