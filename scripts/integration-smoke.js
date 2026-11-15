import { ClaudeClient } from '../src/ai/claude-client.js';
import { loadConfig } from '../src/config/load-config.js';
import { ConversationOrchestrator } from '../src/conversation/orchestrator.js';
import { createLogger } from '../src/observability/logger.js';
import { SearxngSearchProvider } from '../src/tools/web-search.js';

const { config } = loadConfig();
const logger = createLogger('warn');
const model = new ClaudeClient(config.llm);
const searchProvider = config.web.enabled ? new SearxngSearchProvider(config.web) : null;
const orchestrator = new ConversationOrchestrator({ model, searchProvider, config, logger });
const messageId = 'smoke-message-1';
const currentDate = new Date().toLocaleString('ja-JP', { timeZone: config.timezone });
const context = {
  mode: 'all',
  currentDate,
  system: `${config.persona.identity}\n${config.persona.style}\n現在日時: ${currentDate}`,
  conversation: 'U1: Ubuntuの最新リリースについて、検索結果を根拠に短く教えて。',
  recent: [
    {
      messageId,
      content: 'Ubuntuの最新リリースについて、検索結果を根拠に短く教えて。',
    },
  ],
};

const result = await orchestrator.respond(context, [messageId]);
if (result.action !== 'respond') throw new Error(`unexpected action: ${result.action}`);
if (!result.answer.trim()) throw new Error('empty answer');
if (config.web.enabled && !result.usedWeb) throw new Error('web search was not used');
if (config.web.enabled && !/https?:\/\//u.test(result.answer)) {
  throw new Error('answer does not include source URLs');
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      action: result.action,
      usedWeb: result.usedWeb,
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      durationMs: Math.round(result.totalDurationNs / 1_000_000),
      answerPreview: result.answer.slice(0, 500),
    },
    null,
    2,
  )}\n`,
);
