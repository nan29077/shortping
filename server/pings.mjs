import { randomUUID } from 'node:crypto';

// 핑(포인트) 엔진.
// - 충전 한 번이 하나의 로트(lot)가 됩니다. 로트마다 "유료 핑 1개가 실제로 벌어들인 순매출"
//   (결제 채널 수수료를 뺀 금액 ÷ 유료 핑 수)을 원×1000 단위(unit_milli)로 기록합니다.
// - 같은 충전에 붙은 보너스 핑도 같은 단가로 정산합니다. 보너스 비용은 플랫폼이 마케팅비로 부담합니다.
// - 관리자가 무상 지급한 핑은 기준가(1핑 = ping_unit_won)로 정산합니다.
// - 차감은 보너스(무상) 핑을 먼저, 오래된 충전부터 씁니다. 잔액 캐시(ping_wallets)와 장부
//   (ping_ledger), 로트별 사용 내역(ping_consumptions)을 항상 한 트랜잭션에서 함께 갱신합니다.
const error = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const iso = () => new Date().toISOString();

export const channels = ['web', 'app_store', 'google_play'];
export const channelFeeRate = (channel, settings) =>
  channel === 'app_store'
    ? settings.app_store_fee_rate
    : channel === 'google_play'
      ? settings.google_play_fee_rate
      : settings.pg_fee_rate;
export const unitMilliOf = (price, paidPings, feeRate) =>
  paidPings > 0 ? Math.floor((price * (100 - feeRate) * 10) / paidPings) : 0;
export const episodePingsOf = (drama, settings) =>
  drama.free ? 0 : drama.episode_pings > 0 ? drama.episode_pings : settings.default_episode_pings;
// 작품 전체 열기: 아직 잠긴 회차들의 핑 합계에서 할인율만큼 깎고, 한 편 가격보다 싸지지 않게 합니다.
export function titlePingsOf(lockedCount, perEpisode, settings) {
  if (lockedCount <= 0) return 0;
  const full = lockedCount * perEpisode;
  if (lockedCount === 1) return full;
  return Math.max(perEpisode, Math.ceil((full * (100 - settings.title_unlock_discount)) / 100));
}
export async function walletOf(db, userId) {
  const w = await db.get('SELECT paid_balance, bonus_balance FROM ping_wallets WHERE user_id=?', [
    userId,
  ]);
  const paid = Number(w?.paid_balance || 0);
  const bonus = Number(w?.bonus_balance || 0);
  return { paid, bonus, total: paid + bonus };
}
async function lockWallet(db, userId) {
  await db.run(
    'INSERT INTO ping_wallets (user_id,paid_balance,bonus_balance,updated_at) VALUES (?,0,0,?) ON CONFLICT(user_id) DO NOTHING',
    [userId, iso()],
  );
  if (db.engine === 'postgresql')
    await db.get('SELECT user_id FROM ping_wallets WHERE user_id=? FOR UPDATE', [userId]);
  return walletOf(db, userId);
}

// 반드시 트랜잭션 안에서 호출합니다.
export async function creditPings(
  db,
  { userId, type, source, channel = 'web', orderId = null, paid = 0, bonus = 0, unitMilli, memo = '', actorId = null },
) {
  if (paid < 0 || bonus < 0 || paid + bonus <= 0) throw error(400, '지급할 핑을 확인해 주세요.');
  const wallet = await lockWallet(db, userId);
  const stamp = iso();
  const lotId = randomUUID();
  await db.run(
    'INSERT INTO ping_lots (id,user_id,source,channel,order_id,paid_total,paid_left,bonus_total,bonus_left,unit_milli,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [lotId, userId, source, channel, orderId, paid, paid, bonus, bonus, unitMilli, stamp],
  );
  const paidAfter = wallet.paid + paid;
  const bonusAfter = wallet.bonus + bonus;
  await db.run(
    'UPDATE ping_wallets SET paid_balance=?, bonus_balance=?, updated_at=? WHERE user_id=?',
    [paidAfter, bonusAfter, stamp, userId],
  );
  const ledgerId = randomUUID();
  await db.run(
    'INSERT INTO ping_ledger (id,user_id,type,paid_delta,bonus_delta,paid_after,bonus_after,value_milli,order_id,memo,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [ledgerId, userId, type, paid, bonus, paidAfter, bonusAfter, (paid + bonus) * unitMilli, orderId, memo, actorId, stamp],
  );
  return { lotId, ledgerId, wallet: { paid: paidAfter, bonus: bonusAfter, total: paidAfter + bonusAfter } };
}

