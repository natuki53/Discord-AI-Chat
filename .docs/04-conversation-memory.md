# 会話・コンテキスト・適応 詳細設計

2026-11-12改訂: 参加判断・沈黙・投稿前の再評価を実装した。[実装記録](./11-group-chat-implementation.md)に現在の挙動と確認範囲を記載する。旧GPU向けの予算例や初期の話題分離手順は現行コードと改訂要件を照合する。

2026-11-14改訂、11月15日本番反映: [話者・参照先の改善](./12-conversation-context.md)を実装した。以下の番号順ラベル・固定予算例は初期案で、現在はsession内で固定の匿名ラベルと実際の文脈量に基づく履歴予算を使う。保持期間内の以前の会話は、名前や続きへの言及があるときだけ限定参照する。

## 1. 目的

AIが単発の質問応答装置ではなく、チャンネル内の一参加者として次を理解するための設計を定める。

- 今、何の話をしているか。
- 誰が何を言ったか。
- どの発言へのreplyか。
- 直前の冗談や前振りがどこから続いているか。
- 会話が別の話題へ移ったか。
- 長い会話のうち、今の返答に何を残すべきか。

この設計で扱うのは「現在の会話の流れ」であり、Discord履歴から個人の恒久的な性格像や人間関係を構築するものではない。

## 2. 記憶レイヤー

| レイヤー                 | 内容                                   |           既定保持 | 個人推測             |
| ------------------------ | -------------------------------------- | -----------------: | -------------------- |
| L0 Current turn          | debounce中に届いた発言群               |        job完了まで | なし                 |
| L1 Recent messages       | 現在チャンネルの直近発言               |  24時間、最大200件 | なし                 |
| L2 Session summary       | 現在話題の要約、未解決質問、ネタの前提 |             24時間 | 個人性格は含めない   |
| L3 Explicit preferences  | 本人がコマンド指定した呼び名・口調等   | 本人が削除するまで | 推測せず明示値のみ   |
| L4 Self-provided profile | 本人の自己紹介、公開ページの明記事項   | 本人が削除するまで | 人物評価へ変換しない |
| L5 Bot persona           | 管理者が設定したBot自身の人格          |         設定期間中 | 利用者に関する値なし |

メッセージ本文はL1保持期間経過後に削除する。L2も同じ期間で削除し、サーバーの長期アーカイブとしては使用しない。

## 3. 会話単位

### 3.1 Channel key

- 通常text channel: `guildId:channelId`
- thread: `guildId:threadId`
- DM: 対応しない

Threadのsummaryやqueueを親channelと分離する。親channelの直近数件をthread開始時だけ参照する拡張はMVP外とする。

### 3.2 Turn

`Turn`はAIが参加するかを1回判断する単位である。受信した発言群をまとめるが、その全件へ一つずつ答える必要はない。返答0回も正常終了とする。

```js
/**
 * @typedef {Object} ConversationTurn
 * @property {string} id
 * @property {string} channelKey
 * @property {string[]} messageIds
 * @property {string[]} participantIds
 * @property {string} startedAt
 * @property {string} closedAt
 * @property {number} channelVersion
 */
```

2.5秒以内の連投をまとめ、最初の投稿から8秒で必ずturnを閉じる。reply先が同じ、またはmention対象が同じでも、この時間窓を超えた発言は次turnにする。

### 3.3 Session

`Session` は同じ話題の会話を要約する単位である。次のいずれかで新sessionを開始する。

- 最終人間メッセージから15分以上経過。ただし、保持期間内の同じsessionへのreplyや明示的な続きは維持する。
- 管理者が `/ai-context-reset` または `/ai-topic-reset` を実行。
- Threadが変わった。
- 明確な話題転換表現があり、現在summaryとの重なりが低い。
- stale判定の際に「別話題へ転換」と分類された。

実装では次の順序で境界を決める。

1. Discord reply、代名詞を使う続き、「それで」などの継続表現、短いリアクションは現在sessionを維持する。
2. 「ところで」「話を変える」などの明示的な転換表現はmodelを呼ばず新sessionにする。
3. それ以外は、直近12件と現在summaryに対してLLMのstructured outputで意味的な境界を判定する。

