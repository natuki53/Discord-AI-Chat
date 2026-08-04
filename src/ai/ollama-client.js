function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class OllamaClient {
  constructor({
    baseUrl,
    model,
    contextTokens,
    maxOutputTokens,
    timeoutMs,
    temperature,
    keepAlive,
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.contextTokens = contextTokens;
    this.maxOutputTokens = maxOutputTokens;
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.keepAlive = keepAlive;
  }

  async health(signal) {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      signal: combineSignals(signal, Math.min(this.timeoutMs, 10000)),
    });
    if (!response.ok) throw new Error(`Ollama health failed: ${response.status}`);
    const body = await response.json();
    return {
      ok: body.models?.some((model) => model.name === this.model) ?? false,
      models: (body.models ?? []).map((model) => model.name),
    };
  }

  async chat({ messages, format, tools, signal, temperature = this.temperature }) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format,
        tools,
        think: false,
        keep_alive: this.keepAlive,
        options: {
          num_ctx: this.contextTokens,
          num_predict: this.maxOutputTokens,
          temperature,
        },
      }),
      signal: combineSignals(signal, this.timeoutMs),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      const error = new Error(`Ollama chat failed: ${response.status} ${detail}`);
      error.status = response.status;
      throw error;
    }

    const body = await response.json();
    return {
      content: body.message?.content ?? '',
      toolCalls: body.message?.tool_calls ?? [],
      promptTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
      totalDurationNs: body.total_duration ?? 0,
    };
  }
}
