import { ClaudeClient } from '../src/ai/claude-client.js';
import { ClaudeSvgClient } from '../src/ai/claude-svg-client.js';
import { ModelSettingsService } from '../src/ai/model-settings.js';
import { loadConfig } from '../src/config/load-config.js';
import { openDatabase } from '../src/storage/database.js';

const { config } = loadConfig();
if (!config.images.enabled) throw new Error('画像生成が無効です');
const model = new ClaudeClient(config.llm);
const database = openDatabase(config);
try {
  new ModelSettingsService({ config, database, model });
} finally {
  database.close();
}
const provider = new ClaudeSvgClient({
  model,
  maxOutputTokens: config.images.maxOutputTokens,
  timeoutMs: config.images.timeoutMs,
});
const image = await provider.generate({
  prompt: '夜空の下で眠る白い猫の、シンプルでかわいい絵本風イラスト。文字なし。',
  aspect: 'landscape',
});
if (image.data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
  throw new Error('PNG validation failed');
}
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    model: model.model,
    effort: model.effort,
    width: image.data.readUInt32BE(16),
    height: image.data.readUInt32BE(20),
    pngBytes: image.data.length,
    svgBytes: image.source.data.length,
    files: [image.filename, image.source.filename],
  })}\n`,
);
