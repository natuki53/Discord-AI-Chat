import { ClaudeClient } from '../src/ai/claude-client.js';
import { ModelSettingsService } from '../src/ai/model-settings.js';
import { renderSvg } from '../src/ai/svg-renderer.js';
import { loadConfig } from '../src/config/load-config.js';
import { openDatabase } from '../src/storage/database.js';

const offline = process.argv.includes('--offline');
const checks = [];

async function check(name, callback) {
  try {
    const detail = await callback();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
  }
}

let config;
await check('config', async () => {
  const loaded = loadConfig();
  config = loaded.config;
  return loaded.configPath;
});

let database;
if (config) {
  await check('database', async () => {
    database = openDatabase(config);
    database.initializeChannels();
    return database.quickCheck();
  });
  await check('image-renderer', async () => {
    if (!config.images.enabled) return 'disabled';
    const png = await renderSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fff"/></svg>',
    );
    if (png.subarray(1, 4).toString() !== 'PNG') throw new Error('PNG renderer failed');
    return 'claude-svg (PNG/SVG ready)';
  });
}

if (!offline && config) {
  await check('claude', async () => {
    const model = new ClaudeClient(config.llm);
    if (database) new ModelSettingsService({ config, database, model });
    const health = await model.health();
    if (!health.ok) throw new Error(`model not found: ${config.llm.model}`);
    return `${config.llm.model} (effort: ${config.llm.effort})`;
  });
  if (config.web.enabled) {
    await check('web-search', async () => {
      const model = new ClaudeClient(config.llm);
      if (database) new ModelSettingsService({ config, database, model });
      const health = await model.webHealth();
      if (!health.ok) throw new Error('Claude model web search capability unavailable');
      return 'claude (model supports web search; run web-smoke for live verification)';
    });
  }
  await check('discord-token', async () => {
    if (!process.env.DISCORD_BOT_TOKEN) throw new Error('not configured');
    return 'configured';
  });
}

database?.close();
for (const item of checks) {
  process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}\n`);
}
if (checks.some((item) => !item.ok)) process.exitCode = 1;
