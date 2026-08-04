# 設計判断・未決事項

## 1. 確定した設計判断

### D-001: JavaScript ESMを使用する

- 状態: 採用
- 決定: Node.js Active LTS上のJavaScript ESMで実装する。
- 補足: TypeScript compileは使わず、JSDoc、Zod、lint、testで型・契約を守る。

### D-002: WebUIを作らない

- 状態: 採用
- 決定: 管理はDiscord slash command、YAML、SSH/CLI、Docker Composeで行う。hostのOllamaだけはsystemd管理とする。
- 理由: 既存のWebUIは不要という方針であり、公開port、認証面、保守対象を増やさない。

### D-003: RyzenサーバーではDocker Composeで配置する

- 状態: 採用
- 決定: 稼働確認済みのDocker ComposeでBotとSearXNGを管理し、既存Ollamaはsystemdのまま利用する。
- 理由: Node.jsのhost導入やsudo、user lingerへ依存せず、Docker restart policyで起動時復旧できる。

### D-004: SQLite WALをMVPの永続化に使う

- 状態: 採用
- 決定: 単一process、単一hostのMVPはSQLiteとする。
- 移行条件: 複数instance、write contention、外部分析要件が発生した場合にPostgreSQLを検討する。

### D-005: 過去ログから個人profileを作らない

- 状態: 採用・変更不可のcompliance boundary
- 決定: 個人の性格、identity、relationshipを推測・保存しない。過去履歴の一括importもしない。
- 代替: 現在sessionの流れ・ネタ・toneを短期保持し、長期的な好みは本人の明示設定だけを使う。
- 根拠: Discord Developer Policyのuser profiling、mining/scraping、trainingに関する制限。

### D-006: 会話の流れは二層で保持する

- 状態: 採用
- 決定: 直近message windowとsession summaryを組み合わせる。
- 既定: 本文・summaryとも24時間、session idle境界15分、最大context 8K tokens。

### D-007: 指定channelの全発言を取り込み、連投は束ねる

- 状態: 採用
- 決定: 人間の対象messageはすべてingestするが、2.5秒以内の連投を1turnとして1応答にする。
- 既定mode: 要望に合わせて`all`。運用上うるさい場合は`ambient`へ即変更できる。

### D-008: ローカル推論はOllama adapter経由

- 状態: 採用
- 決定: Ollamaのchat、tool calling、structured outputを使う。
- 実装値: `qwen3.5:4b`、context 8192、最大output 500 tokens。
- 実機確認: RTX 2060 6GBへ100% GPU offloadし、約4GB VRAMで動作することを確認済み。

### D-009: Web検索はprovider adapter化する

- 状態: 採用
- 決定: `web_search`と`web_fetch`の内部interfaceを固定し、providerを交換可能にする。
- 実装: アカウント不要のself-hosted SearXNGを採用し、`127.0.0.1:8888`だけで待ち受ける。
- 実機確認: 最新情報の検索、参照URL付与、安全なpage fetchをintegration smokeで確認済み。

### D-010: LLMへ任意実行権限を与えない

- 状態: 採用・変更不可のsecurity boundary
- 決定: toolは検索と安全なpage fetchだけ。shell、filesystem、SSH、Discord管理権限を公開しない。

### D-011: Botは外部公開portを持たない

- 状態: 採用
- 決定: healthはCLIとDiscord commandで確認する。Ollamaもloopbackに限定する。

### D-012: Test runnerはNode.js組み込みを第一候補にする

- 状態: 採用
- 決定: JavaScriptのunit/component testは`node --test`を基準にする。
- 変更条件: fake timerやmockの不足が実装を複雑化する場合のみVitestを比較する。

### D-013: 利用者profileは本人オプトイン方式に限定する

- 状態: 採用・変更不可のcompliance boundary。
- 決定: 通常のBot APIからDiscord profileや連携SNSを自動取得せず、本人が`/ai-profile`で登録した自己紹介と自分の公開HTTPS URLだけを扱う。
- 利用範囲: ページに明記された活動・作品・趣味・関心だけを、今回発言した本人への回答調整に使う。
- 禁止: 性格・能力・保護属性・心理・人間関係の推測、第三者による代理登録、過去ログやSNSの横断照合。

## 2. 配備時の決定状況と残課題

### O-001: Discord Application

- 状態: 主要項目を確定。
- Application/Bot名: `AI Chat`。
- 設定: Botを非公開化し、Message Content Intentを有効化済み。
- 残課題: Bot icon、説明文、問題報告先の最終文面。

### O-002: 対象Guild・channel

- 状態: Guildと`aiチャット`チャンネルをruntime設定へ登録済み。
- response mode: `all`。
- security: 実IDは秘密情報ではないが、環境固有値として追跡対象外の`runtime/bot.yaml`だけに置く。
- 残課題: 管理role IDとthread運用の要否。

### O-003: Bot persona

- 状態: 次の初期personaを採用。
  - 砕けた日本語。
  - 1～3文中心。
  - ネタには乗るが、個人攻撃へ加勢しない。
  - 不確かな事実は断定しない。
  - AIであることを聞かれたら明示する。
- 調整先: `runtime/bot.yaml`の`persona`。

### O-004: Default response mode

