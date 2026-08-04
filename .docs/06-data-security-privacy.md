# データ・セキュリティ・プライバシー設計書

## 1. 方針

このBotは会話の流れを理解するためDiscordメッセージを一時処理するが、サーバーの長期アーカイブ、個人分析、学習データ作成を目的としない。

基本原則:

- 目的に必要なデータだけを取得する。
- 対象チャンネルをallowlistで限定する。
- message本文と会話要約を短期間で削除する。
- 個人の性格、属性、人間関係を推測・保存しない。
- 本人が明示した会話上の好みと、本人が同意して登録した自己紹介・公開リンクだけを長期保存する。
- 利用者が保存内容、用途、削除方法を確認できるようにする。
- Discordメッセージをモデル学習、fine-tuning、評価datasetの素材にしない。
- 外部検索には公開情報の検索に必要な短いqueryだけを送る。
- 応答品質の履歴分析は保持期間内・読み取り専用・local LLMに限定し、個人profileや学習datasetを作らない。

## 2. Discordポリシー境界

2026-08-04時点のDiscord Developer Policyでは、少なくとも次が重要となる。

- API DataはBotの明示された機能に必要な目的だけで使う。
- Discord利用者、そのidentity、他利用者とのrelationshipをAPI Dataからprofileしない。
- Discord上のデータをmine/scrapeしない。
- Discord APIから得たmessage contentで機械学習・AIモデルを訓練しない。例外はDiscordの明示的許可がある場合のみ。
- opt-outやBotを空間から削除する利用者・管理者の選択を尊重する。
- 最小限の権限だけを要求する。

本設計での対応:

| Policy上の論点      | 実装上の境界                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| User profiling禁止  | 履歴から性格・関係性profileを作らない。現在sessionのtoneを一時的に使うだけ |
| Mining/scraping禁止 | 過去ログの一括import、全channel走査、統計分析を行わない                    |
| Training禁止        | messageをtraining/fine-tuning datasetへ出力する機能を作らない              |
| Purpose limitation  | allowlist channelの現在会話への返答と短期contextに限定                     |
| Opt-out             | `/ai-forget`、channel pause、Bot権限削除に対応                             |
| Data care           | 短期retention、secret分離、本文logging禁止、backup期限                     |

本人が`/ai-profile`で自分の情報を能動的に登録する機能は、Discord API Dataから人物像を作る機能と分離する。Bot tokenでDiscordの自己紹介・連携SNSを取得せず、第三者による代理登録も許可しない。外部ページからは本人が明記した活動・作品・趣味だけを抽出し、性格や機微情報へ変換しない。

したがって、当初案にある「サーバーのチャンネル履歴を読み、その人がどんな人かを把握する」はそのまま実装しない。現在会話の流れを理解してネタへ乗ることは行うが、個人の恒久的な特徴へ変換しない。

参考:

