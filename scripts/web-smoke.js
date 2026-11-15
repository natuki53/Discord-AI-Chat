import assert from 'node:assert/strict';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { loadConfig } from '../src/config/load-config.js';
import { ConversationOrchestrator } from '../src/conversation/orchestrator.js';
import { createLogger } from '../src/observability/logger.js';

// 人工の質問だけで検証する。DBやDiscordには接続しない。
const { config } = loadConfig();
config.web.enabled = true;
const model = new ClaudeClient(config.llm);
if (process.argv[2]) model.configure({ model: process.argv[2], effort: 'medium' });
const orchestrator = new ConversationOrchestrator({ model, config, logger: createLogger('warn') });
const currentDate = new Date().toLocaleString('ja-JP', { timeZone: config.timezone });
const cases = [
  { name: 'news', question: '今日の日本のニュースを、異なる報道元から2件、出典付きで短く教えて。' },
  {
    name: 'account',
    question:
      'Xでアカウントが凍結されて解除されない人はどうしたらいい？公式情報を確認し、未確認の情報と区別して教えて。',
  },
  {
    name: 'fetch',
    question:
      'https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool を実際に開いて、max_usesとmax_content_tokensの違いを短く教えて。',
  },
  { name: 'chat', question: 'こんにちは' },
];
const selected = process.argv.slice(3);
for (const [index, item] of cases.entries()) {
  if (selected.length && !selected.includes(item.name)) continue;
  const messageId = `web-smoke-${index}`;
  const result = await orchestrator.respond(
    {
      mode: 'ambient',
      currentDate,
      system: `日本語で短く正確に答えてください。現在日時: ${currentDate}`,
      conversation: `今回の質問: ${item.question}`,
      recent: [{ messageId, content: item.question }],
    },
    [messageId],
    undefined,
    { action: 'respond', targetMessageIds: [messageId], solicited: true },
  );
  assert.equal(result.action, 'respond');
  assert.doesNotMatch(result.answer, /回答案|整形段階|私はこの場でページを開いて/u);
  process.stdout.write(`${JSON.stringify({ case: item.name, model: model.model, ...result })}\n`);
  const urls = [...result.answer.matchAll(/\]\(<(https?:\/\/[^>]+)>\)/gu)].map((match) => match[1]);
  if (item.name === 'chat') {
    assert.equal(result.usedWeb, false);
    assert.equal(urls.length, 0);
  } else {
    assert.equal(result.usedWeb, true);
    assert.ok(urls.length > 0, `${item.name}: cited source missing`);
    assert.doesNotMatch(result.answer, /atwiki\.jp|5ch\.net|store\.shopping\.yahoo/u);
    if (item.name === 'news')
      assert.ok(new Set(urls.map((url) => new URL(url).hostname)).size >= 2);
    if (item.name === 'fetch') assert.ok(result.webFetchRequests >= 1);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, case: item.name, model: model.model, usedWeb: result.usedWeb, webSearchRequests: result.webSearchRequests, webFetchRequests: result.webFetchRequests, answer: result.answer })}\n`,
  );
}
