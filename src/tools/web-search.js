const DIRECT_SEARCH_PATTERN =
  /(検索して|検索し|調べて|調査して|ソース|出典|参照URL|根拠を確認|search|look up)/iu;
const CREATIVE_PATTERN =
  /(占って|占ってみて|おみくじ|創作|架空|大喜利|しりとり|ロールプレイ|なりきって)/iu;
const FRESHNESS_PATTERN =
  /(今日|昨日|今週|現在|最新|最近|ニュース|価格|在庫|天気|試合結果|運行|障害|現職|バージョン|version|release|today|latest|current|news|weather|price)/iu;

const SECRET_PATTERN =
  /(mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/giu;

export function needsFreshInformation(text) {
  const value = String(text ?? '');
  if (DIRECT_SEARCH_PATTERN.test(value)) return true;
  if (CREATIVE_PATTERN.test(value)) return false;
  return FRESHNESS_PATTERN.test(value);
}

export function sanitizeSearchQuery(text) {
  return String(text ?? '')
    .replace(SECRET_PATTERN, '[secret]')
    .replace(/\b\d{17,20}\b/g, '')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<@!?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export class SearxngSearchProvider {
  constructor({ baseUrl, timeoutMs = 10_000, maxResults = 5 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxResults = maxResults;
  }

  async health(signal) {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', 'test');
    url.searchParams.set('format', 'json');
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  }

  async search(query, { signal, maxResults = this.maxResults } = {}) {
    const clean = sanitizeSearchQuery(query);
    if (clean.length < 2) throw new Error('search_query_empty_after_redaction');
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', clean);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'ja-JP');
    url.searchParams.set('safesearch', '1');

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`search_http_${response.status}`);
    const body = await response.json();
    return (body.results ?? [])
      .filter((result) => result.url && result.title)
      .slice(0, Math.min(maxResults, 10))
      .map((result) => ({
        title: String(result.title).slice(0, 300),
        url: String(result.url),
        snippet: String(result.content ?? '').slice(0, 1500),
        publishedAt: result.publishedDate ?? null,
      }));
  }
}
