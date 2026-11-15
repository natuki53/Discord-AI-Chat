function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// 検索候補全体ではなく、Claudeが最終本文で引用した資料だけを取り出す。
export function extractWebResponse(blocks) {
  const documents = blocks
    .filter((block) => block.type === 'web_fetch_tool_result')
    .map((block) => block.content)
    .filter((result) => result?.type === 'web_fetch_result')
    .map((result) => ({ url: result.url, title: result.content?.title }));
  const lastTool = blocks.findLastIndex(
    (block) => block.type === 'server_tool_use' || block.type.endsWith('_tool_result'),
  );
  const sources = [];
  const text = blocks
    .slice(lastTool + 1)
    .filter((block) => block.type === 'text')
    .map((block) => {
      const indices = new Set();
      for (const citation of block.citations ?? []) {
        const source =
          citation.type === 'web_search_result_location'
            ? citation
            : documents[citation.document_index];
        const url = sourceUrl(source?.url);
        if (!url) continue;
        let index = sources.findIndex((item) => item.url === url);
        if (index < 0) {
          index = sources.length;
          sources.push({ url, title: String(source.title ?? citation.document_title ?? '参照元') });
        }
        indices.add(index + 1);
      }
      return `${block.text}${[...indices].map((index) => `[${index}]`).join('')}`;
    })
    .join('');
  const webErrors = blocks
    .filter((block) => ['web_search_tool_result', 'web_fetch_tool_result'].includes(block.type))
    .filter((block) => block.content?.error_code)
    .map((block) => ({ tool: block.type, code: block.content.error_code }));
  return { content: text, sources, webErrors };
}
