import { openDb, migrate } from '../server/db.mjs';
import { randomUUID } from 'node:crypto';
const email = process.argv[2]?.trim().toLowerCase();
if (!email?.includes('@'))
  throw new Error(
    'Usage: node --env-file=.env scripts/promote-admin.mjs verified-account@example.com',
  );
const db = await openDb();
await migrate(db);
try {
  const user = await db.get('SELECT id FROM users WHERE email=?', [email]);
  if (!user) throw new Error('Register the email account first. No account was changed.');
  await db.transaction(async () => {
    await db.run("UPDATE users SET role='admin',status='active' WHERE id=?", [user.id]);
    await db.run(
      'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), user.id, 'operator:promote-admin', user.id, new Date().toISOString()],
    );
  });
  console.log('The specified existing account was promoted to administrator.');
} finally {
  await db.close();
}
