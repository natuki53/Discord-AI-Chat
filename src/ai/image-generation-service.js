export function imageUserError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

export class ImageGenerationService {
  constructor({ provider, cooldownSeconds = 60 }) {
    this.provider = provider;
    this.cooldownMs = cooldownSeconds * 1000;
    this.lastGenerated = new Map();
    this.activeController = null;
    this.stopping = false;
  }

  get available() {
    return Boolean(this.provider) && !this.stopping;
  }

  async generate({ userId, prompt, aspect = 'square', maxBytes = 10 * 1024 * 1024 }) {
    if (!this.available) {
      throw imageUserError('画像生成の接続設定がまだ完了していません。管理者に確認してください。');
    }
    const text = String(prompt ?? '').trim();
    if (!text || text.length > 2000) {
      throw imageUserError('描いてほしい内容を1〜2000文字で指定してください。');
    }
    if (!['square', 'landscape', 'portrait'].includes(aspect)) {
      throw imageUserError('画像の形は正方形・横長・縦長から選んでください。');
    }
    if (this.activeController) {
      throw imageUserError('いま別の画像を生成しています。完了してからもう一度お試しください。');
    }
    const now = Date.now();
    for (const [id, generatedAt] of this.lastGenerated) {
      if (now - generatedAt >= this.cooldownMs) this.lastGenerated.delete(id);
    }
    const previous = this.lastGenerated.get(userId);
    if (previous !== undefined) {
      const seconds = Math.ceil((this.cooldownMs - (now - previous)) / 1000);
      throw imageUserError(`次の画像生成まであと${seconds}秒お待ちください。`);
    }
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const image = await this.provider.generate({
        prompt: text,
        aspect,
        signal: controller.signal,
      });
      if (!Buffer.isBuffer(image.data) || image.data.length === 0) {
        throw new Error('Image provider returned no image');
      }
      if (image.data.length > maxBytes) {
        throw imageUserError(
          '生成画像がこのチャンネルの添付サイズ上限を超えたため送信できませんでした。',
        );
      }
      if (
        image.source &&
        (!Buffer.isBuffer(image.source.data) || image.source.data.length > maxBytes)
      ) {
        throw imageUserError(
          'SVGファイルがこのチャンネルの添付サイズ上限を超えたため送信できませんでした。',
        );
      }
      this.lastGenerated.set(userId, Date.now());
      return image;
    } finally {
      this.activeController = null;
    }
  }

  stop() {
    this.stopping = true;
    this.activeController?.abort();
  }
}
