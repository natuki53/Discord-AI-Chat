import assert from 'node:assert/strict';
import test from 'node:test';
import { configSchema } from '../src/config/load-config.js';
import { validConfig } from './fixtures.js';

test('正常な設定を受理する', () => {
  const parsed = configSchema.parse(validConfig());
  assert.equal(parsed.discord.channels[0].mode, 'all');
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

test('OllamaのLAN公開URLを拒否する', () => {
  const config = validConfig();
  config.llm.baseUrl = 'http://192.168.1.20:11434';
  assert.throws(() => configSchema.parse(config), /loopback/);
});

test('有効なSearXNGのLAN公開URLを拒否する', () => {
  const config = validConfig();
  config.web.enabled = true;
  config.web.provider = 'searxng';
  config.web.baseUrl = 'http://192.168.1.20:8888';
  assert.throws(() => configSchema.parse(config), /loopback/);
});
