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
  return key ? LABELS[key] || key : '';
};
export function zodMessage(issue) {
  if (!issue) return '입력 내용을 확인해 주세요.';
  if (hasHangul(issue.message)) return issue.message;
  const label = labelOf(issue.path);
  const subject = label ? `${label}` : '입력한 값';
  const n = (v) => (typeof v === 'bigint' ? Number(v) : v);
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
      return /received undefined/.test(String(issue.message)) ? `${josa(subject, ['을', '를'])} 입력해 주세요.` : `${subject} 값을 확인해 주세요.`;
    case 'invalid_value':
      return `${subject}에 허용되지 않는 값이에요.`;
    case 'not_multiple_of':
      return `${subject} 값을 확인해 주세요.`;
    default:
      return label ? `${label} 값을 확인해 주세요.` : '입력 내용을 확인해 주세요.';
  }
}
// 오류 문구에 서버 내부 경로·시스템 오류 원문이 섞여 있으면 화면에 내보내지 않습니다.
export const looksInternal = (message) =>
  /(\/(root|home|usr|var|tmp|opt|srv|app)\/|[A-Za-z]:\\|ENOENT|EACCES|EPERM|ECONN|SQLITE_|node_modules|at \S+ \()/.test(String(message || ''));
