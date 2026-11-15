import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeSvgClient } from '../src/ai/claude-svg-client.js';
import { renderSvg, validateSvg } from '../src/ai/svg-renderer.js';

const drawing =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#eef"/><circle cx="512" cy="512" r="200" fill="#f96"/></svg>';

test('SVGを実際のPNGへ変換し、各縦横比の出力サイズを固定する', async () => {
  for (const [aspect, width, height] of [
    ['square', 1024, 1024],
    ['landscape', 1536, 1024],
    ['portrait', 1024, 1536],
  ]) {
    const svg = validateSvg(
      drawing.replace('<svg ', '<svg width="9999999" height="9999999" '),
      aspect,
    );
    const data = await renderSvg(svg);
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16), width);
    assert.equal(data.readUInt32BE(20), height);
    assert.ok(data.length > 1000);
  }
});

test('埋め込みコード・外部参照・ローカル参照・再帰・不正XMLを変換前に拒否する', () => {
  for (const source of [
    '<svg><script>bad()</script></svg>',
    '<svg onload="bad()"/>',
    '<svg><image href="file:///etc/passwd"/></svg>',
    '<svg><image href="https://example.com/x.png"/></svg>',
    '<svg><rect fill="url(file:///etc/passwd)"/></svg>',
    '<svg><rect fill="url(&#104;ttps://example.com)"/></svg>',
    '<svg><rect style="fill:red"/></svg>',
    '<svg><style>rect { fill: red }</style></svg>',
    '<svg><foreignObject/></svg>',
    '<svg><use href="#loop"/></svg>',
    '<svg><svg/></svg>',
    '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg>&secret;</svg>',
    '<?xml-stylesheet href="https://example.com/style.css"?><svg/>',
    '<svg xmlns="https://example.com"/>',
    '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>',
    '<svg><rect></svg>',
    '<svg/><svg/>',
    '<svg viewBox="0 0 -1 2"/>',
    '<svg viewBox="0 0 Infinity 2"/>',
  ])
    assert.throws(() => validateSvg(source), /svg_/);
});

test('SVGの文字数・要素数・深さを制限し、ローカルなグラデーションは描画できる', async () => {
  assert.throws(() => validateSvg('<svg>' + ' '.repeat(131072) + '</svg>'), /size/);
  assert.throws(() => validateSvg('<svg>' + '<rect/>'.repeat(2048) + '</svg>'), /complex/);
  assert.throws(
    () => validateSvg('<svg>' + '<g>'.repeat(32) + '</g>'.repeat(32) + '</svg>'),
    /complex/,
  );
  const svg = validateSvg(
    '<svg><defs><linearGradient id="shade"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#369"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#shade)"/></svg>',
  );
  const data = await renderSvg(svg);
  assert.equal(data.subarray(1, 4).toString(), 'PNG');
});

test('Claudeの選択状態を共有し、画像専用の生成上限でSVGを描かせる', async () => {
  const calls = [];
  const model = {
    selected: 'haiku',
    chat: async (request) => {
      calls.push({ ...request, selected: model.selected });
      return { content: JSON.stringify({ svg: drawing }), stopReason: 'end_turn' };
    },
  };
  const provider = new ClaudeSvgClient({ model, maxOutputTokens: 8192, timeoutMs: 180000 });
  const result = await provider.generate({ prompt: '猫のイラスト', aspect: 'landscape' });
  assert.equal(result.filename, 'illustration.png');
  assert.equal(result.source.filename, 'illustration.svg');
  assert.match(result.source.data.toString(), /width="1536"/);
  assert.equal(calls[0].maxOutputTokens, 8192);
  assert.equal(calls[0].timeoutMs, 180000);
  assert.deepEqual(calls[0].messages[1], { role: 'user', content: '猫のイラスト' });
  assert.match(calls[0].messages[0].content, /1536×1024/);
  model.selected = 'sonnet';
  await provider.generate({ prompt: '犬', aspect: 'square' });
  assert.deepEqual(
    calls.map((call) => call.selected),
    ['haiku', 'sonnet'],
  );
});

test('切れたJSONや危険なSVGをDiscordへ返さない', async () => {
  for (const response of [
    { stopReason: 'max_tokens', content: '{"svg":' },
    { content: 'private invalid response' },
    { content: JSON.stringify({ svg: '<svg><script/></svg>' }) },
  ]) {
    const provider = new ClaudeSvgClient({ model: { chat: async () => response } });
    await assert.rejects(provider.generate({ prompt: '猫' }), (error) => {
      assert.equal(error.userFacing, true);
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  }
});

test('各モデルのeffortに対応した描画用thinkingを使う', async () => {
  for (const family of ['haiku', 'sonnet']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const model = {
        model: `claude-${family}-5-5`,
        effort,
        chat: async (request) => {
          assert.equal(
            request.thinking.type,
            ['xhigh', 'max'].includes(effort)
              ? 'adaptive'
              : family === 'sonnet'
                ? 'between_tools'
                : 'disabled',
          );
          return { content: 'invalid' };
        },
      };
      const provider = new ClaudeSvgClient({ model });
      await assert.rejects(provider.generate({ prompt: '猫' }), /描画データ/);
    }
  }
});

test('SVG変換のタイムアウトと中断を処理する', async () => {
  const svg = validateSvg(drawing);
  await assert.rejects(renderSvg(svg, { timeoutMs: 1 }), /timeout/);
  const controller = new AbortController();
  const rendering = renderSvg(svg, { signal: controller.signal });
  controller.abort();
  await assert.rejects(rendering, /aborted/);
});
