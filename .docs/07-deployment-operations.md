# 配置・運用設計書

## 1. 配置方針

- 対象ホスト: `home-server-2`
- OS: Ubuntu 26.04 LTS
- 実行方式: Docker Compose（実機確認後の採用方式）
- Bot本体: Node.js単一process
- LLM: 同一ホストのOllama service
- DB: local SQLite
- 外部公開port: なし
- 管理: SSH、Docker Compose、Docker logs、Discord slash command
- Docker: 稼働確認済み。`restart: unless-stopped`で常時運転する

実機調査でUbuntu 26.04 LTS、Docker 29、Docker Compose v5、Ollamaのloopback稼働を確認済み。Botはhost networkを使用してOllama `127.0.0.1:11434`と、loopbackへpublishしたSearXNG `127.0.0.1:8888`へ接続する。Docker restart policyによりuser lingerやログイン状態へ依存しない。

## 2. 配置構成

```text
/home/natuki/discord-ai-chat/
├─ compose.yaml
├─ Dockerfile
├─ src/
├─ scripts/
├─ runtime/
│  ├─ bot.yaml                   # environment固有、Git対象外
│  ├─ bot.env                    # mode 0600、secret、Git対象外
│  └─ searxng-settings.yml
└─ data/
   ├─ bot.sqlite3
   ├─ bot.sqlite3-wal
   ├─ bot.sqlite3-shm
   └─ backups/
```

Bot imageは非rootの`node` userで実行し、全Linux capabilityをdropする。host側で書込みが必要なのは`data/`だけとし、`runtime/bot.yaml`はread-only mount、`runtime/bot.env`はComposeの`env_file`として読む。

## 3. Network matrix

| From         | To                  | Protocol/Port | 用途                | 必須                     |
| ------------ | ------------------- | ------------- | ------------------- | ------------------------ |
| Bot          | Discord Gateway/API | WSS/HTTPS 443 | 受信・投稿          | 必須                     |
| Bot          | `127.0.0.1:11434`   | HTTP          | Ollama chat         | 必須                     |
| Bot          | Search provider     | HTTPS 443     | 最新情報検索        | Web有効時                |
| Bot          | Public Web          | HTTPS 443     | page fetch          | providerが代行しない場合 |
| LAN/Internet | Bot                 | なし          | inbound serviceなし | 拒否                     |
| Bot          | LAN private IP      | なし          | SSRF防止            | 拒否                     |

Ollamaを`0.0.0.0`へbindしない。別ホストへ分離するまではloopbackだけで十分である。

## 4. 実装開始前preflight

SSH接続後、read-only確認として次を調べる。

- OS release、kernel、systemd。
- CPU、RAM、swap、空きdisk。
- `nvidia-smi`、driver、RTX 2060の認識、VRAM使用状況。
- Ollama version、service状態、listen address、導入済みmodel。
- Node/npmの有無とversion。
- 時刻同期とtimezone。
- outbound HTTPSとDiscord接続可否。
- 既存serviceのport、GPU利用、CPU/RAM競合。
- Docker EngineとDocker Composeを本番導入条件として確認する。

変更を伴うdriver、Node、Ollamaの導入・更新は、確認結果と既存serviceへの影響を提示してから行う。

## 5. Hardware benchmark

Phase 0で各候補modelに同じprompt setを実行し、次を記録する。

| 項目              | 測定方法                           |
| ----------------- | ---------------------------------- |
| Cold load         | model未load状態から最初のtokenまで |
| Warm TTFT         | warm状態で受付から最初のtokenまで  |
| Generation speed  | output tokens/sec                  |
| Prompt evaluation | 2K/4K/8K contextの所要時間         |
| VRAM              | `nvidia-smi`のused memory peak     |
| RAM/swap          | process peak、swap発生有無         |
| Japanese quality  | 固定会話evalの人手score            |
| Tool calling      | schema成功率、tool名・引数精度     |
| Structured output | JSON schema valid率                |

合格目安:

- 8K設定で通常promptがOOMにならない。
- warm短文のp50が8秒以内を目指せる。
- structured output 20試行中19回以上valid。修復1回込みで20/20。
- Web tool選択テストで明示検索を取りこぼさない。
- 日本語の複数話者を混同しない。

既定modelは3B～4B量子化から選ぶ。7B～8Bは品質向上が応答遅延とVRAM不安定を上回る場合だけ採用する。

## 6. 常駐設計

