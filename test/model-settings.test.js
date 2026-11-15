import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { ModelSettingsService } from '../src/ai/model-settings.js';
import { DatabaseStore } from '../src/storage/database.js';
import { validConfig } from './fixtures.js';

function makeServices() {
  const config = validConfig();
  const model = new ClaudeClient(config.llm, 'test-key');
  let stored = null;
  const database = {
    getModelSettings: () => stored,
    setModelSettings: (_guildId, settings) => {
      stored = { ...settings };
    },
  };
  const settings = new ModelSettingsService({ config, database, model });
  return { config, model, database, settings };
}

test('モデルとeffortを部分更新し、同時操作でも変更を失わない', async (t) => {
  const { config, model, database, settings } = makeServices();
  const targets = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    targets.push(url);
    assert.equal(model.model, targets.length === 1 ? 'claude-sonnet-5-5' : 'claude-haiku-5-5');
    return { ok: true, json: async () => ({ id: 'claude-haiku-5-5' }) };
  });
  await Promise.all([settings.update({ family: 'haiku' }), settings.update({ effort: 'high' })]);
  assert.deepEqual(settings.current(), { model: 'claude-haiku-5-5', effort: 'high' });
  assert.equal(config.llm.model, 'claude-haiku-5-5');
  assert.equal(config.llm.effort, 'high');
  assert.deepEqual(database.getModelSettings(), settings.current());
  assert.equal(targets.length, 2);
  assert.ok(targets.every((url) => url.endsWith('/models/claude-haiku-5-5')));
});

test('モデル未認証・不正入力・保存失敗では使用中の設定を変更しない', async (t) => {
  const { config, database, settings } = makeServices();
  const original = settings.current();
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 429 }));
  await assert.rejects(settings.update({ family: 'haiku' }), /429/);
  await assert.rejects(settings.update({ family: '__proto__' }), /haiku/);
  await assert.rejects(settings.update({ effort: 'invalid' }), /effort/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(settings.current(), original);
  assert.equal(database.getModelSettings(), null);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ id: 'claude-haiku-5-5' }),
  }));
  database.setModelSettings = () => {
    throw new Error('disk full');
  };
  await assert.rejects(settings.update({ family: 'haiku' }), /disk full/);
  assert.deepEqual(settings.current(), original);
  assert.equal(config.llm.model, original.model);
});

test('SQLiteから再起動後のモデルとeffortを復元する', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-ai-model-settings-'));
  const file = path.join(directory, 'settings.sqlite3');
  let database;
  try {
    const config = validConfig();
    database = new DatabaseStore(file, config);
    const model = new ClaudeClient(config.llm, 'test-key');
    const settings = new ModelSettingsService({ config, database, model });
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => ({ id: 'claude-haiku-5-5' }),
    }));
    await settings.update({ family: 'haiku', effort: 'max' });
    database.close();
    database = null;
    const restartedConfig = validConfig();
    database = new DatabaseStore(file, restartedConfig);
    assert.equal(database.getModelSettings('other-guild'), null);
    const restartedModel = new ClaudeClient(restartedConfig.llm, 'test-key');
    const restarted = new ModelSettingsService({
      config: restartedConfig,
      database,
      model: restartedModel,
    });
    assert.deepEqual(restarted.current(), { model: 'claude-haiku-5-5', effort: 'max' });
    assert.equal(restartedConfig.llm.effort, 'max');
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
