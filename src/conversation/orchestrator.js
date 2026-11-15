import { safeWebFetch } from '../tools/safe-web-fetch.js';
import { sanitizeSearchQuery } from '../tools/web-search.js';
import { ParticipationPolicy, currentMessages } from './participation-policy.js';

const FINAL_ANSWER_MAX_CHARACTERS = 800;

const FINAL_FORMAT = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'answer'],
  properties: {
    action: { type: 'string', enum: ['respond', 'silent'] },
    answer: { type: 'string', maxLength: FINAL_ANSWER_MAX_CHARACTERS },
  },
};

const SAFE_MODEL_OUTPUT_FALLBACK = 'ごめん、うまく返答を組み立てられなかった。もう一度聞いてみて。';
const INTERNAL_SPEAKER_LABEL = /\[(?:U\d+|AI):[^\]\r\n]{1,80}\]\s*[:：]?\s*/gu;
const PROTECTED_PROMPT_FRAGMENT =
  /INTERNAL_CANARY_[A-Z0-9_]+|重要規則\s*:|会話セッション要約\s*:|本人が明示した設定\s*:|今回の発言者が本人の同意で登録したプロフィール\s*:|<\/?(?:untrusted_|self_provided_profile_data)[^>]*>|JSON\s*schemaに従って返してください/iu;
const INTERNAL_REQUEST_TARGET =
  /system\s*prompt|システムプロンプト|内部(?:の)?(?:指示|規則|設定|プロンプト|思考)|非公開(?:の)?(?:指示|設定|context)|重要規則|会話セッション要約|本人が明示した設定|\bCURRENT\b|\bU\d+\b|<\/?think>/iu;
const EXTRACTION_ACTION =
  /一字一句|全文|そのまま|見せ|表示|開示|書いて|出して|含め|dump|続け|無視して/iu;
const INTERNAL_OWNERSHIP =
  /あなた(?:が受け取った|の)|直前に受け取った|上(?:記|の)|今までの|非公開|内部/iu;
const CONCEPTUAL_QUESTION = /(?:とは|って何|何ですか|意味は)/u;

function decodeJsonStringFragment(fragment) {
  let escaped = false;
  let closingQuote = -1;
  for (let index = 0; index < fragment.length; index += 1) {
    const character = fragment[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      closingQuote = index;
      break;
    }
  }

  let candidate = closingQuote >= 0 ? fragment.slice(0, closingQuote) : fragment;
  candidate = candidate
    .replace(/\\u[0-9a-f]{0,3}$/iu, '')
    .replace(/\\$/u, '')
    .replace(/\r/gu, '\\r')
    .replace(/\n/gu, '\\n');
  try {
    return JSON.parse(`"${candidate}"`);
  } catch {
    return null;
  }
}

function recoverStructuredAnswer(content) {
  const value = String(content ?? '');
  const action = value.match(/"action"\s*:\s*"(respond|silent)"/u)?.[1];
  const answerMarker = /"answer"\s*:\s*"/u.exec(value);
  if (!action || !answerMarker) return null;
  const answer = decodeJsonStringFragment(value.slice(answerMarker.index + answerMarker[0].length));
  if (typeof answer !== 'string' || !answer.trim()) return null;

  let recovered = answer.trim();
  if (!/[。！？!?]$/u.test(recovered)) {
    const lastSentenceEnd = Math.max(
      recovered.lastIndexOf('。'),
      recovered.lastIndexOf('！'),
      recovered.lastIndexOf('？'),
      recovered.lastIndexOf('!'),
      recovered.lastIndexOf('?'),
    );
    if (lastSentenceEnd >= 0) recovered = recovered.slice(0, lastSentenceEnd + 1).trim();
  }
  return { action, answer: recovered.slice(0, FINAL_ANSWER_MAX_CHARACTERS) };
}

function parseFinal(content) {
  const value = String(content ?? '').trim();
  const candidates = [value];
  const objectStart = value.indexOf('{');
  const objectEnd = value.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(value.slice(objectStart, objectEnd + 1));
  }
  try {
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (!['respond', 'silent'].includes(parsed.action) || typeof parsed.answer !== 'string') {
          continue;
        }
        return { kind: 'valid', value: parsed };
      } catch {
        // 次の候補または途中まで生成されたJSONの復旧を試す。
      }
    }
  } catch {
    // 復旧処理へ進む。
  }

  const recovered = recoverStructuredAnswer(value);
  if (recovered) return { kind: 'recovered', value: recovered };
  return {
    kind: 'fallback',
    value: { action: 'respond', answer: SAFE_MODEL_OUTPUT_FALLBACK },
  };
}

function containsVerbatimSystemLine(answer, system) {
  return String(system ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 32)
    .some((line) => answer.includes(line));
}

