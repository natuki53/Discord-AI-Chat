import { validateModelSettings } from './model-settings.js';
import { extractWebResponse } from './web-response.js';

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ClaudeのJSON出力で未対応の制約は説明へ移す。呼び出し元のschemaは変更しない。
function claudeSchema(schema) {
  const result = { ...schema };
  const constraints = [];
  for (const key of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'maxItems',
    'uniqueItems',
  ]) {
    if (key in result) {
      constraints.push(`${key}: ${JSON.stringify(result[key])}`);
      delete result[key];
    }
  }
  if (result.minItems > 1) {
    constraints.push(`minItems: ${result.minItems}`);
    delete result.minItems;
  }
  if (constraints.length) {
    result.description = [result.description, `Constraints: ${constraints.join(', ')}`]
      .filter(Boolean)
      .join('\n');
  }
  if (result.type === 'object') result.additionalProperties = false;
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [key, claudeSchema(value)]),
    );
  }
  if (result.items) result.items = claudeSchema(result.items);
  for (const key of ['anyOf', 'allOf', 'oneOf']) {
    if (result[key]) result[key] = result[key].map(claudeSchema);
  }
  return result;
}

export class ClaudeClient {
  #apiKey;

  constructor(
    { baseUrl, model, effort = 'medium', maxOutputTokens, timeoutMs },
    apiKey = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!apiKey?.trim()) throw new Error('ANTHROPIC_API_KEYが設定されていません');
    if (baseUrl !== 'https://api.anthropic.com') {
      throw new Error('Claude APIのbaseUrlはhttps://api.anthropic.comを指定してください');
    }
    this.#apiKey = apiKey.trim();
    this.baseUrl = baseUrl;
    this.configure({ model, effort });
    this.maxOutputTokens = maxOutputTokens;
    this.timeoutMs = timeoutMs;
  }

  configure(settings) {
    Object.assign(this, validateModelSettings(settings));
  }

  async request(path, { body, signal, timeoutMs = this.timeoutMs } = {}) {
    const response = await fetch(`${this.baseUrl}/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2026-10-21',
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: combineSignals(signal, timeoutMs),
    });
    if (!response.ok) {
      // エラー本文はpromptや秘密値を含み得るため、ログへ伝播させない。
      await response.body?.cancel();
      const error = new Error(`Claude API request failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async health(signal, model = this.model) {
    const body = await this.request(`models/${encodeURIComponent(model)}`, {
      signal,
      timeoutMs: Math.min(this.timeoutMs, 10000),
    });
    return { ok: typeof body.id === 'string', models: body.id ? [body.id] : [] };
  }

  async webHealth(signal) {
    const body = await this.request(`models/${encodeURIComponent(this.model)}`, {
      signal,
      timeoutMs: Math.min(this.timeoutMs, 10000),
    });
    const supported = body.capabilities?.server_tools?.web_search?.supported;
    return { ok: supported === true, supported: supported ?? null };
  }

  async chat({
    messages,
    format,
    signal,
    maxOutputTokens = this.maxOutputTokens,
    timeoutMs = this.timeoutMs,
    thinking = { type: 'adaptive' },
    web,
  }) {
    if (web && format)
      throw new Error('Claude web citations require a separate structured request');
    const started = process.hrtime.bigint();
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const requestBody = {
      model: this.model,
      max_tokens: maxOutputTokens,
      stream: false,
      thinking,
      ...(system ? { system } : {}),
      messages: messages.filter((message) => message.role !== 'system'),
      output_config: {
        effort: this.effort,
        ...(format ? { format: { type: 'json_schema', schema: claudeSchema(format) } } : {}),
      },
      ...(web
        ? {
            tools: [
              {
                type: 'web_search_20260318',
                name: 'web_search',
                max_uses: web.maxSearches ?? 3,
                allowed_callers: ['direct'],
                user_location: {
                  type: 'approximate',
                  country: 'JP',
                  timezone: web.timezone ?? 'Asia/Tokyo',
                },
              },
              ...(web.maxFetches === 0
                ? []
                : [
                    {
                      type: 'web_fetch_20260318',
                      name: 'web_fetch',
                      max_uses: web.maxFetches ?? 2,
                      allowed_callers: ['direct'],
                      citations: { enabled: true },
                      max_content_tokens: web.maxContentTokens ?? 6000,
                    },
                  ]),
            ],
          }
        : {}),
    };
    const requestSignal = combineSignals(signal, timeoutMs);
    const blocks = [];
    let body;
    let promptTokens = 0;
    let outputTokens = 0;
    let webSearchRequests = 0;
    let webFetchRequests = 0;
    for (let continuation = 0; ; continuation += 1) {
      body = await this.request('messages', {
        body: requestBody,
        signal: requestSignal,
        timeoutMs,
      });
      blocks.push(...(body.content ?? []));
      promptTokens +=
        (body.usage?.input_tokens ?? 0) +
        (body.usage?.cache_creation_input_tokens ?? 0) +
        (body.usage?.cache_read_input_tokens ?? 0);
      outputTokens += body.usage?.output_tokens ?? 0;
      webSearchRequests += body.usage?.server_tool_use?.web_search_requests ?? 0;
      webFetchRequests += body.usage?.server_tool_use?.web_fetch_requests ?? 0;
      if (!web || body.stop_reason !== 'pause_turn') break;
      if (continuation >= 2) throw new Error('Claude web turn continuation limit exceeded');
      // encrypted_contentとthinkingの署名も含め、そのまま再送する。
      requestBody.messages = [
        ...requestBody.messages,
        { role: 'assistant', content: body.content },
      ];
    }
    if (web && body.stop_reason !== 'end_turn') throw new Error('Claude web turn incomplete');
    const webResponse = web ? extractWebResponse(blocks) : {};
    return {
      content: web
        ? webResponse.content
        : (body.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(''),
      toolCalls: [],
      stopReason: body.stop_reason ?? null,
      ...webResponse,
      usedWeb: webSearchRequests + webFetchRequests > 0,
      webSearchRequests,
      webFetchRequests,
      promptTokens,
      outputTokens,
      totalDurationNs: Number(process.hrtime.bigint() - started),
    };
  }
}
