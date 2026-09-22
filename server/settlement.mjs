import { randomUUID } from 'node:crypto';

// Settlement ledger. One entry per confirmed sale, plus one monthly entry per PD for
// the shared subscription pool. Money is stored as whole KRW integers only.
const error = (status, message) => Object.assign(new Error(message), { status });
const iso = () => new Date().toISOString();
// 정산 월은 한국 시간(UTC+9) 기준입니다. 저장은 UTC ISO 문자열이지만 월 경계는 KST로 끊어야
// PD 화면의 달력(브라우저 로컬 시간)과 관리자 월별 집계가 어긋나지 않습니다.
const KST_OFFSET = 9 * 3600000;
export const periodOf = (value) =>
  new Date(new Date(value).getTime() + KST_OFFSET).toISOString().slice(0, 7);
export function periodRange(period) {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - KST_OFFSET);
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - KST_OFFSET);
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
  // 총 공제율 r% = 소득세 i% + 지방소득세 0.1i% 이므로 i = r / 1.1 입니다.
  // 기본값 3.3%에서는 소득세 3%·지방소득세 0.3%로 기존 계산과 동일합니다.
  const incomeTax = Math.floor((amount * settings.withholding_rate) / 110);
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
  if (!drama || !['drama', 'episode'].includes(order.kind) || order.amount <= 0) return null;
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
      order.kind,
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
// PD별 분배율: 개별 설정이 있으면 그 값을, 없으면 공통 플랫폼 몫을 씁니다.
export async function platformRateFor(db, pdId, settings) {
  const row = await db.get('SELECT platform_fee_rate FROM pd_settlement_rates WHERE user_id=?', [
    pdId,
  ]);
  return row ? Number(row.platform_fee_rate) : settings.platform_fee_rate;
}
// 이미 채널 수수료를 뺀 순매출을 분배율로만 나눕니다.
export function splitByRate(gross, rate) {
  const platformFee = Math.round((gross * rate) / 100);
  return { gross, platformFee, pgFee: 0, net: gross - platformFee };
}
// 핑 사용 매출. 주문과 같은 트랜잭션에서 기록해 매출과 정산이 어긋나지 않게 합니다.
export async function recordPingSale(db, { order, drama, gross, rate, settings }) {
  if (gross <= 0) return null;
  const { platformFee, net } = splitByRate(gross, rate);
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
      'ping',
      periodOf(order.created_at),
      gross,
      platformFee,
      0,
      net,
      rate,
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
        "SELECT SUM(amount - channel_fee) AS total FROM orders WHERE kind='subscription' AND created_at>=? AND created_at<?",
        [start, end],
      )
    )?.total || 0,
  );
  // 시청 기록은 (회원, 작품)당 한 줄에 "가장 최근에 연 회차"만 남습니다. 그대로 합산하면 지난달에
  // 이미 정산한 회차가 이번 달에 또 잡히므로, 마지막 정산 시점을 표시해 두고 늘어난 만큼만 셉니다.
  const rows = await db.all(
    `SELECT h.user_id, h.drama_id, h.episode, d.owner_id AS pd_id, COALESCE(m.episode,0) AS settled
     FROM history h JOIN dramas d ON d.id=h.drama_id
     LEFT JOIN settlement_watch_marks m ON m.user_id=h.user_id AND m.drama_id=h.drama_id
     WHERE h.updated_at<?`,
    [end],
  );
  const counted = rows
    .map((r) => ({ ...r, weight: Math.max(0, Number(r.episode) - Number(r.settled)) }))
    .filter((r) => r.weight > 0);
  const weights = new Map();
  for (const row of counted)
    weights.set(row.pd_id, (weights.get(row.pd_id) || 0) + row.weight);
  const total = [...weights.values()].reduce((n, w) => n + w, 0);
  if (!pool || !total)
    return { period, pool, shares: [], reason: pool ? '시청 기록 없음' : '구독 매출 없음' };
  const stamp = iso();
  const ordered = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const amounts = ordered.map(([, weight]) => Math.floor((pool * weight) / total));
  // 절사로 남은 금액은 가장 많이 시청된 방송국에 더해 풀 전액이 빠짐없이 배분되게 합니다.
  amounts[0] += pool - amounts.reduce((n, a) => n + a, 0);
  const shares = [];
  for (let i = 0; i < ordered.length; i++) {
    const [pdId, weight] = ordered[i];
    const gross = amounts[i];
    if (gross <= 0) continue;
    const rate = await platformRateFor(db, pdId, settings);
    const { platformFee, pgFee, net } = splitByRate(gross, rate);
    await db.run(
      'INSERT INTO settlement_entries (id,pd_id,order_id,drama_id,kind,period,gross,platform_fee,pg_fee,net,fee_rate,status,confirm_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      [
        `sub-${period}-${pdId}`,
        pdId,
        null,
        null,
        'subscription',
        period,
        gross,
        platformFee,
        pgFee,
        net,
        rate,
        'available',
        stamp,
        stamp,
      ],
    );
    shares.push({ pd_id: pdId, weight, gross, net });
  }
  for (const row of counted)
    await db.run(
      'INSERT INTO settlement_watch_marks (user_id,drama_id,episode,period) VALUES (?,?,?,?) ON CONFLICT(user_id,drama_id) DO UPDATE SET episode=excluded.episode,period=excluded.period',
      [row.user_id, row.drama_id, row.episode, period],
    );
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
    // 같은 PD의 출금 신청이 동시에 들어와도 한 번만 처리되도록 사용자 행을 잠급니다.
    if (db.engine === 'postgresql')
      await db.get('SELECT id FROM users WHERE id=? FOR UPDATE', [pdId]);
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
      `UPDATE settlement_entries SET status='requested', payout_id=? WHERE status='available' AND id IN (${rows.map(() => '?').join(',')})`,
      [id, ...rows.map((r) => r.id)],
    );
    const locked = await db.all("SELECT id FROM settlement_entries WHERE payout_id=?", [id]);
    if (locked.length !== rows.length)
      throw error(409, '다른 출금 신청이 처리 중입니다. 잠시 후 다시 시도해 주세요.');
    return { id, amount, ...tax };
  });
}
// 정산 수익을 라마로 전환합니다. 출금과 같은 세금 규칙(원천징수·부가세)을 적용한 지급액을
// 라마(1라마 = 10원, 10원 미만은 PD에게 유리하게 올림)로 바로 지급하고, 지급 내역(method='lama')을 남깁니다.
export async function convertToLama(db, { pdId, profile, settings, credit }) {
  return db.transaction(async () => {
    if (db.engine === 'postgresql')
      await db.get('SELECT id FROM users WHERE id=? FOR UPDATE', [pdId]);
    await refreshEntries(db);
    const rows = await db.all(
      "SELECT id,net FROM settlement_entries WHERE pd_id=? AND status='available'",
      [pdId],
    );
    const amount = rows.reduce((n, r) => n + Number(r.net), 0);
    if (!rows.length || amount <= 0) throw error(400, '라마로 바꿀 수 있는 정산 금액이 없습니다.');
    if (amount < settings.lama_convert_min)
      throw error(400, `라마 전환은 ${settings.lama_convert_min.toLocaleString('ko-KR')}원부터 할 수 있어요.`);
    const tax = taxFor(amount, profile, settings);
    const lama = Math.ceil(tax.payable / 10);
    const bonus = Math.floor((lama * Number(settings.lama_convert_bonus_rate || 0)) / 100);
    const id = randomUUID();
    const stamp = iso();
    await db.run(
      'INSERT INTO payouts (id,pd_id,amount,vat,income_tax,local_tax,payable,business_type,bank_name,account_number,account_holder,status,memo,requested_at,processed_at,processed_by,method,lama) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, pdId, amount, tax.vat, tax.incomeTax, tax.localTax, tax.payable, tax.businessType, '', '', '', 'paid', '라마 전환', stamp, stamp, pdId, 'lama', lama + bonus],
    );
    await db.run(
      `UPDATE settlement_entries SET status='paid', payout_id=? WHERE status='available' AND id IN (${rows.map(() => '?').join(',')})`,
      [id, ...rows.map((r) => r.id)],
    );
    const locked = await db.all('SELECT id FROM settlement_entries WHERE payout_id=?', [id]);
    if (locked.length !== rows.length)
      throw error(409, '다른 출금 신청이 처리 중입니다. 잠시 후 다시 시도해 주세요.');
    const wallet = await credit({ payoutId: id, paid: lama, bonus });
    await db.run(
      'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), pdId, 'payout:lama', id, stamp],
    );
    return { id, amount, ...tax, lama, bonus, wallet };
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
    "SELECT o.*, d.owner_id FROM orders o JOIN dramas d ON d.id=o.drama_id WHERE o.kind IN ('drama','episode') AND NOT EXISTS (SELECT 1 FROM settlement_entries s WHERE s.order_id=o.id)",
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
