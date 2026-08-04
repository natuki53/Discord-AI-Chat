import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { commandDefinitions, handleCommand } from '../src/discord/commands.js';

function assertRequiredOptionsFirst(options = [], path = '') {
  let optionalSeen = false;
  for (const option of options) {
    if (option.type === 1 || option.type === 2) {
      assertRequiredOptionsFirst(option.options, `${path}/${option.name}`);
      continue;
    }
    if (option.required) {
      assert.equal(
        optionalSeen,
        false,
        `${path}/${option.name}: 必須optionは任意optionより前に置く`,
      );
    } else {
      optionalSeen = true;
    }
  }
}

test('Discord command定義は登録可能なoption順である', () => {
  const commands = commandDefinitions();
  assert.equal(commands.length, 11);
  assert.ok(commands.some((command) => command.name === 'ai-topic-reset'));
  for (const command of commands) {
    assertRequiredOptionsFirst(command.options, command.name);
  }
});

function createServices() {
  return {
    config: {
      discord: {
        guildId: 'guild-1',
        adminRoleIds: [],
        channels: [{ id: 'channel-1' }],
      },
      llm: { model: 'qwen3.5:4b' },
      web: { enabled: false },
      privacy: { messageRetentionHours: 24 },
    },
    database: {
      getChannel: () => ({ mode: 'all' }),
      getPreference: () => null,
      getProfile: () => null,
      setChannelMode: (_guildId, _channelId, mode) => ({ mode }),
      resumeChannel: () => ({ mode: 'all' }),
      addAuditEvent() {},
    },
    model: { health: async () => ({ ok: true }) },
    searchProvider: null,
    scheduler: { queueLength: () => 0 },
    sessionService: { reset: () => true },
    logger: { warn() {} },
  };
}

function createInteraction(commandName, { subcommand = 'show', admin = true } = {}) {
  const replies = [];
  return {
    commandName,
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'user-1' },
    memberPermissions: { has: () => admin },
    member: { roles: { cache: { map: () => [] } } },
    options: {
      getSubcommand: () => subcommand,
      getBoolean: (name) => name !== 'confirm',
      getString: (name) => (name === 'mode' ? 'all' : 'テスト報告'),
    },
    isChatInputCommand: () => true,
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

test('共有コマンドの成功応答はチャンネル全員へ表示する', async () => {
  const services = createServices();
  for (const commandName of [
    'ai-status',
    'ai-privacy',
    'ai-mode',
    'ai-pause',
    'ai-resume',
    'ai-context-reset',
    'ai-topic-reset',
  ]) {
    const interaction = createInteraction(commandName);
    await handleCommand(interaction, services);
    assert.equal(interaction.replies.length, 1, commandName);
    assert.equal(interaction.replies[0].flags, undefined, commandName);
  }
});

test('本人情報・報告・権限エラーは実行者だけに表示する', async () => {
  const services = createServices();
  const cases = [
    createInteraction('ai-preferences'),
    createInteraction('ai-profile'),
    createInteraction('ai-forget'),
    createInteraction('ai-report'),
    createInteraction('ai-topic-reset', { admin: false }),
  ];
  for (const interaction of cases) {
    await handleCommand(interaction, services);
    assert.equal(interaction.replies.length, 1, interaction.commandName);
    assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral, interaction.commandName);
  }
});
