import assert from 'node:assert/strict';
import test from 'node:test';
import { commandDefinitions } from '../src/discord/commands.js';

function assertRequiredOptionsFirst(options = [], path = '') {
  let optionalSeen = false;
  for (const option of options) {
    if (option.type === 1 || option.type === 2) {
      assertRequiredOptionsFirst(option.options, `${path}/${option.name}`);
      continue;
    }
    if (option.required) {
      assert.equal(
        optionalSeen,
        false,
        `${path}/${option.name}: 必須optionは任意optionより前に置く`,
      );
    } else {
      optionalSeen = true;
    }
  }
}

test('Discord command定義は登録可能なoption順である', () => {
  const commands = commandDefinitions();
  assert.equal(commands.length, 11);
  assert.ok(commands.some((command) => command.name === 'ai-topic-reset'));
  for (const command of commands) {
    assertRequiredOptionsFirst(command.options, command.name);
  }
});
