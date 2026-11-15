# Discord AI Chat

指定したDiscordチャンネルの会話へ、Claude APIが一参加者として加わるBotです。複数人の発言、返信関係、直近のネタや話題を短期的に把握し、必要な場合はWeb検索して出典付きで答えます。

## 主な特徴

- Node.js JavaScript ESM
- Discord.jsによるGateway接続とスラッシュコマンド
- AnthropicのClaude Messages API（既定 `claude-sonnet-5-5`、Ollama・GPU不要）
- Claudeが描くSVGイラストと、PNGプレビュー・編集用SVGのDiscord添付（追加API不要）
- チャンネル単位の連投集約と直列処理
- SQLite WALによる24時間の短期会話記憶
- 会話セッション要約。個人の性格や人間関係は推測・保存しません
- 明示表現と構造化LLM判定による話題の自動分離。名前や「さっきの続き」で参照された会話は保持期間内で補います
- 本人が任意登録した自己紹介・公開リンクから、明記された活動や興味だけを回答へ反映
- SearXNGによるアカウント不要のWeb検索
- 参照URL付きの最新情報回答
- WebUIなし。Docker Compose、CLI、Discordコマンドで運用

詳細は [.docs/README.md](./.docs/README.md) を参照してください。

2026-11-12の[機能見直し](./.docs/10-group-chat-review.md)に基づき、会話を追う処理と発言する判断を分けました。標準の`ambient`では、AI宛の依頼に応じ、人間同士の会話では黙り、冗談や感想でも自然に参加できます。生成中の人間の回答や撤回で、不要になった返答を取り下げます。[実装・設定・検証](./.docs/11-group-chat-implementation.md)も参照してください。

応答の操作は`/ai` →「チャンネル設定」にまとめています。「おまかせ」「呼んだときだけ」「停止」から選べます。旧`all`は「おまかせ」へ統合し、停止中・呼びかけ限定の設定は維持します。自発参加の初期間隔は20秒、候補の期限は45秒、直接依頼の期限は180秒です。沈黙時はtypingや検索をせず、短期文脈と要約は保ちます。

2026-11-14に、表示名・指示語の解釈、話者ラベルの共有、保持期間内の以前の会話の参照、replyの連鎖、添付の未解析表示を改善し、11月15日に参加制御とあわせて本番へ反映しました。[変更・検証・配備記録](./.docs/12-conversation-context.md)を参照してください。保存済みのモデル・effort・応答モードは維持しています。会話の既定保持は24時間のままです。

## 必要環境

- Docker Engine + Docker Compose（本番推奨）またはNode.js 24以上
- Anthropic Consoleで発行したClaude APIキーとAPI利用枠
- Discord Application/Bot token
- Web検索を使う場合はSearXNG

## ローカル準備

```bash
npm install
cp config/bot.example.yaml config/bot.yaml
cp .env.example .env
```

`config/bot.yaml`へGuild IDと対象チャンネルIDを設定し、`.env`へ次を設定します。

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
ANTHROPIC_API_KEY=...
BOT_CONFIG=config/bot.yaml
BOT_DATABASE_PATH=data/bot.sqlite3
```

`.env`、`config/bot.yaml`、SQLite DBはGitへコミットされません。

会話生成・要約・話題判定・プロフィール抽出はすべてClaude APIを使用し、トークンに応じてAPI利用料金が発生します。`llm.contextTokens`は送信する直近会話の量、`llm.maxOutputTokens`はthinkingを含む1回の生成上限（既定4096）を調整します。両モデルでadaptive thinkingを使用し、`llm.effort`の初期値は`medium`です。高いeffortでは時間と出力トークンが増える場合があります。APIキーは環境変数だけで管理し、YAMLへ書かないでください。

既存環境から移行する場合は、`config/bot.yaml`（Composeでは`runtime/bot.yaml`）の`llm.baseUrl`を`https://api.anthropic.com`、`llm.model`を`claude-sonnet-5-5`へ変更し、`temperature`と`keepAlive`を削除します。`runtime/bot.env`にも`ANTHROPIC_API_KEY`を追加し、Botを再作成してください。旧Ollama設定は起動時に拒否します。

## 実行

```bash
npm run doctor
npm run register-commands
npm run compare-models -- claude-haiku-5-5 claude-sonnet-5-5
npm run analyze-history -- 200
npm run audit-internal -- 1000
npm run security-smoke
npm run participation-smoke
npm test
npm start
```

RyzenサーバーではDocker Composeを利用します。`runtime/bot.env`、`runtime/bot.yaml`、`runtime/searxng-settings.yml`を用意してから次を実行します。

```bash
docker compose up -d --build
```

Botはhost networkを利用し、Claude APIの`https://api.anthropic.com`へ接続します。SearXNGはbridge networkから`127.0.0.1:8888`だけへ公開されます。LAN・インターネット向けの公開ポートは追加しません。

## Discord権限

Botへ次だけを付与します。

- View Channels
- Read Message History
- Send Messages
- Send Messages in Threads
- Attach Files（画像生成を使う場合）
- Use Application Commands

Developer PortalのBot設定でMessage Content Intentを有効にしてください。Administrator権限は不要です。

## コマンド

- `/ai` — メニューを開く。普段の操作はここから行います。
- `/ai-image prompt:描いてほしい内容` — イラストを1枚生成。

`/ai`は本人だけに表示されるメニューです。コマンド名や設定値を覚える必要はありません。