- [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)
- [Discord Gateway intents](https://docs.discord.com/developers/events/gateway)
- [Discord Message Resource](https://docs.discord.com/developers/resources/message)
- [Discord OAuth2 and Permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)

運用開始前と大きな機能追加前に最新版を再確認する。

## 3. データ分類

| 分類                  | 例                                    |         保存 |             ログ |               外部送信 |
| --------------------- | ------------------------------------- | -----------: | ---------------: | ---------------------: |
| Secret                | Discord token、search key             | env fileのみ |             禁止 |             認証先のみ |
| Discord識別子         | guild/channel/message/user ID         |     必要期間 | raw値はdebug禁止 |                   禁止 |
| Message content       | 本文、reply内容                       |   既定24時間 |             禁止 |          local LLMのみ |
| Session summary       | 話題、未解決質問、現在のネタ          |   既定24時間 |             禁止 |                   禁止 |
| Explicit preference   | 呼び名、口調、回答長、banter level    | 本人削除まで |     変更種別のみ |                   禁止 |
| Self-provided profile | 自己紹介、本人の公開URL、明記事項要約 | 本人削除まで |   hostと成否のみ | local LLM、公開URL取得 |
| Operational metadata  | job状態、所要時間、error code         |     30日目安 |             許可 |         障害通知先のみ |
| Public Web cache      | 公開URL、抽出本文                     |        6時間 |     URL hostのみ |  search/fetch provider |
| Bot responses         | Discord投稿ID、job metadata           |     最大30日 |         本文禁止 |                Discord |

Discord IDは内部結合と削除要求の実行に必要な範囲で保存する。username、avatar、role一覧、presence、参加channel一覧は保存しない。

## 4. データモデル

SQLiteはWAL mode、foreign keys有効、busy timeout設定で使用する。timestampはUTCのISO 8601、Discord snowflakeは`TEXT`とする。

### 4.1 `channels`

| column              | type      | 制約・説明                 |
| ------------------- | --------- | -------------------------- |
| `guild_id`          | TEXT      | PKの一部                   |
| `channel_id`        | TEXT      | PKの一部                   |
| `mode`              | TEXT      | all/ambient/mention/paused |
| `previous_mode`     | TEXT NULL | pause復帰用                |
| `config_hash`       | TEXT      | 起動設定との整合確認       |
| `version`           | INTEGER   | message更新ごとにincrement |
| `active_session_id` | TEXT NULL | current session            |
| `updated_at`        | TEXT      | UTC                        |

Primary key: `(guild_id, channel_id)`。

### 4.2 `messages`

| column                | type      | 制約・説明                       |
| --------------------- | --------- | -------------------------------- |
| `message_id`          | TEXT      | PK                               |
| `guild_id`            | TEXT      | allowlist Guild                  |
| `channel_id`          | TEXT      | allowlist channel/thread         |
| `author_id`           | TEXT      | 本人削除に必要                   |
| `author_type`         | TEXT      | human/bot/webhook/system         |
| `content`             | TEXT NULL | 削除・retention後はNULL          |
| `content_hash`        | TEXT NULL | 重複・整合確認。本文削除時にNULL |
| `reply_to_message_id` | TEXT NULL | reply graph                      |
| `created_at`          | TEXT      | Discord timestamp                |
| `edited_at`           | TEXT NULL | 最終編集時刻                     |
| `deleted_at`          | TEXT NULL | Discord削除時刻                  |
| `expires_at`          | TEXT      | 本文削除期限                     |
| `ingested_at`         | TEXT      | Bot受信時刻                      |

Indexes:

- `(guild_id, channel_id, created_at DESC)`
- `(author_id, expires_at)`
- `(expires_at)`

`content_hash`は秘密salt付きHMACではなく単純hashにすると短文の辞書攻撃が可能なため、重複判定にmessage IDが使えるMVPではhash自体を省略してよい。必要ならservice secretによるHMACとする。

### 4.3 `conversation_sessions`

| column                    | type      | 制約・説明                  |
| ------------------------- | --------- | --------------------------- |
| `session_id`              | TEXT      | PK、UUID                    |
| `guild_id`                | TEXT      | scope                       |
| `channel_id`              | TEXT      | scope                       |
| `started_at`              | TEXT      | UTC                         |
| `last_activity_at`        | TEXT      | UTC                         |
| `status`                  | TEXT      | active/closed/dirty/deleted |
| `summary_json`            | TEXT NULL | schema検証済みJSON          |
| `summary_source_until_id` | TEXT NULL | 要約済み末尾                |
| `expires_at`              | TEXT      | 削除期限                    |

summaryに個人の性格やrelationshipを保存しない。schemaで禁止fieldを拒否し、保存前にsensitive scannerを通す。

### 4.4 `user_preferences`

| column            | type      | 制約・説明                 |
| ----------------- | --------- | -------------------------- |
| `guild_id`        | TEXT      | PKの一部                   |
| `user_id`         | TEXT      | PKの一部                   |
| `preferred_name`  | TEXT NULL | 32文字以下                 |
| `tone`            | TEXT      | auto/casual/neutral/formal |
| `response_length` | TEXT      | short/normal/detailed      |
| `banter_level`    | TEXT      | low/normal/high            |
| `consented_at`    | TEXT      | 本人が設定した時刻         |
| `updated_at`      | TEXT      | UTC                        |

自由記述欄、管理者代理入力、推測値、confidenceは持たない。

### 4.4.1 `user_profiles`

| column             | type      | 制約・説明                                      |
| ------------------ | --------- | ----------------------------------------------- |
| `guild_id`         | TEXT      | PKの一部                                        |
| `user_id`          | TEXT      | PKの一部、command実行本人                       |
| `self_description` | TEXT NULL | 本人入力、300文字以下                           |
| `links_json`       | TEXT      | 本人の公開HTTPS URL、最大2件                    |
| `source_summary`   | TEXT NULL | ページに明記された活動・作品・趣味だけ、700文字 |
| `consented_at`     | TEXT      | 本人が利用へ同意した時刻                        |
| `refreshed_at`     | TEXT      | 公開ページの最終取得時刻                        |
| `updated_at`       | TEXT      | UTC                                             |

通常のBot APIからDiscordのprofileや連携アカウントを自動取得しない。URL取得にはWeb fetchと同じSSRF、redirect、timeout、size制限を適用する。LLM要約は推測・人物評価・保護属性・人間関係をschemaとpromptで禁止し、本人情報が必要なターンの発言者本人への回答調整だけに利用する。

### 4.5 `response_jobs`

| column                    | type      | 制約・説明           |
| ------------------------- | --------- | -------------------- |
| `job_id`                  | TEXT      | PK                   |
| `guild_id`                | TEXT      | scope                |
| `channel_id`              | TEXT      | scope                |
| `session_id`              | TEXT NULL | snapshot             |
| `source_message_ids_json` | TEXT      | ID配列のみ           |
| `state`                   | TEXT      | state machine        |
| `attempt_count`           | INTEGER   | retry制御            |
| `snapshot_version`        | INTEGER   | stale判定            |
| `discord_response_id`     | TEXT NULL | 投稿成功時           |
| `error_category`          | TEXT NULL | 秘密や本文なし       |
| `created_at`              | TEXT      | UTC                  |
| `updated_at`              | TEXT      | UTC                  |
| `expires_at`              | TEXT      | job metadata削除期限 |

### 4.6 `web_cache`

| column                | type | 制約・説明                      |
| --------------------- | ---- | ------------------------------- |
| `cache_key`           | TEXT | PK                              |
| `kind`                | TEXT | search/page                     |
| `request_fingerprint` | TEXT | normalized queryまたはURLのHMAC |
| `payload_json`        | TEXT | 公開Webデータ                   |
| `fetched_at`          | TEXT | UTC                             |
| `expires_at`          | TEXT | TTL                             |

### 4.7 `audit_events`

| column          | type      | 制約・説明                                       |
| --------------- | --------- | ------------------------------------------------ |
| `event_id`      | TEXT      | PK                                               |
| `actor_id`      | TEXT NULL | command実行者。30日後削除可能                    |
| `guild_id`      | TEXT      | scope                                            |
| `channel_id`    | TEXT NULL | scope                                            |
| `action`        | TEXT      | mode_changed/preference_reset/forget_requested等 |
| `metadata_json` | TEXT      | 件数・状態のみ。本文禁止                         |
| `created_at`    | TEXT      | UTC                                              |
| `expires_at`    | TEXT      | 30日目安                                         |

## 5. Retention

推奨既定値:

| データ                |                       保持 |
| --------------------- | -------------------------: |
| 人間message本文       |                     24時間 |
| session summary       |     最終activityから24時間 |
| Web page cache        |                      6時間 |
| Search cache          |                       30分 |
| job metadata          |                       30日 |
| audit event           |                       30日 |
| explicit preference   | 本人がreset/forgetするまで |
| self-provided profile | 本人がreset/forgetするまで |
| 日次backup            |                      7世代 |

1時間ごとのcleanup jobで期限切れデータを削除する。SQLiteのfile size回収は毎回`VACUUM`せず、週次maintenance windowで`VACUUM`または`VACUUM INTO`を検討する。

## 6. 利用者による確認・削除

### 6.1 `/ai-privacy`

表示内容:

- Botが応答する対象チャンネルであること。
- 本文とsession summaryの保持時間。
- 個人の性格・relationshipを推測保存しないこと。
- ローカルLLMを利用すること。
- 最新情報検索時に個人情報を除いたqueryを検索providerへ送ること。
- `/ai-preferences`、`/ai-profile`、`/ai-forget`の使い方。
- 問題報告先。

### 6.2 `/ai-forget`

二段階確認のephemeral commandとする。

削除対象:

- 同一Guild内で`author_id`が本人の保持中message本文。
- 本人のexplicit preferences。
- 本人が登録したself-provided profile、公開URL、明記事項要約。
- 本人の発言を含むactive session summary。summaryは破棄して残存messageから再構築するか、session全体をresetする。
- 未投稿jobに本人のmessageだけが含まれる場合はcancel。複数人turnなら本人本文を除いて再構築。

保持できるもの:

- commandを実行した事実と削除件数。本文と設定値は残さない。
- Discord上に既に投稿されたBot回答。本人が削除を希望する場合は管理者へのreport導線を案内する。

backup内のデータは最大7日で自然失効する。backup復元時はservice起動前にretention cleanupと、保持中の削除要求ledgerを再適用する。

## 7. 権限設計

### 7.1 Discord権限

要求するもの:

- View Channel
- Read Message History
- Send Messages
- Send Messages in Threads（Thread対応時）
- Use Application Commands
- Embed Links（参照表示で必要なら）

要求しないもの:

- Administrator
- Manage Guild
- Manage Channels
- Manage Messages
- Manage Roles
- Kick Members
- Ban Members
- Mention Everyone

`MESSAGE_CONTENT` privileged intentはDeveloper Portalで有効化する。規模拡大によりverified appの条件へ入る場合は、Discordの審査と最新ルールを確認する。

### 7.2 OS権限

- 専用user `discord-ai` で実行する。
- login shell、sudo権限を与えない。
- app directoryはread-only、`data/`と`logs/`だけwrite可。
- env fileはrootまたはservice user所有、mode 0600。
- Ollama APIはloopback bind。
- Bot processからSSH key、home directory、Docker socketへアクセスさせない。

## 8. Secret管理

- `.env`をrepositoryへcommitしない。
- `.env.example`はkey名だけを示す。
- Pino redactionに`token`、`authorization`、`apiKey`、`cookie`を登録する。
- exception objectやHTTP headersを丸ごとserializeしない。
- Discord token漏洩時はDeveloper Portalで即時resetし、service停止、env更新、ログ確認を行う。
- Search key漏洩時はprovider側でrevoke/rotateする。
- secretをDiscord command、prompt、LLM tool resultへ渡さない。

## 9. Threat model

| 脅威                      | 攻撃例                                   | 防御                                             |
| ------------------------- | ---------------------------------------- | ------------------------------------------------ |
| Prompt injection          | 利用者がsystem rule無視を要求            | prompt hierarchy、tool schema、app側policy       |
| Indirect injection        | Web本文が秘密開示や別URL取得を命令       | 非信頼境界、search-result allowlist、tool budget |
| SSRF                      | `127.0.0.1:11434`やrouter管理画面をfetch | public HTTPSのみ、DNS/IP検証、redirect再検証     |
| Mention abuse             | AIが`@everyone`を生成                    | `allowedMentions: { parse: [] }`                 |
| Bot loop                  | 別Botの発言へ相互返信                    | bot/webhook除外                                  |
| Token exfiltration        | error/debugでheader出力                  | redaction、秘密をLLMへ渡さない                   |
| DB theft                  | server userがSQLiteを読む                | service user権限、disk暗号化推奨、短期retention  |
| Data overcollection       | 全channelや古い履歴を読む                | allowlist、履歴bootstrapなし、24h保持            |
| Profile drift             | 冗談を個人性格として固定                 | user profile生成なし、session summary schema制限 |
| Message flood             | 高頻度投稿でGPU/queue枯渇                | queue上限、coalescing、global concurrency 1      |
| Malformed Discord content | zero-width、巨大emoji、制御文字          | normalize、長さ上限、schema validation           |
| Supply chain              | npm package侵害                          | lockfile、依存最小化、audit、更新review          |

## 10. Loggingと監査

通常ログ例:

```json
{
  "level": "info",
  "event": "response_posted",
  "correlationId": "...",
  "guildHash": "...",
  "channelHash": "...",
  "sourceMessageCount": 3,
  "usedWeb": true,
  "latencyMs": 8240,
  "model": "configured-model",
  "promptTokens": 4210,
  "outputTokens": 118
}
```

禁止するログ:

- message本文。
- username、preferredName。
- Web query全文、page本文。
- Discord/API token。
- LLM thinking。
- structured summaryの中身。

debug時も本番message本文loggingを有効化しない。再現には人工fixtureか、利用者が明示して提供した最小例を使う。

## 11. チャンネル告知文案

```text
このチャンネルではAI Botが会話に参加します。
Botは会話の流れを保つため直近のメッセージを最大24時間一時保存しますが、過去ログから個人の性格や人間関係を分析・保存したり、メッセージをAI学習に使ったりしません。
最新情報を調べるときは、個人情報を除いた検索語を外部検索サービスへ送る場合があります。
本人が /ai-profile で登録した自己紹介と自分の公開リンクは、明記された活動や興味だけを回答調整へ利用し、人物評価には使いません。
保存内容と設定は /ai-privacy、自分の設定削除は /ai-preferences reset と /ai-profile reset、関連データ削除は /ai-forget で確認できます。
```

本番導入時はBotのApplication profileまたは固定messageから常に確認できるようにする。
