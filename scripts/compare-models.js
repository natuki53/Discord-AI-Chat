import { performance } from 'node:perf_hooks';
import { OllamaClient } from '../src/ai/ollama-client.js';
import { loadConfig } from '../src/config/load-config.js';

const { config } = loadConfig();
const candidates = process.argv.slice(2);
if (!candidates.length) {
  throw new Error('比較するmodel名を1つ以上指定してください');
}

const boundaryFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['relation', 'confidence'],
  properties: {
    relation: {
      type: 'string',
      enum: ['continuation', 'same_topic', 'new_topic', 'uncertain'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const boundaryCases = [
  {
    name: 'follow_up',
    previous: 'USER: 昨日の競馬は惜しかったね\nAI: 最後で外れたの悔しいね',
    current: 'USER: それで次はどれくらい賭けるの？',
    expected: false,
  },
  {
    name: 'new_topic',
    previous: 'USER: 昨日の競馬は惜しかったね\nAI: 最後で外れたの悔しいね',
    current: 'USER: RTX 2060で使えるAIモデルは？',
    expected: true,
  },
  {
    name: 'same_subject_new_aspect',
    previous: 'USER: RTX 2060でローカルAIを動かしたい\nAI: 6GB VRAMなら小型モデルが現実的だね',
    current: 'USER: VRAMはどれくらい余る？',
    expected: false,
  },
  {
    name: 'explicit_shift',
    previous: 'USER: 今日暑すぎる\nAI: 外に出た瞬間に溶けそう',
    current: 'USER: ところで明日の天気は？',
    expected: true,
  },
];

for (const candidate of candidates) {
  const model = new OllamaClient({
    ...config.llm,
    model: candidate,
    maxOutputTokens: 180,
    temperature: 0,
    keepAlive: '2m',
  });
  const started = performance.now();
  const cases = [];
  for (const item of boundaryCases) {
    const caseStarted = performance.now();
    const response = await model.chat({
      messages: [
        {
          role: 'system',
          content:
            '直前と今回のDiscord会話の関係を一つだけ分類してください。追加質問や代名詞を使う続きはcontinuation、同じ対象の別側面はsame_topic、対象が変わり直前の文脈なしで理解できる場合だけnew_topic、不明ならuncertainです。',
        },
        {
          role: 'user',
          content: `<previous>${item.previous}</previous>\n<current>${item.current}</current>`,
        },
      ],
      format: boundaryFormat,
      temperature: 0,
    });
    let parsed;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      parsed = null;
    }
    const actual = parsed?.relation === 'new_topic';
    cases.push({
      name: item.name,
      passed: parsed !== null && actual === item.expected,
      durationMs: Math.round(performance.now() - caseStarted),
      outputTokens: response.outputTokens,
      result: parsed ?? response.content.slice(0, 200),
    });
  }

  const chatStarted = performance.now();
  const chat = await model.chat({
    messages: [
      {
        role: 'system',
        content: 'Discordの雑談へ日本語で自然に参加し、1文だけで返してください。',
      },
      {
        role: 'user',
        content: 'USER1: サーバー再起動したら全部直る説\nUSER2: 腰痛も？\nこの流れへ短く返して。',
      },
    ],
    temperature: 0.4,
  });
  process.stdout.write(
    `${JSON.stringify({
      model: candidate,
      passed: cases.filter((item) => item.passed).length,
      total: cases.length,
      durationMs: Math.round(performance.now() - started),
      cases,
      chatDurationMs: Math.round(performance.now() - chatStarted),
      chatPreview: chat.content.slice(0, 200),
    })}\n`,
  );
}
