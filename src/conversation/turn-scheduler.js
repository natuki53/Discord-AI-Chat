export class TurnScheduler {
  constructor({ processTurn, resolveChannelConfig, globalConcurrency = 1, clock = globalThis }) {
    this.processTurn = processTurn;
    this.resolveChannelConfig = resolveChannelConfig;
    this.globalConcurrency = globalConcurrency;
    this.clock = clock;
    this.channels = new Map();
    this.readyQueue = [];
    this.readySet = new Set();
    this.active = 0;
    this.accepting = true;
    this.idleWaiters = [];
  }

  enqueue({ guildId, channelId, messageId }) {
    if (!this.accepting) return false;
    const key = `${guildId}:${channelId}`;
    let state = this.channels.get(key);
    if (!state) {
      state = {
        key,
        guildId,
        channelId,
        pendingMessageIds: [],
        firstQueuedAt: null,
        lastQueuedAt: null,
        timer: null,
        running: false,
      };
      this.channels.set(key, state);
    }

    if (!state.pendingMessageIds.includes(messageId)) {
      state.pendingMessageIds.push(messageId);
    }
    const now = this.now();
    state.firstQueuedAt ??= now;
    state.lastQueuedAt = now;
    this.schedule(state);
    return true;
  }

  now() {
    return typeof this.clock.now === 'function' ? this.clock.now() : Date.now();
  }

  schedule(state) {
    const channelConfig = this.resolveChannelConfig(state.channelId);
    if (!channelConfig) return;
    if (state.timer) this.clock.clearTimeout(state.timer);
    const elapsed = this.now() - state.firstQueuedAt;
    const remainingMaximum = Math.max(0, channelConfig.maxDebounceMs - elapsed);
    const delay = Math.min(channelConfig.debounceMs, remainingMaximum);
    state.timer = this.clock.setTimeout(() => {
      state.timer = null;
      this.markReady(state.key);
    }, delay);
  }

  markReady(key) {
    if (!this.readySet.has(key)) {
      this.readySet.add(key);
      this.readyQueue.push(key);
    }
    this.pump();
  }

  pump() {
    while (this.active < this.globalConcurrency && this.readyQueue.length > 0) {
      const key = this.readyQueue.shift();
      this.readySet.delete(key);
      const state = this.channels.get(key);
      if (!state || state.running || state.pendingMessageIds.length === 0) continue;

      const messageIds = state.pendingMessageIds.splice(0);
      state.firstQueuedAt = null;
      state.lastQueuedAt = null;
      state.running = true;
      this.active += 1;

      Promise.resolve(
        this.processTurn({
          guildId: state.guildId,
          channelId: state.channelId,
          messageIds,
        }),
      )
        .catch(() => {})
        .finally(() => {
          state.running = false;
          this.active -= 1;
          if (state.pendingMessageIds.length > 0 && !state.timer) this.markReady(key);
          this.pump();
          this.resolveIdleIfNeeded();
        });
    }
    this.resolveIdleIfNeeded();
  }

  queueLength(channelId) {
    let count = 0;
    for (const state of this.channels.values()) {
      if (!channelId || state.channelId === channelId) count += state.pendingMessageIds.length;
    }
    return count;
  }

  async shutdown(timeoutMs = 30_000) {
    this.accepting = false;
    for (const state of this.channels.values()) {
      if (state.timer) {
        this.clock.clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.pendingMessageIds.length > 0) this.markReady(state.key);
    }
    if (this.isIdle()) return true;

    return await new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(false), timeoutMs);
      this.idleWaiters.push(() => {
        this.clock.clearTimeout(timer);
        resolve(true);
      });
    });
  }

  isIdle() {
    return (
      this.active === 0 &&
      this.readyQueue.length === 0 &&
      [...this.channels.values()].every(
        (state) => state.pendingMessageIds.length === 0 && !state.running,
      )
    );
  }

  resolveIdleIfNeeded() {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
