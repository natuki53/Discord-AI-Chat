import assert from 'node:assert/strict';
import test from 'node:test';
import { configSchema } from '../src/config/load-config.js';
import { validConfig } from './fixtures.js';

test('正常な設定を受理する', () => {
  const parsed = configSchema.parse(validConfig());
  assert.equal(parsed.discord.channels[0].mode, 'ambient');
  assert.deepEqual(parsed.images, {
    enabled: true,
    provider: 'claude-svg',
    maxOutputTokens: 8192,
    timeoutMs: 180000,
    cooldownSeconds: 60,
  });
});

test('省略時はambientを標準とし、明示モードと参加頻度の設定を維持する', () => {
  const config = validConfig();
  delete config.discord.channels[0].mode;
  const parsed = configSchema.parse(config);
  assert.equal(parsed.discord.channels[0].mode, 'ambient');
  assert.equal(parsed.conversation.ambientCooldownSeconds, 20);
  assert.equal(parsed.conversation.maxPendingMessages, 50);
  for (const mode of ['ambient', 'mention', 'paused']) {
    config.discord.channels[0].mode = mode;
    assert.equal(configSchema.parse(config).discord.channels[0].mode, mode);
  }
  config.discord.channels[0].mode = 'all';
  assert.equal(configSchema.parse(config).discord.channels[0].mode, 'ambient');
  config.conversation.ambientCooldownSeconds = -1;
  assert.throws(() => configSchema.parse(config));
});

test('Discord IDをnumberで受け取らない', () => {
  const config = validConfig();
  config.discord.guildId = 123;
  assert.throws(() => configSchema.parse(config));
});

test('重複チャンネルを拒否する', () => {
  const config = validConfig();
  config.discord.channels.push({ ...config.discord.channels[0] });
  assert.throws(() => configSchema.parse(config), /重複/);
});

test('Claude API以外への送信先を拒否する', () => {
  const config = validConfig();
  config.llm.baseUrl = 'http://192.168.1.20:11434';
  assert.throws(() => configSchema.parse(config));
});

test('Claude APIの接続先とモデルの既定値を設定する', () => {
  const config = validConfig();
  delete config.llm.baseUrl;
  delete config.llm.model;
  const parsed = configSchema.parse(config);
  assert.equal(parsed.llm.baseUrl, 'https://api.anthropic.com');
  assert.equal(parsed.llm.model, 'claude-sonnet-5-5');
  assert.equal(parsed.llm.effort, 'medium');
});

test('Haikuと全effortを受理し未対応モデルやeffortを拒否する', () => {
  const config = validConfig();
  config.llm.model = 'claude-haiku-5-5';
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    config.llm.effort = effort;
    assert.equal(configSchema.parse(config).llm.effort, effort);
  }
  config.llm.effort = 'invalid';
  assert.throws(() => configSchema.parse(config));
  config.llm.effort = 'medium';
  config.llm.model = 'claude-unsupported';
  assert.throws(() => configSchema.parse(config));
});

test('旧Ollama設定を明示的に拒否する', () => {
  const config = validConfig();
  config.llm.baseUrl = 'http://127.0.0.1:11434';
  config.llm.model = 'qwen3.5:9b';
  assert.throws(() => configSchema.parse(config));
});

test('有効なSearXNGのLAN公開URLを拒否する', () => {
  const config = validConfig();
  config.web.enabled = true;
  config.web.provider = 'searxng';
  config.web.baseUrl = 'http://192.168.1.20:8888';
  assert.throws(() => configSchema.parse(config), /loopback/);
});
