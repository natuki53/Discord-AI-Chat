import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { normalizeResponseMode } from '../conversation/response-mode.js';
import { CLAUDE_MODELS } from '../ai/model-settings.js';

export const RESPONSE_MODES = Object.freeze({
  ambient: { label: 'おまかせ', description: '会話の流れに合わせて自然に参加します（おすすめ）' },
  mention: { label: '呼んだときだけ', description: 'AIへのメンション・返信にだけ応じます' },
  paused: { label: '停止', description: 'このチャンネルの会話の取り込みと応答を止めます' },
});
export const MODEL_PRESETS = Object.freeze({
  quick: {
    label: '速さ優先',
    description: '気軽な会話向け（Haiku）',
    family: 'haiku',
    effort: 'medium',
  },
  thoughtful: {
    label: 'じっくり',
    description: '複雑な相談向け（Sonnet）',
    family: 'sonnet',
    effort: 'high',
  },
});
export const TONES = Object.freeze({
  auto: 'おまかせ',
  casual: 'くだけた口調',
  formal: '丁寧',
  neutral: '普通',
});
export const LENGTHS = Object.freeze({ short: '短め', normal: 'ふつう', detailed: '詳しく' });

const id = (action, userId) => `ai:${action}:${userId}`;
const row = (...components) => new ActionRowBuilder().addComponents(...components);
function button(action, label, userId, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id(action, userId)).setLabel(label).setStyle(style);
}
function select(action, placeholder, choices, current, userId) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId(id(action, userId))
      .setPlaceholder(placeholder)
      .addOptions(
        Object.entries(choices).map(([value, choice]) => ({
          label: typeof choice === 'string' ? choice : choice.label,
          value,
          ...(choice.description ? { description: choice.description } : {}),
          default: value === current,
        })),
      ),
  );
}
function page(title, description, components, notice) {
  return {
    content: notice || null,
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description)],
    components,
    allowedMentions: { parse: [] },
  };
}
export function homeMenu({ userId, channel, admin, imageAvailable }, notice) {
  const mode = RESPONSE_MODES[normalizeResponseMode(channel?.mode)]?.label ?? '対象外';
  return page(
    'AIメニュー',
    [
      `このチャンネル：**${mode}**`,
      '質問するときはAIにメンション、またはAIの発言に返信してください。',
      imageAvailable ? 'イラストは `/ai-image` で作れます。' : 'イラスト生成は現在利用できません。',
      'このメニューと個人設定は、あなたにだけ表示されます。',
    ].join('\n\n'),
    [
      row(
        button('personal', '自分の設定', userId, ButtonStyle.Primary),
        button('help', '使い方・データ', userId),
        ...(admin ? [button('channel', 'チャンネル設定', userId)] : []),
      ),
    ],
    notice,
  );
}
export function personalMenu({ userId, preference, profile }, notice) {
  return page(
    '自分の設定',
    [
      `呼び名：${preference?.preferredName ?? 'Discordの表示名'}`,
      `話し方：${TONES[preference?.tone] ?? 'おまかせ'}`,
      `返答の長さ：${LENGTHS[preference?.responseLength] ?? 'ふつう'}`,
      `自己紹介：${profile?.selfDescription ?? '未登録'}`,
      `公開リンク：${profile?.links?.join('\n') || '未登録'}`,
      'プロフィールには自分の情報だけを登録してください。入力した情報・公開リンクに明記された活動や興味を、あなたへの返答に使います。',
    ].join('\n\n'),
    [
      select('tone', '話し方を選ぶ', TONES, preference?.tone ?? 'auto', userId),
      select('length', '返答の長さを選ぶ', LENGTHS, preference?.responseLength ?? 'normal', userId),
      row(
        button('profile-edit', '同意して呼び名・プロフィールを編集', userId, ButtonStyle.Primary),
        button('profile-refresh', '公開リンクを更新', userId).setDisabled(!profile?.links?.length),
      ),
      row(button('personal-reset', '自分の設定をリセット', userId), button('home', '戻る', userId)),
    ],
    notice,
  );
}
export function channelMenu({ userId, channel, settings }, notice) {
  const current = Object.entries(MODEL_PRESETS).find(
    ([, preset]) =>
      settings?.model === CLAUDE_MODELS[preset.family] && settings?.effort === preset.effort,
  )?.[0];
  return page(
    'チャンネル設定',
    [
      '応答のしかたはこのチャンネルに適用します。停止から戻すときも、同じメニューで選び直せます。',
      `現在：**${RESPONSE_MODES[normalizeResponseMode(channel?.mode)]?.label ?? '対象外'}**`,
      `返答の設定：**${MODEL_PRESETS[current]?.label ?? 'これまでの設定を使用中'}**`,
      '「速さ優先／じっくり」はサーバー全体に適用します。選び直すまでは現在の設定を維持します。',
    ].join('\n\n'),
    [
      select('mode', '応答のしかた', RESPONSE_MODES, normalizeResponseMode(channel?.mode), userId),
      select('quality', '返答の設定', MODEL_PRESETS, current, userId),
      row(
        button('topic-reset', '話題を区切る', userId),
        button('diagnostics', '接続を確認', userId),
        button('home', '戻る', userId),
      ),
    ],
    notice,
  );
}
export function helpMenu(userId) {
  return page(
    '使い方',
    [
      '**話しかける**：AIにメンションするか、AIの発言に返信します。おまかせでは雑談にも自然に参加します。',
      '**絵を描く**：`/ai-image prompt:描いてほしい内容`。画像の形は省略できます。',
      '**自分の情報・話し方**：「自分の設定」から変更できます。',
      '**応答の変更・話題の区切り**：管理者の「チャンネル設定」にまとめています。',
    ].join('\n\n'),
    [
      row(
        button('privacy', 'データと削除', userId),
        button('report', '問題を報告', userId),
        button('home', '戻る', userId),
      ),
    ],
  );
}
export function privacyMenu(userId, retentionHours, notice) {
  return page(
    'データと削除',
    [
      `会話の本文と要約をローカルDBに既定${retentionHours}時間保存します。`,
      '返答・要約・話題判定・プロフィール抽出のため、必要な会話文脈と本人登録情報、参照したWeb資料をAnthropicのClaude APIへ送信します。API側の保持・削除はAnthropicの契約・設定に従います。',
      '性格・属性・人間関係のプロフィールは作らず、メッセージをAIの学習に使いません。最新情報を調べるときは、個人情報を除いた検索語を検索サービスへ送ります。',
      'イラスト生成で送るのは依頼文のみです。生成した画像はDiscordへ添付し、BotのDBには保存しません。',
      '下の削除ボタンは、このサーバーで保存中のあなたの本文・個人設定・プロフィールを削除します。Discordの投稿や添付、API側のデータは削除しません。',
    ].join('\n\n'),
    [
      row(
        button('forget', '自分の保存データを削除', userId, ButtonStyle.Danger),
        button('help', '戻る', userId),
      ),
    ],
    notice,
  );
}
export function confirmationMenu(userId, action, nonce) {
  const forget = action === 'forget';
  return page(
    forget ? '保存データを削除しますか？' : '自分の設定をリセットしますか？',
    forget
      ? 'このサーバーで保存中のあなたの本文・個人設定・プロフィールを削除します。取り消せません。'
      : '呼び名・話し方・返答の長さ・プロフィールを初期状態へ戻します。会話本文は削除しません。',
    [
      row(
        button(
          `${action}-confirm`,
          forget ? '削除する' : 'リセットする',
          userId,
          ButtonStyle.Danger,
        ).setCustomId(`ai:${action}-confirm:${userId}:${nonce}`),
        button(forget ? 'privacy' : 'personal', 'キャンセル', userId),
      ),
    ],
  );
}
function input(name, label, value, maxLength, style = TextInputStyle.Short) {
  const field = new TextInputBuilder()
    .setCustomId(name)
    .setLabel(label)
    .setStyle(style)
    .setRequired(false)
    .setMaxLength(maxLength);
  if (value) field.setValue(value);
  return row(field);
}
export function profileModal(userId, preference, profile) {
  return new ModalBuilder()
    .setCustomId(id('profile-save', userId))
    .setTitle('自分の情報を編集（空欄で削除）')
    .addComponents(
      input('name', '呼び名', preference?.preferredName, 32),
      input(
        'description',
        '自己紹介（返答への利用に同意して保存）',
        profile?.selfDescription,
        300,
        TextInputStyle.Paragraph,
      ),
      input(
        'links',
        '自分の公開HTTPSリンク（2件まで・改行区切り）',
        profile?.links?.join('\n'),
        1001,
        TextInputStyle.Paragraph,
      ),
    );
}
export function reportModal(userId) {
  const report = input(
    'description',
    '問題の内容（会話本文は自動収集しません）',
    null,
    500,
    TextInputStyle.Paragraph,
  );
  report.components[0].setRequired(true);
  return new ModalBuilder()
    .setCustomId(id('report-save', userId))
    .setTitle('問題を報告')
    .addComponents(report);
}
