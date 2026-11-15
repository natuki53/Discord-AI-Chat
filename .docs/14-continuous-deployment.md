# mainの保護と本番への自動配備

## 開発から配備まで

1. 目的別のブランチで変更し、`main`へのPRを作成する。
2. GitHub-hosted runnerの`Quality checks`がlint、整形、Node.jsテスト、配備制御のPythonテスト、Dockerイメージとオフラインdoctorを確認する。
3. `main`の保護条件を満たしたPRをマージする。
4. 本番サーバーのuser timerが約1分間隔で`main`を取得する。そのSHAに対する`main`・pushイベントのCI成功をGitHub APIで確認してから配備する。
5. 新しいイメージを作成し、Linux上のテストとDBコピーでのdoctorを行ってからBotだけを切り替える。
6. Discord再接続、doctor、コマンド登録と読み取り確認、ソース一致の確認に成功したら、配備済みSHAを記録する。

CIは全PRで実行し、path filterによる必須チェックの未実行を作らない。Actionsの参照はコミットSHAで固定する。CIの権限は`contents: read`で、外部APIキーや本番の設定を渡さない。

## mainの保護

- PR経由の変更を必須とする。
- `Quality checks`の成功と、最新の`main`に追従した状態を必須とする。
- 未解決のレビュー会話を残したままマージしない。
- 管理者にも同じ制限を適用し、force pushとブランチ削除を禁止する。
- 承認レビューの必須人数は0。単独メンテナーでもPR・CI経由でマージできる。必要に応じてGitHubの設定で増やす。

## サーバー構成

| パス                                                       | 内容                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `~/.local/lib/discord-ai-chat-deploy/production_deploy.py` | 配備コントローラー                                    |
| `~/.config/discord-ai-chat-deploy/config.json`             | `deploy/production.example.json`に対応するパス設定    |
| `~/.local/state/discord-ai-chat-deploy/state.json`         | 配備済み・待機中・失敗したSHA                         |
| `~/.local/state/discord-ai-chat-deploy/pending.json`       | 中断した切替の復旧情報                                |
| `~/discord-ai-chat-deploy/automatic/`                      | SHAごとのソース、以前のソース・コマンド定義、確認結果 |

公開リポジトリをHTTPSで読み取り取得する。GitHubへの書き込みキーや、本番SSH鍵をCIへ登録する必要はない。Botが使うAPIキーとDiscord tokenは既存の`runtime/bot.env`から、doctor・Bot・コマンド登録にだけ渡す。`runtime/`と`data/`をGitのソースで上書きしない。SearXNGや他のサービスは再作成しない。

user timerは`deploy/discord-ai-chat-deploy.service`と`.timer`を`~/.config/systemd/user/`へ配置して有効化する。ユーザーのlingerを有効にした環境では、ログイン状態に依存せず実行できる。

```bash
systemctl --user daemon-reload
systemctl --user enable --now discord-ai-chat-deploy.timer
systemctl --user status discord-ai-chat-deploy.timer
journalctl --user -u discord-ai-chat-deploy.service -n 50 --no-pager
python3 ~/.local/lib/discord-ai-chat-deploy/production_deploy.py \
  --config ~/.config/discord-ai-chat-deploy/config.json --status
```

コントローラー自身の更新は、レビューした`deploy/production_deploy.py`をインストール先へコピーする。通常のBot配備でコントローラーやtimerの設定を変更しない。

## 失敗と復旧

- CI未完了・失敗、API確認不能、新しいmainへの更新中は現在のBotを維持する。API確認不能では確認間隔を延ばす。
- 切替前にDBとコマンド定義、以前のイメージ・ソースを保存する。DBコピーでの検証用ファイルは終了時に削除する。
- 切替後の失敗では以前のイメージ・ソース・応答設定・コマンド定義へ戻す。切替中に届いた会話本文全体を巻き戻さない。DBの変更は旧版と共存できる移行にする。
- プロセス中断や再起動で未完了の切替が残った場合、次回の起動で`pending.json`から復旧する。
- 失敗した同一SHAを自動で繰り返さない。修正をmainへマージするか、原因を解消してから手動で再試行する。
- 配備コントローラーが作るDBバックアップは7日を超えたものだけを削除する。既存の手動バックアップは変更しない。
- `automatic/`のソースとDockerの配備用イメージは復旧用に残す。ディスク使用量は通常のサーバー保守で確認する。

```bash
python3 ~/.local/lib/discord-ai-chat-deploy/production_deploy.py \
  --config ~/.config/discord-ai-chat-deploy/config.json --retry
```

競合する配備はlockで防ぐ。`--retry`は同じlockを使う。手作業でBotを入れ替える場合はtimerを停止してから行う。

## 検証

Node.jsの150件に加え、Pythonの18件でCIのSHA・イベント・workflow照合、確認失敗時の待機、古いCI結果、配備前の中断、ソースとコマンドの復旧、会話の保持、プロセス中断からの復旧、パス境界、バックアップ保持期間を確認する。
