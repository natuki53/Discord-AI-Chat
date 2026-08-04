import Database from 'better-sqlite3';

const INTERNAL_PATTERNS = [
  { name: 'structured_json', pattern: /["'{]\s*(?:action|answer)["']?\s*:/iu },
  { name: 'context_marker', pattern: /\bCURRENT\b|\[U\d+:/u },
  { name: 'prompt_instruction', pattern: /JSON\s*schema|system\s*prompt|システムプロンプト/iu },
  {
    name: 'prompt_section',
    pattern: /重要規則|会話セッション要約|本人が明示した設定|今回の発言者が本人/u,
  },
  { name: 'untrusted_tag', pattern: /<\/?untrusted_[^>]*>/iu },
  { name: 'reasoning_tag', pattern: /<\/?think>|内部思考|思考過程/iu },
  { name: 'secret_canary', pattern: /INTERNAL_CANARY_[A-Z0-9_]+/u },
];

function redact(value) {
  return String(value ?? '')
    .replace(/<@!?\d+>/gu, '@user')
    .replace(/<@&\d+>/gu, '@role')
    .replace(/\b\d{17,20}\b/gu, '[id]')
    .replace(/https?:\/\/\S+/gu, '[url]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 280);
}

const databasePath = process.env.BOT_DATABASE_PATH ?? './data/bot.sqlite3';
const limit = Math.min(Math.max(Number(process.argv[2] ?? 500), 20), 2000);
const database = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const rows = database
    .prepare(
      `SELECT message_id, content, created_at
       FROM messages
       WHERE author_type = 'bot' AND content IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit);
  const findings = [];
  for (const row of rows) {
    const matches = INTERNAL_PATTERNS.filter(({ pattern }) => pattern.test(row.content)).map(
      ({ name }) => name,
    );
    if (!matches.length) continue;
    findings.push({
      messageId: row.message_id,
      createdAt: row.created_at,
      matches,
      preview: redact(row.content),
    });
  }
  process.stdout.write(
    `${JSON.stringify({ scannedBotMessages: rows.length, findingCount: findings.length, findings }, null, 2)}\n`,
  );
  if (findings.length) process.exitCode = 2;
} finally {
  database.close();
}
