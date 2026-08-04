import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config/load-config.js';
import { commandDefinitions } from '../src/discord/commands.js';

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!token) throw new Error('DISCORD_BOT_TOKENが設定されていません');
if (!applicationId) throw new Error('DISCORD_APPLICATION_IDが設定されていません');

const { config } = loadConfig();
const rest = new REST({ version: '10' }).setToken(token);
const result = await rest.put(
  Routes.applicationGuildCommands(applicationId, config.discord.guildId),
  {
    body: commandDefinitions(),
  },
);
process.stdout.write(`${result.length} commands registered for guild ${config.discord.guildId}\n`);
