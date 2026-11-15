import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageGenerationService } from '../src/ai/image-generation-service.js';

test('未設定・空の依頼・不正な形では画像APIを呼ばない', async () => {
  const disabled = new ImageGenerationService({ provider: null });
  assert.equal(disabled.available, false);
  await assert.rejects(disabled.generate({ prompt: '猫' }), /接続設定/);
  let called = false;
  const service = new ImageGenerationService({
    provider: {
      generate: async () => {
        called = true;
      },
    },
  });
  await assert.rejects(service.generate({ prompt: ' ' }), /1〜2000/);
  await assert.rejects(service.generate({ prompt: '猫', aspect: 'invalid' }), /画像の形/);
  assert.equal(called, false);
});

test('画像を返し、同じ利用者の連続生成を抑止する', async () => {
  const data = Buffer.from('image');
  const calls = [];
  const service = new ImageGenerationService({
    provider: {
      generate: async (request) => {
        calls.push(request);
        return { data, filename: 'illustration.png' };
      },
    },
    cooldownSeconds: 60,
  });
  const result = await service.generate({
    userId: 'user1',
    prompt: ' 猫のイラスト ',
    aspect: 'landscape',
  });
  assert.equal(result.data, data);
  assert.equal(calls[0].prompt, '猫のイラスト');
  assert.equal(calls[0].aspect, 'landscape');
  await assert.rejects(service.generate({ userId: 'user1', prompt: '犬' }), /秒お待ち/);
  await service.generate({ userId: 'user2', prompt: '犬' });
  assert.equal(calls.length, 2);
});

test('生成の同時実行を防ぎ、失敗後は枠を解放する', async () => {
  let reject;
  const service = new ImageGenerationService({
    provider: {
      generate: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    },
  });
  const active = service.generate({ userId: 'user1', prompt: '猫' });
  await assert.rejects(service.generate({ userId: 'user2', prompt: '犬' }), /別の画像/);
  reject(new Error('failed'));
  await assert.rejects(active, /failed/);
  service.provider = { generate: async () => ({ data: Buffer.from('ok'), filename: 'image.png' }) };
  await service.generate({ userId: 'user1', prompt: '猫' });
});

test('空の画像と添付上限超過を拒否する', async () => {
  const service = new ImageGenerationService({
    provider: { generate: async () => ({ data: Buffer.alloc(0) }) },
  });
  await assert.rejects(service.generate({ userId: 'user', prompt: '猫' }), /no image/);
  service.provider = { generate: async () => ({ data: Buffer.alloc(8), filename: 'image.png' }) };
  await assert.rejects(
    service.generate({ userId: 'user', prompt: '猫', maxBytes: 4 }),
    /添付サイズ/,
  );
  service.provider = {
    generate: async () => ({
      data: Buffer.alloc(2),
      source: { data: Buffer.alloc(8), filename: 'illustration.svg' },
    }),
  };
  await assert.rejects(
    service.generate({ userId: 'user', prompt: '猫', maxBytes: 4 }),
    /SVGファイル/,
  );
});

test('停止時は生成リクエストを中断し新しい依頼を受けない', async () => {
  let signal;
  const service = new ImageGenerationService({
    provider: {
      generate: (request) => {
        signal = request.signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    },
  });
  const generating = service.generate({ userId: 'user', prompt: '猫' });
  service.stop();
  assert.equal(signal.aborted, true);
  await assert.rejects(generating, /aborted/);
  assert.equal(service.available, false);
  await assert.rejects(service.generate({ userId: 'other', prompt: '犬' }), /接続設定/);
});
