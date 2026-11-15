import { createHmac } from 'node:crypto';

export const SPEAKER_LABEL_VERSION = 1;

// 履歴窓の先頭が変わっても同じ話者を指す。別sessionでは異なるラベルになる。
export function speakerLabel(sessionId, message) {
  if (message.authorType === 'bot') return 'AI';
  const digest = createHmac('sha256', sessionId).update(message.authorId).digest('hex');
  return `U${Number.parseInt(digest.slice(0, 12), 16)}`;
}

export function usableSummary(summary) {
  if (!summary) return null;
  // 旧ラベルは当時の履歴窓に依存し、現在の話者へ安全に対応付けできない。
  if (
    summary.speakerLabelVersion !== SPEAKER_LABEL_VERSION &&
    /\bU\d+\b/u.test(JSON.stringify(summary))
  )
    return null;
  return summary;
}
