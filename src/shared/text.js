export function sanitizeDisplayName(value) {
  return Array.from(String(value ?? ''))
    .filter((character) => {
      const code = character.codePointAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .replace(/[@#:`]/g, '')
    .trim()
    .slice(0, 32);
}

export function neutralizeMentions(value) {
  return String(value)
    .replace(/@everyone/gi, '@ everyone')
    .replace(/@here/gi, '@ here')
    .replace(/<@&?\d+>/g, '[mention]');
}

export function splitDiscordMessage(value, maximum = 1900) {
  const text = neutralizeMentions(value).trim();
  if (!text) return [];
  if (text.length <= maximum) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maximum) {
    const candidate = remaining.slice(0, maximum);
    const breakAt = Math.max(
      candidate.lastIndexOf('\n\n'),
      candidate.lastIndexOf('\n'),
      candidate.lastIndexOf('。'),
    );
    const cut = breakAt >= Math.floor(maximum * 0.5) ? breakAt + 1 : maximum;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function estimateTokens(value) {
  const text = String(value ?? '');
  return Math.ceil(text.length * 1.2);
}
