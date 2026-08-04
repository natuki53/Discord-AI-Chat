import { OllamaClient } from './ai/ollama-client.js';
import { loadConfig, channelConfig } from './config/load-config.js';
import { ContextBuilder } from './conversation/context-builder.js';
import { ConversationOrchestrator } from './conversation/orchestrator.js';
import { SessionService } from './conversation/session-service.js';
import { TurnScheduler } from './conversation/turn-scheduler.js';
import { DiscordBot } from './discord/bot.js';
import { createLogger } from './observability/logger.js';
import { ProfileService } from './profile/profile-service.js';
import { openDatabase } from './storage/database.js';
import { SearxngSearchProvider } from './tools/web-search.js';

const logger = createLogger();

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKENが設定されていません');
  const { config, configPath } = loadConfig();
  const database = openDatabase(config);
  database.initializeChannels();

  const model = new OllamaClient(config.llm);
  const searchProvider =
    config.web.enabled && config.web.provider === 'searxng'
      ? new SearxngSearchProvider(config.web)
      : null;
  const contextBuilder = new ContextBuilder({ database, config });
  const profileService = new ProfileService({ model, config, logger });
  const sessionService = new SessionService({ database, config, model, logger });
  const orchestrator = new ConversationOrchestrator({
    model,
    searchProvider,
    profileService,
    config,
    logger,
  });

  let bot;
  const scheduler = new TurnScheduler({
    processTurn: (turn) => bot.processTurn(turn),
    resolveChannelConfig: (channelId) => channelConfig(config, channelId),
    globalConcurrency: config.conversation.globalConcurrency,
  });
  const services = {
    config,
    database,
    model,
    searchProvider,
    contextBuilder,
    sessionService,
    orchestrator,
    scheduler,
    logger,
  };
  bot = new DiscordBot(services);
  services.bot = bot;

  const cleanupTimer = setInterval(
    () => {
      const result = database.cleanup();
      logger.info({ event: 'retention_completed', ...result }, 'retention completed');
    },
    60 * 60 * 1000,
  );
  cleanupTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'service_stopping', signal }, 'service stopping');
    clearInterval(cleanupTimer);
    await bot.stop();
    database.close();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
  process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));

  const health = await model.health();
  if (!health.ok) throw new Error(`Ollama modelが見つかりません: ${config.llm.model}`);
  logger.info(
    { event: 'service_starting', configPath, model: config.llm.model },
    'service starting',
  );
  await bot.start(token);
}

main().catch((error) => {
  logger.fatal({ event: 'service_fatal', error: error.message }, 'service failed');
  process.exitCode = 1;
});