- 状態: `all`で確定。
- 理由: 「設定されたチャンネルの会話をすべて拾って返す」という要望を優先。
- 観測項目: AIが話しすぎる場合、debounceを3～5秒へ伸ばすか`ambient`へ変更する。

### O-005: Retention

- 状態: message本文24時間、session summary24時間、operational data 30日で確定。
- backup保持は運用開始後に7日を初期値として確認する。
- 選択肢:
  - 6時間: privacy重視、長い一日の会話を忘れやすい。
  - 24時間: 推奨。日中の会話を保ちつつ長期蓄積しない。
  - 72時間: 会話継続性は上がるが保存量とprivacy影響が増える。
- 本番告知文に実値を反映する。

### O-006: LLM model

- 状態: `qwen3.5:4b`を採用。
- 実測: context 8192でRTX 2060へ100% GPU offload、Web検索込みintegration smokeに成功。
- 残課題: 実会話での日本語品質と同時利用時latencyをlimited rolloutで観測する。

### O-007: Search provider

- 状態: self-hosted SearXNGを採用。
- 理由: providerアカウントや外部API keyを不要にする。
- 配置: Docker ComposeでBotと同時管理し、loopbackだけへ公開する。

### O-008: OS・service配置

- 状態: 配備済み。
- host: Ubuntu 26.04、Ryzen 5 3500、RTX 2060 6GB、RAM約30GiB。
- 配置: `/home/natuki/discord-ai-chat`。
- service: BotとSearXNGはDocker Compose、Ollamaはhost service。外部公開portは追加しない。

### O-009: VOICEVOXとの将来連携

- MVP: 対象外。
- 確認事項: RTX 2060上でOllamaと同居させるか、既存サーバーのGTX 1650上のVOICEVOXをnetwork経由で使うか。
- 判断基準: GPU VRAM競合、音声channel要件、利用頻度、network認証。

### O-010: Privacy告知と問題報告先

- 必要な決定: 固定messageを置くchannel、連絡先、reportを誰が確認するか。
- 実装block: full rollout前に必須。

## 3. 配備確認チェックリスト

### Discord側

- [x] Discord Application/Botを作成済み。
- [x] Bot tokenを再発行し、権限600のruntime環境ファイルへ保存済み。
- [x] `MESSAGE_CONTENT` intentをDeveloper Portalで有効化済み。
- [x] Guild IDと対象channel IDを取得済み。
- [ ] 管理role IDを確定する。
- [x] 最小権限でBotをGuildへ追加済み。
- [ ] Privacy告知を置く場所を決めた。

### Server側

- [x] SSH接続可能。
- [x] OSとDocker Composeを確認済み。
- [x] RTX 2060を`nvidia-smi`で認識。
- [x] Ollamaがloopbackで動作。
- [x] Docker imageでNode.js 24を固定。
- [x] app/data/config配置を作成済み。
- [x] OllamaのGPU使用量を確認済み。
- [x] outbound HTTPSが利用可能。

### Product決定

- [x] Bot名・初期personaを確定。
- [x] default response modeを`all`で確定。
- [x] retentionを確定。
- [x] LLM modelの実機smokeを完了。
- [x] Search providerをSearXNGで確定。
- [x] SearXNGを用意し、検索を確認済み。
- [ ] `/ai-report`の確認担当を決定。

### 品質・運用

- [ ] 人工conversation eval corpusを作成。
- [ ] backup/restore手順を確認。
- [x] token漏洩時のrotation手順を実施・確認。
- [ ] shadow → limited → full rollout日程を決める。

## 4. MVP実装チケット案

実装時は次の単位へ分割する。

| Ticket | 内容                          | 完了条件                          |
| ------ | ----------------------------- | --------------------------------- |
| T-001  | Node.js project scaffold      | lint/test/config validationが動く |
| T-002  | SQLite migration/repositories | integration test成功              |
| T-003  | Discord input/filter          | shadowで対象messageだけ記録       |
| T-004  | Turn scheduler                | debounce/直列化unit test成功      |
| T-005  | Ollama adapter/benchmark      | model決定、structured output成功  |
| T-006  | Context/session summary       | budget/session eval成功           |
| T-007  | Conversation orchestration    | basic multi-speaker response成功  |
| T-008  | Discord output/stale policy   | mention安全、二重投稿なし         |
| T-009  | Preferences/privacy commands  | show/set/reset/forget成功         |
| T-010  | Web search/fetch              | citation/SSRF/injection test成功  |
| T-011  | Operations                    | Compose/doctor/backup/restore成功 |
| T-012  | Rollout                       | 72時間limited運転合格             |

## 5. 仕様変更時の判断基準

次の変更は通常の実装判断ではなく、要件・privacy reviewをやり直す。

- 過去messageの一括取得。
- retentionの72時間超への延長。
- 個人別の推測値、embedding、行動scoreの保存。
- 別Guild間のmemory共有。
- Discord messageの外部LLM送信。
- shell、SSH、filesystem、LAN access toolの追加。
- Botへの管理権限付与。
- DMの自動受信・送信。
- WebUIや外部公開APIの追加。

これらは技術的に実装可能かどうかだけでなく、Discord policy、利用者告知、権限、脅威モデルを再評価してから決定する。
