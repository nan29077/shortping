import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { loadSettings, saveSettings, settingDefaults } from './settings.mjs';
import {
  balanceOf,
  closeSubscriptionPeriod,
  processPayout,
  refreshEntries,
  periodOf,
} from './settlement.mjs';
import { channelSelect } from './routes-studio.mjs';
import { channels as pingChannels, channelFeeRate, creditPings, debitPings, walletOf } from './pings.mjs';
import { appearanceFromSettings, homeThemes } from './home-appearance.mjs';
import { HOME_SECTIONS, layoutOf, layoutSchema, normalizeLayout, styleSchema } from './home-layout.mjs';

const memberSql = `SELECT u.id,u.email,u.name,u.role,u.status,u.created_at,u.last_login_at,u.phone,
  p.avatar,p.bio,
  (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.amount>0) AS order_count,
  (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.user_id=u.id) AS spend,
  (SELECT COALESCE(w.paid_balance,0) FROM ping_wallets w WHERE w.user_id=u.id) AS ping_paid,
  (SELECT COALESCE(w.bonus_balance,0) FROM ping_wallets w WHERE w.user_id=u.id) AS ping_bonus,
  (SELECT r.platform_fee_rate FROM pd_settlement_rates r WHERE r.user_id=u.id) AS custom_rate,
  (SELECT COUNT(*) FROM entitlements e WHERE e.user_id=u.id) AS owned,
  (SELECT COUNT(*) FROM favorites f WHERE f.user_id=u.id) AS favorites,
  (SELECT COUNT(*) FROM history h WHERE h.user_id=u.id) AS watched,
  (SELECT COUNT(*) FROM dramas d WHERE d.owner_id=u.id) AS drama_count,
  (SELECT COUNT(*) FROM support_tickets t WHERE t.user_id=u.id) AS tickets,
  (SELECT c.id FROM channels c WHERE c.owner_id=u.id) AS channel_id,
  (SELECT c.name FROM channels c WHERE c.owner_id=u.id) AS channel_name,
  (SELECT c.status FROM channels c WHERE c.owner_id=u.id) AS channel_status,
  (SELECT s.expires_at FROM subscriptions s WHERE s.user_id=u.id) AS subscription_expires,
  (SELECT COALESCE(SUM(se.net),0) FROM settlement_entries se WHERE se.pd_id=u.id AND se.status='available') AS settle_available,
  (SELECT COALESCE(SUM(se.net),0) FROM settlement_entries se WHERE se.pd_id=u.id AND se.status='paid') AS settle_paid
  FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id`;

