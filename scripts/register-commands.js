import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config/load-config.js';
import { commandDefinitions } from '../src/discord/commands.js';

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!token) throw new Error('DISCORD_BOT_TOKENが設定されていません');
if (!applicationId) throw new Error('DISCORD_APPLICATION_IDが設定されていません');

const { config } = loadConfig();
const rest = new REST({ version: '10' }).setToken(token);
const route = Routes.applicationGuildCommands(applicationId, config.discord.guildId);
const definitions = commandDefinitions();
const checking = process.argv.includes('--check');
const result = checking ? await rest.get(route) : await rest.put(route, { body: definitions });
const names = result.map((item) => item.name).sort();
const expected = definitions.map((item) => item.name).sort();
if (JSON.stringify(names) !== JSON.stringify(expected))
  throw new Error('登録済みコマンドが現在の定義と一致しません。');
process.stdout.write(
  `${JSON.stringify({ action: checking ? 'verified' : 'registered', count: result.length, commands: names })}\n`,
);
