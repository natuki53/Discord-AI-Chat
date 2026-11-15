// 旧版の「全会話へ応答」は通常の参加方針へ統合する。
export function normalizeResponseMode(mode) {
  return mode === 'all' ? 'ambient' : mode;
}