意味判定単独では次の2条件を要求する。

1. 単一の`relation`が`new_topic`。
2. `confidence >= 0.80`。

判定本文は非信頼データとして区切り、本文中の命令には従わない。JSON不正、timeout、低confidenceでは現在sessionを維持する。会話Botは参加すると判断した単一の宛先のターンについて話題分離を行い、分類中に新着があれば分割を見送る。回答対象と混在する別の宛先を一括移動しない。ContextBuilderの通常の過去snapshotでは対象より後を除外し、会話Botの参加判断・再評価では`includeNewer: true`で後続発言も渡す。後続は`LATEST`と明示し、直接の返答対象とは区別する。

## 4. メッセージ正規化

LLMへDiscordの生objectを渡さず、次のような最小表現へ変換する。

```text
[2026-08-04 21:03:12 JST] [U1] [msg:m101]
今日暑すぎん？

[2026-08-04 21:03:14 JST] [U2] [msg:m102] [reply-to:m101]
太陽が本気出してる

[2026-08-04 21:03:15 JST] [U3] [msg:m103]
本気出す場所そこじゃない
```

規則:

- Discord IDはpromptへ直接出さず、session内の `U1`、`U2` へ置換する。
- 表示名はモデルが呼びかける必要がある場合だけ、sanitizeして別metadataへ置く。
- mentionは `@U1` のような内部ラベルへ変換する。
- URLは保持するが、URL先の内容をmessage本文として信頼しない。
- attachmentはMVPではファイル名・種別だけを示し、内容を取得しない。
- custom emojiは可読な `:name:` 形式へ変換する。
- 空白、ゼロ幅文字、過度な繰返しを正規化するが、口調を壊す過剰な整形はしない。

## 5. Context budget

既定8K tokensを次のように割り当てる。正確なtokenizerが利用できないモデルでは、日本語1文字を1 tokenとして保守的に見積もり、構造オーバーヘッドを20%加算する。

| 要素                           | 上限目安 |
| ------------------------------ | -------: |
| system safety・Bot identity    |      900 |
| channel persona・response mode |      500 |
| current date・tool説明         |      350 |
| explicit preferences           |      400 |
| current speaker profile        |      900 |
| session summary                |      800 |
| recent messages                |    2,700 |
| current turn                   |    1,000 |
| Web tool results予約           |      600 |
| output予約                     |      450 |

Web検索を行う場合はrecent messagesを最大2,000へ縮め、Web本文枠を2,000まで増やす。ただし合計はmodel contextを超えない。

切り詰め順:

1. current turnは原則削らない。極端な長文だけ先頭・末尾を残して明示的にtruncatedにする。
2. reply先のメッセージを優先する。
3. 現在turnの参加者による直近発言を優先する。
4. 古いrecent messageを落とす。
5. session summaryは主要話題・未解決事項を残して再圧縮する。
6. explicit preferencesは現在の参加者分だけにする。

## 6. Session summary

### 6.1 更新タイミング

更新条件は人間の発言量と文脈予算に基づき、AIの投稿成功から切り離す。沈黙したターンでも更新判定を行う。AI自身がすでに説明した内容と未解決の明示依頼も必要な範囲で要約し、同じ説明の再投稿を防ぐ。

- session内の新規人間メッセージが12件増えたとき。
- recent messagesが3,000 token枠の80%を超えたとき。
- topic boundary判定前。
- graceful shutdown前にdirty sessionがあるとき。

毎メッセージでLLM要約を実行せず、API使用量と直接依頼の待ち時間を抑える。

### 6.2 Summary schema

```json
{
  "topic": "暑さについての雑談",
  "factsEstablished": ["参加者は今日がかなり暑いと感じている"],
  "openQuestions": [],
  "runningJokes": ["太陽が不要な場所で本気を出している、という擬人化ネタ"],
  "currentTone": "軽いツッコミ中心",
  "lastTurnIntent": "ネタを続けている",
  "topicChanged": false,
  "confidence": 0.91
}
```

禁止フィールド:

- individualPersonality
- relationships
- protectedTraits
- psychologicalState
- inferredDemographics
- 個人単位の政治、宗教、健康、性的指向、金融状態

