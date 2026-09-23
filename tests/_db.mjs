// 테스트용 DB 선택 도우미
// - 기본: 각 실행마다 새 SQLite 파일(data/tests/<runId>/shortping.sqlite)
// - TEST_PG_ADMIN_URL 지정 시: 실행마다 새 PostgreSQL 데이터베이스를 만들어 같은 테스트를 PostgreSQL로 실행
//   예) TEST_PG_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres npm test
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const adminUrl = process.env.TEST_PG_ADMIN_URL || '';
export const usingPg = Boolean(adminUrl);

export async function prepareTestDb(runId, dataDir) {
  if (!usingPg) return { url: '', all: sqliteAll(dataDir), run: sqliteRun(dataDir), close: async () => {} };
  const pg = (await import('pg')).default;
  const name = 'sp_test_' + runId.replace(/[^a-z0-9]/gi, '').slice(0, 24).toLowerCase();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = '/' + name;
  const url = u.toString();
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const conv = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => '$' + ++i);
  };
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  return {
    url,
    all: async (sql, params = []) => (await pool.query(conv(sql), params)).rows,
    run: async (sql, params = []) => {
      await pool.query(conv(sql), params);
    },
    close: async () => {
      await pool.end().catch(() => {});
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await a.end();
    },
  };
}

function open(dataDir, readOnly) {
  const db = readOnly ? new DatabaseSync(path.join(dataDir, 'shortping.sqlite'), { readOnly: true }) : new DatabaseSync(path.join(dataDir, 'shortping.sqlite'));
  if (!readOnly) db.exec('PRAGMA busy_timeout=5000');
  return db;
}
function sqliteAll(dataDir) {
  return async (sql, params = []) => {
    const db = open(dataDir, true);
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  };
}
function sqliteRun(dataDir) {
  return async (sql, params = []) => {
    const db = open(dataDir, false);
    try {
      db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  };
}
