import { randomUUID } from 'node:crypto';
import { sealAccount } from './bank-secret.mjs';

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
// 사업자 기준(부가세 가산)은 관리자가 사업자 정보를 확인(verified)한 뒤에만 적용합니다.
// 확인 전에는 개인 기준(원천징수)으로 계산해 자가 신고만으로 더 받는 일을 막습니다.
export const isVerifiedBusiness = (profile) =>
  profile?.business_type === 'business' && Number(profile?.verified) === 1;
export function taxFor(amount, profile, settings) {
  if (isVerifiedBusiness(profile)) {
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
// 구독 풀(그 달 숏핑 패스 결제액 - 결제 채널 수수료)
export async function subscriptionPool(db, period) {
  const [start, end] = periodRange(period);
  return Number(
    (
      await db.get(
        "SELECT SUM(amount - channel_fee) AS total FROM orders WHERE kind='subscription' AND created_at>=? AND created_at<?",
        [start, end],
      )
    )?.total || 0,
  );
}
// 구독 배분 계산(저장하지 않음 — 마감과 관리자 미리보기가 함께 씁니다).
//  1) 인정 재생: 구독자가 유료 회차를 회차 길이의 기준 %(sub_min_progress_pct) 이상 본 기록만(작품 주인·관리자·구매 회차 제외는 기록 단계에서 처리)
//  2) 구독자별 상한: 한 구독자가 한 달에 한 작품에서 최대 N회, 전체 최대 M회까지(먼저 본 순서대로 인정)
//  3) PD 가중치: 인정 재생 수 × PD별 배수(기본 1). '배분 제외'인 PD는 0
//  4) 풀 × (내 가중 재생 / 전체 가중 재생). PD별 상한(cap_pct, 풀의 %)을 넘는 몫은 상한까지만 주고,
//     넘친 금액은 상한에 걸리지 않은 PD들에게 가중 재생 비율대로 다시 나눕니다(모두 상한이면 플랫폼에 남음).
//  5) 원 단위 절사, 절사로 남은 몇 원은 가중 재생이 가장 많은(상한에 걸리지 않은) PD에게 더합니다.
// 규칙을 끄면(sub_view_rules_enabled=0) 1)·2)를 적용하지 않아 예전처럼 모든 재생 기록을 셉니다. 3)~5)는 늘 적용됩니다.
export async function subscriptionPlan(db, period, pool, settings) {
  const rulesOn = Number(settings.sub_view_rules_enabled ?? 1) === 1;
  const capDrama = rulesOn ? Math.max(0, Number(settings.sub_cap_per_drama || 0)) : 0;
  const capUser = rulesOn ? Math.max(0, Number(settings.sub_cap_per_user || 0)) : 0;
  const views = await db.all(
    `SELECT v.user_id, v.drama_id, d.owner_id AS pd_id
     FROM subscription_views v JOIN dramas d ON d.id=v.drama_id
     WHERE v.period=? AND v.user_id<>d.owner_id${rulesOn ? ' AND v.qualified=1' : ''}
     ORDER BY v.user_id, v.created_at, v.drama_id, v.episode`,
    [period],
  );
  const perUser = new Map(),
    perUserDrama = new Map(),
    counted = new Map(),
    raw = new Map();
  let cappedViews = 0;
  for (const v of views) {
    raw.set(v.pd_id, (raw.get(v.pd_id) || 0) + 1);
    const key = `${v.user_id}\u0000${v.drama_id}`;
    const u = perUser.get(v.user_id) || 0,
      d = perUserDrama.get(key) || 0;
    if ((capDrama && d >= capDrama) || (capUser && u >= capUser)) {
      cappedViews++;
      continue;
    }
    perUser.set(v.user_id, u + 1);
    perUserDrama.set(key, d + 1);
    counted.set(v.pd_id, (counted.get(v.pd_id) || 0) + 1);
  }
  const overrides = new Map((await db.all('SELECT * FROM subscription_overrides')).map((o) => [o.user_id, o]));
  const rows = [...counted.entries()].map(([pdId, weight]) => {
    const o = overrides.get(pdId);
    const multiplier = o ? Number(o.weight) : 1;
    const excluded = !!o && Number(o.excluded) === 1;
    const capPct = o ? Number(o.cap_pct) || 0 : 0;
    return {
      pd_id: pdId,
      views: raw.get(pdId) || 0,
      weight,
      multiplier,
      excluded,
      cap_pct: capPct,
      effective: excluded ? 0 : weight * multiplier,
      capped: false,
      exact: 0,
      gross: 0,
    };
  });
  rows.sort((a, b) => b.effective - a.effective || b.weight - a.weight || String(a.pd_id).localeCompare(String(b.pd_id)));
  const total = rows.reduce((n, r) => n + r.effective, 0);
  const capOf = (r) => (r.cap_pct > 0 ? Math.floor((pool * r.cap_pct) / 100) : Infinity);
  let pending = rows.filter((r) => r.effective > 0);
  let remaining = pool;
  while (pool > 0 && pending.length) {
    const sum = pending.reduce((n, r) => n + r.effective, 0);
    const over = pending.filter((r) => (remaining * r.effective) / sum > capOf(r));
    if (!over.length) {
      for (const r of pending) r.exact = (remaining * r.effective) / sum;
      remaining = 0;
      break;
    }
    // 상한을 넘는 PD는 상한까지만 확정하고, 남은 금액을 나머지 PD에게 다시 나눕니다.
    for (const r of over) {
      r.capped = true;
      r.gross = capOf(r);
      remaining -= r.gross;
    }
    pending = pending.filter((r) => !r.capped);
  }
  for (const r of rows) if (!r.capped) r.gross = Math.floor(r.exact);
  // 절사로 남은 금액: 상한에 걸리지 않은 PD 중 가중 재생이 가장 많은 PD에게(상한을 넘지 않는 만큼)
  const assigned = () => rows.reduce((n, r) => n + r.gross, 0);
  const top = rows.find((r) => r.effective > 0 && !r.capped);
  if (top && remaining === 0) top.gross += Math.max(0, Math.min(pool - assigned(), capOf(top) - top.gross));
  const undistributed = pool - assigned();
  return {
    total,
    rows: rows.map(({ exact, ...r }) => r),
    summary: {
      rules: {
        enabled: rulesOn,
        min_progress_pct: Number(settings.sub_min_progress_pct ?? 30),
        cap_per_drama: capDrama,
        cap_per_user: capUser,
      },
      counted_views: rows.reduce((n, r) => n + r.weight, 0),
      capped_views: cappedViews,
      undistributed,
    },
  };
}
// Subscription revenue is shared monthly in proportion to episodes watched, the same
// pooled model streaming services use. Closing a period twice changes nothing.
export async function closeSubscriptionPeriod(db, period, settings, actorId) {
  const [, end] = periodRange(period);
  if (new Date(end).getTime() > Date.now())
    throw error(400, '아직 종료되지 않은 월은 마감할 수 없습니다.');
  const pool = await subscriptionPool(db, period);
  const plan = await subscriptionPlan(db, period, pool, settings);
  const stamp = iso();
  if (!pool || !plan.total) {
    // 배분할 것이 없어도 마감 기록은 남겨, 다음 달 마감 순서 검사가 막히지 않게 합니다.
    await db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [
      randomUUID(),
      actorId,
      'settlement:closed',
      period,
      stamp,
    ]);
    return { period, pool, shares: [], reason: !pool ? '구독 매출 없음' : plan.rows.length ? '배분 대상 PD 없음(모두 제외)' : '시청 기록 없음', ...plan.summary };
  }
  const shares = [];
  for (const row of plan.rows) {
    const { pd_id: pdId, weight, gross } = row;
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
    shares.push({ ...row, pd_id: pdId, weight, gross, net });
  }
  await db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [
    randomUUID(),
    actorId,
    'settlement:closed',
    period,
    stamp,
  ]);
  return { period, pool, shares, ...plan.summary };
}
export async function requestPayout(db, { pdId, profile, settings }) {
  if (!profile?.account_number || !profile?.bank_name || !profile?.account_holder)
    throw error(400, '출금 계좌를 먼저 등록해 주세요.');
  if (profile.business_type === 'business' && !profile.business_no)
    throw error(400, '사업자등록번호를 먼저 등록해 주세요.');
  if (profile.business_type === 'business' && !isVerifiedBusiness(profile))
    throw error(409, '사업자 정보 확인 중입니다. 관리자 확인 후 출금할 수 있어요. 급하면 개인으로 바꿔 신청해 주세요.');
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
        // 출금 신청 시점의 계좌를 암호화된 채로 복사합니다(평문이 남아 있던 프로필도 여기서 암호화).
        sealAccount(profile.account_number),
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
    // 두 관리자가 같은 출금을 동시에 처리해도 한 번만 반영되도록 행을 잠그고 상태 조건으로 갱신합니다.
    const payout = await db.get(
      'SELECT * FROM payouts WHERE id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''),
      [payoutId],
    );
    if (!payout) throw error(404, '출금 요청을 찾을 수 없습니다.');
    if (payout.method === 'lama') throw error(409, '라마 전환 내역은 처리할 수 없습니다.');
    if (['paid', 'rejected'].includes(payout.status))
      throw error(409, '이미 처리된 출금 요청입니다.');
    if (action === 'rejected' && !memo.trim()) throw error(400, '반려 사유를 입력해 주세요.');
    const stamp = iso();
    const changed = await db.run(
      "UPDATE payouts SET status=?,memo=?,processed_at=?,processed_by=? WHERE id=? AND status IN ('requested','approved')",
      [action, memo, action === 'approved' ? null : stamp, actorId, payoutId],
    );
    if (Number(changed?.rowCount ?? changed?.changes ?? 1) === 0)
      throw error(409, '이미 처리된 출금 요청입니다.');
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
