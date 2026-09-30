import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

// PostgreSQL은 COUNT/SUM(bigint)과 NUMERIC을 문자열로 돌려줍니다. 화면과 정산 계산이 숫자를
// 기대하므로 안전 범위(2^53) 안에서 숫자로 바꿔 받습니다.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

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
      // 트랜잭션 컨텍스트를 물려받지 않는 자리에서 실행합니다(타이머·백그라운드 작업용).
      detach: (fn) => context.exit(fn),
      // 돈이 오가는 트랜잭션 첫머리에서 회원 행을 잠가 같은 회원의 동시 요청을 한 줄로 세웁니다.
      lockUser: async (userId) => {
        if (!context.getStore()) throw new Error('lockUser must run inside a transaction');
        await query('SELECT id FROM users WHERE id=? FOR UPDATE', [userId]);
      },
      isUnique: (e) => e?.code === '23505',
      close: () => pool.end(),
      engine: 'postgresql',
    };
  }
  const dir = process.env.DATA_DIR || path.resolve('data');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'shortping.sqlite'));
  // busy_timeout: 작업 프로세스(npm run worker)나 테스트 도구가 같은 파일을 잠깐 잡고 있어도 바로 실패하지 않고 5초까지 기다립니다.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
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
    detach: (fn) => context.exit(fn),
    // SQLite는 BEGIN IMMEDIATE로 트랜잭션이 이미 한 줄로 실행됩니다.
    lockUser: async () => {},
    isUnique: (e) => /UNIQUE constraint failed/i.test(String(e?.message || '')),
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
    // 구독 풀 배분용 재생 기록: 구독 덕분에 재생된 회차만, 월마다 회원·작품·회차당 한 번
    `CREATE TABLE IF NOT EXISTS subscription_views (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, episode INTEGER NOT NULL, period TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,drama_id,episode,period))`,
    `CREATE INDEX IF NOT EXISTS subscription_views_period ON subscription_views(period)`,
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
    // ── 업로드 고도화 ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS upload_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, mime TEXT NOT NULL, size BIGINT NOT NULL, received BIGINT NOT NULL DEFAULT 0, filename TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    // ── 라마(제작 포인트, 1라마 = 10원) ────────────────────────────
    `CREATE TABLE IF NOT EXISTS lama_products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), lama INTEGER NOT NULL CHECK(lama > 0), bonus_lama INTEGER NOT NULL DEFAULT 0 CHECK(bonus_lama >= 0), badge TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lama_wallets (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, paid_balance INTEGER NOT NULL DEFAULT 0 CHECK(paid_balance >= 0), bonus_balance INTEGER NOT NULL DEFAULT 0 CHECK(bonus_balance >= 0), held_paid INTEGER NOT NULL DEFAULT 0 CHECK(held_paid >= 0), held_bonus INTEGER NOT NULL DEFAULT 0 CHECK(held_bonus >= 0), updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lama_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, paid_delta INTEGER NOT NULL DEFAULT 0, bonus_delta INTEGER NOT NULL DEFAULT 0, held_delta INTEGER NOT NULL DEFAULT 0, paid_after INTEGER NOT NULL, bonus_after INTEGER NOT NULL, held_after INTEGER NOT NULL DEFAULT 0, job_id TEXT, order_id TEXT, payout_id TEXT, memo TEXT NOT NULL DEFAULT '', actor_id TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS lama_ledger_user ON lama_ledger(user_id, created_at)`,
    // ── AI 연결 ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS ai_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '', api_key_enc TEXT NOT NULL DEFAULT '', key_hint TEXT NOT NULL DEFAULT '', secret_enc TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'unknown', last_error TEXT NOT NULL DEFAULT '', last_checked_at TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ai_models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE, capability TEXT NOT NULL, model_id TEXT NOT NULL, label TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'standard', unit TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, price_lama REAL NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '', max_seconds INTEGER NOT NULL DEFAULT 10, image_input INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 50, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ai_user_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, daily_lama INTEGER, monthly_lama INTEGER, blocked INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT)`,
    // 6단계(2026-09-30) 모델 품질: 품질 시험 문제 · 시험 실행 · 품질 표본(시험 + 실제 AI 검수 점수)
    `CREATE TABLE IF NOT EXISTS ai_benchmarks (id TEXT PRIMARY KEY, name TEXT NOT NULL, capability TEXT NOT NULL, prompt TEXT NOT NULL, ref_image TEXT NOT NULL DEFAULT '', seconds INTEGER NOT NULL DEFAULT 5, created_by TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ai_benchmark_runs (id TEXT PRIMARY KEY, benchmark_id TEXT NOT NULL, model_id TEXT NOT NULL, job_id TEXT, verify_job_id TEXT, status TEXT NOT NULL DEFAULT 'queued', result_url TEXT NOT NULL DEFAULT '', score INTEGER, face INTEGER, cost_won INTEGER NOT NULL DEFAULT 0, seconds REAL, summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, finished_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS ai_quality_samples (id TEXT PRIMARY KEY, model_ref TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, score INTEGER NOT NULL, face INTEGER, created_at TEXT NOT NULL)`,
    // AI 작업 처리기(서버마다 하나) 살아 있음 표시: 여러 대로 운영할 때 다른 서버가 처리 중인 작업을 가로채지 않도록
    `CREATE TABLE IF NOT EXISTS ai_workers (id TEXT PRIMARY KEY, seen_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ai_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id TEXT, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, capability TEXT NOT NULL, requested_model TEXT NOT NULL DEFAULT 'auto', model_ref TEXT, provider_id TEXT, vendor_model TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT 'standard', input TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', estimate_lama INTEGER NOT NULL DEFAULT 0, hold_paid INTEGER NOT NULL DEFAULT 0, hold_bonus INTEGER NOT NULL DEFAULT 0, charged_lama INTEGER NOT NULL DEFAULT 0, cost_won INTEGER NOT NULL DEFAULT 0, vendor_ref TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, tried TEXT NOT NULL DEFAULT '', claimed_by TEXT, billed INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, next_poll_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS ai_jobs_status ON ai_jobs(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS ai_jobs_user ON ai_jobs(user_id, created_at)`,
    // ── 숏핑 스튜디오(AI 제작) ─────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS studio_projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT, title TEXT NOT NULL, logline TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '로맨스', tone TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', episode_count INTEGER NOT NULL DEFAULT 5, episode_seconds INTEGER NOT NULL DEFAULT 60, poster TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS studio_characters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', look TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', voice_model TEXT NOT NULL DEFAULT 'auto', voice TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS studio_episodes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'outline', video TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 0, subtitles TEXT NOT NULL DEFAULT '', exported_at TEXT, UNIQUE(project_id, number))`,
    `CREATE TABLE IF NOT EXISTS studio_shots (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES studio_episodes(id) ON DELETE CASCADE, sort_order INTEGER NOT NULL DEFAULT 0, scene TEXT NOT NULL DEFAULT '', visual TEXT NOT NULL DEFAULT '', dialogue TEXT NOT NULL DEFAULT '', speaker_id TEXT, camera TEXT NOT NULL DEFAULT '', seconds INTEGER NOT NULL DEFAULT 5, image TEXT NOT NULL DEFAULT '', audio TEXT NOT NULL DEFAULT '', audio_seconds REAL NOT NULL DEFAULT 0, video TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS studio_assets (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, target_type TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL, job_id TEXT, model_label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS studio_assets_target ON studio_assets(target_type, target_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS studio_locations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, name TEXT NOT NULL, look TEXT NOT NULL DEFAULT '', look_en TEXT NOT NULL DEFAULT '', look_en_src TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS studio_script_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, episode_id TEXT NOT NULL REFERENCES studio_episodes(id) ON DELETE CASCADE, version INTEGER NOT NULL, shots TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS studio_script_versions_ep ON studio_script_versions(episode_id, version)`,
    `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', read_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at)`,
    // 합성 대기열(회차·예고편). 웹 서버 안에서 돌거나, COMPOSE_WORKER=external이면 별도 작업 프로세스(npm run worker)가 처리합니다.
    `CREATE TABLE IF NOT EXISTS studio_renders (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, target_id TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', claimed_by TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS studio_renders_status ON studio_renders(status, created_at)`,
    `CREATE TABLE IF NOT EXISTS voice_samples (model_ref TEXT NOT NULL, voice TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(model_ref, voice))`,
    `CREATE TABLE IF NOT EXISTS drama_thumbnails (id TEXT PRIMARY KEY, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, url TEXT NOT NULL, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, winner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS drama_thumbnails_drama ON drama_thumbnails(drama_id)`,
    // 메인페이지 관리 변경 기록(되돌리기용): kind = appearance(PC 여백) | layout(메인 화면 구성)
    `CREATE TABLE IF NOT EXISTS home_history (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, actor_id TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS home_history_created ON home_history(created_at)`,
    `CREATE TABLE IF NOT EXISTS ai_route_rules (id TEXT PRIMARY KEY, capability TEXT NOT NULL, tier TEXT NOT NULL, model_ids TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT, UNIQUE(capability, tier))`,
    // AI 조수(작업 공간 채팅, 2026-09-24): PD 말 → 실행 계획(승인 후 실행) → 결과·되돌리기 기록
    `CREATE TABLE IF NOT EXISTS studio_chat (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', job_id TEXT, episode_id TEXT, result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS studio_chat_project ON studio_chat(project_id, created_at)`,
    // 드라매직 벤치마킹 고도화(2026-09-25): 소품 · 내 자산 라이브러리 · 협업(팀·초대·의견·활동)
    `CREATE TABLE IF NOT EXISTS studio_props (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, name TEXT NOT NULL, look TEXT NOT NULL DEFAULT '', look_en TEXT NOT NULL DEFAULT '', look_en_src TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS studio_library (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, image TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS studio_library_owner ON studio_library(owner_id, kind)`,
    `CREATE TABLE IF NOT EXISTS studio_members (project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, pay_mode TEXT NOT NULL DEFAULT 'self', sponsor_limit INTEGER NOT NULL DEFAULT 0, invited_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY(project_id, user_id))`,
    `CREATE INDEX IF NOT EXISTS studio_members_user ON studio_members(user_id)`,
    `CREATE TABLE IF NOT EXISTS studio_invites (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, email TEXT, role TEXT NOT NULL, pay_mode TEXT NOT NULL DEFAULT 'self', sponsor_limit INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, expires_at TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS studio_invites_project ON studio_invites(project_id)`,
    `CREATE TABLE IF NOT EXISTS studio_comments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, target_type TEXT NOT NULL, target_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS studio_comments_project ON studio_comments(project_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS studio_activity (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE, user_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS studio_activity_project ON studio_activity(project_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ai_safety_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, term TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    // ── 계정·운영 고도화(2026-09-29): 이메일·문자 발송 기록, 비밀번호 재설정, 휴대폰 인증, 구독 배분 개별 설정, 조회수·썸네일 클릭 중복 방지 ──
    `CREATE TABLE IF NOT EXISTS message_outbox (id TEXT PRIMARY KEY, channel TEXT NOT NULL, provider TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '', user_id TEXT, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS message_outbox_created ON message_outbox(created_at)`,
    `CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS phone_verifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, phone TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, verified_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS phone_verifications_user ON phone_verifications(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS subscription_overrides (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, weight REAL NOT NULL DEFAULT 1 CHECK(weight >= 0 AND weight <= 5), excluded INTEGER NOT NULL DEFAULT 0, cap_pct REAL NOT NULL DEFAULT 0 CHECK(cap_pct >= 0 AND cap_pct <= 100), memo TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, updated_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS view_marks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, drama_id TEXT NOT NULL REFERENCES dramas(id) ON DELETE CASCADE, episode INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(user_id, drama_id, episode, day))`,
    `CREATE TABLE IF NOT EXISTS thumb_click_marks (viewer_key TEXT NOT NULL, thumb_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(viewer_key, thumb_id, day))`,
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
  // 2026-09-24: 방송국 배너는 배너 영역을 가득 채우는 방식이 기본입니다. 기존 방송국도 한 번만 바꿔 둡니다
  // (PD가 이후 '원본 전체 보이기'를 다시 고르면 그대로 유지).
  if (!(await db.get("SELECT key FROM platform_settings WHERE key='migrated_banner_cover'"))) {
    await db.run("UPDATE channels SET banner_fit='cover'");
    await db.run("INSERT INTO platform_settings (key,value,updated_at) VALUES ('migrated_banner_cover','1',?) ON CONFLICT(key) DO NOTHING", [new Date().toISOString()]);
  }
  await ensureColumn(db, 'channels', 'overlay', 'INTEGER NOT NULL DEFAULT 45');
  await ensureColumn(db, 'channels', 'greeting', "TEXT NOT NULL DEFAULT ''");
  // 관리자가 숨긴 방송국은 PD가 공개 상태를 바꿀 수 없습니다.
  await ensureColumn(db, 'channels', 'admin_hidden', 'INTEGER NOT NULL DEFAULT 0');
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
  // 업로드 고도화: 권리·AI 자가 신고, 회차 출처와 자막, 소리 유무
  await ensureColumn(db, 'dramas', 'rights_confirmed', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'dramas', 'likeness_confirmed', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'dramas', 'ai_usage', "TEXT NOT NULL DEFAULT 'none'");
  await ensureColumn(db, 'dramas', 'declared_at', 'TEXT');
  await ensureColumn(db, 'episodes', 'source', "TEXT NOT NULL DEFAULT 'upload'");
  await ensureColumn(db, 'episodes', 'subtitles', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, 'episodes', 'studio_episode_id', 'TEXT');
  await ensureColumn(db, 'media_metadata', 'has_audio', 'INTEGER NOT NULL DEFAULT 1');
  // 스튜디오 결과 파일은 소유자만이 아니라 어느 프로젝트의 결과인지도 기록합니다.
  // 협업자는 같은 PD의 다른 비공개 프로젝트 파일까지 볼 수 없고, 참여한 프로젝트 파일만 볼 수 있어야 합니다.
  await ensureColumn(db, 'media_files', 'project_id', 'TEXT');
  // 공개 작품의 A/B 후보는 관리자가 확인한 이미지에만 노출 허용 표시를 남깁니다.
  await ensureColumn(db, 'drama_thumbnails', 'reviewed', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'user_profiles', 'studio_terms_at', 'TEXT');
  // 정산 수익을 라마로 전환한 지급은 method='lama'
  await ensureColumn(db, 'payouts', 'method', "TEXT NOT NULL DEFAULT 'bank'");
  await ensureColumn(db, 'payouts', 'lama', 'INTEGER NOT NULL DEFAULT 0');
  // 스튜디오 고도화: 빠른 제작, 중국 모델 제외, 목소리 미리듣기, 공급사 동시작업·월예산·장애 차단
  await ensureColumn(db, 'studio_projects', 'exclude_cn', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'studio_projects', 'autopilot', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, 'studio_characters', 'voice_sample', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, 'ai_providers', 'max_concurrency', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'ai_providers', 'monthly_budget_won', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'ai_providers', 'fail_streak', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'ai_providers', 'cooldown_until', 'TEXT');
  // 공급사 오류 원문(관리자 전용). PD 화면에는 정리된 문구(error)만 보여 줍니다.
  await ensureColumn(db, 'ai_jobs', 'error_detail', "TEXT NOT NULL DEFAULT ''");
  // ── AI 드라마 고도화(2026-09-23): 설정집·시즌 설계·장면 편집·소리·연재형 공개 ──
  const cols = [
    ['studio_projects', 'bible', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'season', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'source_text', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'subtitle_style', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'narrator_model', "TEXT NOT NULL DEFAULT 'auto'"],
    ['studio_projects', 'narrator_voice', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'bgm', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'bgm_volume', 'REAL NOT NULL DEFAULT 0.22'],
    ['studio_projects', 'trailer', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'trailer_status', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'meta', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'thumbs', "TEXT NOT NULL DEFAULT ''"],
    ['studio_projects', 'resolution', "TEXT NOT NULL DEFAULT '720p'"],
    // 프로젝트 예산(라마, 0 = 제한 없음): 넘는 작업은 확인을 받고, 자동 선택은 예산 안에서 고릅니다.
    ['studio_projects', 'budget_lama', 'INTEGER NOT NULL DEFAULT 0'],
    // 드라매직 벤치마킹 고도화(2026-09-25)
    ['studio_projects', 'script_text', "TEXT NOT NULL DEFAULT ''"], // 붙여 넣은 완성 대본(컷으로 나누기용)
    ['studio_projects', 'style_refs', "TEXT NOT NULL DEFAULT ''"], // 스타일 잠금 참고 이미지(JSON 배열)
    ['studio_projects', 'relations', "TEXT NOT NULL DEFAULT ''"], // 인물 관계(JSON 배열)
    ['studio_projects', 'approval_mode', "TEXT NOT NULL DEFAULT 'auto'"], // 협업 승인: auto(팀이 있으면 켜짐)·on·off
    ['studio_shots', 'prop_ids', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'states', "TEXT NOT NULL DEFAULT ''"], // 인물 상태(JSON {인물ID: '젖은 머리'})
    ['studio_shots', 'verify', "TEXT NOT NULL DEFAULT ''"], // AI 결과 검수(JSON)
    ['studio_shots', 'updated_at', 'TEXT'],
    ['studio_shots', 'updated_by', 'TEXT'],
    ['studio_shots', 'updated_session', 'TEXT'], // 같은 사람이라도 다른 기기 · 탭에서 고쳤는지 알기 위해(세션 해시 앞부분)
    // 힉스필드 벤치마킹 고도화(2026-09-29): 컷 연출(앵글·렌즈 느낌·움직임 강도) · 끝 장면 지정 · 화질 올리기 기록 · 효과
    ['studio_shots', 'angle', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'lens', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'move_strength', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'end_image', "TEXT NOT NULL DEFAULT ''"], // 영상이 끝날 장면(직접 고른 이미지). 비어 있으면 end_frame(다음 컷 이미지)을 따름
    ['studio_shots', 'upscaled', "TEXT NOT NULL DEFAULT ''"], // 화질 올린 결과(JSON {image:url, video:url}) — 지금 파일이 이미 올린 것인지 확인용
    ['studio_shots', 'effect', "TEXT NOT NULL DEFAULT ''"], // 합성 효과(회상·꿈결·긴장·충격 줌·심장 박동·흔들림·흑백)
    ['studio_assets', 'batch', "TEXT NOT NULL DEFAULT ''"], // 후보 묶음(같은 요청으로 만든 후보 여러 장)
    ['studio_assets', 'verify', "TEXT NOT NULL DEFAULT ''"], // 후보 AI 검수 결과(JSON)
    // 전체 점검 반영(2026-09-29): 합성하는 동안 컷이 바뀌었는지(1이면 합성본을 '완료'로 확정하지 않음)
    ['studio_episodes', 'compose_dirty', 'INTEGER NOT NULL DEFAULT 0'],
    // 2단계 연출(2026-09-30): 조명 · 시간과 색감 · 카메라 높이 · 조리개(f값) · 초점 거리(mm)
    ['studio_shots', 'light', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'tone', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'height', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'dof', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'focal', 'INTEGER NOT NULL DEFAULT 0'],
    // 3단계 일관성 고정(2026-09-30): 인물 헤어 · 체형 · 금지 요소 · 외형 고정, 장소 · 소품 고정
    ['studio_characters', 'hair', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'body', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'forbid', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'locked', 'INTEGER NOT NULL DEFAULT 0'],
    ['studio_locations', 'locked', 'INTEGER NOT NULL DEFAULT 0'],
    ['studio_locations', 'forbid', "TEXT NOT NULL DEFAULT ''"],
    ['studio_props', 'locked', 'INTEGER NOT NULL DEFAULT 0'],
    // 5단계(2026-09-30): 컷 영상 AI 검수 결과(JSON, 검수한 영상 주소 포함)
    ['studio_shots', 'video_verify', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'script_review', "TEXT NOT NULL DEFAULT ''"], // 승인: ''·requested·approved·changes
    ['studio_episodes', 'final_review', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'review_note', "TEXT NOT NULL DEFAULT ''"],
    ['ai_jobs', 'flags', "TEXT NOT NULL DEFAULT ''"], // 알림 표시(end_ignored: 고른 모델이 끝 장면 지정을 따르지 않음)
    ['ai_jobs', 'actor_id', 'TEXT'], // 작업을 누른 사람(협업: 라마를 낸 사람은 user_id)
    ['studio_episodes', 'hook', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'cliffhanger', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'bgm', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'bgm_volume', 'REAL NOT NULL DEFAULT -1'],
    ['studio_episodes', 'thumbnail', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'intro_card', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'outro_card', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'compose_progress', 'REAL NOT NULL DEFAULT 0'],
    ['studio_episodes', 'compose_error', "TEXT NOT NULL DEFAULT ''"],
    ['studio_episodes', 'compose_claimed_by', 'TEXT'],
    ['studio_episodes', 'compose_queued_at', 'TEXT'],
    ['studio_episodes', 'script_version', 'INTEGER NOT NULL DEFAULT 0'],
    ['studio_episodes', 'diagnosis', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'look_en', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'look_en_src', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'outfit', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'refs', "TEXT NOT NULL DEFAULT ''"],
    ['studio_characters', 'voice_style', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'visual_en', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'visual_en_src', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'cast_ids', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'location_id', 'TEXT'],
    ['studio_shots', 'camera_move', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'emotion', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'speed', 'REAL NOT NULL DEFAULT 1'],
    ['studio_shots', 'narration', 'INTEGER NOT NULL DEFAULT 0'],
    ['studio_shots', 'seed', 'INTEGER'],
    ['studio_shots', 'seed_lock', 'INTEGER NOT NULL DEFAULT 0'],
    ['studio_shots', 'end_frame', 'INTEGER NOT NULL DEFAULT 0'],
    ['studio_shots', 'lipsync', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'sfx', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'sfx_prompt', "TEXT NOT NULL DEFAULT ''"],
    ['studio_shots', 'sfx_volume', 'REAL NOT NULL DEFAULT 0.6'],
    ['studio_shots', 'transition', "TEXT NOT NULL DEFAULT 'cut'"],
    ['studio_shots', 'caption', 'TEXT'],
    // 연재형 공개: 회차 단위 검수·예약 공개
    ['episodes', 'review_status', "TEXT NOT NULL DEFAULT 'approved'"],
    ['episodes', 'review_note', "TEXT NOT NULL DEFAULT ''"],
    ['episodes', 'publish_at', 'TEXT'],
    ['episodes', 'thumbnail', "TEXT NOT NULL DEFAULT ''"],
    ['episodes', 'submitted_at', 'TEXT'],
    ['dramas', 'trailer', "TEXT NOT NULL DEFAULT ''"],
    ['dramas', 'hashtags', "TEXT NOT NULL DEFAULT ''"],
    ['dramas', 'subtitle_style', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [t, c, type] of cols) await ensureColumn(db, t, c, type);
  // 결과 확인 중 일시 오류가 연속으로 난 횟수(공급사 작업은 유지한 채 다시 확인합니다).
  await ensureColumn(db, 'ai_jobs', 'poll_failures', 'INTEGER NOT NULL DEFAULT 0');
  // 계정·운영 고도화(2026-09-29): 휴대폰 인증 시각 · 탈퇴 시각 · 구독 배분 인정 재생(진행률 기준 충족)
  await ensureColumn(db, 'users', 'phone_verified_at', 'TEXT');
  await ensureColumn(db, 'users', 'withdrawn_at', 'TEXT');
  // 이 칸이 생기기 전 기록은 그대로 인정(1)하고, 이후 재생은 진행률 보고로 기준을 넘길 때 1이 됩니다.
  await ensureColumn(db, 'subscription_views', 'qualified', 'INTEGER NOT NULL DEFAULT 1');
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
  // 라마 기본 충전 상품(웹 전용 · PD 스튜디오). 이후 구성은 관리자 라마 관리에서 바꿉니다.
  if (!(await db.get('SELECT id FROM lama_products LIMIT 1'))) {
    const stamp = new Date().toISOString();
    const defaults = [
      ['lama-10k', '1,000라마', 10000, 1000, 0, ''],
      ['lama-50k', '5,000라마', 50000, 5000, 250, '보너스'],
      ['lama-100k', '10,000라마', 100000, 10000, 700, '인기'],
      ['lama-300k', '30,000라마', 300000, 30000, 3000, '제작사 추천'],
    ];
    let order = 0;
    for (const [id, name, price, lama, bonus, badge] of defaults)
      await db.run(
        'INSERT INTO lama_products (id,name,price,lama,bonus_lama,badge,active,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?) ON CONFLICT DO NOTHING',
        [id, name, price, lama, bonus, badge, order++, stamp, stamp],
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