export function guardAssistantAnswer(answer, system = '', contextMessageIds = []) {
  const value = String(answer ?? '').trim();
  if (PROTECTED_PROMPT_FRAGMENT.test(value) || containsVerbatimSystemLine(value, system)) {
    return { answer: SAFE_MODEL_OUTPUT_FALLBACK, reason: 'protected_prompt_fragment' };
  }
  let withoutLabels = value
    .replace(INTERNAL_SPEAKER_LABEL, '')
    .replace(/\bCURRENT\b/gu, '今回の発言')
    .replace(/\bLATEST\b/gu, '後続の発言')
    .trim();
  for (const messageId of contextMessageIds) {
    if (!/^\d{17,20}$/u.test(messageId)) continue;
    withoutLabels = withoutLabels
      .replaceAll(messageId, '')
      .replace(/\s{2,}/gu, ' ')
      .trim();
  }
  if (!withoutLabels) {
    return { answer: SAFE_MODEL_OUTPUT_FALLBACK, reason: 'empty_after_guard' };
  }
  return {
    answer: withoutLabels,
    reason: withoutLabels === value ? null : 'internal_context_marker',
  };
}

export function removeDanglingJsonBrace(answer) {
  const value = String(answer ?? '').trim();
  if (value.endsWith('}') && !value.includes('{')) return value.slice(0, -1).trimEnd();
  return value;
}

