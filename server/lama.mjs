import { randomUUID } from 'node:crypto';

// 라마: PD가 숏핑 스튜디오에서 AI 제작에 쓰는 포인트. 1라마 = 10원.
// - 잔액은 충전 라마(paid)와 보너스 라마(bonus)로 나눠 관리하고, 보너스부터 씁니다.
// - AI 작업을 시작할 때 예상 라마를 '예약(held)'하고, 성공하면 실제 사용량만 차감한 뒤 나머지를 돌려주며,
//   실패·취소하면 전부 돌려줍니다. 지갑(lama_wallets)과 장부(lama_ledger)는 항상 한 트랜잭션에서 바꿉니다.
// - 라마 매출은 플랫폼 매출입니다. PD 정산으로 넘어가지 않습니다.
export const LAMA_WON = 10;
const error = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const iso = () => new Date().toISOString();

export async function lamaWalletOf(db, userId) {
  const w = await db.get(
    'SELECT paid_balance,bonus_balance,held_paid,held_bonus FROM lama_wallets WHERE user_id=?',
    [userId],
  );
  const paid = Number(w?.paid_balance || 0),
    bonus = Number(w?.bonus_balance || 0),
    heldPaid = Number(w?.held_paid || 0),
    heldBonus = Number(w?.held_bonus || 0);
  return { paid, bonus, held: heldPaid + heldBonus, heldPaid, heldBonus, total: paid + bonus };
}
async function lock(db, userId) {
  await db.run(
    'INSERT INTO lama_wallets (user_id,paid_balance,bonus_balance,held_paid,held_bonus,updated_at) VALUES (?,0,0,0,0,?) ON CONFLICT(user_id) DO NOTHING',
    [userId, iso()],
  );
  if (db.engine === 'postgresql')
    await db.get('SELECT user_id FROM lama_wallets WHERE user_id=? FOR UPDATE', [userId]);
  return lamaWalletOf(db, userId);
}
async function write(db, userId, w, entry) {
  const stamp = iso();
  await db.run(
    'UPDATE lama_wallets SET paid_balance=?,bonus_balance=?,held_paid=?,held_bonus=?,updated_at=? WHERE user_id=?',
    [w.paid, w.bonus, w.heldPaid, w.heldBonus, stamp, userId],
  );
  await db.run(
    'INSERT INTO lama_ledger (id,user_id,type,paid_delta,bonus_delta,held_delta,paid_after,bonus_after,held_after,job_id,order_id,payout_id,memo,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      randomUUID(),
      userId,
      entry.type,
      entry.paid || 0,
      entry.bonus || 0,
      entry.held || 0,
      w.paid,
      w.bonus,
      w.heldPaid + w.heldBonus,
      entry.jobId || null,
      entry.orderId || null,
      entry.payoutId || null,
      entry.memo || '',
      entry.actorId || null,
      stamp,
    ],
  );
  return { ...w, held: w.heldPaid + w.heldBonus, total: w.paid + w.bonus };
}

// 반드시 트랜잭션 안에서 호출합니다.
export async function creditLama(db, { userId, type, paid = 0, bonus = 0, orderId, payoutId, memo, actorId }) {
  if (paid < 0 || bonus < 0 || paid + bonus <= 0) throw error(400, '지급할 라마를 확인해 주세요.');
  const w = await lock(db, userId);
  return write(db, userId, { ...w, paid: w.paid + paid, bonus: w.bonus + bonus }, {
    type,
    paid,
    bonus,
    orderId,
    payoutId,
    memo,
    actorId,
  });
}
const insufficient = (need, balance) =>
  error(400, `라마가 부족해요. ${need.toLocaleString('ko-KR')}라마가 필요하고 사용 가능한 라마는 ${balance.toLocaleString('ko-KR')}라마예요.`, {
    code: 'insufficient_lama',
    need,
    balance,
  });
// 관리자 회수: 사용 가능 잔액에서 보너스부터 뺍니다.
export async function debitLama(db, { userId, amount, type = 'revoke', memo, actorId }) {
  if (!Number.isInteger(amount) || amount <= 0) throw error(400, '차감할 라마를 확인해 주세요.');
  const w = await lock(db, userId);
  if (w.total < amount) throw insufficient(amount, w.total);
  const bonus = Math.min(w.bonus, amount);
  const paid = amount - bonus;
  return write(db, userId, { ...w, paid: w.paid - paid, bonus: w.bonus - bonus }, {
    type,
    paid: -paid,
    bonus: -bonus,
    memo,
    actorId,
  });
}
// AI 작업 시작: 예상 라마를 예약합니다.
export async function holdLama(db, { userId, amount, jobId, memo }) {
  if (!Number.isInteger(amount) || amount <= 0) throw error(400, '예약할 라마를 확인해 주세요.');
  const w = await lock(db, userId);
  if (w.total < amount) throw insufficient(amount, w.total);
  const holdBonus = Math.min(w.bonus, amount);
  const holdPaid = amount - holdBonus;
  const wallet = await write(
    db,
    userId,
    { paid: w.paid - holdPaid, bonus: w.bonus - holdBonus, heldPaid: w.heldPaid + holdPaid, heldBonus: w.heldBonus + holdBonus },
    { type: 'hold', paid: -holdPaid, bonus: -holdBonus, held: amount, jobId, memo },
  );
  return { holdPaid, holdBonus, wallet };
}
// 작업 성공: 실제 사용량(charge)만 차감하고 나머지 예약분은 돌려줍니다. 보너스 예약분부터 씁니다.
export async function captureLama(db, { userId, jobId, holdPaid, holdBonus, charge, memo }) {
  const hold = holdPaid + holdBonus;
  const used = Math.max(0, Math.min(hold, Math.ceil(charge)));
  const usedBonus = Math.min(holdBonus, used);
  const usedPaid = used - usedBonus;
  const w = await lock(db, userId);
  if (w.heldPaid < holdPaid || w.heldBonus < holdBonus) throw new Error('lama hold out of sync for ' + userId);
  const wallet = await write(
    db,
    userId,
    {
      paid: w.paid + (holdPaid - usedPaid),
      bonus: w.bonus + (holdBonus - usedBonus),
      heldPaid: w.heldPaid - holdPaid,
      heldBonus: w.heldBonus - holdBonus,
    },
    { type: 'spend', paid: holdPaid - usedPaid, bonus: holdBonus - usedBonus, held: -hold, jobId, memo },
  );
  return { used, usedPaid, usedBonus, wallet };
}
// 작업 실패·취소: 예약분 전부 돌려줍니다.
export async function releaseLama(db, { userId, jobId, holdPaid, holdBonus, memo }) {
  const hold = holdPaid + holdBonus;
  if (hold <= 0) return lamaWalletOf(db, userId);
  const w = await lock(db, userId);
  if (w.heldPaid < holdPaid || w.heldBonus < holdBonus) throw new Error('lama hold out of sync for ' + userId);
  return write(
    db,
    userId,
    { paid: w.paid + holdPaid, bonus: w.bonus + holdBonus, heldPaid: w.heldPaid - holdPaid, heldBonus: w.heldBonus - holdBonus },
    { type: 'release', paid: holdPaid, bonus: holdBonus, held: -hold, jobId, memo },
  );
}
