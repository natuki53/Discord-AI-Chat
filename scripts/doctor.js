import { OllamaClient } from '../src/ai/ollama-client.js';
import { loadConfig } from '../src/config/load-config.js';
import { openDatabase } from '../src/storage/database.js';
import { SearxngSearchProvider } from '../src/tools/web-search.js';

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
}

if (!offline && config) {
  await check('ollama', async () => {
    const health = await new OllamaClient(config.llm).health();
    if (!health.ok) throw new Error(`model not found: ${config.llm.model}`);
    return config.llm.model;
  });
  if (config.web.enabled && config.web.provider === 'searxng') {
    await check('web-search', async () => {
      const health = await new SearxngSearchProvider(config.web).health();
      if (!health.ok) throw new Error(`HTTP ${health.status}`);
      return 'searxng';
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
