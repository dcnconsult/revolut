import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const sourcePath = process.env.SANDBOX_DATABASE_PATH ?? '/var/lib/revolut/sandbox-transfers.sqlite';
const backupDirectory = process.env.SANDBOX_BACKUP_DIRECTORY ?? '/backups';
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(backupDirectory, `sandbox-transfers-${timestamp}.sqlite`);

if (sourcePath === ':memory:') throw new Error('Cannot back up an in-memory database.');
const database = new DatabaseSync(sourcePath, { readOnly: true, timeout: 10_000 });
try {
  await backup(database, destination, { rate: 100 });
} finally {
  database.close();
}

const digest = createHash('sha256').update(await readFile(destination)).digest('hex');
await writeFile(`${destination}.sha256`, `${digest}  ${destination.split('/').at(-1)}\n`, { mode: 0o600 });
console.log(`SQLITE_BACKUP_OK file=${destination.split('/').at(-1)} checksum=sha256`);
