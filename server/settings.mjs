// Platform-wide operating values. The super administrator edits these at runtime,
// so nothing here is hard-coded in the payment, pricing or settlement paths.
export const settingDefaults = {
  subscription_price: 7900,
  subscription_days: 30,
  default_free_episodes: 3,
  // 핑(포인트): 10,000원 = 100핑 기준. 회차는 핑으로 열고, 작품 전체 열기는 할인해 줍니다.
  ping_unit_won: 100, // 1핑 기준가(원). 무상 지급 핑의 정산 단가와 화면 환산에 사용
  default_episode_pings: 5, // 작품별 회차 핑을 정하지 않았을 때
  title_unlock_discount: 20, // 작품 전체 열기 할인율(%)
  // 결제 채널 수수료(%). 정산은 채널 수수료를 뺀 순매출을 PD·플랫폼이 나눕니다.
  pg_fee_rate: 0, // 웹 결제(PG) 수수료 — PG 연동 후 계약 요율 입력
  app_store_fee_rate: 30, // App Store 인앱결제
  google_play_fee_rate: 30, // Google Play 인앱결제
  platform_fee_rate: 30, // 공통 플랫폼 몫(%). PD 몫 = 100 - 이 값. PD별 개별 비율이 우선
  settle_hold_days: 7, // 판매 확정까지
  payout_min: 10000, // 최소 출금 신청 금액
  withholding_rate: 3.3, // 비사업자 사업소득 원천징수
  vat_rate: 10, // 사업자 세금계산서 부가세
  // ── 숏핑 스튜디오(AI 제작) · 라마(1라마 = 10원) ──
  ai_enabled: 1, // 0이면 모든 AI 제작 작업을 멈춥니다
  usd_krw_rate: 1400, // 모델 원가(USD)를 원화로 바꾸는 환율
  ai_margin_rate: 180, // 원가 대비 라마 판매가(%) — 모델별 고정 단가가 있으면 그 값이 우선
  ai_monthly_budget_won: 1000000, // 플랫폼 전체 월 AI 원가 한도(원), 0이면 무제한
  ai_daily_limit_lama: 20000, // PD 1명의 하루 라마 사용 한도, 0이면 무제한 (PD별 개별 한도 우선)
  ai_concurrency: 3, // 동시에 실행할 AI 작업 수
  lama_signup_bonus: 300, // PD 첫 방문 시 체험 라마
  lama_convert_min: 1000, // 정산 수익 → 라마 전환 최소 금액(원)
  lama_convert_bonus_rate: 0, // 라마 전환 보너스(%)
  ai_blocked_terms: '', // 줄바꿈으로 구분한 금칙어(기본 금칙어에 추가)
  ai_allow_cn: 1, // 중국 공급사(Kling·Hailuo·Wan·Seedance·DeepSeek 등) 사용 허용
  ai_breaker_failures: 5, // 공급사 연속 실패가 이 횟수면 잠시 자동 제외
  ai_breaker_cooldown_min: 10, // 자동 제외 시간(분)
  // 어디에서도 쓰지 않는 업로드 파일을 만든 뒤 며칠 지나면 지울지(일). 0이면 자동 정리를 하지 않습니다.
  media_retention_days: 91,
  payout_notice:
    '출금은 영업일 기준 3일 이내에 지급됩니다. 지급대행 연동 후 자동 이체로 전환됩니다.',
  home_theme: 'cinematic',
  home_eyebrow: 'SHORT STORIES, DEEP MOMENTS',
  home_headline: '짧은 순간,',
  home_highlight: '깊은 이야기.',
  home_description: '다양한 장르의 숏폼 드라마를\n언제 어디서나 만나보세요.',
  home_caption: '오늘의 장면이 내일의 취향이 됩니다.',
  home_copyright: '© 2026 SHORTPING',
  home_style: '', // PC 여백 글자 색·크기·배경(JSON, server/home-layout.mjs)
  home_layout: '', // 메인 화면 구성: 추천 배너·섹션 순서·에디터 추천·공지 띠(JSON)
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