export function adminRoutes({ app, db, fail, now, roles, catalogSql }) {
  const audit = (actorId, action, targetId) =>
    db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [
      randomUUID(),
      actorId,
      action,
      targetId,
      now(),
    ]);

  app.get('/api/admin/settlements', roles('admin'), async (req, res) => {
    await refreshEntries(db);
    const settings = await loadSettings(db);
    const month = z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional()
      .parse(req.query.month || undefined);
    const filter = month ? ' WHERE s.period=?' : '';
    const params = month ? [month] : [];
    res.json({
      settings,
      month: month || '',
      totals: await db.get(
        `SELECT COALESCE(SUM(s.gross),0) AS gross, COALESCE(SUM(s.platform_fee+s.pg_fee),0) AS fee, COALESCE(SUM(s.net),0) AS net,
         COALESCE(SUM(CASE WHEN s.status='pending' THEN s.net ELSE 0 END),0) AS pending,
         COALESCE(SUM(CASE WHEN s.status='available' THEN s.net ELSE 0 END),0) AS available,
         COALESCE(SUM(CASE WHEN s.status='requested' THEN s.net ELSE 0 END),0) AS requested,
         COALESCE(SUM(CASE WHEN s.status='paid' THEN s.net ELSE 0 END),0) AS paid
         FROM settlement_entries s` + filter,
        params,
      ),
      creators: await db.all(
        `SELECT u.id,u.name,u.email,u.status,
         COALESCE(t.business_type,'individual') AS business_type, COALESCE(t.verified,0) AS verified,
         COALESCE(SUM(s.gross),0) AS gross,
         COALESCE(SUM(s.platform_fee+s.pg_fee),0) AS fee,
         COALESCE(SUM(s.net),0) AS net,
         COALESCE(SUM(CASE WHEN s.status='pending' THEN s.net ELSE 0 END),0) AS pending,
         COALESCE(SUM(CASE WHEN s.status='available' THEN s.net ELSE 0 END),0) AS available,
         COALESCE(SUM(CASE WHEN s.status='requested' THEN s.net ELSE 0 END),0) AS requested,
         COALESCE(SUM(CASE WHEN s.status='paid' THEN s.net ELSE 0 END),0) AS paid
         FROM users u LEFT JOIN settlement_entries s ON s.pd_id=u.id${month ? ' AND s.period=?' : ''}
         LEFT JOIN pd_tax_profiles t ON t.user_id=u.id
         WHERE u.role IN ('pd','admin')
         GROUP BY u.id,u.name,u.email,u.status,t.business_type,t.verified
         ORDER BY net DESC`,
        params,
      ),
      entries: await db.all(
        `SELECT s.*, d.title AS drama_title, u.name AS pd_name FROM settlement_entries s
         LEFT JOIN dramas d ON d.id=s.drama_id JOIN users u ON u.id=s.pd_id` +
          filter +
          ' ORDER BY s.created_at DESC LIMIT 400',
        params,
      ),
      // 목록은 최근 200건이지만, 누적 통계는 전체 기준으로 따로 계산합니다(라마 전환은 은행 지급과 분리).
      payoutStats: await db.get(
        `SELECT COALESCE(SUM(CASE WHEN status='paid' AND method<>'lama' THEN payable ELSE 0 END),0) AS paid_bank,
         COALESCE(SUM(CASE WHEN status='paid' AND method='lama' THEN payable ELSE 0 END),0) AS paid_lama,
         COALESCE(SUM(CASE WHEN status IN ('requested','approved') THEN payable ELSE 0 END),0) AS waiting,
         COUNT(*) AS count FROM payouts`,
      ),
      payouts: await db.all(
        `SELECT p.*, u.name AS pd_name, u.email AS pd_email FROM payouts p JOIN users u ON u.id=p.pd_id ORDER BY
         CASE p.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, p.requested_at DESC LIMIT 200`,
      ),
      closed: await db.all(
        "SELECT period, COUNT(*) AS creators, SUM(gross) AS gross FROM settlement_entries WHERE kind='subscription' GROUP BY period ORDER BY period DESC LIMIT 12",
      ),
    });
  });
  app.post('/api/admin/settlements/close', roles('admin'), async (req, res) => {
    const b = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.body);
    const settings = await loadSettings(db);
    // 앞 달 구독 매출이 남아 있는데 마감하지 않았다면 순서대로 마감하도록 안내합니다.
    const earlier = await db.get(
      `SELECT MIN(v.period) AS period FROM subscription_views v
       WHERE v.period < ? AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action='settlement:closed' AND a.target_id=v.period)`,
      [b.period],
    );
    if (earlier?.period)
      fail(409, `${earlier.period} 구독 정산이 아직 마감되지 않았어요. 앞 달부터 순서대로 마감해 주세요.`);
    // 배분 항목·시청 표시·감사 기록을 한 트랜잭션으로 묶어 중간에 실패해도 절반만 남지 않게 합니다.
    res.json(await db.transaction(() => closeSubscriptionPeriod(db, b.period, settings, req.user.id)));
  });
  app.post('/api/admin/payouts/:id', roles('admin'), async (req, res) => {
    const b = z
      .object({
        action: z.enum(['approved', 'paid', 'rejected']),
        memo: z.string().trim().max(500).default(''),
      })
      .parse(req.body);
    res.json(
      await processPayout(db, {
        payoutId: req.params.id,
        action: b.action,
        actorId: req.user.id,
        memo: b.memo,
      }),
    );
  });
  app.get('/api/admin/tax', roles('admin'), async (req, res) => {
    // 한국 시간 기준 연도. 지급명세는 실제 지급일(processed_at) 기준으로 모읍니다.
    const kstYear = String(new Date(Date.now() + 9 * 3600000).getUTCFullYear());
    const year = z
      .string()
      .regex(/^\d{4}$/)
      .parse(req.query.year || kstYear);
    const yStart = new Date(Date.UTC(Number(year), 0, 1) - 9 * 3600000).toISOString();
    const yEnd = new Date(Date.UTC(Number(year) + 1, 0, 1) - 9 * 3600000).toISOString();
    res.json({
      year,
      creators: await db.all(
        `SELECT u.id,u.name,u.email,
         COALESCE(t.business_type,'individual') AS business_type, COALESCE(t.verified,0) AS verified,
         COALESCE(t.business_no,'') AS business_no, COALESCE(t.business_name,'') AS business_name,
         COALESCE(t.rep_name,'') AS rep_name, COALESCE(t.business_class,'') AS business_class,
         COALESCE(t.business_item,'') AS business_item, COALESCE(t.tax_email,'') AS tax_email,
         COALESCE(t.bank_name,'') AS bank_name, COALESCE(t.account_number,'') AS account_number,
         COALESCE(t.account_holder,'') AS account_holder, COALESCE(t.verified_note,'') AS verified_note,
         t.updated_at
         FROM users u LEFT JOIN pd_tax_profiles t ON t.user_id=u.id
         WHERE u.role IN ('pd','admin') ORDER BY u.created_at DESC`,
      ),
      paid: await db.all(
        `SELECT pd_id, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(vat),0) AS vat,
         COALESCE(SUM(income_tax),0) AS income_tax, COALESCE(SUM(local_tax),0) AS local_tax,
         COALESCE(SUM(payable),0) AS payable
         FROM payouts WHERE status='paid' AND processed_at>=? AND processed_at<? GROUP BY pd_id`,
        [yStart, yEnd],
      ),
    });
  });
  app.patch('/api/admin/tax/:id', roles('admin'), async (req, res) => {
    const b = z
      .object({
        business_type: z.enum(['individual', 'business']),
        verified: z.boolean(),
        verified_note: z.string().trim().max(300).default(''),
      })
      .parse(req.body);
    if (!(await db.get('SELECT id FROM users WHERE id=?', [req.params.id])))
      fail(404, '회원을 찾을 수 없습니다.');
    await db.run(
      'INSERT INTO pd_tax_profiles (user_id,updated_at) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING',
      [req.params.id, now()],
    );
    await db.run(
      'UPDATE pd_tax_profiles SET business_type=?,verified=?,verified_note=?,updated_at=? WHERE user_id=?',
      [b.business_type, b.verified ? 1 : 0, b.verified_note, now(), req.params.id],
    );
    await audit(
      req.user.id,
      `tax:${b.business_type}:${b.verified ? 'verified' : 'pending'}`,
      req.params.id,
    );
    res.json({ ok: true });
  });

  app.get('/api/admin/settings', roles('admin'), async (req, res) =>
    res.json({ settings: await loadSettings(db), defaults: settingDefaults }),
  );
  // 부분 저장을 허용합니다. 화면마다 자기 항목만 보내도 나머지 값은 그대로 유지됩니다.
  app.put('/api/admin/settings', roles('admin'), async (req, res) => {
    const b = z
      .object({
        subscription_price: z.number().int().min(0).max(1000000),
        subscription_days: z.number().int().min(1).max(365),
        default_free_episodes: z.number().int().min(1).max(50),
        ping_unit_won: z.number().int().min(1).max(10000),
        default_episode_pings: z.number().int().min(1).max(1000),
        title_unlock_discount: z.number().min(0).max(90),
        platform_fee_rate: z.number().min(0).max(90),
        pg_fee_rate: z.number().min(0).max(20),
        app_store_fee_rate: z.number().min(0).max(50),
        google_play_fee_rate: z.number().min(0).max(50),
        settle_hold_days: z.number().int().min(0).max(90),
        payout_min: z.number().int().min(0).max(10000000),
        withholding_rate: z.number().min(0).max(30),
        vat_rate: z.number().min(0).max(30),
        payout_notice: z.string().trim().max(300),
        ai_enabled: z.number().int().min(0).max(1),
        usd_krw_rate: z.number().min(100).max(10000),
        ai_margin_rate: z.number().min(100).max(1000),
        ai_monthly_budget_won: z.number().int().min(0).max(10000000000),
        ai_daily_limit_lama: z.number().int().min(0).max(100000000),
        ai_concurrency: z.number().int().min(1).max(20),
        lama_signup_bonus: z.number().int().min(0).max(100000),
        lama_convert_min: z.number().int().min(0).max(100000000),
        lama_convert_bonus_rate: z.number().min(0).max(50),
        ai_blocked_terms: z.string().max(5000),
        ai_allow_cn: z.number().int().min(0).max(1),
        ai_breaker_failures: z.number().int().min(1).max(100),
        ai_breaker_cooldown_min: z.number().int().min(1).max(1440),
        ai_weight_cost: z.number().int().min(0).max(100),
        ai_weight_speed: z.number().int().min(0).max(100),
        ai_weight_reliability: z.number().int().min(0).max(100),
        ai_assistant_enabled: z.number().int().min(0).max(1),
        ai_assistant_daily_limit: z.number().int().min(0).max(10000),
        studio_upload_enabled: z.number().int().min(0).max(1),
        studio_upload_image_mb: z.number().int().min(1).max(50),
        studio_upload_video_mb: z.number().int().min(1).max(500),
        studio_upload_video_seconds: z.number().int().min(3).max(300),
        studio_upload_audio_mb: z.number().int().min(1).max(100),
        studio_upload_audio_seconds: z.number().int().min(3).max(600),
        // 0 = 자동 정리 끔. 켤 때는 실수로 너무 짧게 잡지 않도록 최소 7일.
        media_retention_days: z
          .number()
          .int()
          .min(0)
          .max(3650)
          .refine((v) => v === 0 || v >= 7, '보관 기간은 0(끔) 또는 7일 이상으로 입력해 주세요.'),
      })
      .partial()
      .parse(req.body);
    if (!Object.keys(b).length) fail(400, '변경할 항목이 없습니다.');
    const merged = { ...(await loadSettings(db)), ...b };
    if (merged.platform_fee_rate + merged.pg_fee_rate > 100)
      fail(400, '플랫폼 수수료와 결제 수수료의 합은 100%를 넘을 수 없습니다.');
    const settings = await saveSettings(db, b, req.user.id);
    await audit(req.user.id, 'settings:updated:' + Object.keys(b).join(','), 'platform');
    res.json({ settings });
  });

  // ── 포인트(핑) 관리 ────────────────────────────────────────────────
  app.get('/api/admin/pings', roles('admin'), async (req, res) => {
    const settings = await loadSettings(db);
    const num = (row, key) => Number(row?.[key] || 0);
    const issued = await db.get(
      "SELECT COALESCE(SUM(CASE WHEN paid_delta>0 THEN paid_delta ELSE 0 END),0) AS paid, COALESCE(SUM(CASE WHEN bonus_delta>0 THEN bonus_delta ELSE 0 END),0) AS bonus, COALESCE(SUM(CASE WHEN type='spend' THEN -(paid_delta+bonus_delta) ELSE 0 END),0) AS spent, COALESCE(SUM(CASE WHEN type='revoke' THEN -(paid_delta+bonus_delta) ELSE 0 END),0) AS revoked FROM ping_ledger",
    );
    const outstanding = await db.get(
      'SELECT COALESCE(SUM(paid_left),0) AS paid, COALESCE(SUM(bonus_left),0) AS bonus, COALESCE(SUM((paid_left+bonus_left)*unit_milli),0) AS value_milli FROM ping_lots',
    );
    res.json({
      settings,
      summary: {
        issued_paid: num(issued, 'paid'),
        issued_bonus: num(issued, 'bonus'),
        spent: num(issued, 'spent'),
        revoked: num(issued, 'revoked'),
        outstanding_paid: num(outstanding, 'paid'),
        outstanding_bonus: num(outstanding, 'bonus'),
        // 아직 쓰이지 않은 핑이 앞으로 PD 정산으로 넘어갈 수 있는 최대 금액(원)
        liability: Math.floor(num(outstanding, 'value_milli') / 1000),
      },
      charges: await db.all(
        "SELECT channel, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(channel_fee),0) AS channel_fee, COALESCE(SUM(pings),0) AS pings, COALESCE(SUM(bonus_pings),0) AS bonus FROM orders WHERE kind='ping_charge' GROUP BY channel",
      ),
      sales: await db.get(
        "SELECT COUNT(*) AS count, COALESCE(SUM(gross),0) AS gross, COALESCE(SUM(platform_fee),0) AS platform_fee, COALESCE(SUM(net),0) AS net FROM settlement_entries WHERE kind='ping'",
      ),
      products: await db.all('SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.product_id=p.id) AS sold FROM ping_products p ORDER BY p.channel, p.sort_order, p.price'),
      rates: await db.all(
        `SELECT u.id,u.name,u.email,u.role, r.platform_fee_rate, r.updated_at
         FROM users u LEFT JOIN pd_settlement_rates r ON r.user_id=u.id
         WHERE u.role IN ('pd','admin') ORDER BY (r.platform_fee_rate IS NULL), u.name`,
      ),
      ledger: await db.all(
        `SELECT l.*, u.name AS user_name, u.email AS user_email, d.title, a.name AS actor_name
         FROM ping_ledger l JOIN users u ON u.id=l.user_id LEFT JOIN dramas d ON d.id=l.drama_id
         LEFT JOIN users a ON a.id=l.actor_id ORDER BY l.created_at DESC LIMIT 200`,
      ),
      channels: pingChannels.map((id) => ({ id, fee_rate: channelFeeRate(id, settings) })),
    });
  });
  const productSchema = z.object({
    channel: z.enum(pingChannels),
    name: z.string().trim().min(1).max(40),
    price: z.number().int().min(100).max(10000000),
    pings: z.number().int().min(1).max(1000000),
    bonus_pings: z.number().int().min(0).max(1000000).default(0),
    badge: z.string().trim().max(12).default(''),
    active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(999).default(0),
  });
  app.post('/api/admin/pings/products', roles('admin'), async (req, res) => {
    const b = productSchema.parse(req.body);
    const id = randomUUID();
    const stamp = now();
    await db.run(
      'INSERT INTO ping_products (id,channel,name,price,pings,bonus_pings,badge,active,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, b.channel, b.name, b.price, b.pings, b.bonus_pings, b.badge, b.active ? 1 : 0, b.sort_order, stamp, stamp],
    );
    await audit(req.user.id, `ping-product:created:${b.channel}`, id);
    res.status(201).json({ id });
  });
  // 가격·핑 수를 바꿔도 이미 충전된 핑의 정산 단가는 충전 당시 값 그대로 유지됩니다.
  app.patch('/api/admin/pings/products/:id', roles('admin'), async (req, res) => {
    const b = productSchema.parse(req.body);
    if (!(await db.get('SELECT id FROM ping_products WHERE id=?', [req.params.id])))
      fail(404, '충전 상품을 찾을 수 없습니다.');
    await db.run(
      'UPDATE ping_products SET channel=?,name=?,price=?,pings=?,bonus_pings=?,badge=?,active=?,sort_order=?,updated_at=? WHERE id=?',
      [b.channel, b.name, b.price, b.pings, b.bonus_pings, b.badge, b.active ? 1 : 0, b.sort_order, now(), req.params.id],
    );
    await audit(req.user.id, `ping-product:updated:${b.active ? 'active' : 'inactive'}`, req.params.id);
    res.json({ ok: true });
  });
  // 판매 이력이 있는 상품은 주문 기록을 지키기 위해 삭제 대신 판매 중지합니다.
  app.delete('/api/admin/pings/products/:id', roles('admin'), async (req, res) => {
    if (!(await db.get('SELECT id FROM ping_products WHERE id=?', [req.params.id])))
      fail(404, '충전 상품을 찾을 수 없습니다.');
    const sold = await db.get('SELECT id FROM orders WHERE product_id=? LIMIT 1', [req.params.id]);
    if (sold) {
      await db.run('UPDATE ping_products SET active=0,updated_at=? WHERE id=?', [now(), req.params.id]);
      await audit(req.user.id, 'ping-product:deactivated', req.params.id);
      return res.json({ ok: true, deactivated: true });
    }
    await db.run('DELETE FROM ping_products WHERE id=?', [req.params.id]);
    await audit(req.user.id, 'ping-product:deleted', req.params.id);
    res.json({ ok: true, deleted: true });
  });
  // 관리자 지급(보상·이벤트)과 회수. 지급 핑은 무상(보너스) 핑으로 쌓이고, 사용되면 기준가로 PD에 정산됩니다.
  app.post('/api/admin/pings/adjust', roles('admin'), async (req, res) => {
    const b = z
      .object({
        userId: z.string().min(1).max(80),
        action: z.enum(['grant', 'revoke']),
        pings: z.number().int().min(1).max(100000),
        memo: z.string().trim().min(2, '사유를 입력해 주세요.').max(200),
      })
      .parse(req.body);
    if (!(await db.get('SELECT id FROM users WHERE id=?', [b.userId])))
      fail(404, '회원을 찾을 수 없습니다.');
    const settings = await loadSettings(db);
    const result = await db.transaction(async () => {
      const done =
        b.action === 'grant'
          ? await creditPings(db, {
              userId: b.userId,
              type: 'grant',
              source: 'grant',
              channel: 'admin',
              bonus: b.pings,
              unitMilli: settings.ping_unit_won * 1000,
              memo: b.memo,
              actorId: req.user.id,
            })
          : await debitPings(db, {
              userId: b.userId,
              pings: b.pings,
              type: 'revoke',
              memo: b.memo,
              actorId: req.user.id,
            });
      await audit(req.user.id, `pings:${b.action}:${b.pings}`, b.userId);
      return done;
    });
    res.json({ wallet: result.wallet });
  });
  // PD별 분배 비율. rate가 null이면 공통 비율로 되돌립니다. 이미 기록된 정산에는 소급하지 않습니다.
  app.put('/api/admin/pings/rates/:id', roles('admin'), async (req, res) => {
    const b = z.object({ platform_fee_rate: z.number().min(0).max(100).nullable() }).parse(req.body);
    const user = await db.get('SELECT id,role FROM users WHERE id=?', [req.params.id]);
    if (!user) fail(404, '회원을 찾을 수 없습니다.');
    if (b.platform_fee_rate === null)
      await db.run('DELETE FROM pd_settlement_rates WHERE user_id=?', [user.id]);
    else
      await db.run(
        'INSERT INTO pd_settlement_rates (user_id,platform_fee_rate,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET platform_fee_rate=excluded.platform_fee_rate,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
        [user.id, b.platform_fee_rate, now(), req.user.id],
      );
    await audit(req.user.id, `pd-rate:${b.platform_fee_rate ?? 'default'}`, user.id);
    res.json({ ok: true });
  });

  // ── 메인페이지 관리 ─────────────────────────────────────────
  // 변경할 때마다 적용 직후 상태를 기록해 두고(최근 30개), 기록에서 되돌릴 수 있게 합니다.
  const recordHome = async (kind, data, actorId) => {
    await db.run('INSERT INTO home_history (id,kind,data,actor_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), kind, JSON.stringify(data), actorId, now()]);
    const old = await db.all('SELECT id FROM home_history ORDER BY created_at DESC LIMIT 1000 OFFSET 30');
    for (const r of old) await db.run('DELETE FROM home_history WHERE id=?', [r.id]);
  };
  // 관리자가 올린(또는 관리자 계정이 가진) 이미지만 배경으로 쓸 수 있습니다.
  const checkImage = async (url) => {
    if (!url || !url.startsWith('/uploads/')) return;
    const f = await db.get('SELECT m.owner_id, u.role FROM media_files m LEFT JOIN users u ON u.id=m.owner_id WHERE m.url=?', [url]);
    if (!f || f.role !== 'admin') fail(403, '관리자 화면에서 올린 이미지만 배경으로 쓸 수 있어요.');
  };
  const appearanceSchema = z.object({
    theme: z.enum(homeThemes.map((theme) => theme.id)),
    eyebrow: z.string().trim().min(2).max(60),
    headline: z.string().trim().min(2).max(40),
    highlight: z.string().trim().min(2).max(40),
    description: z.string().trim().min(2).max(160),
    caption: z.string().trim().min(2).max(80),
    copyright: z.string().trim().min(2).max(60),
    style: styleSchema.optional(),
  });
  async function applyAppearance(b, actorId) {
    if (b.style) await checkImage(b.style.image);
    const settings = await saveSettings(
      db,
      {
        home_theme: b.theme,
        home_eyebrow: b.eyebrow,
        home_headline: b.headline,
        home_highlight: b.highlight,
        home_description: b.description,
        home_caption: b.caption,
        home_copyright: b.copyright,
        ...(b.style ? { home_style: JSON.stringify(b.style) } : {}),
      },
      actorId,
    );
    const appearance = appearanceFromSettings(settings);
    await recordHome('appearance', { theme: appearance.theme, eyebrow: appearance.eyebrow, headline: appearance.headline, highlight: appearance.highlight, description: appearance.description, caption: appearance.caption, copyright: appearance.copyright, style: appearance.style }, actorId);
    return appearance;
  }
  async function applyLayout(value, actorId) {
    const iso = (v) => (v ? new Date(v).toISOString() : '');
    const layout = normalizeLayout({ ...value, notice: { ...value.notice, start: iso(value.notice.start), end: iso(value.notice.end) } });
    if (layout.notice.start && layout.notice.end && layout.notice.start >= layout.notice.end) fail(400, '공지 띠 종료 시각은 시작 시각보다 뒤여야 해요.');
    const settings = await saveSettings(db, { home_layout: JSON.stringify(layout) }, actorId);
    const saved = layoutOf(settings.home_layout);
    await recordHome('layout', saved, actorId);
    return saved;
  }
  app.get('/api/admin/home-appearance', roles('admin'), async (req, res) => {
    const settings = await loadSettings(db);
    res.json({ appearance: appearanceFromSettings(settings), themes: homeThemes, layout: layoutOf(settings.home_layout), sections: HOME_SECTIONS });
  });
  app.put('/api/admin/home-appearance', roles('admin'), async (req, res) => {
    const b = appearanceSchema.parse(req.body);
    const appearance = await applyAppearance(b, req.user.id);
    await audit(req.user.id, 'home-appearance:updated', b.theme);
    res.json({ appearance });
  });
  app.put('/api/admin/home-layout', roles('admin'), async (req, res) => {
    const layout = await applyLayout(layoutSchema.parse(req.body), req.user.id);
    await audit(req.user.id, 'home-layout:updated', 'home');
    res.json({ layout });
  });
  app.get('/api/admin/home-history', roles('admin'), async (req, res) => {
    const rows = await db.all('SELECT h.id,h.kind,h.data,h.created_at,u.name AS actor_name FROM home_history h LEFT JOIN users u ON u.id=h.actor_id ORDER BY h.created_at DESC LIMIT 30');
    res.json(rows.map((r) => ({ ...r, data: JSON.parse(r.data) })));
  });
  app.post('/api/admin/home-history/:id/restore', roles('admin'), async (req, res) => {
    const row = await db.get('SELECT * FROM home_history WHERE id=?', [req.params.id]);
    if (!row) fail(404, '기록을 찾을 수 없어요.');
    const data = JSON.parse(row.data);
    if (row.kind === 'appearance') {
      const appearance = await applyAppearance(appearanceSchema.parse(data), req.user.id);
      await audit(req.user.id, 'home-appearance:restored', row.id);
      return res.json({ appearance });
    }
    const layout = await applyLayout(layoutSchema.parse(data), req.user.id);
    await audit(req.user.id, 'home-layout:restored', row.id);
    res.json({ layout });
  });

  app.get('/api/admin/members', roles('admin'), async (req, res) => {
    const role = z
      .enum(['all', 'viewer', 'pd', 'admin'])
      .default('all')
      .parse(req.query.role || 'all');
    const status = z
      .enum(['all', 'active', 'suspended', 'withdrawn'])
      .default('all')
      .parse(req.query.status || 'all');
    const where = [];
    const params = [];
    if (role !== 'all') {
      where.push('u.role=?');
      params.push(role);
    }
    if (status !== 'all') {
      where.push('u.status=?');
      params.push(status);
    }
    const rows = await db.all(
      memberSql +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY u.created_at DESC',
      params,
    );
    res.json({
      members: rows,
      counts: await db.all(
        'SELECT role, status, COUNT(*) AS count FROM users GROUP BY role,status',
      ),
    });
  });
  app.get('/api/admin/members/:id', roles('admin'), async (req, res) => {
    const member = await db.get(memberSql + ' WHERE u.id=?', [req.params.id]);
    if (!member) fail(404, '회원을 찾을 수 없습니다.');
    const id = member.id;
    res.json({
      member,
      orders: await db.all(
        'SELECT o.*, d.title FROM orders o LEFT JOIN dramas d ON d.id=o.drama_id WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 100',
        [id],
      ),
      entitlements: await db.all(
        'SELECT e.drama_id, d.title, d.image FROM entitlements e JOIN dramas d ON d.id=e.drama_id WHERE e.user_id=?',
        [id],
      ),
      history: await db.all(
        'SELECT h.*, d.title FROM history h JOIN dramas d ON d.id=h.drama_id WHERE h.user_id=? ORDER BY h.updated_at DESC LIMIT 30',
        [id],
      ),
      dramas: await db.all(catalogSql + ' WHERE d.owner_id=? ORDER BY d.created_at DESC', [id]),
      channel: await db.get(channelSelect + ' WHERE c.owner_id=?', [id]),
      tickets: await db.all(
        'SELECT id,category,title,status,created_at FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 30',
        [id],
      ),
      notes: await db.all(
        'SELECT n.*, u.name AS actor_name FROM member_notes n JOIN users u ON u.id=n.actor_id WHERE n.user_id=? ORDER BY n.created_at DESC',
        [id],
      ),
      sessions: Number(
        (
          await db.get('SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND expires_at>?', [
            id,
            now(),
          ])
        )?.count || 0,
      ),
      settlement: member.role === 'viewer' ? null : await balanceOf(db, id),
      payouts: await db.all(
        'SELECT * FROM payouts WHERE pd_id=? ORDER BY requested_at DESC LIMIT 20',
        [id],
      ),
      tax: await db.get('SELECT * FROM pd_tax_profiles WHERE user_id=?', [id]),
      wallet: await walletOf(db, id),
      pingLedger: await db.all(
        'SELECT l.*, d.title FROM ping_ledger l LEFT JOIN dramas d ON d.id=l.drama_id WHERE l.user_id=? ORDER BY l.created_at DESC LIMIT 50',
        [id],
      ),
    });
  });
  app.patch('/api/admin/members/:id', roles('admin'), async (req, res) => {
    const b = z
      .object({
        role: z.enum(['viewer', 'pd', 'admin']),
        status: z.enum(['active', 'suspended', 'withdrawn']),
        name: z.string().trim().min(2).max(30),
        phone: z
          .string()
          .trim()
          .max(20)
          .regex(/^[0-9-]*$/, '연락처는 숫자와 하이픈만 입력해 주세요.')
          .default(''),
      })
      .parse(req.body);
    if (req.params.id === req.user.id || req.params.id === 'demo-admin')
      fail(400, '현재 관리자 계정은 변경할 수 없어요.');
    if (!(await db.get('SELECT id FROM users WHERE id=?', [req.params.id])))
      fail(404, '회원을 찾을 수 없습니다.');
    await db.transaction(async () => {
      await db.run('UPDATE users SET role=?,status=?,name=?,phone=? WHERE id=?', [
        b.role,
        b.status,
        b.name,
        b.phone,
        req.params.id,
      ]);
      if (b.status !== 'active')
        await db.run('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
      await audit(req.user.id, `user:${b.role}:${b.status}`, req.params.id);
    });
    res.json({ ok: true });
  });
  app.post('/api/admin/members/:id/notes', roles('admin'), async (req, res) => {
    const b = z.object({ note: z.string().trim().min(1).max(1000) }).parse(req.body);
    if (!(await db.get('SELECT id FROM users WHERE id=?', [req.params.id])))
      fail(404, '회원을 찾을 수 없습니다.');
    await db.run(
      'INSERT INTO member_notes (id,user_id,actor_id,note,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), req.params.id, req.user.id, b.note, now()],
    );
    res.status(201).json({ ok: true });
  });
  app.post('/api/admin/members/:id/logout', roles('admin'), async (req, res) => {
    if (!(await db.get('SELECT id FROM users WHERE id=?', [req.params.id])))
      fail(404, '회원을 찾을 수 없습니다.');
    await db.run('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
    await audit(req.user.id, 'user:sessions-cleared', req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/admin/channels', roles('admin'), async (req, res) =>
    res.json(await db.all(channelSelect + ' ORDER BY c.featured DESC, c.created_at DESC')),
  );
  app.patch('/api/admin/channels/:id', roles('admin'), async (req, res) => {
    const b = z
      .object({
        status: z.enum(['draft', 'active', 'hidden']),
        featured: z.boolean(),
        featured_order: z.number().int().min(0).max(99).default(0),
      })
      .parse(req.body);
    if (!(await db.get('SELECT id FROM channels WHERE id=?', [req.params.id])))
      fail(404, '방송국을 찾을 수 없습니다.');
    await db.run('UPDATE channels SET status=?,featured=?,featured_order=?,admin_hidden=? WHERE id=?', [
      b.status,
      b.featured ? 1 : 0,
      b.featured_order,
      b.status === 'hidden' ? 1 : 0,
      req.params.id,
    ]);
    await audit(req.user.id, `channel:${b.status}${b.featured ? ':featured' : ''}`, req.params.id);
    res.json({ ok: true });
  });
  // Pricing and visibility stay editable after publication; the story files do not.
  app.patch('/api/admin/dramas/:id/pricing', roles('admin'), async (req, res) => {
    const b = z
      .object({
        free: z.boolean().default(false),
        episode_pings: z.number().int().min(0).max(1000).default(0),
        free_episodes: z.number().int().min(1).max(50),
        badge: z.enum(['NEW', 'HOT', '독점', '완결', '추천']),
        status: z.enum(['published', 'hidden']),
      })
      .parse(req.body);
    const drama = await db.get('SELECT * FROM dramas WHERE id=?', [req.params.id]);
    if (!drama) fail(404, '작품을 찾을 수 없습니다.');
    if (!['published', 'hidden'].includes(drama.status))
      fail(409, '공개된 작품의 판매 설정만 변경할 수 있어요.');
    await db.run(
      'UPDATE dramas SET free=?,episode_pings=?,free_episodes=?,badge=?,status=? WHERE id=?',
      [b.free ? 1 : 0, b.episode_pings, b.free_episodes, b.badge, b.status, drama.id],
    );
    await audit(req.user.id, `drama:pricing:${b.status}`, drama.id);
    res.json({ ok: true });
  });
  return { periodOf };
}
