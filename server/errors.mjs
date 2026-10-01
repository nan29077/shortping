// 입력 검사(zod) 오류를 화면에 그대로 보여 줄 수 있는 한국어 문장으로 바꿉니다.
// 직접 적은 한국어 안내(.regex(..., '...'), .refine(..., '...'))는 그대로 쓰고, 기본 영어 문구는 항목 이름과 조건으로 새로 만듭니다.
const LABELS = {
  email: '이메일',
  password: '비밀번호',
  newPassword: '새 비밀번호',
  currentPassword: '현재 비밀번호',
  name: '이름',
  phone: '휴대폰 번호',
  code: '인증번호',
  token: '재설정 링크',
  title: '제목',
  body: '내용',
  tagline: '한 줄 소개',
  synopsis: '줄거리',
  bio: '소개',
  slug: '방송국 주소',
  reply: '답변',
  note: '메모',
  memo: '메모',
  reason: '사유',
  price: '가격',
  number: '회차 번호',
  duration: '길이',
  account_number: '계좌번호',
  business_no: '사업자등록번호',
  tax_email: '세금계산서 이메일',
  webhook_url: '웹훅 주소',
  sender_email: '보내는 이메일',
  sender_number: '발신 번호',
  // 운영 설정 · 상품 · 정산(관리자 화면) — 2026-10-01: 영문 항목 이름이 그대로 보이던 것 정리
  subscription_price: '구독료',
  subscription_days: '구독 기간',
  default_free_episodes: '기본 무료 회차 수',
  ping_unit_won: '핑 1개 금액',
  default_episode_pings: '기본 회차 핑',
  title_unlock_discount: '전체 열기 할인율',
  pg_fee_rate: 'PG 수수료율',
  app_store_fee_rate: '앱스토어 수수료율',
  google_play_fee_rate: '구글 플레이 수수료율',
  platform_fee_rate: '플랫폼 수수료율',
  settle_hold_days: '정산 보류 기간',
  payout_min: '최소 출금액',
  withholding_rate: '원천징수율',
  vat_rate: '부가세율',
  usd_krw_rate: '환율',
  ai_margin_rate: 'AI 마진율',
  ai_monthly_budget_won: 'AI 월 예산',
  ai_daily_limit_lama: '하루 라마 한도',
  ai_concurrency: '동시 작업 수',
  ai_breaker_failures: '연속 실패 기준',
  ai_breaker_cooldown_min: '쉬는 시간',
  ai_assistant_daily_limit: 'AI 조수 하루 한도',
  lama_signup_bonus: '가입 체험 라마',
  lama_convert_min: '라마 전환 최소 금액',
  lama_convert_bonus_rate: '라마 전환 보너스율',
  studio_upload_image_mb: '이미지 최대 용량',
  studio_upload_video_mb: '영상 최대 용량',
  studio_upload_video_seconds: '영상 최대 길이',
  studio_upload_audio_mb: '음성 최대 용량',
  studio_upload_audio_seconds: '음성 최대 길이',
  studio_collab_max_members: '팀 최대 인원',
  sub_min_progress_pct: '시청 인정 기준',
  sub_cap_per_drama: '작품당 배분 상한',
  sub_cap_per_user: '회원당 배분 상한',
  media_retention_days: '파일 보관 기간',
  episode_pings: '회차 핑',
  free_episodes: '무료 회차 수',
  lama: '라마',
  bonus_lama: '보너스 라마',
  daily_lama: '하루 라마',
  monthly_lama: '월 라마',
  monthly_budget_won: '월 예산',
  price_lama: '라마 가격',
  pings: '핑',
  bonus_pings: '보너스 핑',
  sort_order: '정렬 순서',
  cost_usd: '원가(USD)',
  max_concurrency: '동시 작업 수',
  max_seconds: '최대 길이',
  base_url: 'API 주소',
  api_key: 'API 키',
  model_id: '모델 ID',
  weight: '가중치',
  cap_pct: '상한(%)',
  sponsor_limit: '지원 한도',
  max_uses: '최대 인원',
  budget_lama: '프로젝트 예산',
  episode_count: '회차 수',
  episode_seconds: '회차 길이',
  logline: '한 줄 아이디어',
  instruction: '요청 사항',
  period: '마감 월',
  progress: '시청 위치',
};
const hasHangul = (s) => /[가-힣]/.test(String(s || ''));
// 받침에 맞는 조사(은/는, 을/를). 한글이 아니면 '은(는)'처럼 둘 다 적습니다.
const josa = (word, [withBatchim, without]) => {
  const c = String(word).charCodeAt(String(word).length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return word + ((c - 0xac00) % 28 ? withBatchim : without);
  return `${word}${withBatchim}(${without})`;
};
const labelOf = (path) => {
  const key = [...(path || [])].reverse().find((p) => typeof p === 'string');
  // 모르는 영어 칸 이름은 그대로 보이면 'progress은(는)'처럼 어색해서 '입력한 값'으로 말해요.
  return key && LABELS[key] ? LABELS[key] : '';
};
export function zodMessage(issue) {
  if (!issue) return '입력 내용을 확인해 주세요.';
  if (hasHangul(issue.message)) return issue.message;
  const label = labelOf(issue.path);
  const subject = label ? `${label}` : '입력한 값';
  const n = (v) => (typeof v === 'bigint' ? Number(v) : v);
  // '입력한 값 값을'처럼 겹치지 않게 해요.
  const valueOf = label ? `${label} 값을` : '입력한 값을';
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string')
        return Number(issue.minimum) <= 1 ? `${josa(subject, ['을', '를'])} 입력해 주세요.` : `${josa(subject, ['은', '는'])} ${n(issue.minimum)}자 이상 입력해 주세요.`;
      if (issue.origin === 'array') return `${josa(subject, ['을', '를'])} ${n(issue.minimum)}개 이상 골라 주세요.`;
      return `${josa(subject, ['은', '는'])} ${n(issue.minimum)} 이상이어야 해요.`;
    case 'too_big':
      if (issue.origin === 'string') return `${josa(subject, ['은', '는'])} ${n(issue.maximum)}자 이하로 입력해 주세요.`;
      if (issue.origin === 'array') return `${josa(subject, ['은', '는'])} ${n(issue.maximum)}개까지 고를 수 있어요.`;
      return `${josa(subject, ['은', '는'])} ${n(issue.maximum)} 이하여야 해요.`;
    case 'invalid_format':
      if (issue.format === 'email') return `${label || '이메일'} 형식을 확인해 주세요.`;
      if (issue.format === 'url') return `${label || '주소'} 형식을 확인해 주세요.`;
      return `${subject} 형식을 확인해 주세요.`;
    case 'invalid_type':
      return /received undefined/.test(String(issue.message)) ? `${josa(subject, ['을', '를'])} 입력해 주세요.` : `${valueOf} 확인해 주세요.`;
    case 'invalid_value':
      return `${subject}에 허용되지 않는 값이에요.`;
    case 'not_multiple_of':
      return `${valueOf} 확인해 주세요.`;
    default:
      return label ? `${label} 값을 확인해 주세요.` : '입력 내용을 확인해 주세요.';
  }
}
// 오류 문구에 서버 내부 경로·시스템 오류 원문이 섞여 있으면 화면에 내보내지 않습니다.
export const looksInternal = (message) =>
  /(\/(root|home|usr|var|tmp|opt|srv|app)\/|[A-Za-z]:\\|ENOENT|EACCES|EPERM|ECONN|SQLITE_|node_modules|at \S+ \()/.test(String(message || ''));
