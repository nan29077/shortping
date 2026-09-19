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
import { appearanceFromSettings, homeThemes } from './home-appearance.mjs';

const memberSql = `SELECT u.id,u.email,u.name,u.role,u.status,u.created_at,u.last_login_at,u.phone,
  p.avatar,p.bio,
  (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) AS order_count,
  (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.user_id=u.id) AS spend,
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
      .regex(/^\d{4}-\d{2}$/)
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
         FROM users u LEFT JOIN settlement_entries s ON s.pd_id=u.id
         LEFT JOIN pd_tax_profiles t ON t.user_id=u.id
         WHERE u.role IN ('pd','admin')
         GROUP BY u.id,u.name,u.email,u.status,t.business_type,t.verified
         ORDER BY net DESC`,
      ),
      entries: await db.all(
        `SELECT s.*, d.title AS drama_title, u.name AS pd_name FROM settlement_entries s
         LEFT JOIN dramas d ON d.id=s.drama_id JOIN users u ON u.id=s.pd_id` +
          filter +
          ' ORDER BY s.created_at DESC LIMIT 400',
        params,
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
    const b = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
    const settings = await loadSettings(db);
    res.json(await closeSubscriptionPeriod(db, b.period, settings, req.user.id));
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
    const year = z
      .string()
      .regex(/^\d{4}$/)
      .default(String(new Date().getFullYear()))
      .parse(req.query.year || String(new Date().getFullYear()));
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
         FROM payouts WHERE status='paid' AND requested_at>=? AND requested_at<? GROUP BY pd_id`,
        [`${year}-01-01T00:00:00.000Z`, `${Number(year) + 1}-01-01T00:00:00.000Z`],
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
  app.put('/api/admin/settings', roles('admin'), async (req, res) => {
    const b = z
      .object({
        subscription_price: z.number().int().min(0).max(1000000),
        subscription_days: z.number().int().min(1).max(365),
        default_drama_price: z.number().int().min(0).max(1000000),
        default_free_episodes: z.number().int().min(1).max(50),
        platform_fee_rate: z.number().min(0).max(90),
        pg_fee_rate: z.number().min(0).max(20),
        settle_hold_days: z.number().int().min(0).max(90),
        payout_min: z.number().int().min(0).max(10000000),
        withholding_rate: z.number().min(0).max(30),
        vat_rate: z.number().min(0).max(30),
        payout_notice: z.string().trim().max(300),
      })
      .parse(req.body);
    const settings = await saveSettings(db, b, req.user.id);
    await audit(req.user.id, 'settings:updated', 'platform');
    res.json({ settings });
  });

  app.get('/api/admin/home-appearance', roles('admin'), async (req, res) => {
    const settings = await loadSettings(db);
    res.json({ appearance: appearanceFromSettings(settings), themes: homeThemes });
  });
  app.put('/api/admin/home-appearance', roles('admin'), async (req, res) => {
    const b = z
      .object({
        theme: z.enum(homeThemes.map((theme) => theme.id)),
        eyebrow: z.string().trim().min(2).max(60),
        headline: z.string().trim().min(2).max(40),
        highlight: z.string().trim().min(2).max(40),
        description: z.string().trim().min(2).max(160),
        caption: z.string().trim().min(2).max(80),
        copyright: z.string().trim().min(2).max(60),
      })
      .parse(req.body);
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
      },
      req.user.id,
    );
    await audit(req.user.id, 'home-appearance:updated', b.theme);
    res.json({ appearance: appearanceFromSettings(settings) });
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
    await db.run('UPDATE channels SET status=?,featured=?,featured_order=? WHERE id=?', [
      b.status,
      b.featured ? 1 : 0,
      b.featured_order,
      req.params.id,
    ]);
    await audit(req.user.id, `channel:${b.status}${b.featured ? ':featured' : ''}`, req.params.id);
    res.json({ ok: true });
  });
  // Pricing and visibility stay editable after publication; the story files do not.
  app.patch('/api/admin/dramas/:id/pricing', roles('admin'), async (req, res) => {
    const b = z
      .object({
        price: z.number().int().min(0).max(1000000),
        free_episodes: z.number().int().min(1).max(50),
        badge: z.enum(['NEW', 'HOT', '독점', '완결', '추천']),
        status: z.enum(['published', 'hidden']),
      })
      .parse(req.body);
    const drama = await db.get('SELECT * FROM dramas WHERE id=?', [req.params.id]);
    if (!drama) fail(404, '작품을 찾을 수 없습니다.');
    if (!['published', 'hidden'].includes(drama.status))
      fail(409, '공개된 작품의 판매 설정만 변경할 수 있어요.');
    await db.run('UPDATE dramas SET price=?,free_episodes=?,badge=?,status=? WHERE id=?', [
      b.price,
      b.free_episodes,
      b.badge,
      b.status,
      drama.id,
    ]);
    await audit(req.user.id, `drama:pricing:${b.status}`, drama.id);
    res.json({ ok: true });
  });
  return { periodOf };
}
