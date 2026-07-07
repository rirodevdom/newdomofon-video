import fs from 'node:fs/promises';
import path from 'node:path';
import { query, closeDb } from './db.js';

async function main() {
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sqlPath = path.join(migrationsDir, file);
    const sql = await fs.readFile(sqlPath, 'utf8');
    await query(sql);
    console.log(`Migration applied: ${file}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