export function requestsInternalConfiguration(text) {
  const value = String(text ?? '');
  if (!INTERNAL_REQUEST_TARGET.test(value)) return false;
  if (CONCEPTUAL_QUESTION.test(value) && !INTERNAL_OWNERSHIP.test(value)) return false;
  return EXTRACTION_ACTION.test(value) || INTERNAL_OWNERSHIP.test(value);
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

export function isSelfDescriptionQuestion(text) {
  return /私(?:って|は).{0,12}どんな人|どんな人だと思/u.test(String(text ?? ''));
}

export function isGeneralOpinionQuestion(text) {
  return /(?:人|やつ).{0,12}(?:どう思う|どう思います)/u.test(String(text ?? ''));
}

export function turnStyleInstruction(text, participantNames = []) {
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
  const refersToParticipant = participantNames.some(
    (name) => name.length >= 2 && normalized.includes(name),
  );
  if (isGeneralOpinionQuestion(normalized) && !refersToParticipant) {
    return `${currentPriority}\n今回は一般的な意見を聞く質問です。直前の本人プロフィールや質問者自身へ結び付けず、質問した理由も推測せずに、聞かれた対象への考えを先に短く答えてください。`;
  }
  if (isSelfDescriptionQuestion(normalized)) {
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
    this.participation = new ParticipationPolicy({ model, config, logger });
  }

  async decideParticipation(context, sourceMessageIds, signal, options) {
    return this.participation.decide(context, sourceMessageIds, signal, options);
  }

  async respond(context, sourceMessageIds, signal, participation) {
    const decision =
      participation ?? (await this.decideParticipation(context, sourceMessageIds, signal));
    if (decision.action === 'silent') {
      return {
        ...decision,
        answer: '',
        usedWeb: false,
        promptTokens: 0,
        outputTokens: 0,
        totalDurationNs: 0,
      };
    }
    const targets = currentMessages(context, decision.targetMessageIds);
    const currentText = targets.map((message) => message.content).join('\n');
    if (requestsInternalConfiguration(currentText)) {
      this.logger.warn(
        { event: 'internal_request_blocked' },
        'internal configuration request blocked',
      );
      return {
        action: 'respond',
        answer: 'その内容は表示できないよ。普段の会話や質問にはそのまま答えるね。',
        usedWeb: false,
        promptTokens: 0,
        outputTokens: 0,
        totalDurationNs: 0,
      };
    }
    const shouldSearch = this.config.web.enabled && decision.needsWeb;
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
    const styleInstruction = turnStyleInstruction(currentText, context.participantNames);
    const modeInstruction = `参加判断で選んだ返答対象は${JSON.stringify(decision.targetMessageIds)}です。この対象へだけ、参加者として自然に答えてください。人間同士の質問をまとめて回答せず、後続発言で解決・撤回された場合はsilentのまま本文を空にしてください。`;
    const webInstruction = shouldSearch
      ? results.length
        ? `最新性が必要なためWeb検索を行いました。重要な事実には[1]のように資料番号を付けてください。\n${webMaterial}`
        : `最新性が必要ですが検索に失敗しました（${searchError ?? '結果なし'}）。最新情報を推測で断定せず、確認できなかったと短く伝えてください。`
      : '今回はWeb検索をしていません。';

    const userPrompt = `${context.conversation}\n\n${modeInstruction}\n\n${styleInstruction}\n\n${webInstruction}\n\nanswerは最大${FINAL_ANSWER_MAX_CHARACTERS}文字に収め、JSON以外の文字を出さず、JSON schemaに従って返してください。`;
    const messages = [
      { role: 'system', content: context.system },
      { role: 'user', content: userPrompt },
    ];
    let response = await this.model.chat({
      messages,
      format: FINAL_FORMAT,
      signal,
    });
    let parsedFinal = parseFinal(response.content);
    if (parsedFinal.kind === 'fallback') {
      this.logger.warn(
        {
          event: 'model_output_invalid',
          attempt: 1,
          outputTokens: response.outputTokens,
        },
        'model output was not valid structured data; retrying once',
      );
      try {
        const retry = await this.model.chat({
          messages: [
            messages[0],
            {
              role: 'user',
              content: `${userPrompt}\n\n前回は形式に失敗しました。要点を1〜3文・最大500文字に縮め、完全なJSONを一つだけ返してください。`,
            },
          ],
          format: FINAL_FORMAT,
          signal,
        });
        response = {
          ...retry,
          promptTokens: response.promptTokens + retry.promptTokens,
          outputTokens: response.outputTokens + retry.outputTokens,
          totalDurationNs: response.totalDurationNs + retry.totalDurationNs,
        };
        parsedFinal = parseFinal(retry.content);
      } catch (error) {
        this.logger.warn(
          { event: 'model_output_retry_failed', reason: error.message },
          'model output retry failed',
        );
      }
    }
    const final = parsedFinal.value;
    if (parsedFinal.kind === 'recovered') {
      this.logger.warn(
        { event: 'model_output_recovered', outputTokens: response.outputTokens },
        'truncated structured model output was recovered',
      );
    } else if (parsedFinal.kind === 'fallback') {
      this.logger.warn(
        { event: 'model_output_invalid', attempt: 2, outputTokens: response.outputTokens },
        'model output was not valid structured data after retry',
      );
    }
    const greeting = greetingText(currentText);
    if (greeting && final.action === 'respond') final.answer = `${greeting}！`;
    if (isLaughterOnly(currentText) && final.action === 'respond') {
      const laughterAnswer = final.answer
        .trim()
        .split(/\n/u)[0]
        .replace(/(?:それより|ところで|話変わるけど).*$/u, '')
        .trim()
        .slice(0, 30);
      final.answer = /^(?:w{1,8}|ｗ{1,8})(?:\s|[!！?？…。、]|$)/iu.test(laughterAnswer)
        ? '草'
        : laughterAnswer || '草';
    }
    if (
      /(?:今日|きょう).{0,12}(?:占って|占ってみて|おみくじ)/u.test(currentText) &&
      final.action === 'respond'
    ) {
      final.answer = final.answer
        .replace(/^@\S+\s*/u, '')
        .replace(/(?:明日|あした|翌日)[^。！？!\n]*(?:[。！？!]|$)/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
    }
    if (isSelfDescriptionQuestion(currentText) && final.action === 'respond') {
      const lines = final.answer
        .split(/\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      const substantive = lines.find(
        (line) =>
          !/(?:プロフィールから|性格.{0,8}(?:わから|わかりま)|AIだから|断定でき|はっきり言え)/u.test(
            line,
          ),
      );
      final.answer = (substantive ?? lines[0] ?? final.answer).slice(0, 160);
    }
    if (isGeneralOpinionQuestion(currentText) && final.action === 'respond') {
      final.answer = final.answer.trim().split(/\n/u)[0].slice(0, 160);
    }
    if (parsedFinal.kind === 'fallback' && !decision.solicited && context.mode !== 'all') {
      return {
        action: 'silent',
        answer: '',
        usedWeb: results.length > 0,
        promptTokens: response.promptTokens,
        outputTokens: response.outputTokens,
        totalDurationNs: response.totalDurationNs,
      };
    }
    if (final.action === 'respond') final.answer = removeDanglingJsonBrace(final.answer);

    if (parsedFinal.kind !== 'fallback' && final.action === 'respond' && results.length > 0) {
      const references = results
        .slice(0, 5)
        .map((result, index) => `[${index + 1}] ${result.title}: ${result.url}`)
        .join('\n');
      final.answer = `${final.answer.trim()}\n\n参照（${new Date().toLocaleDateString('ja-JP', { timeZone: this.config.timezone })}取得）\n${references}`;
    }

    if (final.action === 'respond') {
      const guarded = guardAssistantAnswer(
        final.answer,
        context.system,
        context.recent.map((message) => message.messageId),
      );
      final.answer = guarded.answer;
      if (guarded.reason) {
        this.logger.warn(
          { event: 'output_guard_triggered', reason: guarded.reason },
          'assistant output guard triggered',
        );
        if (
          !decision.solicited &&
          context.mode !== 'all' &&
          guarded.reason !== 'internal_context_marker'
        ) {
          final.action = 'silent';
          final.answer = '';
        }
      }
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