- **自分の設定**：呼び名・自己紹介・自分の公開リンクを一つの入力フォームで編集。話し方と返答の長さも選べます。入力した情報を本人への返答調整に使うことを明示します。
- **使い方・データ**：利用方法、保持期間、自分の保存データの削除、問題報告。削除・個人設定リセットには本人の確認が必要です。
- **チャンネル設定**：管理者向け。「おまかせ／呼んだときだけ／停止」、話題の区切り、接続確認をまとめています。停止から戻すときも同じ選択欄を使います。

管理者の返答設定は「速さ優先（Haiku・medium）」と「じっくり（Sonnet・high）」の2つです。この設定はサーバー全体へ適用し、SQLiteへ保存して再起動後も引き継ぎます。選び直すまでは保存済みのモデル・effortを維持します。接続確認や保存に失敗した場合も元の設定を保ちます。

以前の13種類のコマンドはこの2種類へ置き換えます。移行内容は[操作の整理](./.docs/13-simple-controls.md)を参照してください。イラストの生成結果は、これまでどおりチャンネルへ投稿します。

### イラスト生成

```text
/ai-image prompt:星空の下で眠る白い猫の絵本風イラスト aspect:landscape
```

`aspect`は正方形・横長・縦長から選べます。指定しなければ正方形です。依頼文は最大2000文字で、1回につき1枚を生成します。ClaudeがSVGを記述し、BotがPNGへ変換して、プレビュー用PNGと編集用SVGをDiscordへ添付します。

既存の`ANTHROPIC_API_KEY`だけで利用できます。メニューで選択中のHaiku/Sonnetとeffortをそのまま使います。SVG生成時は`low` / `medium` / `high`で事前のthinkingを抑え、`xhigh` / `max`でadaptive thinkingを使います。通常会話のthinking設定は変更しません。別の画像生成API契約やキーは不要ですが、ClaudeによるSVG生成分の通常のトークン料金は発生します。

`images`設定の省略時は`provider: claude-svg`、SVG生成の最大8192出力トークン、最大180秒、利用者ごとに60秒の間隔で動作します。会話用の生成上限は変更しません。`images.maxOutputTokens`でSVG生成の上限を調整し、`images.enabled: false`で無効にできます。`/ai`のメニューから利用可否を確認できます。旧設定に`provider: openai`がある場合は`claude-svg`へ変更し、`model`と`quality`を削除してください。

生成はBot全体で同時に1件です。設定済みチャンネルで利用でき、停止中のチャンネルでは実行しません。Botには「ファイルを添付」権限が必要です。`images.cooldownSeconds`で生成間隔を調整できます。

SVGは基本図形・パス・グラデーションを使うベクターイラストです。文字描画、写真のような画像、外部画像の取り込みには対応しません。生成データを厳密にXML解析して許可した要素・属性だけを受け入れ、スクリプト、スタイル、外部URL・ローカルファイル参照を拒否します。PNG変換は[resvg-js](https://github.com/thx/resvg-js)を使い、固定サイズ・別Worker・最大5秒で実行します。

`npm run doctor`はPNG変換機能をローカルで検査します。`npm run image-smoke`は選択中のモデルとeffortで実際にSVGを生成し、PNGへの変換と両ファイルのサイズを検証します。Discordへの投稿や画像のディスク保存は行いません。実APIを使うためClaudeのトークン料金が発生します。

返信、「それで」などの続き、短いリアクションは現在の話題を引き継ぎます。「ところで」「話を変える」などは即座に新しい会話セッションへ分離します。それ以外も、現在の発言が高信頼度で別話題と判定された場合は今回の発言だけを新セッションへ移し、古い要約と発言を回答モデルへ渡しません。判定失敗時は誤分離を避けるため現在のセッションを維持します。

## プライバシー

Botは対象チャンネルの現在の会話を理解する目的で、本文と会話要約をローカルDBへ既定24時間保存します。返答・要約・話題判定・プロフィール抽出に必要な会話文脈、表示名・メッセージID、本人登録情報、参照したWeb資料はAnthropicへ送信します。API側の保持・削除はAnthropicとの契約・設定に従い、メニューから行う本人データ削除はローカルDB内の削除です。過去ログの一括取得、個人の性格・属性・人間関係のプロファイル、メッセージを使ったモデル学習は行いません。プロフィールは本人が同意して登録した情報だけを扱い、公開ページに明記された活動・作品・趣味・関心だけを抽出します。

`/ai-image`は依頼文だけをClaude APIへ送信します。この処理で会話履歴やプロフィールを送ることはありません。依頼文・SVG・PNGをBotのDBやディスクへ保存せず、通常ログへも記録しません。Anthropic側の保持は契約・設定に従います。Discord上の添付画像・SVGはDiscordで管理され、メニューによるローカルDB削除には含まれません。

`analyze-history`は保持期間内の本文を読み取り専用でClaude APIへ渡し、名前・ID・URLを出力しないよう指示した応答品質の傾向を出力します。送信前にDiscordのmention・ID・URLを置換しますが、本文中の名前・機微情報すべての匿名化を保証するものではありません。モデルの追加学習や個人profileの作成には使用しません。

API仕様: [Messages API](https://platform.claude.com/docs/en/api/messages/create)、[構造化出力](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)、[Sonnet 5.5への移行](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)。API version `2026-10-21`を使用し、未対応のsampling parameterは送信しません。

Effort仕様: [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)。高いeffortでも`maxOutputTokens`の上限は維持します。上限へ達すると回答が途中で切れる場合があるため、必要に応じて最大32768まで調整できます。

モデルの構造化出力が壊れた場合は生出力をDiscordへ送らず定型文へ置き換えます。正常な出力も投稿直前に検査し、内部話者label、contextのmessage ID、prompt section、非信頼データ用tagを除去または遮断します。

## ライセンス

Private use。公開ライセンスを設定する場合は別途決定してください。
