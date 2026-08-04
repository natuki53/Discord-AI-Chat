import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const source = path.resolve(process.env.BOT_DATABASE_PATH ?? 'data/bot.sqlite3');
const destinationDirectory = path.resolve(process.env.BOT_BACKUP_DIRECTORY ?? 'data/backups');
fs.mkdirSync(destinationDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(destinationDirectory, `bot-${stamp}.sqlite3`);
const database = new Database(source, { readonly: true, fileMustExist: true });
await database.backup(destination);
database.close();

const backups = fs
  .readdirSync(destinationDirectory)
  .filter((name) => /^bot-.*\.sqlite3$/.test(name))
  .sort()
  .reverse();
for (const obsolete of backups.slice(7)) {
  fs.rmSync(path.join(destinationDirectory, obsolete));
}
process.stdout.write(`${destination}\n`);
