import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

export async function openDb() {
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const context = new AsyncLocalStorage();
    const query = async (sql, values = []) => {
      let i = 0;
      return (context.getStore() || pool).query(
        sql.replace(/\?/g, () => `$${++i}`),
        values,
      );
    };
    const transaction = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await context.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };
    return {
      all: async (s, p) => (await query(s, p)).rows,
      get: async (s, p) => (await query(s, p)).rows[0],
      run: query,
      transaction,
      close: () => pool.end(),
      engine: 'postgresql',
    };
  }
  const dir = process.env.DATA_DIR || path.resolve('data');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'shortping.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const operation = (fn) => (context.getStore() ? Promise.resolve(fn()) : exclusive(fn));
  const transaction = (fn) =>
    exclusive(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await context.run(true, fn);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    });
  return {
    all: (s, p = []) => operation(() => db.prepare(s).all(...p)),
    get: (s, p = []) => operation(() => db.prepare(s).get(...p)),
    run: (s, p = []) => operation(() => db.prepare(s).run(...p)),
    transaction,
    close: () => db.close(),
    engine: 'sqlite',
  };
}

export async function migrate(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','pd','viewer')), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS dramas (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, tagline TEXT NOT NULL, synopsis TEXT NOT NULL, genre TEXT NOT NULL, image TEXT NOT NULL, accent TEXT NOT NULL DEFAULT '#c4f562', badge TEXT NOT NULL DEFAULT 'NEW', status TEXT NOT NULL DEFAULT 'draft', price INTEGER NOT NULL DEFAULT 3900 CHECK(price >= 0), free_episodes INTEGER NOT NULL DEFAULT 3, views INTEGER NOT NULL DEFAULT 0, review_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, number INTEGER NOT NULL CHECK(number > 0), title TEXT NOT NULL, video TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 90, UNIQUE(drama_id, number))`,
    `CREATE TABLE IF NOT EXISTS favorites (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, PRIMARY KEY(user_id,drama_id))`,
    `CREATE TABLE IF NOT EXISTS history (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, episode INTEGER NOT NULL, progress REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,drama_id))`,
    `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), drama_id TEXT REFERENCES dramas(id), kind TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, idempotency_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS entitlements (user_id TEXT NOT NULL REFERENCES users(id), drama_id TEXT NOT NULL REFERENCES dramas(id), order_id TEXT NOT NULL REFERENCES orders(id), PRIMARY KEY(user_id,drama_id))`,
    `CREATE TABLE IF NOT EXISTS subscriptions (user_id TEXT PRIMARY KEY REFERENCES users(id), order_id TEXT NOT NULL REFERENCES orders(id), expires_at TEXT NOT NULL, auto_renew INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS media_files (url TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), mime TEXT NOT NULL, created_at TEXT NOT NULL)`,
  ];
  for (const sql of statements) await db.run(sql);
}
