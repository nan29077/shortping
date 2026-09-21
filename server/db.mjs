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
    `CREATE TABLE IF NOT EXISTS user_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, avatar TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', auto_next INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, tagline TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', banner TEXT NOT NULL DEFAULT '', logo TEXT NOT NULL DEFAULT '', accent TEXT NOT NULL DEFAULT '#c4f562', status TEXT NOT NULL DEFAULT 'draft', featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS channel_categories (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, UNIQUE(channel_id,name))`,
    `CREATE TABLE IF NOT EXISTS channel_follows (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(user_id,channel_id))`,
    `CREATE TABLE IF NOT EXISTS dramas (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, tagline TEXT NOT NULL, synopsis TEXT NOT NULL, genre TEXT NOT NULL, image TEXT NOT NULL, accent TEXT NOT NULL DEFAULT '#c4f562', badge TEXT NOT NULL DEFAULT 'NEW', status TEXT NOT NULL DEFAULT 'draft', price INTEGER NOT NULL DEFAULT 3900 CHECK(price >= 0), free_episodes INTEGER NOT NULL DEFAULT 3, views INTEGER NOT NULL DEFAULT 0, review_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, number INTEGER NOT NULL CHECK(number > 0), title TEXT NOT NULL, video TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 90, UNIQUE(drama_id, number))`,
    `CREATE TABLE IF NOT EXISTS favorites (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, PRIMARY KEY(user_id,drama_id))`,
    `CREATE TABLE IF NOT EXISTS history (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, episode INTEGER NOT NULL, progress REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,drama_id))`,
    `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), drama_id TEXT REFERENCES dramas(id), kind TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, idempotency_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS entitlements (user_id TEXT NOT NULL REFERENCES users(id), drama_id TEXT NOT NULL REFERENCES dramas(id), order_id TEXT NOT NULL REFERENCES orders(id), PRIMARY KEY(user_id,drama_id))`,
    `CREATE TABLE IF NOT EXISTS episode_entitlements (user_id TEXT NOT NULL REFERENCES users(id), drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, episode INTEGER NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id), created_at TEXT NOT NULL, PRIMARY KEY(user_id,drama_id,episode))`,
    `CREATE TABLE IF NOT EXISTS subscriptions (user_id TEXT PRIMARY KEY REFERENCES users(id), order_id TEXT NOT NULL REFERENCES orders(id), expires_at TEXT NOT NULL, auto_renew INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS media_files (url TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), mime TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS media_metadata (url TEXT PRIMARY KEY REFERENCES media_files(url) ON DELETE CASCADE, duration INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS content_reviews (id TEXT PRIMARY KEY, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS support_tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), category TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, replied_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS pd_tax_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, business_type TEXT NOT NULL DEFAULT 'individual', business_no TEXT NOT NULL DEFAULT '', business_name TEXT NOT NULL DEFAULT '', rep_name TEXT NOT NULL DEFAULT '', business_class TEXT NOT NULL DEFAULT '', business_item TEXT NOT NULL DEFAULT '', tax_email TEXT NOT NULL DEFAULT '', bank_name TEXT NOT NULL DEFAULT '', account_number TEXT NOT NULL DEFAULT '', account_holder TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0, verified_note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS payouts (id TEXT PRIMARY KEY, pd_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, vat INTEGER NOT NULL DEFAULT 0, income_tax INTEGER NOT NULL DEFAULT 0, local_tax INTEGER NOT NULL DEFAULT 0, payable INTEGER NOT NULL, business_type TEXT NOT NULL DEFAULT 'individual', bank_name TEXT NOT NULL DEFAULT '', account_number TEXT NOT NULL DEFAULT '', account_holder TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'requested', memo TEXT NOT NULL DEFAULT '', requested_at TEXT NOT NULL, processed_at TEXT, processed_by TEXT REFERENCES users(id))`,
    `CREATE TABLE IF NOT EXISTS settlement_entries (id TEXT PRIMARY KEY, pd_id TEXT NOT NULL REFERENCES users(id), order_id TEXT REFERENCES orders(id), drama_id TEXT REFERENCES dramas(id), kind TEXT NOT NULL, period TEXT NOT NULL DEFAULT '', gross INTEGER NOT NULL, platform_fee INTEGER NOT NULL DEFAULT 0, pg_fee INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL, fee_rate REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', confirm_at TEXT NOT NULL, payout_id TEXT REFERENCES payouts(id), created_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS settlement_entry_order ON settlement_entries(order_id) WHERE order_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS settlement_entry_pd ON settlement_entries(pd_id,status)`,
    `CREATE TABLE IF NOT EXISTS settlement_watch_marks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, episode INTEGER NOT NULL, period TEXT NOT NULL, PRIMARY KEY(user_id,drama_id))`,
    // 핑(포인트) — 충전 상품, 지갑(잔액 캐시), 충전 단위(로트), 거래 장부, 사용 내역, PD별 분배율
    `CREATE TABLE IF NOT EXISTS ping_products (id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'web', name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), pings INTEGER NOT NULL CHECK(pings > 0), bonus_pings INTEGER NOT NULL DEFAULT 0 CHECK(bonus_pings >= 0), badge TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ping_wallets (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, paid_balance INTEGER NOT NULL DEFAULT 0 CHECK(paid_balance >= 0), bonus_balance INTEGER NOT NULL DEFAULT 0 CHECK(bonus_balance >= 0), updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ping_lots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'web', order_id TEXT REFERENCES orders(id), paid_total INTEGER NOT NULL DEFAULT 0, paid_left INTEGER NOT NULL DEFAULT 0 CHECK(paid_left >= 0), bonus_total INTEGER NOT NULL DEFAULT 0, bonus_left INTEGER NOT NULL DEFAULT 0 CHECK(bonus_left >= 0), unit_milli BIGINT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ping_lots_user ON ping_lots(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ping_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, paid_delta INTEGER NOT NULL DEFAULT 0, bonus_delta INTEGER NOT NULL DEFAULT 0, paid_after INTEGER NOT NULL, bonus_after INTEGER NOT NULL, value_milli BIGINT NOT NULL DEFAULT 0, order_id TEXT REFERENCES orders(id), drama_id TEXT, episode INTEGER, memo TEXT NOT NULL DEFAULT '', actor_id TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ping_ledger_user ON ping_ledger(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ping_consumptions (ledger_id TEXT NOT NULL REFERENCES ping_ledger(id) ON DELETE CASCADE, lot_id TEXT NOT NULL REFERENCES ping_lots(id) ON DELETE CASCADE, paid INTEGER NOT NULL DEFAULT 0, bonus INTEGER NOT NULL DEFAULT 0, value_milli BIGINT NOT NULL, PRIMARY KEY(ledger_id, lot_id))`,
    `CREATE TABLE IF NOT EXISTS pd_settlement_rates (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, platform_fee_rate REAL NOT NULL CHECK(platform_fee_rate >= 0 AND platform_fee_rate <= 100), updated_at TEXT NOT NULL, updated_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS member_notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL, created_at TEXT NOT NULL)`,
  ];
  for (const sql of statements) await db.run(sql);
  // Added after the first release: keep existing local and hosted databases usable.
  await ensureColumn(db, 'dramas', 'channel_id', 'TEXT');
  await ensureColumn(db, 'dramas', 'category_id', 'TEXT');
  await ensureColumn(db, 'dramas', 'published_at', 'TEXT');
  await ensureColumn(db, 'users', 'last_login_at', 'TEXT');
  await ensureColumn(db, 'users', 'phone', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, 'dramas', 'episode_price', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'channels', 'theme', "TEXT NOT NULL DEFAULT 'lime'");
  await ensureColumn(db, 'channels', 'banner_fit', "TEXT NOT NULL DEFAULT 'contain'");
  await ensureColumn(db, 'channels', 'overlay', 'INTEGER NOT NULL DEFAULT 45');
  await ensureColumn(db, 'channels', 'greeting', "TEXT NOT NULL DEFAULT ''");
  // 편당 결제는 원화에서 핑으로 바뀌었습니다. 무료 여부는 가격 0원이 아니라 별도 표시로 관리합니다.
  if (await ensureColumn(db, 'dramas', 'free', 'INTEGER NOT NULL DEFAULT 0'))
    await db.run('UPDATE dramas SET free=1 WHERE price=0');
  await ensureColumn(db, 'dramas', 'episode_pings', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'user_profiles', 'auto_unlock', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'orders', 'channel', "TEXT NOT NULL DEFAULT 'web'");
  await ensureColumn(db, 'orders', 'channel_fee', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'orders', 'pings', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'orders', 'bonus_pings', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'orders', 'product_id', 'TEXT');
  // 처음 한 번만 기본 충전 상품(웹)을 만들어 둡니다. 이후 구성은 관리자 포인트 관리에서 바꿉니다.
  if (!(await db.get('SELECT id FROM ping_products LIMIT 1'))) {
    const stamp = new Date().toISOString();
    const defaults = [
      ['ping-5k', '50핑', 5000, 50, 0, ''],
      ['ping-10k', '100핑', 10000, 100, 0, '기본'],
      ['ping-30k', '300핑', 30000, 300, 15, '보너스'],
      ['ping-50k', '500핑', 50000, 500, 40, '인기'],
      ['ping-100k', '1,000핑', 100000, 1000, 100, '최대 혜택'],
    ];
    let order = 0;
    for (const [id, name, price, pings, bonus, badge] of defaults)
      await db.run(
        "INSERT INTO ping_products (id,channel,name,price,pings,bonus_pings,badge,active,sort_order,created_at,updated_at) VALUES (?,'web',?,?,?,?,?,1,?,?,?) ON CONFLICT DO NOTHING",
        [id, name, price, pings, bonus, badge, order++, stamp, stamp],
      );
  }
  await db.run(
    "UPDATE dramas SET published_at=created_at WHERE published_at IS NULL AND status='published'",
  );
}

async function ensureColumn(db, table, column, type) {
  const existing =
    db.engine === 'postgresql'
      ? (
          await db.all(
            'SELECT column_name AS name FROM information_schema.columns WHERE table_name=?',
            [table],
          )
        ).map((r) => r.name)
      : (await db.all(`PRAGMA table_info(${table})`)).map((r) => r.name);
  if (existing.includes(column)) return false;
  await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}
