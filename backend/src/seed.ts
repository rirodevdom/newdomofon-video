import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { query, closeDb } from './db.js';

async function main() {
  const exists = await query<{ id: string }>('SELECT id FROM users WHERE login = $1', [config.adminLogin]);
  if (exists.rowCount) {
    console.log('Admin already exists');
    return;
  }
  const hash = await bcrypt.hash(config.adminPassword, 12);
  await query(
    'INSERT INTO users(login, password_hash, role, is_active) VALUES ($1, $2, $3, true)',
    [config.adminLogin, hash, 'super_admin']
  );
  await query("INSERT INTO camera_groups(name) VALUES ('Default') ON CONFLICT DO NOTHING");
  console.log(`Admin user created: ${config.adminLogin}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