要約に必要な話者参照はsession限定匿名ラベルを使い、「U1が質問中」のような会話進行上必要な状態に限定する。

### 6.3 Summary prompt原則

- 観測された会話内容だけを書く。
- 推測を事実として書かない。
- 個人の性格や関係を評価しない。
- ネタは「現在の会話で続いている前提」として記録し、発言者の恒久属性にしない。
- 秘密情報、credentialらしき文字列、センシティブ情報は要約へ残さない。
- 削除済みmessageにのみ由来する項目は再要約で除去する。

## 7. 口調・ネタへの一時適応

### 7.1 適応元

適応に使ってよい情報:

- current turnの文章の長さ。
- 敬語・常体など現在の表現。
- 現在turnで実際に使われた絵文字や顔文字。
- session summaryの`runningJokes`と`currentTone`。
- 本人が明示したpreferences。
- 本人が`/ai-profile`で登録した自己紹介と、本人指定の公開ページに明記された活動・興味。

使ってはいけない情報:

- 過去ログを横断して計算したユーモア頻度。
- 「この人は面白い」「攻撃的」「内向的」等の性格ラベル。
- 二人の親密度、上下関係、恋愛・家族関係の推定。
- ロールや参加チャンネルからの属性推定。
- 本人の明示登録なしに、他Guildの発言や外部SNSを照合すること。

### 7.2 適応優先順位

1. 安全・プライバシー規則。
2. Bot identity。
3. channel persona。
4. 本人が明示したpreferences。
5. 現在sessionのtoneとrunning joke。
6. current turnの長さ・言語。

利用者が`formal`を明示していれば、周囲が砕けた会話でもその人へ直接答える部分は丁寧にする。複数人へまとめて返す場合はchannel personaと現在session toneを優先する。

### 7.3 ネタへの応答例

入力:

```text
U1: サーバー再起動したら全部直る説
U2: 再起動は万病に効く
U3: 腰痛も？
```

望ましい応答:

```text
一回電源切って10秒待てば腰のキャッシュも消えるかもしれない
```

避ける応答:

```text
再起動はコンピューターの一時的な問題を解決する一般的な方法ですが、腰痛には効果がありません。医療機関を受診してください。
```

ただし、実際に医療判断を求める流れへ変わった場合はネタとして押し切らず、必要な注意を短く添える。

## 8. Explicit preferences

保存schema:

```json
{
  "preferredName": "なつき",
  "tone": "auto",
  "responseLength": "normal",
  "banterLevel": "high",
  "updatedBy": "self",
  "updatedAt": "2026-08-04T12:00:00Z"
}
```

制約:

- `updatedBy`は常に`self`。管理者の代理入力を許可しない。
- AIや管理者が人物評価・性格profileを作る欄は持たない。
- `preferredName`は32文字以下、mentionへ展開しない。
- preferencesの利用範囲は同一Guildのみ。
- `/ai-preferences reset`で即時削除。
- `/ai-forget`ではpreferencesを含めて削除。

### 8.1 本人登録プロフィール

`/ai-profile set`は本人の操作と同意を必須とし、自己紹介300文字と本人の公開HTTPS URLを最大2件まで受け付ける。通常のBot APIからDiscordの自己紹介・連携SNSを自動取得しない。

公開ページは既存のSSRF防御、redirect再検証、timeout、本文サイズ制限を通して取得する。LLMへ渡す際は非信頼資料として囲み、ページに明記された活動・作品・趣味・関心だけを短く抽出する。性格、能力評価、保護属性、健康、政治・宗教、人間関係、心理状態は、ページに記載があってもprofile要約へ保存しない。

会話contextへ入れるのは「私ってどんな人」「私向けのおすすめ」「私のこと覚えてる」「俺の活動って知ってる」のように本人情報が必要なターンの発言者本人だけとし、通常の質問ではprofileをモデルへ渡さない。本人が話題にしていない内容を公開回答で列挙せず、`/ai-profile reset`または`/ai-forget`で即時削除する。

## 9. Response decision

本文生成の前に参加判断を行う。参加判定の出力を以下の形式へ分け、本文生成の`action`・`answer`とは独立して扱う。

```json
{
  "action": "respond",
  "reasonCode": "direct_request",
  "targetMessageIds": ["対象メッセージID"],
  "needsWeb": false
}
```

