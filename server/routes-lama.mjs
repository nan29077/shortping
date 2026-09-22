import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { loadSettings } from './settings.mjs';
import { LAMA_WON, creditLama, debitLama, lamaWalletOf } from './lama.mjs';
import { balanceOf, convertToLama, refreshEntries } from './settlement.mjs';

// 라마(제작 포인트) API. PD 스튜디오 전용(웹)이며, 원화 충전·정산 수익 전환·관리자 지급/회수를 다룹니다.
export function lamaRoutes({ app, db, fail, now, roles, demo }) {
  const audit = (actorId, action, targetId) =>
    db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), actorId, action, targetId, now()]);
  // PD가 처음 스튜디오 지갑을 열면 체험 라마를 한 번 드립니다.
  async function welcome(userId, settings) {
    const bonus = Number(settings.lama_signup_bonus || 0);
    if (bonus <= 0) return;
    await db.transaction(async () => {
      if (await db.get("SELECT id FROM lama_ledger WHERE user_id=? AND type='welcome' LIMIT 1", [userId])) return;
      await creditLama(db, { userId, type: 'welcome', bonus, memo: '숏핑 스튜디오 체험 라마' });
    });
  }
  const taxProfile = (id) => db.get('SELECT * FROM pd_tax_profiles WHERE user_id=?', [id]);

  app.get('/api/lama', roles('pd', 'admin'), async (req, res) => {
    const settings = await loadSettings(db);
    await welcome(req.user.id, settings);
    await refreshEntries(db);
    const balance = await balanceOf(db, req.user.id);
    res.json({
      wallet: await lamaWalletOf(db, req.user.id),
      products: await db.all('SELECT id,name,price,lama,bonus_lama,badge FROM lama_products WHERE active=1 ORDER BY sort_order, price'),
      ledger: await db.all(
        'SELECT l.id,l.type,l.paid_delta,l.bonus_delta,l.held_delta,l.paid_after,l.bonus_after,l.held_after,l.memo,l.created_at,l.job_id FROM lama_ledger l WHERE l.user_id=? ORDER BY l.created_at DESC LIMIT 150',
        [req.user.id],
      ),
      policy: {
        unit_won: LAMA_WON,
        convert_min: settings.lama_convert_min,
        convert_bonus_rate: settings.lama_convert_bonus_rate,
        withholding_rate: settings.withholding_rate,
        vat_rate: settings.vat_rate,
        daily_limit: settings.ai_daily_limit_lama,
      },
      convertible: balance.available,
      demo,
    });
  });
  app.post('/api/lama/charge', roles('pd', 'admin'), async (req, res) => {
    if (!demo) fail(503, '결제 서비스 연동 준비 중입니다.');
    const b = z.object({ productId: z.string().min(1).max(80), idempotencyKey: z.string().uuid() }).parse(req.body);
    const settings = await loadSettings(db);
    const result = await db.transaction(async () => {
      const existing = await db.get('SELECT * FROM orders WHERE idempotency_key=?', [b.idempotencyKey]);
      if (existing) {
        if (existing.user_id !== req.user.id || existing.kind !== 'lama_charge') fail(409, '중복 요청입니다.');
        return { id: existing.id, amount: existing.amount, wallet: await lamaWalletOf(db, req.user.id) };
      }
      const product = await db.get('SELECT * FROM lama_products WHERE id=? AND active=1', [b.productId]);
      if (!product) fail(404, '충전 상품을 찾을 수 없습니다.');
      const id = randomUUID();
      await db.run(
        'INSERT INTO orders (id,user_id,drama_id,kind,amount,status,idempotency_key,created_at,channel,channel_fee,pings,bonus_pings,product_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, req.user.id, null, 'lama_charge', product.price, 'test_paid', b.idempotencyKey, now(), 'web', Math.round((product.price * settings.pg_fee_rate) / 100), product.lama, product.bonus_lama, product.id],
      );
      const wallet = await creditLama(db, { userId: req.user.id, type: 'charge', paid: product.lama, bonus: product.bonus_lama, orderId: id, memo: product.name });
      return { id, amount: product.price, lama: product.lama, bonus: product.bonus_lama, wallet };
    });
    res.json(result);
  });
  // 정산 수익(출금 가능 전액)을 라마로 바꿉니다. 세금 규칙은 출금과 같습니다.
  app.post('/api/lama/convert', roles('pd', 'admin'), async (req, res) => {
    const settings = await loadSettings(db);
    const profile = await taxProfile(req.user.id);
    const result = await convertToLama(db, {
      pdId: req.user.id,
      profile,
      settings,
      credit: ({ payoutId, paid, bonus }) =>
        creditLama(db, { userId: req.user.id, type: 'convert', paid, bonus, payoutId, memo: '정산 수익 전환' }),
    });
    res.status(201).json(result);
  });

  // ── 관리자 ──────────────────────────────────────────
  app.get('/api/admin/lama', roles('admin'), async (req, res) => {
    const num = (r, k) => Number(r?.[k] || 0);
    const wallets = await db.get('SELECT COALESCE(SUM(paid_balance),0) AS paid, COALESCE(SUM(bonus_balance),0) AS bonus, COALESCE(SUM(held_paid+held_bonus),0) AS held FROM lama_wallets');
    const flows = await db.all("SELECT type, COALESCE(SUM(paid_delta),0) AS paid, COALESCE(SUM(bonus_delta),0) AS bonus, COUNT(*) AS count FROM lama_ledger GROUP BY type");
    const charges = await db.get("SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(channel_fee),0) AS fee FROM orders WHERE kind='lama_charge'");
    const conversions = await db.get("SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(lama),0) AS lama FROM payouts WHERE method='lama'");
    const ai = await db.get("SELECT COALESCE(SUM(charged_lama),0) AS lama, COALESCE(SUM(cost_won),0) AS cost FROM ai_jobs WHERE status='succeeded'");
    res.json({
      summary: {
        outstanding_paid: num(wallets, 'paid'),
        outstanding_bonus: num(wallets, 'bonus'),
        held: num(wallets, 'held'),
        charge_count: num(charges, 'count'),
        charge_amount: num(charges, 'amount'),
        charge_fee: num(charges, 'fee'),
        convert_count: num(conversions, 'count'),
        convert_amount: num(conversions, 'amount'),
        convert_lama: num(conversions, 'lama'),
        spent_lama: num(ai, 'lama'),
        spent_won: num(ai, 'lama') * LAMA_WON,
        ai_cost_won: num(ai, 'cost'),
      },
      flows,
      products: await db.all('SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.product_id=p.id) AS sold FROM lama_products p ORDER BY p.sort_order, p.price'),
      wallets: await db.all(
        "SELECT u.id,u.name,u.email,u.role,COALESCE(w.paid_balance,0) AS paid,COALESCE(w.bonus_balance,0) AS bonus,COALESCE(w.held_paid+w.held_bonus,0) AS held FROM users u LEFT JOIN lama_wallets w ON w.user_id=u.id WHERE u.role IN ('pd','admin') ORDER BY COALESCE(w.paid_balance,0)+COALESCE(w.bonus_balance,0) DESC, u.name",
      ),
      ledger: await db.all(
        'SELECT l.*, u.name AS user_name, u.email AS user_email, a.name AS actor_name FROM lama_ledger l JOIN users u ON u.id=l.user_id LEFT JOIN users a ON a.id=l.actor_id ORDER BY l.created_at DESC LIMIT 200',
      ),
    });
  });
  const productSchema = z.object({
    name: z.string().trim().min(1).max(40),
    price: z.number().int().min(1000).max(100000000),
    lama: z.number().int().min(1).max(10000000),
    bonus_lama: z.number().int().min(0).max(10000000).default(0),
    badge: z.string().trim().max(12).default(''),
    active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(999).default(0),
  });
  app.post('/api/admin/lama/products', roles('admin'), async (req, res) => {
    const b = productSchema.parse(req.body);
    const id = randomUUID();
    await db.run(
      'INSERT INTO lama_products (id,name,price,lama,bonus_lama,badge,active,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, b.name, b.price, b.lama, b.bonus_lama, b.badge, b.active ? 1 : 0, b.sort_order, now(), now()],
    );
    await audit(req.user.id, 'lama-product:created', id);
    res.status(201).json({ id });
  });
  app.patch('/api/admin/lama/products/:id', roles('admin'), async (req, res) => {
    const b = productSchema.parse(req.body);
    if (!(await db.get('SELECT id FROM lama_products WHERE id=?', [req.params.id]))) fail(404, '충전 상품을 찾을 수 없습니다.');
    await db.run('UPDATE lama_products SET name=?,price=?,lama=?,bonus_lama=?,badge=?,active=?,sort_order=?,updated_at=? WHERE id=?', [
      b.name, b.price, b.lama, b.bonus_lama, b.badge, b.active ? 1 : 0, b.sort_order, now(), req.params.id,
    ]);
    await audit(req.user.id, 'lama-product:updated', req.params.id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/lama/products/:id', roles('admin'), async (req, res) => {
    if (!(await db.get('SELECT id FROM lama_products WHERE id=?', [req.params.id]))) fail(404, '충전 상품을 찾을 수 없습니다.');
    if (await db.get('SELECT id FROM orders WHERE product_id=? LIMIT 1', [req.params.id])) {
      await db.run('UPDATE lama_products SET active=0,updated_at=? WHERE id=?', [now(), req.params.id]);
      return res.json({ ok: true, deactivated: true });
    }
    await db.run('DELETE FROM lama_products WHERE id=?', [req.params.id]);
    await audit(req.user.id, 'lama-product:deleted', req.params.id);
    res.json({ ok: true, deleted: true });
  });
  app.post('/api/admin/lama/adjust', roles('admin'), async (req, res) => {
    const b = z
      .object({
        userId: z.string().min(1).max(80),
        action: z.enum(['grant', 'revoke']),
        lama: z.number().int().min(1).max(10000000),
        memo: z.string().trim().min(2, '사유를 입력해 주세요.').max(200),
      })
      .parse(req.body);
    const user = await db.get('SELECT id,role FROM users WHERE id=?', [b.userId]);
    if (!user) fail(404, '회원을 찾을 수 없습니다.');
    const wallet = await db.transaction(async () => {
      const w =
        b.action === 'grant'
          ? await creditLama(db, { userId: b.userId, type: 'grant', bonus: b.lama, memo: b.memo, actorId: req.user.id })
          : await debitLama(db, { userId: b.userId, amount: b.lama, type: 'revoke', memo: b.memo, actorId: req.user.id });
      await audit(req.user.id, `lama:${b.action}:${b.lama}`, b.userId);
      return w;
    });
    res.json({ wallet });
  });
}
