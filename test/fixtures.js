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
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      contextTokens: 8192,
      maxOutputTokens: 1024,
      timeoutMs: 60000,
    },
    web: {
      enabled: false,
      provider: 'claude',
      timeoutMs: 120000,
      maxSearches: 3,
      maxFetches: 2,
      maxContentTokens: 6000,
    },
    privacy: {
      messageRetentionHours: 24,
      sessionSummaryRetentionHours: 24,
      operationalRetentionDays: 30,
    },
    conversation: {
      recentMessageLimit: 60,
      summaryEveryMessages: 12,
      semanticTopicBoundaries: true,
      topicBoundaryConfidence: 0.8,
      topicBoundaryLookbackMessages: 12,
      maxResponseCharacters: 1800,
      globalConcurrency: 1,
    },
  };
}
