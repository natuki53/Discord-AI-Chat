export function validConfig() {
  return {
    schemaVersion: 1,
    timezone: 'Asia/Tokyo',
    discord: {
      guildId: '123456789012345678',
      adminRoleIds: [],
      channels: [
        {
          id: '123456789012345679',
          mode: 'all',
          debounceMs: 2500,
          maxDebounceMs: 8000,
          sessionIdleMinutes: 15,
        },
      ],
    },
    persona: { name: 'AI', identity: 'AIです', style: '短く答える' },
    llm: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:4b',
      contextTokens: 8192,
      maxOutputTokens: 500,
      timeoutMs: 60000,
      temperature: 0.7,
      keepAlive: '15m',
    },
    web: {
      enabled: false,
      provider: 'disabled',
      baseUrl: 'http://127.0.0.1:8888',
      timeoutMs: 8000,
      maxResults: 5,
      maxFetchesPerTurn: 2,
      maxBytesPerPage: 1048576,
    },
    privacy: {
      messageRetentionHours: 24,
      sessionSummaryRetentionHours: 24,
      operationalRetentionDays: 30,
    },
    conversation: {
      recentMessageLimit: 60,
      summaryEveryMessages: 12,
      maxResponseCharacters: 1800,
      globalConcurrency: 1,
    },
  };
}
