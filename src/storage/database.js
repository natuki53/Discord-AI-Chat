import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MIGRATION = `
CREATE TABLE IF NOT EXISTS model_settings (
  guild_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  configured_mode TEXT NOT NULL,
  mode_override TEXT,
  previous_mode TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  active_session_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  session_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT,
  summary_message_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_channel_activity
  ON conversation_sessions (guild_id, channel_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT NOT NULL,
  content TEXT,
  reply_to_message_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  expires_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages (guild_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author_expires
  ON messages (author_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_expires
  ON messages (expires_at);

CREATE TABLE IF NOT EXISTS user_preferences (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  preferred_name TEXT,
  tone TEXT NOT NULL,
  response_length TEXT NOT NULL,
  banter_level TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  self_description TEXT,
  links_json TEXT NOT NULL,
  source_summary TEXT,
  consented_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS response_jobs (
  job_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  snapshot_version INTEGER NOT NULL,
  discord_response_id TEXT,
  error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_state_created
  ON response_jobs (state, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  actor_id TEXT,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_expires ON audit_events (expires_at);
`;

function plusHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function plusDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export class DatabaseStore {
  constructor(filePath, config) {
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    this.db = new Database(absolute);
    this.config = config;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(MIGRATION);
  }

  close() {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.close();
  }

  quickCheck() {
    return this.db.pragma('quick_check', { simple: true });
  }

  getModelSettings(guildId) {
    return (
      this.db.prepare('SELECT model, effort FROM model_settings WHERE guild_id = ?').get(guildId) ??
      null
    );
  }

  setModelSettings(guildId, { model, effort }) {
    this.db
      .prepare(
        `
      INSERT INTO model_settings (guild_id, model, effort, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        model = excluded.model, effort = excluded.effort, updated_at = excluded.updated_at
    `,
      )
      .run(guildId, model, effort, new Date().toISOString());
  }

  initializeChannels() {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO channels (guild_id, channel_id, configured_mode, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET
        configured_mode = excluded.configured_mode,
        updated_at = excluded.updated_at
    `);
    const transaction = this.db.transaction(() => {
      for (const channel of this.config.discord.channels) {
        statement.run(this.config.discord.guildId, channel.id, channel.mode, now);
      }
    });
    transaction();
  }

  getChannel(guildId, channelId) {
    const row = this.db
      .prepare('SELECT * FROM channels WHERE guild_id = ? AND channel_id = ?')
      .get(guildId, channelId);
    if (!row) return null;
    return {
      guildId: row.guild_id,
      channelId: row.channel_id,
      configuredMode: row.configured_mode,
      mode: row.mode_override ?? row.configured_mode,
      previousMode: row.previous_mode,
      version: row.version,
      activeSessionId: row.active_session_id,
    };
  }

  setChannelMode(guildId, channelId, mode) {
    const current = this.getChannel(guildId, channelId);
    if (!current) throw new Error('対象チャンネルが設定されていません');
    const now = new Date().toISOString();
    const previous = current.mode === 'paused' ? current.previousMode : current.mode;
    this.db
      .prepare(
        `UPDATE channels
         SET mode_override = ?, previous_mode = ?, updated_at = ?
         WHERE guild_id = ? AND channel_id = ?`,
      )
      .run(mode, previous, now, guildId, channelId);
    return this.getChannel(guildId, channelId);
  }

  resumeChannel(guildId, channelId) {
    const current = this.getChannel(guildId, channelId);
    if (!current) throw new Error('対象チャンネルが設定されていません');
    const mode = current.previousMode ?? current.configuredMode;
    return this.setChannelMode(guildId, channelId, mode);
  }

  createSession({ sessionId, guildId, channelId, now, retentionHours }) {
    const timestamp = now.toISOString();
    const transaction = this.db.transaction(() => {
      const current = this.getChannel(guildId, channelId);
      if (current?.activeSessionId) {
        this.db
          .prepare("UPDATE conversation_sessions SET status = 'closed' WHERE session_id = ?")
          .run(current.activeSessionId);
      }
      this.db
        .prepare(
          `INSERT INTO conversation_sessions
           (session_id, guild_id, channel_id, started_at, last_activity_at, status, expires_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(sessionId, guildId, channelId, timestamp, timestamp, plusHours(now, retentionHours));
      this.db
        .prepare(
          `UPDATE channels SET active_session_id = ?, updated_at = ?
           WHERE guild_id = ? AND channel_id = ?`,
        )
        .run(sessionId, timestamp, guildId, channelId);
    });
    transaction();
    return this.getSession(sessionId);
  }

  splitSession({
    guildId,
    channelId,
    previousSessionId,
    newSessionId,
    messageIds,
    now,
    retentionHours,
  }) {
    const uniqueMessageIds = [...new Set(messageIds)];
    if (!uniqueMessageIds.length) return null;
    const placeholders = uniqueMessageIds.map(() => '?').join(',');
    const timestamp = now.toISOString();
    const transaction = this.db.transaction(() => {
      const channel = this.getChannel(guildId, channelId);
      if (channel?.activeSessionId !== previousSessionId) return null;
      const movable = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE guild_id = ? AND channel_id = ? AND session_id = ?
             AND author_type = 'human' AND processed_at IS NULL
             AND message_id IN (${placeholders})`,
        )
        .get(guildId, channelId, previousSessionId, ...uniqueMessageIds).count;
      if (movable !== uniqueMessageIds.length) return null;
      const boundary = this.db
        .prepare(
          `SELECT created_at, message_id FROM messages
           WHERE guild_id = ? AND channel_id = ? AND session_id = ?
             AND author_type = 'human' AND message_id IN (${placeholders})
           ORDER BY created_at ASC, message_id ASC LIMIT 1`,
        )
        .get(guildId, channelId, previousSessionId, ...uniqueMessageIds);

      this.db
        .prepare("UPDATE conversation_sessions SET status = 'closed' WHERE session_id = ?")
        .run(previousSessionId);
      this.db
        .prepare(
          `INSERT INTO conversation_sessions
           (session_id, guild_id, channel_id, started_at, last_activity_at, status, expires_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          newSessionId,
          guildId,
          channelId,
          timestamp,
          timestamp,
          plusHours(now, retentionHours),
        );
      this.db
        .prepare(
          `UPDATE messages SET session_id = ?
           WHERE guild_id = ? AND channel_id = ? AND session_id = ?
             AND author_type = 'human' AND processed_at IS NULL
             AND (created_at > ? OR (created_at = ? AND message_id >= ?))`,
        )
        .run(
          newSessionId,
          guildId,
          channelId,
          previousSessionId,
          boundary.created_at,
          boundary.created_at,
          boundary.message_id,
        );
      this.db
        .prepare(
          `UPDATE channels
           SET active_session_id = ?, version = version + 1, updated_at = ?
           WHERE guild_id = ? AND channel_id = ?`,
        )
        .run(newSessionId, timestamp, guildId, channelId);
      return newSessionId;
    });
    const result = transaction();
    return result ? this.getSession(result) : null;
  }

  getSession(sessionId) {
    if (!sessionId) return null;
    const row = this.db
      .prepare('SELECT * FROM conversation_sessions WHERE session_id = ?')
      .get(sessionId);
    if (!row) return null;
    return {
      sessionId: row.session_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      startedAt: row.started_at,
      lastActivityAt: row.last_activity_at,
      status: row.status,
      summary: row.summary_json ? JSON.parse(row.summary_json) : null,
      summaryMessageCount: row.summary_message_count,
      expiresAt: row.expires_at,
    };
  }

  touchSession(sessionId, now, retentionHours) {
    this.db
      .prepare(
        `UPDATE conversation_sessions
         SET last_activity_at = ?, expires_at = ?
         WHERE session_id = ?`,
      )
      .run(now.toISOString(), plusHours(now, retentionHours), sessionId);
  }

  saveSessionSummary(sessionId, summary, messageCount, now, retentionHours) {
    this.db
      .prepare(
        `UPDATE conversation_sessions
         SET summary_json = ?, summary_message_count = ?, expires_at = ?
         WHERE session_id = ?`,
      )
      .run(JSON.stringify(summary), messageCount, plusHours(now, retentionHours), sessionId);
  }

  resetSession(guildId, channelId) {
    const channel = this.getChannel(guildId, channelId);
    if (!channel?.activeSessionId) return false;
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE conversation_sessions
           SET status = 'deleted', summary_json = NULL
           WHERE session_id = ?`,
        )
        .run(channel.activeSessionId);
      this.db
        .prepare(
          `UPDATE channels SET active_session_id = NULL, version = version + 1, updated_at = ?
           WHERE guild_id = ? AND channel_id = ?`,
        )
        .run(now, guildId, channelId);
    });
    transaction();
    return true;
  }

  ingestMessage(message, retentionHours) {
    const now = new Date();
    const transaction = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO messages
           (message_id, guild_id, channel_id, session_id, author_id, author_name, author_type,
            content, reply_to_message_id, created_at, expires_at, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.messageId,
          message.guildId,
          message.channelId,
          message.sessionId,
          message.authorId,
          message.authorName,
          message.authorType,
          message.content,
          message.replyToMessageId,
          message.createdAt,
          plusHours(now, retentionHours),
          now.toISOString(),
        );
      if (result.changes === 0) {
        return {
          isNew: false,
          version: this.getChannel(message.guildId, message.channelId)?.version ?? 0,
        };
      }
      this.db
        .prepare(
          `UPDATE channels SET version = version + 1, updated_at = ?
           WHERE guild_id = ? AND channel_id = ?`,
        )
        .run(now.toISOString(), message.guildId, message.channelId);
      this.touchSession(message.sessionId, now, this.config.privacy.sessionSummaryRetentionHours);
      return { isNew: true, version: this.getChannel(message.guildId, message.channelId).version };
    });
    return transaction();
  }

  updateMessage({ messageId, content, editedAt, guildId, channelId }) {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE messages SET content = ?, edited_at = ?
           WHERE message_id = ? AND deleted_at IS NULL`,
        )
        .run(content, editedAt, messageId);
      if (result.changes > 0) {
        this.db
          .prepare(
            `UPDATE channels SET version = version + 1, updated_at = ?
             WHERE guild_id = ? AND channel_id = ?`,
          )
          .run(now, guildId, channelId);
      }
      return result.changes > 0;
    });
    return transaction();
  }

  deleteMessage({ messageId, guildId, channelId }) {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE messages SET content = NULL, deleted_at = ?, processed_at = COALESCE(processed_at, ?)
           WHERE message_id = ?`,
        )
        .run(now, now, messageId);
      if (result.changes > 0) {
        this.db
          .prepare(
            `UPDATE channels SET version = version + 1, updated_at = ?
             WHERE guild_id = ? AND channel_id = ?`,
          )
          .run(now, guildId, channelId);
      }
      return result.changes > 0;
    });
    return transaction();
  }

  getRecentMessages(guildId, channelId, sessionId, limit) {
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT message_id, author_id, author_name, author_type, content, reply_to_message_id,
                  created_at, edited_at
           FROM messages
           WHERE guild_id = ? AND channel_id = ? AND session_id = ?
             AND deleted_at IS NULL AND content IS NOT NULL
           ORDER BY created_at DESC, message_id DESC
           LIMIT ?
         ) ORDER BY created_at ASC, message_id ASC`,
      )
      .all(guildId, channelId, sessionId, limit)
      .map((row) => ({
        messageId: row.message_id,
        authorId: row.author_id,
        authorName: row.author_name,
        authorType: row.author_type,
        content: row.content,
        replyToMessageId: row.reply_to_message_id,
        createdAt: row.created_at,
        editedAt: row.edited_at,
      }));
  }

  countSessionMessages(sessionId) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE session_id = ? AND author_type = 'human' AND deleted_at IS NULL`,
      )
      .get(sessionId).count;
  }

  getUnprocessedMessages(guildId, channelId, limit = 100) {
    return this.db
      .prepare(
        `SELECT message_id FROM messages
         WHERE guild_id = ? AND channel_id = ? AND author_type = 'human'
           AND processed_at IS NULL AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(guildId, channelId, limit)
      .map((row) => row.message_id);
  }

  markMessagesProcessed(messageIds, now = new Date()) {
    if (!messageIds.length) return;
    const statement = this.db.prepare('UPDATE messages SET processed_at = ? WHERE message_id = ?');
    const transaction = this.db.transaction(() => {
      for (const messageId of messageIds) statement.run(now.toISOString(), messageId);
    });
    transaction();
  }

  getPreferences(guildId, userIds) {
    if (!userIds.length) return new Map();
    const placeholders = userIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM user_preferences
         WHERE guild_id = ? AND user_id IN (${placeholders})`,
      )
      .all(guildId, ...userIds);
    return new Map(
      rows.map((row) => [
        row.user_id,
        {
          preferredName: row.preferred_name,
          tone: row.tone,
          responseLength: row.response_length,
          banterLevel: row.banter_level,
        },
      ]),
    );
  }

  getPreference(guildId, userId) {
    return this.getPreferences(guildId, [userId]).get(userId) ?? null;
  }

  setPreference(guildId, userId, preference) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_preferences
         (guild_id, user_id, preferred_name, tone, response_length, banter_level,
          consented_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
           preferred_name = excluded.preferred_name,
           tone = excluded.tone,
           response_length = excluded.response_length,
           banter_level = excluded.banter_level,
           updated_at = excluded.updated_at`,
      )
      .run(
        guildId,
        userId,
        preference.preferredName,
        preference.tone,
        preference.responseLength,
        preference.banterLevel,
        now,
        now,
      );
    return this.getPreference(guildId, userId);
  }

  resetPreference(guildId, userId) {
    return (
      this.db
        .prepare('DELETE FROM user_preferences WHERE guild_id = ? AND user_id = ?')
        .run(guildId, userId).changes > 0
    );
  }

  getProfiles(guildId, userIds) {
    if (!userIds.length) return new Map();
    const placeholders = userIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM user_profiles
         WHERE guild_id = ? AND user_id IN (${placeholders})`,
      )
      .all(guildId, ...userIds);
    return new Map(
      rows.map((row) => [
        row.user_id,
        {
          selfDescription: row.self_description,
          links: JSON.parse(row.links_json),
          sourceSummary: row.source_summary,
          consentedAt: row.consented_at,
          refreshedAt: row.refreshed_at,
          updatedAt: row.updated_at,
        },
      ]),
    );
  }

  getProfile(guildId, userId) {
    return this.getProfiles(guildId, [userId]).get(userId) ?? null;
  }

  setProfile(guildId, userId, profile) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_profiles
         (guild_id, user_id, self_description, links_json, source_summary,
          consented_at, refreshed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
           self_description = excluded.self_description,
           links_json = excluded.links_json,
           source_summary = excluded.source_summary,
           refreshed_at = excluded.refreshed_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        guildId,
        userId,
        profile.selfDescription,
        JSON.stringify(profile.links),
        profile.sourceSummary,
        now,
        profile.refreshedAt ?? now,
        now,
      );
    return this.getProfile(guildId, userId);
  }

  resetProfile(guildId, userId) {
    return (
      this.db
        .prepare('DELETE FROM user_profiles WHERE guild_id = ? AND user_id = ?')
        .run(guildId, userId).changes > 0
    );
  }

  forgetUser(guildId, userId) {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const messageResult = this.db
        .prepare(
          `UPDATE messages SET content = NULL, deleted_at = ?, processed_at = COALESCE(processed_at, ?)
           WHERE guild_id = ? AND author_id = ? AND content IS NOT NULL`,
        )
        .run(now, now, guildId, userId);
      const preferenceResult = this.db
        .prepare('DELETE FROM user_preferences WHERE guild_id = ? AND user_id = ?')
        .run(guildId, userId);
      const profileResult = this.db
        .prepare('DELETE FROM user_profiles WHERE guild_id = ? AND user_id = ?')
        .run(guildId, userId);
      const sessionResult = this.db
        .prepare(
          `UPDATE conversation_sessions SET summary_json = NULL, summary_message_count = 0
           WHERE guild_id = ? AND session_id IN (
             SELECT DISTINCT session_id FROM messages WHERE guild_id = ? AND author_id = ?
           )`,
        )
        .run(guildId, guildId, userId);
      return {
        messages: messageResult.changes,
        preferences: preferenceResult.changes,
        profiles: profileResult.changes,
        sessions: sessionResult.changes,
      };
    });
    return transaction();
  }

  createJob(job) {
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO response_jobs
         (job_id, guild_id, channel_id, session_id, source_message_ids_json, state,
          snapshot_version, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?)`,
      )
      .run(
        job.jobId,
        job.guildId,
        job.channelId,
        job.sessionId,
        JSON.stringify(job.sourceMessageIds),
        job.snapshotVersion,
        now.toISOString(),
        now.toISOString(),
        plusDays(now, this.config.privacy.operationalRetentionDays),
      );
  }

  finishJob(jobId, state, { discordResponseId = null, errorCategory = null } = {}) {
    this.db
      .prepare(
        `UPDATE response_jobs
         SET state = ?, discord_response_id = ?, error_category = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(state, discordResponseId, errorCategory, new Date().toISOString(), jobId);
  }

  addAuditEvent(event) {
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO audit_events
         (event_id, actor_id, guild_id, channel_id, action, metadata_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.actorId,
        event.guildId,
        event.channelId,
        event.action,
        JSON.stringify(event.metadata ?? {}),
        now.toISOString(),
        plusDays(now, this.config.privacy.operationalRetentionDays),
      );
  }

  cleanup(now = new Date()) {
    const timestamp = now.toISOString();
    const transaction = this.db.transaction(() => {
      const messages = this.db
        .prepare(
          `UPDATE messages SET content = NULL
           WHERE expires_at < ? AND content IS NOT NULL`,
        )
        .run(timestamp).changes;
      const sessions = this.db
        .prepare(
          `UPDATE conversation_sessions SET summary_json = NULL, status = 'deleted'
           WHERE expires_at < ? AND (summary_json IS NOT NULL OR status != 'deleted')`,
        )
        .run(timestamp).changes;
      const jobs = this.db
        .prepare('DELETE FROM response_jobs WHERE expires_at < ?')
        .run(timestamp).changes;
      const audits = this.db
        .prepare('DELETE FROM audit_events WHERE expires_at < ?')
        .run(timestamp).changes;
      return { messages, sessions, jobs, audits };
    });
    return transaction();
  }
}

export function openDatabase(
  config,
  filePath = process.env.BOT_DATABASE_PATH ?? 'data/bot.sqlite3',
) {
  return new DatabaseStore(filePath, config);
}
