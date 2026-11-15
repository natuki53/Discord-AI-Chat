import assert from 'node:assert/strict';
import { ClaudeClient } from '../src/ai/claude-client.js';
import { loadConfig } from '../src/config/load-config.js';
import { ParticipationPolicy } from '../src/conversation/participation-policy.js';
import { createLogger } from '../src/observability/logger.js';

// 人工会話だけを送信する。Discord接続、DB、検索、投稿は使わない。
const { config } = loadConfig();
const client = new ClaudeClient(config.llm);
let requests = 0;
let promptTokens = 0;
let outputTokens = 0;
const model = {
  get effort() {
    return client.effort;
  },
  async chat(request) {
    const result = await client.chat(request);
    requests += 1;
    promptTokens += result.promptTokens;
    outputTokens += result.outputTokens;
    return result;
  },
};
const policy = new ParticipationPolicy({ model, config, logger: createLogger('warn') });
const rows = (items) =>
  items.map(([authorId, content, extra = {}], index) => ({
    messageId: `sample-${index + 1}`,
    authorId,
    authorType: authorId === 'AI' ? 'bot' : 'human',
    content,
    replyToAuthorType: 'unknown',
    createdAt: new Date(Date.now() - 10000 + index * 100).toISOString(),
    ...extra,
  }));

const cases = [
  {
    id: 'human_exchange',
    messages: rows([
      ['A', 'Bさん、週末の集合は何時にする？'],
      ['B', '土曜の10時に駅集合で！'],
      ['A', '了解、切符はこっちで取っておくね'],
    ]),
    current: [2],
    expected: 'silent',
  },
  {
    id: 'implicit_followup',
    messages: rows([
      ['A', 'AIさん、キャッシュって何？'],
      ['AI', '前に計算した結果を保存して、同じ処理を速くする仕組みだよ。'],
      ['A', 'もう少し具体的な例を教えて'],
    ]),
    current: [2],
    expected: 'respond',
    botRecentlySpoke: true,
  },
  {
    id: 'named_call',
    messages: rows([
      ['A', 'みんなで秋の旅行を計画してる'],
      ['B', '温泉でのんびりがいいな'],
      ['A', 'AIさんはどう思う？'],
    ]),
    current: [2],
    expected: 'respond',
  },
  {
    id: 'already_answered',
    messages: rows([
      ['A', 'AIさん、この設定はONとOFFのどっちにすればいい？', { mentionedBot: true }],
      ['B', 'その用途ならOFFだよ。これで解決する'],
      ['A', 'OFFにしたら直った。ありがとう！'],
    ]),
    current: [0],
    expected: 'silent',
    revalidate: true,
  },
  {
    id: 'join_banter',
    messages: rows([
      ['A', 'サーバー再起動したら全部直る説'],
      ['AI', '再起動は万病に効くってやつだね。'],
      ['B', 'じゃあ腰痛も再起動で治る？'],
    ]),
    current: [2],
    expected: 'respond',
  },
];

let failed = false;
for (const sample of cases) {
  const currentMessages = sample.current.map((index) => sample.messages[index]);
  const latestIndex = Math.max(...sample.current);
  const context = {
    mode: 'ambient',
    recent: sample.messages,
    currentMessages,
    laterMessages: sample.messages.slice(latestIndex + 1),
    conversation: sample.messages
      .map((message) => `${message.authorId}: ${message.content}`)
      .join('\n'),
    lastBotMessageAt: sample.botRecentlySpoke ? new Date().toISOString() : null,
    lastBotTargetAuthorIds: sample.botRecentlySpoke ? ['A'] : [],
  };
  const result = await policy.decide(
    context,
    currentMessages.map((message) => message.messageId),
    undefined,
    { revalidate: sample.revalidate },
  );
  const pass = result.action === sample.expected && result.reasonCode !== 'uncertain';
  failed ||= !pass;
  console.warn(
    JSON.stringify({
      scenario: sample.id,
      expected: sample.expected,
      actual: result.action,
      reason: result.reasonCode,
      pass,
    }),
  );
}
console.warn(
  JSON.stringify({ model: config.llm.model, requests, promptTokens, outputTokens, pass: !failed }),
);
assert.ok(!failed, 'participation smoke failed');