### 6.1 Docker Compose（採用方式）

- `search`: SearXNGを`127.0.0.1:8888`だけへpublishする。
- `bot`: host networkでOllamaとSearXNGへ接続し、`restart: unless-stopped`で復旧する。
- 両containerで`no-new-privileges`を有効にし、Botは全capabilityをdropする。
- 起動は`docker compose up -d --build`、状態確認は`docker compose ps`、ログ確認は`docker compose logs bot`を使う。

### 6.2 systemd（Dockerを使わない場合の代替）

unit例:

```ini
[Unit]
Description=Discord AI Chat Bot
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=discord-ai
Group=discord-ai
WorkingDirectory=/opt/discord-ai-chat/current
Environment=NODE_ENV=production
EnvironmentFile=/etc/discord-ai-chat/bot.env
ExecStart=/usr/bin/node src/index.js --config /etc/discord-ai-chat/bot.yaml
ExecStartPre=/usr/bin/node scripts/doctor.js --offline --config /etc/discord-ai-chat/bot.yaml
Restart=on-failure
RestartSec=5s
TimeoutStopSec=40s
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/discord-ai-chat
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

このunitは代替配置用であり、現在のRyzenサーバーでは使用しない。採用する場合はNode pathとsystemd hardening対応状況に合わせ、`ProtectSystem=strict`でNode/Ollama/CA証明書へのreadが妨げられないことを検証する。

## 7. 起動・停止

### 7.1 起動

1. config/env schemaを検証。
2. data directory権限を検証。
3. SQLite migrationとintegrity quick check。
4. Ollama healthとmodel存在を検証。
5. search enabledならcredential存在だけ確認。外部障害でBot全体を止めない。
6. pending jobをreconcile。
7. Discordへ接続。
8. ready後にschedulerを開始。

### 7.2 Graceful shutdown

`SIGTERM`受信時:

1. Discordからの新規job受付を停止。
2. statusをdrainingへ変更。
3. debounce中turnをDBへpending保存。
4. 実行中generationを最大30秒待つ。
5. 未完了ならAbortControllerで中断してpendingへ戻す。
6. DB checkpointを実行。
7. Discord clientとDBをclose。

### 7.3 再起動

運用者が再起動する場合は、可能ならBotの`/ai-pause`後に`docker compose restart bot`を実行する。OS再起動時はDockerの通常停止とrestart policyに任せる。急停止後もpending job reconcileで二重投稿を抑える。

## 8. Health check

WebUIや公開HTTP endpointは作らず、image内の`scripts/doctor.js`と`/ai-status`を使う。

### 8.1 `doctor`

| check                             | offline |   online |
| --------------------------------- | ------: | -------: |
| config schema                     |     yes |      yes |
| env key existence                 |     yes |      yes |
| DB open/migration/integrity       |     yes |      yes |
| directory permission              |     yes |      yes |
| Ollama health/model               |      no |      yes |
| Search provider lightweight check |      no | optional |
| Discord REST current bot          |      no |      yes |

exit codeは全必須check成功で0、それ以外は非0。secretやmessage本文を表示しない。

### 8.2 `/ai-status`

表示:

- version/commit ID。
- uptime。
- channel mode。
- queue lengthと現在のstate。
- LLM model、healthy/unhealthy、直近latency。
- Web enabled/disabled、provider、circuit状態。
- DB healthy、最終backup時刻。

表示しないもの:

- token/API key。
- raw filesystem pathのうち秘密を含むもの。
- message本文、query、Web本文。
- 他利用者のpreferences。

## 9. Observability

### 9.1 Log events

- `service_starting`, `service_ready`, `service_stopping`
- `discord_connected`, `discord_disconnected`
- `message_ingested`, `message_ignored`
- `turn_created`, `generation_started`, `generation_superseded`
- `tool_called`, `tool_failed`
- `response_posted`, `response_failed`
- `retention_completed`, `backup_completed`, `backup_failed`
- `privacy_delete_completed`

### 9.2 Metrics

専用metrics serverはMVPで作らず、JSON logから次を集計できるようfieldを固定する。

- ingested messages/minute
- turns/minute
- response countとsilent count
- queue depth
- end-to-end latency p50/p95
- prompt/output tokens
- web use ratio、search/fetch error ratio
- stale/superseded ratio
- Ollama timeout/OOM count
- Discord error/rate limit count
- DB size、backup age

### 9.3 通知

同じDiscord Botが停止すると通知できないため、重大障害通知をBot自身の投稿だけに依存しない。MVPでは`docker compose ps`と`docker compose logs bot`をSSHで確認し、将来は既存の監視基盤または別webhookを明示設定する。

## 10. Backupと復元

### 10.1 Backup

- 日次、利用の少ない時間帯に実行。
- SQLite online backup APIまたは`VACUUM INTO`を使い、単純な稼働中file copyを避ける。
- backup前にretention cleanupを行う。
- backup完成後に`PRAGMA integrity_check`相当を実行。
- 7世代保持。
- backup directoryはmode 0700。
- 可能ならserverの暗号化diskまたは暗号化backup先を使用。

### 10.2 Restore drill

月1回またはschema変更時にtest directoryへ復元する。

1. serviceを停止するか、test copyで実施。
2. backup integrityを検証。
3. migrationを適用。
4. retentionとprivacy deletion ledgerを適用。
5. `doctor --offline`を実行。
6. 本番へ戻す場合はownershipを検証して起動。

## 11. Releaseとrollback

### 11.1 Release

1. test/lint/format checkを通す。
2. 追跡対象のsourceとlockfileだけを配備先へ同期する。
3. `docker compose build bot`でlockfileどおりimageを構築する。
4. 新imageで`doctor --offline`と`doctor --online`を実行する。
5. schema変更時はDB backupとrollback方針を確認する。
6. `docker compose up -d search bot`で切り替える。
7. `docker compose ps`とJSON logで`discord_ready`を確認する。
8. `/ai-status`とlimited channelでsmoke testする。

### 11.2 Rollback

- codeだけの問題: 事前にcommit IDでtagしたprevious imageへ戻してBotを再作成する。
- backward-compatible migration: DBはそのまま。
- destructive migration: 原則禁止。必要な場合はmaintenance停止とbackup restore手順をrelease前に用意。
- LLM model問題: configをprevious modelへ戻し、Ollamaにmodelが残っていることを確認。

## 12. 障害対応runbook

### 12.1 Botがoffline

1. `docker compose ps`でcontainer状態とrestart回数を確認する。
2. `docker compose logs --since 10m bot`でerror categoryを確認する。本文を共有しない。
3. `doctor --offline`。
4. Ollama、network、DBの順に切り分け。
5. token invalidの場合はservice停止後にrotation。

### 12.2 応答が遅い

1. queue depth、generation latency、prompt tokensを確認。
2. `nvidia-smi`でVRAM、GPU utilization、他processを確認。
3. swap、thermal throttlingを確認。
4. Web tool待ちか、LLM待ちかをcorrelation IDで区別。
5. 一時対応は`ambient`または`mention`へ変更、context縮小。

### 12.3 OOM

1. global concurrencyを1へ確認。
2. model/context/他GPU processを確認。
3. jobは小contextで1回だけretry。
4. 継続する場合はBotを`mention`へし、より小さいmodelへ戻す。
5. 根本対応前に自動retryを繰り返さない。

### 12.4 検索だけ失敗

1. Bot雑談機能は継続。
2. provider circuit状態、credential、外部statusを確認。
3. secretをcommandやjournalへ表示しない。
4. 一時的に`web.enabled=false`とし、最新情報を確認できない旨をBotが示す。

### 12.5 DB異常

1. `docker compose stop bot`でBotを停止する。
2. DBとWAL/SHMをそのまま保全し、上書きしない。
3. integrity check。
4. 最新正常backupをtest pathへ復元。
5. retention/privacy delete適用後に切替。

### 12.6 Token漏洩

1. `docker compose stop bot`でBotを停止する。
2. Discord Developer Portalでtoken reset。
3. env file更新。
4. 漏洩箇所、Docker log、Git履歴、shell historyを確認。
5. 不審なBot操作をDiscord audit logで確認。
6. 原因修正後に起動。

## 13. Capacity方針

MVPは1 Guild、少数allowlist channels、global generation 1を想定する。次が継続したら拡張判断を行う。

- queue待ちp95が30秒を超える。
- 1時間あたりのsuperseded率が20%を超える。
- GPU utilizationが高止まりし、会話体験が崩れる。
- SQLite write contentionが観測される。

最初の対策はmodel/context/応答モードの調整であり、すぐに複数instance化しない。RTX 2060 6GBでは複数model同時生成より直列処理の方が安定する可能性が高い。
