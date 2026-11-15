# 検索・返答・会話の解釈をClaudeへ統合

2026-11-16改訂。

## 変更内容

検索の要否、検索語、追加検索、ページ取得、出典の選択をClaudeに任せる。BotはClaude APIの`web_search_20260318`と`web_fetch_20260318`を渡す。検索語へ利用者の依頼文や現在時刻を機械的に連結する処理、SearXNG adapter、専用Composeサービスは削除した。

公式検索のcitationsと`output_config.format`の厳密なJSON出力は併用できないため、Webが有効な会話では次の2段階を使う。

1. Claudeが必要に応じて検索・ページ取得し、引用付きの回答案を作る。挨拶・雑談・創作では検索不要と伝える。
2. 同じClaudeが回答案と会話をもとに、投稿判断とDiscord用の本文をJSONへ整える。要約・参加判定・画像生成などにはWebツールを渡さない。

引用はAPIの最終text blockにあるcitation metadataから取り出す。取得ページの文書引用もURLへ対応させる。検索候補の全件を出典として表示せず、整形後の本文でも使った資料番号だけを参照一覧へ追加する。Discordのリンクプレビュー抑止、段落、出典番号とURLの対応を維持する。

APIの`pause_turn`は暗号化検索結果とthinkingの署名を変更せず継続する。継続は最大2回、全体timeoutは共通とする。途中の実況、thinking、ツール結果そのものはDiscordへ渡さない。HTTP 200内のツールエラーも分類して記録し、検索失敗時に別の検索サービスへ切り替えない。

## 返答と話題の解釈

- 挨拶の定型文への置き換え、笑いの30文字制限、一般意見の1行化、本人への質問の160文字化、占いの文章削除を撤廃した。Claudeへ会話上の方針を渡し、本文・段落をそのまま保つ。
- 「それで」なら継続、「ところで」なら分離といった固定語句判定を外し、話題境界をClaudeで判定する。意味判定が有効な場合は、保持期限内の文脈を残して判断させる。無効な場合のidle期限、保持期限、明示的な話題リセットは維持する。
- 自発参加の宛先や暗黙の続きはClaudeが判定する。語句によるcooldownの例外を外し、Claudeが`direct_request`か`bot_conversation_continues`と判断した場合に通常の自発参加と区別する。
- Discordの明示的なmention・reply情報、停止、権限、宛先IDの検証、連投制限、期限、取り消し・削除・本人データ削除後の投稿抑止、出力guardはアプリ側に残す。

## 設定と移行

```yaml
web:
  enabled: true
  provider: claude
  timeoutMs: 120000
  maxSearches: 3
  maxFetches: 2
  maxContentTokens: 6000
```

検索は1〜5回、ページ取得は0〜3回、取得本文は1000〜20000 tokensの範囲で設定する。`maxFetches: 0`でページ取得ツールを渡さない。`web.enabled: false`では両ツールと回答案の生成を無効にする。

旧`provider: searxng`と`provider: disabled`は、起動時に`enabled`を維持して`claude`へ変換する。旧URL、10秒のtimeout、結果件数、取得byte数は引き継がない。runtime設定ファイルの書き換えは不要。新規構成のComposeはBotだけで、検索用の公開ポートはない。

会話文脈は従来どおりAnthropicへ送る。検索エンジンへ渡す検索語と取得URLはClaudeが作るため、会話の個人情報・秘密値・Discord ID・本人登録プロフィールを転記しないよう指示する。これはアプリが検索語を横取りして匿名化する保証ではない。検索語、本文、thinking、暗号化結果、APIキーは通常ログに保存しない。

通常のトークン料金に加え、公式Web検索の料金が発生する。公式料金は1,000検索あたり10 USD、検索結果の入力tokensは別。回答案と整形の2回分のtokensも使用する。ページ取得本文のtokensにも通常料金が発生する。

## 検証

ローカルで159件のNode.jsテスト、lint、整形検査に成功。HaikuとSonnetの両方でニュース・凍結手続き・指定URL・挨拶の実API検証に成功し、指定URLのweb_fetchと、挨拶での検索未使用を確認した。人工会話の品質検証にも成功した。X公式ヘルプを直接取得できないケースは残り、第三者の情報と区別した回答になる。

- `npm test`: 署名付きの継続、回数・中断・打ち切り、引用とURLの対応、使用した引用だけの表示、検索失敗、返答の段落保持、既存の投稿抑止と保持期限を検証する。
- `npm run web-smoke -- claude-haiku-5-5`: 人工のニュース・凍結手続き・指定URL・挨拶で実APIを使う。モデル引数を省略した場合は設定ファイルのモデルを使う。Discordへの投稿や会話DBの参照は行わない。
- `npm run quality-smoke`: 人工会話で挨拶、本人登録情報、一般意見、笑い、占い、話題の分離を実APIで検証する。
- `npm run doctor`: Models APIで選択モデルの検索対応を確認する。検索の実行や組織側の利用可否を完全に検証するものではなく、実動作は`web-smoke`で確認する。

検索しても公式ページの取得制限、検索エンジン側の網羅性、モデルの出典選択によって確認できない情報は残る。検索移行だけで全ての事実の正確性を保証しない。

## 公式仕様

- [Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
- [Structured outputsの互換性](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#feature-compatibility)
