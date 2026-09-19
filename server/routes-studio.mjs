import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { loadSettings } from './settings.mjs';
import {
  balanceOf,
  breakdown,
  refreshEntries,
  requestPayout,
  taxFor,
  periodOf,
} from './settlement.mjs';

const imageField = z
  .string()
  .regex(/^(|\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp)))$/);
export const channelSelect = `SELECT c.*, u.name AS owner_name, p.avatar AS owner_avatar, p.bio AS owner_bio,
  (SELECT COUNT(*) FROM dramas d WHERE d.channel_id=c.id AND d.status='published') AS drama_count,
  (SELECT COALESCE(SUM(d.views),0) FROM dramas d WHERE d.channel_id=c.id AND d.status='published') AS views,
  (SELECT COUNT(*) FROM channel_follows f WHERE f.channel_id=c.id) AS followers
  FROM channels c JOIN users u ON u.id=c.owner_id LEFT JOIN user_profiles p ON p.user_id=c.owner_id`;

// 방송국 = a PD's own broadcasting station: one per uploader, with its own banner,
// shelves (categories) and public page. Viewers browse and follow stations directly.
export function studioRoutes({ app, db, fail, now, roles, requireAuth, checkMedia, catalogSql }) {
  const myChannel = (id) => db.get('SELECT * FROM channels WHERE owner_id=?', [id]);
  const categoriesOf = (channelId) =>
    db.all('SELECT * FROM channel_categories WHERE channel_id=? ORDER BY sort_order,name', [
      channelId,
    ]);

  app.get('/api/channels', async (req, res) => {
    const rows = await db.all(
      channelSelect +
        " WHERE c.status='active' ORDER BY c.featured DESC, c.featured_order ASC, views DESC",
    );
    for (const row of rows)
      row.posters = (
        await db.all(
          "SELECT image FROM dramas WHERE channel_id=? AND status='published' ORDER BY views DESC LIMIT 3",
          [row.id],
        )
      ).map((d) => d.image);
    res.json(rows);
  });
  app.get('/api/channels/:id', async (req, res) => {
    const channel = await db.get(channelSelect + ' WHERE c.id=? OR c.slug=?', [
      req.params.id,
      req.params.id,
    ]);
    const owner = channel && (req.user?.role === 'admin' || req.user?.id === channel.owner_id);
    if (!channel || (channel.status !== 'active' && !owner))
      fail(404, '방송국을 찾을 수 없습니다.');
    res.json({
      ...channel,
      categories: await categoriesOf(channel.id),
      dramas: await db.all(
        catalogSql +
          " WHERE d.channel_id=? AND d.status='published' ORDER BY d.created_at DESC, d.views DESC",
        [channel.id],
      ),
      following: req.user
        ? !!(await db.get('SELECT user_id FROM channel_follows WHERE user_id=? AND channel_id=?', [
            req.user.id,
            channel.id,
          ]))
        : false,
    });
  });
  app.post('/api/channels/:id/follow', requireAuth, async (req, res) => {
    const channel = await db.get("SELECT id FROM channels WHERE id=? AND status='active'", [
      req.params.id,
    ]);
    if (!channel) fail(404, '방송국을 찾을 수 없습니다.');
    const active = z.boolean().parse(req.body.active);
    if (active)
      await db.run(
        'INSERT INTO channel_follows (user_id,channel_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
        [req.user.id, channel.id, now()],
      );
    else
      await db.run('DELETE FROM channel_follows WHERE user_id=? AND channel_id=?', [
        req.user.id,
        channel.id,
      ]);
    res.json({ ok: true });
  });

  app.get('/api/studio/channel', roles('pd', 'admin'), async (req, res) => {
    const channel = await myChannel(req.user.id);
    if (!channel) return res.json({ channel: null, categories: [], dramas: [] });
    const detail = await db.get(channelSelect + ' WHERE c.id=?', [channel.id]);
    res.json({
      channel: detail,
      categories: await categoriesOf(channel.id),
      dramas: await db.all(catalogSql + ' WHERE d.owner_id=? ORDER BY d.created_at DESC', [
        req.user.id,
      ]),
    });
  });
  app.put('/api/studio/channel', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({
        name: z.string().trim().min(2).max(40),
        slug: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9-]{1,29}$/, '영문 소문자, 숫자, 하이픈 2~30자로 입력해 주세요.'),
        tagline: z.string().trim().max(80).default(''),
        description: z.string().trim().max(1500).default(''),
        banner: imageField.default(''),
        logo: imageField.default(''),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c4f562'),
        status: z.enum(['draft', 'active', 'hidden']).default('draft'),
      })
      .parse(req.body);
    if (b.banner) await checkMedia(req, b.banner);
    if (b.logo) await checkMedia(req, b.logo);
    const taken = await db.get('SELECT owner_id FROM channels WHERE slug=?', [b.slug]);
    if (taken && taken.owner_id !== req.user.id) fail(409, '이미 사용 중인 방송국 주소입니다.');
    const existing = await myChannel(req.user.id);
    if (existing)
      await db.run(
        'UPDATE channels SET name=?,slug=?,tagline=?,description=?,banner=?,logo=?,accent=?,status=? WHERE id=?',
        [b.name, b.slug, b.tagline, b.description, b.banner, b.logo, b.accent, b.status, existing.id],
      );
    else {
      const id = randomUUID();
      await db.run(
        'INSERT INTO channels (id,owner_id,name,slug,tagline,description,banner,logo,accent,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          req.user.id,
          b.name,
          b.slug,
          b.tagline,
          b.description,
          b.banner,
          b.logo,
          b.accent,
          b.status,
          now(),
        ],
      );
      await db.run('UPDATE dramas SET channel_id=? WHERE owner_id=? AND channel_id IS NULL', [
        id,
        req.user.id,
      ]);
    }
    res.json({ ok: true });
  });
  app.post('/api/studio/channel/categories', roles('pd', 'admin'), async (req, res) => {
    const channel = await myChannel(req.user.id);
    if (!channel) fail(400, '방송국을 먼저 개설해 주세요.');
    const b = z.object({ name: z.string().trim().min(1).max(20) }).parse(req.body);
    const list = await categoriesOf(channel.id);
    if (list.length >= 12) fail(400, '카테고리는 최대 12개까지 만들 수 있어요.');
    if (list.some((c) => c.name === b.name)) fail(409, '이미 있는 카테고리입니다.');
    await db.run(
      'INSERT INTO channel_categories (id,channel_id,name,sort_order) VALUES (?,?,?,?)',
      [randomUUID(), channel.id, b.name, list.length],
    );
    res.status(201).json({ ok: true });
  });
  app.delete('/api/studio/channel/categories/:id', roles('pd', 'admin'), async (req, res) => {
    const channel = await myChannel(req.user.id);
    const category = await db.get('SELECT * FROM channel_categories WHERE id=?', [req.params.id]);
    if (!category || !channel || category.channel_id !== channel.id)
      fail(404, '카테고리를 찾을 수 없습니다.');
    await db.transaction(async () => {
      await db.run('UPDATE dramas SET category_id=NULL WHERE category_id=?', [category.id]);
      await db.run('DELETE FROM channel_categories WHERE id=?', [category.id]);
    });
    res.json({ ok: true });
  });
  // Shelving a title inside the station is display-only, so it stays available while published.
  app.patch('/api/studio/dramas/:id/category', roles('pd', 'admin'), async (req, res) => {
    const drama = await db.get('SELECT * FROM dramas WHERE id=?', [req.params.id]);
    if (!drama) fail(404, '작품을 찾을 수 없습니다.');
    if (req.user.role !== 'admin' && drama.owner_id !== req.user.id)
      fail(403, '본인 작품만 수정할 수 있습니다.');
    const b = z.object({ category_id: z.string().nullable() }).parse(req.body);
    const channel = await myChannel(drama.owner_id);
    if (!channel) fail(400, '방송국을 먼저 개설해 주세요.');
    if (b.category_id) {
      const category = await db.get(
        'SELECT id FROM channel_categories WHERE id=? AND channel_id=?',
        [b.category_id, channel.id],
      );
      if (!category) fail(404, '카테고리를 찾을 수 없습니다.');
    }
    await db.run('UPDATE dramas SET channel_id=?,category_id=? WHERE id=?', [
      channel.id,
      b.category_id,
      drama.id,
    ]);
    res.json({ ok: true });
  });

  const taxProfile = async (id) => {
    await db.run(
      'INSERT INTO pd_tax_profiles (user_id,updated_at) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING',
      [id, now()],
    );
    return db.get('SELECT * FROM pd_tax_profiles WHERE user_id=?', [id]);
  };
  app.get('/api/studio/settlement', roles('pd', 'admin'), async (req, res) => {
    const settings = await loadSettings(db);
    await refreshEntries(db);
    const pdId = req.user.id;
    const entries = await db.all(
      'SELECT s.*, d.title AS drama_title FROM settlement_entries s LEFT JOIN dramas d ON d.id=s.drama_id WHERE s.pd_id=? ORDER BY s.created_at DESC LIMIT 400',
      [pdId],
    );
    res.json({
      balance: await balanceOf(db, pdId),
      entries,
      payouts: await db.all(
        'SELECT * FROM payouts WHERE pd_id=? ORDER BY requested_at DESC LIMIT 100',
        [pdId],
      ),
      profile: await taxProfile(pdId),
      settings: {
        platform_fee_rate: settings.platform_fee_rate,
        pg_fee_rate: settings.pg_fee_rate,
        settle_hold_days: settings.settle_hold_days,
        payout_min: settings.payout_min,
        withholding_rate: settings.withholding_rate,
        vat_rate: settings.vat_rate,
        payout_notice: settings.payout_notice,
      },
    });
  });
  app.put('/api/studio/tax', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({
        business_type: z.enum(['individual', 'business']),
        business_no: z.string().trim().max(20).default(''),
        business_name: z.string().trim().max(60).default(''),
        rep_name: z.string().trim().max(30).default(''),
        business_class: z.string().trim().max(40).default(''),
        business_item: z.string().trim().max(40).default(''),
        tax_email: z.union([z.literal(''), z.email().max(254)]).default(''),
        bank_name: z.string().trim().max(30).default(''),
        account_number: z
          .string()
          .trim()
          .max(30)
          .regex(/^[0-9-]*$/, '계좌번호는 숫자와 하이픈만 입력해 주세요.')
          .default(''),
        account_holder: z.string().trim().max(30).default(''),
        contact: z.string().trim().max(30).default(''),
        address: z.string().trim().max(120).default(''),
      })
      .parse(req.body);
    if (b.business_type === 'business' && !/^\d{3}-?\d{2}-?\d{5}$/.test(b.business_no))
      fail(400, '사업자등록번호 10자리를 정확히 입력해 주세요.');
    await taxProfile(req.user.id);
    await db.run(
      'UPDATE pd_tax_profiles SET business_type=?,business_no=?,business_name=?,rep_name=?,business_class=?,business_item=?,tax_email=?,bank_name=?,account_number=?,account_holder=?,contact=?,address=?,verified=0,updated_at=? WHERE user_id=?',
      [
        b.business_type,
        b.business_no,
        b.business_name,
        b.rep_name,
        b.business_class,
        b.business_item,
        b.tax_email,
        b.bank_name,
        b.account_number,
        b.account_holder,
        b.contact,
        b.address,
        now(),
        req.user.id,
      ],
    );
    res.json({ ok: true });
  });
  app.post('/api/studio/payouts', roles('pd', 'admin'), async (req, res) => {
    const settings = await loadSettings(db);
    const profile = await taxProfile(req.user.id);
    const result = await requestPayout(db, { pdId: req.user.id, profile, settings });
    await db.run(
      'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), req.user.id, 'payout:requested', result.id, now()],
    );
    res.status(201).json(result);
  });
  app.get('/api/studio/payouts/:id', roles('pd', 'admin'), async (req, res) => {
    const payout = await db.get('SELECT * FROM payouts WHERE id=?', [req.params.id]);
    if (!payout || (payout.pd_id !== req.user.id && req.user.role !== 'admin'))
      fail(404, '출금 요청을 찾을 수 없습니다.');
    res.json({
      ...payout,
      entries: await db.all(
        'SELECT s.*, d.title AS drama_title FROM settlement_entries s LEFT JOIN dramas d ON d.id=s.drama_id WHERE s.payout_id=? ORDER BY s.created_at',
        [payout.id],
      ),
    });
  });
  return { taxProfile, breakdown, taxFor, periodOf };
}