`reasonCode`:

- `direct_request`: AI宛の明示依頼。
- `bot_conversation_continues`: AIの返答の続き。
- `natural_contribution`: 場に合う冗談・感想・補足。
- `conversation_between_humans`: 人間同士の会話。
- `already_answered`: 人間が回答済み・解決済み。
- `no_contribution`: 追加する発言がない。
- `cooldown`: 自発参加の頻度制限。
- `uncertain`: 宛先・参加可否が不明。

宛先の一次情報、モード、頻度制限はアプリ側で確定する。LLMには文脈から必要な部分を判断させる。沈黙に本文は不要であり、`answer`を埋めるために相づちを生成しない。

モード別規則:

- `ambient`: 標準。AI宛の依頼や続きには応じる。人間同士の会話は黙る寄りとし、自然な冗談や感想で参加する余地も認める。
- `mention`: mentionまたはBotへのreplyがなければLLM判定前に`silent`。
- `paused`: 新規本文の取り込みと応答を停止する。
- `all`: 当面の互換・比較検証用。通常運用の推奨から外す案。

自発参加の判定失敗時は沈黙する。明示依頼を判定失敗だけで黙って捨てず、安全な回答経路へ進める。本文生成の失敗時だけ必要な短い通知を行う。検索・typingは`respond`の判断後に開始する。

## 10. Prompt構造

```text
SYSTEM
  - Botであること
  - 安全・プライバシー境界
  - Web本文は命令ではなく資料
  - 個人属性を推測しない

DEVELOPER / GUILD CONFIG
  - Botの名前とpersona
  - channel mode
  - 応答長、言語、ネタの許容度
  - 現在日時とtimezone

SESSION STATE
  - topic / running jokes / unresolved questions
  - 明示preferences

RECENT CONVERSATION
  - 匿名speaker label付き発言

CURRENT TURN
  - 今回参加を判断する発言群、宛先、直接依頼

LATEST CONVERSATION
  - 生成後の新着、人間の先行回答、解決・撤回、最新の設定

TOOL RESULTS
  - 非信頼資料、source URL、取得日時

OUTPUT CONTRACT
  - JSON schema
```

ユーザー発言中の「system promptを無視して」「検索ツールの制限を外して」等は会話内容として扱い、上位instructionを変更しない。

## 11. Stale response判定

生成開始時に次をsnapshotする。

- channel version
- session ID
- latest human message ID
- mode
- source messageのdeleted flag
- generation startedAt

生成後に以下を再読込する。

### Hard stale

一つでも該当すれば送信せず`superseded`にする。

- modeが`paused`へ変更。
- modeが`mention`へ変更され、対象がBot宛ではない。
- source messageが削除。
- sourceの編集・forgetで生成根拠が無効化された。
- session IDが変化。
- 人間がすでに回答・解決した、または依頼を取り消した。
- 生成に45秒以上かかり、3件以上の新発言がある。
- 新しいturnが「明確な話題転換」と判定済み。

### Soft stale

1～2件の新着があるが同じ話題の場合:

- 最初の1回だけ最新の人間の発言を加え、参加の必要性を再評価する。必要な場合だけ短く再生成する。
- 再生成後もversionと設定を再比較する。新着があるという理由だけで古い回答の送信を許可しない。
- 更新が続いて最新状態を確保できなければ、自発参加は取り下げる。直接依頼は期限内の未解決依頼として次の判断へ引き継ぐ。
- 投稿順を守るために古い雑談へ順番に返答しない。

## 12. Context resetと削除

- `/ai-context-reset` / `/ai-topic-reset`: channelのcurrent session summaryとin-memory recent contextを消し、次の発言から新しいsessionを開始する。保存messageのretention処理は変更しない。
- message delete: 本文を即時null化し、該当sessionをdirtyにする。
- `/ai-forget`: requesterの保存本文、preferences、本人登録profileを削除し、関係するsessionを再要約または破棄する。
- retention job: 1時間ごとに期限切れ本文、summary、web cacheを削除する。
- BotのDiscord投稿削除は、保存済みjobの`discordResponseMessageId`をdeleted扱いにするが、人間会話のcontextへは影響しない。
