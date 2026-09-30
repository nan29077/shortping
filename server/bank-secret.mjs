import { encrypt, decrypt } from './ai/secret.mjs';

// 출금 계좌번호 저장 보호: DB에는 'enc:v1:…'(AES-256-GCM, server/ai/secret.mjs와 같은 키)로만 둡니다.
// 접두어가 있으면 이미 암호화된 값이라 다시 암호화하지 않으므로, 옮기는 작업을 여러 번 실행해도 안전합니다.
const PREFIX = 'enc:';
let warned = false;

export const isEncrypted = (value) => String(value || '').startsWith(PREFIX);
export function sealAccount(value) {
  const v = String(value || '').trim();
  if (!v || isEncrypted(v)) return v;
  try {
    return PREFIX + encrypt(v);
  } catch (e) {
    // 운영에서 AI_SECRET_KEY가 없으면 암호화할 수 없습니다. 출금이 막히지 않도록 평문으로 두고 크게 알립니다
    // (관리자 '서비스 상태' 화면에도 경고가 표시돼요).
    if (!warned) console.warn('[숏핑] 계좌번호를 암호화하지 못했어요(AI_SECRET_KEY 확인 필요):', e.message);
    warned = true;
    return v;
  }
}
export function openAccount(value) {
  const v = String(value || '');
  if (!isEncrypted(v)) return v;
  try {
    return decrypt(v.slice(PREFIX.length));
  } catch {
    // 키가 바뀌어 풀 수 없는 값은 화면에 암호문을 내보내지 않습니다.
    return '';
  }
}
// 목록 화면용: 앞 3자리와 끝 3자리만 보이고 나머지 숫자는 *로 가립니다(하이픈 모양은 유지). 예) 110-***-***789
export function maskAccount(value) {
  const plain = openAccount(value);
  const digits = plain.replace(/\D/g, '');
  if (!digits) return '';
  const keepHead = digits.length >= 9 ? 3 : 0;
  const keepTail = digits.length >= 6 ? 3 : Math.min(2, digits.length - 1);
  let seen = 0;
  return plain.replace(/\d/g, (d) => {
    const i = seen++;
    return i < keepHead || i >= digits.length - keepTail ? d : '*';
  });
}
// 행 목록의 account_number만 가린 값으로 바꿉니다.
export const maskRows = (rows) => rows.map((r) => (r && 'account_number' in r ? { ...r, account_number: maskAccount(r.account_number) } : r));
export const maskRow = (row) => (row && 'account_number' in row ? { ...row, account_number: maskAccount(row.account_number) } : row);
export const openRow = (row) => (row && 'account_number' in row ? { ...row, account_number: openAccount(row.account_number) } : row);

// 서버 시작 시: 평문으로 남아 있는 계좌번호를 한 트랜잭션에서 암호화합니다. 여러 번 실행해도 결과가 같습니다.
export async function migrateAccountNumbers(db) {
  const tables = [
    ['pd_tax_profiles', 'user_id'],
    ['payouts', 'id'],
  ];
  let changed = 0;
  try {
    await db.transaction(async () => {
      for (const [table, key] of tables) {
        const rows = await db.all(
          `SELECT ${key} AS k, account_number FROM ${table} WHERE account_number<>'' AND account_number NOT LIKE 'enc:%'`,
        );
        for (const r of rows) {
          const sealed = sealAccount(r.account_number);
          if (!isEncrypted(sealed)) return; // 키가 없어 암호화할 수 없으면 아무것도 바꾸지 않습니다.
          await db.run(`UPDATE ${table} SET account_number=? WHERE ${key}=? AND account_number=?`, [sealed, r.k, r.account_number]);
          changed++;
        }
      }
    });
  } catch (e) {
    console.warn('[숏핑] 계좌번호 암호화 이전을 건너뛰었어요:', e.message);
    return 0;
  }
  if (changed) console.log(`[숏핑] 평문 계좌번호 ${changed}건을 암호화했어요.`);
  return changed;
}
export async function plaintextAccountCount(db) {
  const n = async (t) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE account_number<>'' AND account_number NOT LIKE 'enc:%'`))?.n || 0);
  return (await n('pd_tax_profiles')) + (await n('payouts'));
}
