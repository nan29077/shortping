import { randomUUID } from 'node:crypto';

// Settlement ledger. One entry per confirmed sale, plus one monthly entry per PD for
// the shared subscription pool. Money is stored as whole KRW integers only.
const error = (status, message) => Object.assign(new Error(message), { status });
const iso = () => new Date().toISOString();
export const periodOf = (value) => String(value).slice(0, 7);
export function periodRange(period) {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  return [start.toISOString(), end.toISOString()];
}
export function breakdown(amount, settings) {
  const platformFee = Math.round((amount * settings.platform_fee_rate) / 100);
  const pgFee = Math.round((amount * settings.pg_fee_rate) / 100);
  return { gross: amount, platformFee, pgFee, net: Math.max(0, amount - platformFee - pgFee) };
}
// Individual sellers are withheld 3.3% (3% income + 0.3% local). Registered businesses
// issue a tax invoice instead and receive VAT on top of the settled amount.
export function taxFor(amount, profile, settings) {
  if (profile?.business_type === 'business') {
    const vat = Math.round((amount * settings.vat_rate) / 100);
    return { vat, incomeTax: 0, localTax: 0, payable: amount + vat, businessType: 'business' };
  }
  const incomeTax = Math.floor((amount * (settings.withholding_rate - 0.3)) / 100);
  const localTax = Math.floor(incomeTax * 0.1);
  return {
    vat: 0,
    incomeTax,
    localTax,
    payable: amount - incomeTax - localTax,
    businessType: 'individual',
  };
}
export async function recordSale(db, { order, drama, settings }) {
  if (!drama || order.kind !== 'drama' || order.amount <= 0) return null;
  const { gross, platformFee, pgFee, net } = breakdown(order.amount, settings);
  const confirmAt = new Date(
    new Date(order.created_at).getTime() + settings.settle_hold_days * 86400000,
  ).toISOString();
  await db.run(
    'INSERT INTO settlement_entries (id,pd_id,order_id,drama_id,kind,period,gross,platform_fee,pg_fee,net,fee_rate,status,confirm_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    [
      randomUUID(),
      drama.owner_id,
      order.id,
      drama.id,
      'drama',
      periodOf(order.created_at),
      gross,
      platformFee,
      pgFee,
      net,
      settings.platform_fee_rate,
      'pending',
      confirmAt,
      order.created_at,
    ],
  );
  return { net, confirmAt };
}
export async function refreshEntries(db) {
  await db.run("UPDATE settlement_entries SET status='available' WHERE status='pending' AND confirm_at<=?", [
    iso(),
  ]);
}
export async function balanceOf(db, pdId) {
  const rows = await db.all(
    'SELECT status, SUM(net) AS total, COUNT(*) AS count FROM settlement_entries WHERE pd_id=? GROUP BY status',
    [pdId],
  );
  const sum = (status) => Number(rows.find((r) => r.status === status)?.total || 0);
  return {
    pending: sum('pending'),
    available: sum('available'),
    requested: sum('requested'),
    paid: sum('paid'),
    gross: Number(
      (await db.get('SELECT SUM(gross) AS total FROM settlement_entries WHERE pd_id=?', [pdId]))
        ?.total || 0,
    ),
    fee: Number(
      (
        await db.get(
          'SELECT SUM(platform_fee + pg_fee) AS total FROM settlement_entries WHERE pd_id=?',
          [pdId],
        )
      )?.total || 0,
    ),
  };
}
// Subscription revenue is shared monthly in proportion to episodes watched, the same
// pooled model streaming services use. Closing a period twice changes nothing.
export async function closeSubscriptionPeriod(db, period, settings, actorId) {
  const [start, end] = periodRange(period);
  if (new Date(end).getTime() > Date.now())
    throw error(400, '아직 종료되지 않은 월은 마감할 수 없습니다.');
  const pool = Number(
    (
      await db.get(
        "SELECT SUM(amount) AS total FROM orders WHERE kind='subscription' AND created_at>=? AND created_at<?",
        [start, end],
      )
    )?.total || 0,
  );
  const weights = await db.all(
    'SELECT d.owner_id AS pd_id, SUM(h.episode) AS weight FROM history h JOIN dramas d ON d.id=h.drama_id WHERE h.updated_at>=? AND h.updated_at<? GROUP BY d.owner_id',
    [start, end],
  );
  const total = weights.reduce((n, w) => n + Number(w.weight), 0);
  if (!pool || !total) return { period, pool, shares: [], reason: pool ? '시청 기록 없음' : '구독 매출 없음' };
  const stamp = iso();
  const shares = [];
  for (const row of weights) {
    const gross = Math.floor((pool * Number(row.weight)) / total);
    if (gross <= 0) continue;
    const { platformFee, pgFee, net } = breakdown(gross, settings);
    await db.run(
      'INSERT INTO settlement_entries (id,pd_id,order_id,drama_id,kind,period,gross,platform_fee,pg_fee,net,fee_rate,status,confirm_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      [
        `sub-${period}-${row.pd_id}`,
        row.pd_id,
        null,
        null,
        'subscription',
        period,
        gross,
        platformFee,
        pgFee,
        net,
        settings.platform_fee_rate,
        'available',
        stamp,
        stamp,
      ],
    );
    shares.push({ pd_id: row.pd_id, weight: Number(row.weight), gross, net });
  }
  await db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [
    randomUUID(),
    actorId,
    'settlement:closed',
    period,
    stamp,
  ]);
  return { period, pool, shares };
}
export async function requestPayout(db, { pdId, profile, settings }) {
  if (!profile?.account_number || !profile?.bank_name || !profile?.account_holder)
    throw error(400, '출금 계좌를 먼저 등록해 주세요.');
  if (profile.business_type === 'business' && !profile.business_no)
    throw error(400, '사업자등록번호를 먼저 등록해 주세요.');
  return db.transaction(async () => {
    await refreshEntries(db);
    const rows = await db.all(
      "SELECT id,net FROM settlement_entries WHERE pd_id=? AND status='available'",
      [pdId],
    );
    const amount = rows.reduce((n, r) => n + Number(r.net), 0);
    if (!rows.length || amount <= 0) throw error(400, '출금 가능한 정산 금액이 없습니다.');
    if (amount < settings.payout_min)
      throw error(400, `최소 출금 금액은 ${settings.payout_min.toLocaleString('ko-KR')}원입니다.`);
    const tax = taxFor(amount, profile, settings);
    const id = randomUUID();
    await db.run(
      'INSERT INTO payouts (id,pd_id,amount,vat,income_tax,local_tax,payable,business_type,bank_name,account_number,account_holder,status,requested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        pdId,
        amount,
        tax.vat,
        tax.incomeTax,
        tax.localTax,
        tax.payable,
        tax.businessType,
        profile.bank_name,
        profile.account_number,
        profile.account_holder,
        'requested',
        iso(),
      ],
    );
    await db.run(
      `UPDATE settlement_entries SET status='requested', payout_id=? WHERE id IN (${rows.map(() => '?').join(',')})`,
      [id, ...rows.map((r) => r.id)],
    );
    return { id, amount, ...tax };
  });
}
export async function processPayout(db, { payoutId, action, actorId, memo = '' }) {
  return db.transaction(async () => {
    const payout = await db.get('SELECT * FROM payouts WHERE id=?', [payoutId]);
    if (!payout) throw error(404, '출금 요청을 찾을 수 없습니다.');
    if (['paid', 'rejected'].includes(payout.status))
      throw error(409, '이미 처리된 출금 요청입니다.');
    if (action === 'rejected' && !memo.trim()) throw error(400, '반려 사유를 입력해 주세요.');
    const stamp = iso();
    await db.run(
      'UPDATE payouts SET status=?,memo=?,processed_at=?,processed_by=? WHERE id=?',
      [action, memo, action === 'approved' ? null : stamp, actorId, payoutId],
    );
    if (action === 'paid')
      await db.run("UPDATE settlement_entries SET status='paid' WHERE payout_id=?", [payoutId]);
    if (action === 'rejected')
      await db.run(
        "UPDATE settlement_entries SET status='available', payout_id=NULL WHERE payout_id=?",
        [payoutId],
      );
    await db.run(
      'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), actorId, `payout:${action}`, payoutId, stamp],
    );
    return { ok: true };
  });
}
export async function backfillEntries(db, settings) {
  const orders = await db.all(
    "SELECT o.*, d.owner_id FROM orders o JOIN dramas d ON d.id=o.drama_id WHERE o.kind='drama' AND NOT EXISTS (SELECT 1 FROM settlement_entries s WHERE s.order_id=o.id)",
  );
  for (const order of orders)
    await recordSale(db, {
      order,
      drama: { id: order.drama_id, owner_id: order.owner_id },
      settings,
    });
  await refreshEntries(db);
  return orders.length;
}
