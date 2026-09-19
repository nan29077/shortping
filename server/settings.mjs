// Platform-wide operating values. The super administrator edits these at runtime,
// so nothing here is hard-coded in the payment, pricing or settlement paths.
export const settingDefaults = {
  subscription_price: 7900,
  subscription_days: 30,
  default_drama_price: 3900,
  default_free_episodes: 3,
  default_episode_price: 500, // 회차 단건 구매 기본가
  platform_fee_rate: 30, // %, 플랫폼 수수료
  pg_fee_rate: 0, // %, 결제대행 수수료 (연동 후 사용)
  settle_hold_days: 7, // 구매 후 판매 확정까지
  payout_min: 10000, // 최소 출금 신청 금액
  withholding_rate: 3.3, // 비사업자 사업소득 원천징수
  vat_rate: 10, // 사업자 세금계산서 부가세
  payout_notice:
    '출금은 영업일 기준 3일 이내에 지급됩니다. 지급대행 연동 후 자동 이체로 전환됩니다.',
  home_theme: 'cinematic',
  home_eyebrow: 'SHORT STORIES, DEEP MOMENTS',
  home_headline: '짧은 순간,',
  home_highlight: '깊은 이야기.',
  home_description: '다양한 장르의 숏폼 드라마를\n언제 어디서나 만나보세요.',
  home_caption: '오늘의 장면이 내일의 취향이 됩니다.',
  home_copyright: '© 2026 SHORTPING',
};
const numeric = new Set(
  Object.entries(settingDefaults)
    .filter(([, v]) => typeof v === 'number')
    .map(([k]) => k),
);
let cache = null;
export async function loadSettings(db) {
  if (cache) return cache;
  const rows = await db.all('SELECT key,value FROM platform_settings');
  const values = { ...settingDefaults };
  for (const row of rows)
    if (row.key in values) values[row.key] = numeric.has(row.key) ? Number(row.value) : row.value;
  cache = values;
  return values;
}
export async function saveSettings(db, patch, actorId) {
  const stamp = new Date().toISOString();
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in settingDefaults)) continue;
    await db.run(
      'INSERT INTO platform_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
      [key, String(value), stamp, actorId],
    );
  }
  cache = null;
  return loadSettings(db);
}
export const clearSettingsCache = () => {
  cache = null;
};
