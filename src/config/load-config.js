import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'Discord IDは17〜20桁の文字列で指定してください');

function isLoopbackUrl(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

const channelSchema = z.object({
  id: snowflake,
  mode: z.enum(['all', 'ambient', 'mention', 'paused']).default('all'),
  debounceMs: z.number().int().min(250).max(30_000).default(2500),
  maxDebounceMs: z.number().int().min(500).max(60_000).default(8000),
  sessionIdleMinutes: z.number().int().min(1).max(1440).default(15),
});

export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    timezone: z.string().min(1).default('Asia/Tokyo'),
    discord: z.object({
      guildId: snowflake,
      adminRoleIds: z.array(snowflake).default([]),
      channels: z.array(channelSchema).min(1),
    }),
    persona: z.object({
      name: z.string().min(1).max(64),
      identity: z.string().min(1).max(2000),
      style: z.string().min(1).max(2000),
    }),
    llm: z.object({
      baseUrl: z.url(),
      model: z.string().min(1),
      contextTokens: z.number().int().min(2048).max(32768).default(8192),
      maxOutputTokens: z.number().int().min(32).max(2048).default(500),
      timeoutMs: z.number().int().min(5000).max(180000).default(60000),
      temperature: z.number().min(0).max(2).default(0.75),
      keepAlive: z.string().default('15m'),
    }),
    web: z.object({
      enabled: z.boolean().default(false),
      provider: z.enum(['searxng', 'disabled']).default('disabled'),
      baseUrl: z.url(),
      timeoutMs: z.number().int().min(1000).max(30000).default(10000),
      maxResults: z.number().int().min(1).max(10).default(5),
      maxFetchesPerTurn: z.number().int().min(0).max(3).default(2),
      maxBytesPerPage: z.number().int().min(65536).max(2_097_152).default(1_048_576),
    }),
    privacy: z.object({
      messageRetentionHours: z.number().int().min(1).max(72).default(24),
      sessionSummaryRetentionHours: z.number().int().min(1).max(72).default(24),
      operationalRetentionDays: z.number().int().min(1).max(90).default(30),
    }),
    conversation: z.object({
      recentMessageLimit: z.number().int().min(10).max(200).default(60),
      summaryEveryMessages: z.number().int().min(5).max(50).default(12),
      semanticTopicBoundaries: z.boolean().default(true),
      topicBoundaryConfidence: z.number().min(0.5).max(1).default(0.8),
      topicBoundaryLookbackMessages: z.number().int().min(4).max(30).default(12),
      maxResponseCharacters: z.number().int().min(100).max(1900).default(1800),
      globalConcurrency: z.number().int().min(1).max(2).default(1),
    }),
  })
  .superRefine((config, context) => {
    const ids = config.discord.channels.map((channel) => channel.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['discord', 'channels'],
        message: 'チャンネルIDが重複しています',
      });
    }

    for (const [index, channel] of config.discord.channels.entries()) {
      if (channel.maxDebounceMs < channel.debounceMs) {
        context.addIssue({
          code: 'custom',
          path: ['discord', 'channels', index, 'maxDebounceMs'],
          message: 'maxDebounceMsはdebounceMs以上にしてください',
        });
      }
    }

    if (!isLoopbackUrl(config.llm.baseUrl)) {
      context.addIssue({
        code: 'custom',
        path: ['llm', 'baseUrl'],
        message: 'MVPではOllamaのloopback URLだけを許可します',
      });
    }

    if (config.web.enabled && !isLoopbackUrl(config.web.baseUrl)) {
      context.addIssue({
        code: 'custom',
        path: ['web', 'baseUrl'],
        message: 'MVPではSearXNGのloopback URLだけを許可します',
      });
    }
  });

export function resolveConfigPath(requestedPath = process.env.BOT_CONFIG) {
  if (requestedPath) return path.resolve(requestedPath);

  const normal = path.resolve('config/bot.yaml');
  if (fs.existsSync(normal)) return normal;
  return path.resolve('config/bot.example.yaml');
}

export function loadConfig(requestedPath) {
  const configPath = resolveConfigPath(requestedPath);
  const source = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(source);
  const config = configSchema.parse(parsed);
  return { config, configPath };
}

export function channelConfig(config, channelId) {
  return config.discord.channels.find((channel) => channel.id === channelId) ?? null;
}
