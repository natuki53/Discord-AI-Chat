import { sanitizeDisplayName } from '../shared/text.js';

const HISTORY_REFERENCE =
  /さっき|先ほど|今まで|これまで|前(?:の話|に話|も話)|覚えて|話してた|君への|あなたへの/u;

export function recallConversation({ previous, recent, sources }) {
  if (!previous.length) return [];
  // 「今までの君へのあたり」のような次の発言でも、直前に言及された相手を保つ。
  const currentText = sources.map((message) => message.content).join('\n');
  const referenceText = [...recent.slice(-6), ...sources]
    .map((message) => message.content)
    .join('\n');
  const referencedAuthors = new Set(
    previous
      .filter((message) => {
        const name = sanitizeDisplayName(message.authorName);
        return message.authorType === 'human' && name.length >= 2 && referenceText.includes(name);
      })
      .map((message) => message.authorId),
  );
  if (!referencedAuthors.size && !HISTORY_REFERENCE.test(currentText)) return [];
  if (!referencedAuthors.size) return previous.slice(-12);

  const selected = new Set();
  for (let index = previous.length - 1; index >= 0 && selected.size < 16; index -= 1) {
    if (!referencedAuthors.has(previous[index].authorId)) continue;
    for (const nearby of [index, index - 1, index + 1]) {
      if (nearby >= 0 && nearby < previous.length && selected.size < 16) selected.add(nearby);
    }
  }
  return [...selected].sort((left, right) => left - right).map((index) => previous[index]);
}
