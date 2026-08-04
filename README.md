# Discord AI Chat

指定したDiscordチャンネルの会話へ、ローカルLLMが一参加者として加わるBotです。複数人の発言、返信関係、直近のネタや話題を短期的に把握し、必要な場合はWeb検索して出典付きで答えます。

## 主な特徴

- Node.js JavaScript ESM
- Discord.jsによるGateway接続とスラッシュコマンド
- Ollama上のローカルLLM（既定 `qwen3.5:9b`、RTX 2060ではCPU/GPU hybrid）
- チャンネル単位の連投集約と直列処理
- SQLite WALによる24時間の短期会話記憶
- 会話セッション要約。個人の性格や人間関係は推測・保存しません
- 明示表現と構造化LLM判定による話題の自動分離。新しい話題へ古い会話を混ぜません
- 本人が任意登録した自己紹介・公開リンクから、明記された活動や興味だけを回答へ反映
- SearXNGによるアカウント不要のWeb検索
- 参照URL付きの最新情報回答
- WebUIなし。Docker Compose、CLI、Discordコマンドで運用

詳細は [.docs/README.md](./.docs/README.md) を参照してください。

## 必要環境

- Docker Engine + Docker Compose（本番推奨）またはNode.js 24以上
- Ollamaとtool/structured outputに対応するモデル
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
BOT_CONFIG=config/bot.yaml
BOT_DATABASE_PATH=data/bot.sqlite3
```

`.env`、`config/bot.yaml`、SQLite DBはGitへコミットされません。

## 実行

```bash
npm run doctor
npm run register-commands
npm run compare-models -- qwen3.5:4b qwen3.5:9b
npm run analyze-history -- 200
npm run audit-internal -- 1000
npm run security-smoke
npm test
npm start
```

RyzenサーバーではDocker Composeを利用します。`runtime/bot.env`、`runtime/bot.yaml`、`runtime/searxng-settings.yml`を用意してから次を実行します。

```bash
docker compose up -d --build
```

Botはhost networkを利用し、既存Ollamaの`127.0.0.1:11434`へ接続します。SearXNGはbridge networkから`127.0.0.1:8888`だけへ公開されます。LAN・インターネット向けの公開ポートは追加しません。

## Discord権限

Botへ次だけを付与します。

- View Channels
- Read Message History
- Send Messages
- Send Messages in Threads
- Use Application Commands

Developer PortalのBot設定でMessage Content Intentを有効にしてください。Administrator権限は不要です。

## コマンド

- `/ai-status` — 稼働状態
- `/ai-privacy` — データの用途と保持期間
- `/ai-preferences` — 本人が明示する呼び名・口調・回答長
- `/ai-profile` — 本人の自己紹介・自分の公開リンクの登録、再取得、削除
- `/ai-forget` — 保存中の本人データを削除
- `/ai-mode`、`/ai-pause`、`/ai-resume` — 管理者向け応答制御
- `/ai-context-reset` — 現在の会話文脈を破棄
- `/ai-topic-reset` — 現在の話題を区切り、次の発言から新しい流れにする
- `/ai-report` — 問題報告

`/ai-status`、`/ai-privacy`と管理者によるモード変更・停止・再開・話題リセットの成功結果は、チャンネル全員に表示されます。本人情報を扱う`/ai-preferences`、`/ai-profile`、`/ai-forget`、報告内容、権限エラーは実行者だけに表示されます。
設定・保存データ・応答モード・話題を変更した成功通知は、通常会話と区別できる色付きEmbedで表示します。

返信、「それで」などの続き、短いリアクションは現在の話題を引き継ぎます。「ところで」「話を変える」などは即座に新しい会話セッションへ分離します。それ以外も、現在の発言が高信頼度で別話題と判定された場合は今回の発言だけを新セッションへ移し、古い要約と発言を回答モデルへ渡しません。判定失敗時は誤分離を避けるため現在のセッションを維持します。

## プライバシー

Botは対象チャンネルの現在の会話を理解する目的で、本文と会話要約を既定24時間保存します。過去ログの一括取得、個人の性格・属性・人間関係のプロファイル、メッセージを使ったモデル学習は行いません。`/ai-profile`は本人が同意して登録した情報だけを扱い、公開ページに明記された活動・作品・趣味・関心だけを抽出します。

`analyze-history`は保持期間内の本文を読み取り専用でローカルLLMへ渡し、名前・ID・URLを除いた応答品質の傾向だけを出力します。モデルの追加学習や個人profileの作成には使用しません。

モデルの構造化出力が壊れた場合は生出力をDiscordへ送らず定型文へ置き換えます。正常な出力も投稿直前に検査し、内部話者label、contextのmessage ID、prompt section、非信頼データ用tagを除去または遮断します。

## ライセンス

Private use。公開ライセンスを設定する場合は別途決定してください。
