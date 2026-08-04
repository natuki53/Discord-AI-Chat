import { safeWebFetch } from '../tools/safe-web-fetch.js';
import { needsFreshInformation, sanitizeSearchQuery } from '../tools/web-search.js';

const FINAL_FORMAT = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'answer'],
  properties: {
    action: { type: 'string', enum: ['respond', 'silent'] },
    answer: { type: 'string' },
  },
};

function parseFinal(content) {
  try {
    const parsed = JSON.parse(content);
    if (!['respond', 'silent'].includes(parsed.action) || typeof parsed.answer !== 'string') {
      throw new Error('invalid_final_shape');
    }
    return parsed;
  } catch {
    const fallback = String(content ?? '').trim();
    return { action: fallback ? 'respond' : 'silent', answer: fallback };
  }
}

function buildSourceMaterial(results, pages) {
  if (!results.length) return '';
  return results
    .map((result, index) => {
      const page = pages.find((item) => item.sourceIndex === index + 1);
      return `<untrusted_web_source index="${index + 1}" url="${result.url}">
タイトル: ${result.title}
公開日候補: ${result.publishedAt ?? '不明'}
検索概要: ${result.snippet}
取得本文: ${page?.text ?? '本文取得なし'}
</untrusted_web_source>`;
    })
    .join('\n\n');
}

export function isLaughterOnly(text) {
  return /^(?:[wｗ笑草😂🤣\s!！?？]+|lol)$/iu.test(String(text ?? '').trim());
}

export function greetingText(text) {
  const normalized = String(text ?? '').trim();
  const match = normalized.match(
    /^(こんにちは|こんばんは|おはよう(?:ございます)?|やあ|こん|おつ|お疲れ(?:さま|様)?)[!！。．.\s]*$/u,
  );
  return match?.[1] ?? null;
}

export function turnStyleInstruction(text) {
  const normalized = String(text ?? '').trim();
  const currentPriority =
    '今回のCURRENT発言群だけを直接の返答対象にしてください。過去の履歴は意味を補う材料であり、現在の発言が触れていない古い話題を復活させてはいけません。表示名は識別用であり、必要がなければ呼び掛けに使わないでください。';
  if (isLaughterOnly(normalized)) {
    return `${currentPriority}\n今回の発言は短い笑い反応です。意味を説明せず、新しい話題を追加せず、直前の一発言に20文字程度の一言だけで自然に返してください。`;
  }
  const greeting = greetingText(normalized);
  if (greeting) {
    return `${currentPriority}\n今回は挨拶だけです。「${greeting}」を基準に、一文で自然に返してください。別の時間帯の挨拶へ言い換えないでください。`;
  }
  if (/(?:占って|占ってみて|おみくじ)/u.test(normalized)) {
    return `${currentPriority}\n今回は会話遊びとしての占いです。外部情報や根拠を持ち出さず、事実の予測だと断定せずに、明るく短い占い結果をその場で作ってください。依頼を断ったり、時期が早いとは言わないでください。指定された期間を変えず、「今日」なら今日の運勢として答えてください。`;
  }
  if (/(?:人|やつ).{0,12}(?:どう思う|どう思います)/u.test(normalized)) {
    return `${currentPriority}\n今回は一般的な意見を聞く質問です。直前の本人プロフィールや質問者自身へ結び付けず、質問した理由も推測せずに、聞かれた対象への考えを先に短く答えてください。`;
  }
  if (/私(?:って|は).{0,12}どんな人|どんな人だと思/u.test(normalized)) {
    return `${currentPriority}\n人物像を推測せず、今回までの会話で直接観測できたことか、本人登録プロフィールに明記された活動・興味だけを短く伝えてください。「断定できない」「AIだから」「はっきり言えない」などの前置きは加えず、わかっている活動を先に答えてください。`;
  }
  return `${currentPriority}\n雑談は原則1〜3文で答え、求められていない理由の列挙・講義・質問意図の推測を追加しないでください。`;
}

export class ConversationOrchestrator {
  constructor({ model, searchProvider, config, logger }) {
    this.model = model;
    this.searchProvider = searchProvider;
    this.config = config;
    this.logger = logger;
  }

  async respond(context, sourceMessageIds, signal) {
    const currentMessages = context.recent.filter((message) =>
      sourceMessageIds.includes(message.messageId),
    );
    const currentText = currentMessages.map((message) => message.content).join('\n');
    const shouldSearch = this.config.web.enabled && needsFreshInformation(currentText);
    let results = [];
    let pages = [];
    let searchError = null;

    if (shouldSearch && this.searchProvider) {
      try {
        const query = sanitizeSearchQuery(`${currentText} ${context.currentDate}`);
        results = await this.searchProvider.search(query, { signal });
        for (const [index, result] of results
          .slice(0, this.config.web.maxFetchesPerTurn)
          .entries()) {
          try {
            const page = await safeWebFetch(result.url, {
              signal,
              timeoutMs: this.config.web.timeoutMs,
              maxBytes: this.config.web.maxBytesPerPage,
            });
            pages.push({ sourceIndex: index + 1, ...page });
          } catch (error) {
            this.logger.debug(
              { event: 'web_fetch_rejected', reason: error.message, sourceIndex: index + 1 },
              'web fetch rejected',
            );
          }
        }
      } catch (error) {
        searchError = error.message;
        this.logger.warn(
          { event: 'web_search_failed', reason: error.message },
          'web search failed',
        );
      }
    }

    const webMaterial = buildSourceMaterial(results, pages);
    const styleInstruction = turnStyleInstruction(currentText);
    const modeInstruction =
      context.mode === 'ambient'
        ? '人間同士の会話だけで完結しており、AIが加わる価値が低い場合はactionをsilentにしてください。'
        : '意味のある人間の発言には原則actionをrespondにしてください。';
    const webInstruction = shouldSearch
      ? results.length
        ? `最新性が必要なためWeb検索を行いました。重要な事実には[1]のように資料番号を付けてください。\n${webMaterial}`
        : `最新性が必要ですが検索に失敗しました（${searchError ?? '結果なし'}）。最新情報を推測で断定せず、確認できなかったと短く伝えてください。`
      : '今回はWeb検索をしていません。';

    const response = await this.model.chat({
      messages: [
        { role: 'system', content: context.system },
        {
          role: 'user',
          content: `${context.conversation}\n\n${modeInstruction}\n\n${styleInstruction}\n\n${webInstruction}\n\nJSON schemaに従って返してください。`,
        },
      ],
      format: FINAL_FORMAT,
      signal,
    });
    const final = parseFinal(response.content);
    const greeting = greetingText(currentText);
    if (greeting && final.action === 'respond') final.answer = `${greeting}！`;
    if (isLaughterOnly(currentText) && final.action === 'respond') {
      final.answer = final.answer.trim().split(/\n/u)[0].slice(0, 40);
    }
    if (context.mode === 'all' && final.action === 'silent' && currentText.trim()) {
      final.action = 'respond';
      final.answer ||= 'うん、流れは見てるよ。';
    }

    if (final.action === 'respond' && results.length > 0) {
      const references = results
        .slice(0, 5)
        .map((result, index) => `[${index + 1}] ${result.title}: ${result.url}`)
        .join('\n');
      final.answer = `${final.answer.trim()}\n\n参照（${new Date().toLocaleDateString('ja-JP', { timeZone: this.config.timezone })}取得）\n${references}`;
    }

    return {
      ...final,
      usedWeb: results.length > 0,
      promptTokens: response.promptTokens,
      outputTokens: response.outputTokens,
      totalDurationNs: response.totalDurationNs,
    };
  }
}
