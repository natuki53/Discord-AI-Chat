import pino from 'pino';

export function createLogger(level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: [
        'token',
        '*.token',
        'authorization',
        '*.authorization',
        'apiKey',
        '*.apiKey',
        'content',
        '*.content',
        'thinking',
        '*.thinking',
      ],
      censor: '[REDACTED]',
    },
  });
}