// 반드시 트랜잭션 안에서 호출합니다. 사용한 핑의 순매출(value_milli)을 돌려줍니다.
export async function debitPings(
  db,
  { userId, pings, type, orderId = null, dramaId = null, episode = null, memo = '', actorId = null },
) {
  if (!Number.isInteger(pings) || pings <= 0) throw error(400, '차감할 핑을 확인해 주세요.');
  const wallet = await lockWallet(db, userId);
  if (wallet.total < pings)
    throw error(400, `핑이 부족해요. ${pings}핑이 필요하고 현재 ${wallet.total}핑이 있어요.`, {
      code: 'insufficient_pings',
      need: pings,
      balance: wallet.total,
    });
  const lots = await db.all(
    'SELECT * FROM ping_lots WHERE user_id=? AND (paid_left>0 OR bonus_left>0) ORDER BY created_at, id',
    [userId],
  );
  let bonusNeed = Math.min(pings, wallet.bonus);
  let paidNeed = pings - bonusNeed;
  const parts = new Map();
  const take = (lot, field, count) => {
    const part = parts.get(lot.id) || { lot, paid: 0, bonus: 0 };
    part[field] += count;
    parts.set(lot.id, part);
  };
  for (const lot of lots) {
    if (!bonusNeed) break;
    const n = Math.min(Number(lot.bonus_left), bonusNeed);
    if (n > 0) {
      take(lot, 'bonus', n);
      bonusNeed -= n;
    }
  }
  for (const lot of lots) {
    if (!paidNeed) break;
    const n = Math.min(Number(lot.paid_left), paidNeed);
    if (n > 0) {
      take(lot, 'paid', n);
      paidNeed -= n;
    }
  }
  // 잔액 캐시와 로트가 어긋나면 돈이 걸린 일이라 진행하지 않습니다.
  if (bonusNeed || paidNeed) throw new Error('ping wallet and lots are out of sync for ' + userId);
  const stamp = iso();
  const ledgerId = randomUUID();
  let paidUsed = 0;
  let bonusUsed = 0;
  let valueMilli = 0;
  const consumptions = [];
  for (const { lot, paid, bonus } of parts.values()) {
    await db.run(
      'UPDATE ping_lots SET paid_left=paid_left-?, bonus_left=bonus_left-? WHERE id=? AND paid_left>=? AND bonus_left>=?',
      [paid, bonus, lot.id, paid, bonus],
    );
    const value = (paid + bonus) * Number(lot.unit_milli);
    paidUsed += paid;
    bonusUsed += bonus;
    valueMilli += value;
    consumptions.push([lot.id, paid, bonus, value]);
  }
  const paidAfter = wallet.paid - paidUsed;
  const bonusAfter = wallet.bonus - bonusUsed;
  await db.run(
    'UPDATE ping_wallets SET paid_balance=?, bonus_balance=?, updated_at=? WHERE user_id=?',
    [paidAfter, bonusAfter, stamp, userId],
  );
  await db.run(
    'INSERT INTO ping_ledger (id,user_id,type,paid_delta,bonus_delta,paid_after,bonus_after,value_milli,order_id,drama_id,episode,memo,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [ledgerId, userId, type, -paidUsed, -bonusUsed, paidAfter, bonusAfter, valueMilli, orderId, dramaId, episode, memo, actorId, stamp],
  );
  for (const [lotId, paid, bonus, value] of consumptions)
    await db.run(
      'INSERT INTO ping_consumptions (ledger_id,lot_id,paid,bonus,value_milli) VALUES (?,?,?,?,?)',
      [ledgerId, lotId, paid, bonus, value],
    );
  return {
    ledgerId,
    valueMilli,
    paidUsed,
    bonusUsed,
    wallet: { paid: paidAfter, bonus: bonusAfter, total: paidAfter + bonusAfter },
  };
}
