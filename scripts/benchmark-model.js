import { performance } from 'node:perf_hooks';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { loadConfig } from '../src/config/load-config.js';

const { config } = loadConfig();
const model = new ClaudeClient(config.llm);
const prompts = [
  '日本語で一文だけ自己紹介してください。',
  'U1: サーバー再起動したら全部直る説\nU2: 腰痛も？\nこのネタに短く乗ってください。',
  '次をJSONで返してください: action=respond, answer=こんにちは',
];

for (const [index, prompt] of prompts.entries()) {
  const start = performance.now();
  const response = await model.chat({
    messages: [{ role: 'user', content: prompt }],
  });
  const durationMs = Math.round(performance.now() - start);
  process.stdout.write(
    `${JSON.stringify({
      case: index + 1,
      durationMs,
      promptTokens: response.promptTokens,
      outputTokens: response.outputTokens,
      tokensPerSecond:
        response.totalDurationNs > 0
          ? Number((response.outputTokens / (response.totalDurationNs / 1e9)).toFixed(2))
          : null,
      preview: response.content.slice(0, 120),
    })}\n`,
  );
}
