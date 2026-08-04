import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnScheduler } from '../src/conversation/turn-scheduler.js';

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now() {
    return this.time;
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  tick(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

function makeScheduler(clock, turns) {
  return new TurnScheduler({
    processTurn: async (turn) => turns.push(turn),
    resolveChannelConfig: () => ({ debounceMs: 2500, maxDebounceMs: 8000 }),
    globalConcurrency: 1,
    clock,
  });
}

test('単発messageをdebounce後に処理する', async () => {
  const clock = new FakeClock();
  const turns = [];
  const scheduler = makeScheduler(clock, turns);
  scheduler.enqueue({ guildId: 'g', channelId: 'c', messageId: 'm1' });
  clock.tick(2499);
  assert.equal(turns.length, 0);
  clock.tick(1);
  await Promise.resolve();
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].messageIds, ['m1']);
});

test('連投を一つのturnへ束ねる', async () => {
  const clock = new FakeClock();
  const turns = [];
  const scheduler = makeScheduler(clock, turns);
  scheduler.enqueue({ guildId: 'g', channelId: 'c', messageId: 'm1' });
  clock.tick(1000);
  scheduler.enqueue({ guildId: 'g', channelId: 'c', messageId: 'm2' });
  clock.tick(2499);
  assert.equal(turns.length, 0);
  clock.tick(1);
  await Promise.resolve();
  assert.deepEqual(turns[0].messageIds, ['m1', 'm2']);
});

test('連投が続いてもmaxDebounceで閉じる', async () => {
  const clock = new FakeClock();
  const turns = [];
  const scheduler = makeScheduler(clock, turns);
  scheduler.enqueue({ guildId: 'g', channelId: 'c', messageId: 'm0' });
  for (let index = 1; index <= 4; index += 1) {
    clock.tick(1800);
    scheduler.enqueue({ guildId: 'g', channelId: 'c', messageId: `m${index}` });
  }
  clock.tick(799);
  assert.equal(turns.length, 0);
  clock.tick(1);
  await Promise.resolve();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].messageIds.length, 5);
});
