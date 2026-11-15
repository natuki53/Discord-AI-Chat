export const CLAUDE_MODELS = Object.freeze({
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
});

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export function validateModelSettings({ model, effort }) {
  if (!Object.values(CLAUDE_MODELS).includes(model) || !EFFORT_LEVELS.includes(effort)) {
    const error = new Error(
      'モデルはhaiku/sonnet、effortはlow/medium/high/xhigh/maxから選んでください。',
    );
    error.userFacing = true;
    throw error;
  }
  return { model, effort };
}

export class ModelSettingsService {
  constructor({ config, database, model }) {
    this.config = config;
    this.database = database;
    this.model = model;
    this.pending = Promise.resolve();
    const saved = database.getModelSettings(config.discord.guildId);
    if (saved) {
      const settings = validateModelSettings(saved);
      model.configure(settings);
      Object.assign(config.llm, settings);
    }
  }

  current() {
    return { model: this.model.model, effort: this.model.effort };
  }

  update(changes) {
    const result = this.pending.then(async () => {
      if (changes.family != null && !Object.hasOwn(CLAUDE_MODELS, changes.family)) {
        const error = new Error('モデルはhaikuまたはsonnetを選んでください。');
        error.userFacing = true;
        throw error;
      }
      const next = validateModelSettings({
        model: changes.family == null ? this.model.model : CLAUDE_MODELS[changes.family],
        effort: changes.effort ?? this.model.effort,
      });
      const health = await this.model.health(undefined, next.model);
      if (!health.ok) throw new Error('選択したClaudeモデルを利用できません。');
      this.database.setModelSettings(this.config.discord.guildId, next);
      this.model.configure(next);
      Object.assign(this.config.llm, next);
      return next;
    });
    this.pending = result.catch(() => {});
    return result;
  }
}
