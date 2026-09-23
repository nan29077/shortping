import { z } from 'zod';

// 메인페이지 관리(최고관리자): PC 여백 디자인(글자 색·크기·배경)과 메인 화면 구성(추천 배너·섹션 순서·
// 에디터 추천·하단 배너·공지 띠)을 설정값(platform_settings)에 JSON으로 저장합니다.

// ── PC 여백 디자인 ───────────────────────────────────────────
const color = z.union([z.literal(''), z.string().regex(/^#[0-9a-fA-F]{6}$/)]);
export const COPY_KEYS = ['eyebrow', 'headline', 'highlight', 'description', 'caption', 'copyright'];
export const styleSchema = z.object({
  colors: z.object(Object.fromEntries(COPY_KEYS.map((k) => [k, color.default('')]))).prefault({}),
  size: z.enum(['s', 'm', 'l']).default('m'),
  box: z.boolean().default(false), // 카피 뒤 배경 상자(기본 끔)
  shadow: z.boolean().default(true), // 글자 그림자(사진 위에서도 잘 읽히게)
  shade: z.number().int().min(0).max(80).default(0), // 배경 사진을 더 어둡게(%)
  image: z.union([z.literal(''), z.string().regex(/^\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/)]).default(''),
  focus: z.enum(['center', 'top', 'bottom', 'left', 'right']).default('center'),
  // 여백 로테이션: 켜면 5개 테마 사진을 4시간마다 돌아가며 보여 줍니다(끄면 고른 테마·사진).
  rotate: z.boolean().default(false),
  rotateCopy: z.boolean().default(false), // 로테이션 때 문구도 그 테마 문구로 함께 바꾸기
});
export const defaultStyle = styleSchema.parse({});
export function styleOf(raw) {
  try {
    return styleSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    return defaultStyle;
  }
}

// ── 메인 화면 구성 ───────────────────────────────────────────
// 섹션 id → 기본 제목(관리자가 제목을 비워 두면 이 값을 씁니다)
export const HOME_SECTIONS = [
  { id: 'continue', name: '이어보기', title: '멈춘 곳부터, 이어보기', subtitle: '' },
  { id: 'curated', name: '에디터 추천', title: '에디터가 고른 이야기', subtitle: '숏핑 에디터가 직접 골랐어요' },
  { id: 'channels', name: '주목할 방송국', title: '지금 주목할 방송국', subtitle: 'PD가 직접 운영하는 방송국에서 골라 보기' },
  { id: 'trending', name: '지금 핫한 작품', title: '지금 가장 핫한 숏핑', subtitle: '' },
  { id: 'membership', name: '숏핑 패스 배너', title: '숏핑 패스로 모든 이야기를 만나세요', subtitle: '취향껏, 마음껏, 끊김 없이.' },
  { id: 'binge', name: '정주행 추천', title: '오늘부터 정주행 각', subtitle: '한 번 시작하면 멈출 수 없는 이야기' },
  { id: 'newest', name: '새로 올라온 작품', title: '새로 올라온 이야기', subtitle: '가장 최근 공개된 숏핑 오리지널' },
  { id: 'free', name: '무료 추천', title: '무료로 먼저 만나보세요', subtitle: '첫 화부터 부담 없이 시작하는 작품' },
  { id: 'followed', name: '구독 방송국 소식', title: '구독 중인 방송국의 새 소식', subtitle: '내가 구독한 방송국의 작품' },
  { id: 'editorial', name: '하단 안내 배너', title: '', subtitle: '' },
];
const SECTION_IDS = HOME_SECTIONS.map((s) => s.id);
const id = z.string().trim().min(1).max(80);
const link = z.union([z.literal(''), z.string().trim().regex(/^(https:\/\/[^\s]{3,300}|[a-z][a-z0-9/_-]{0,120})$/, '링크는 https:// 주소나 앱 안 주소(예: membership, drama/작품ID)만 쓸 수 있어요.')]);
const when = z.union([z.literal(''), z.string().datetime()]);
export const layoutSchema = z.object({
  hero: z
    .object({
      mode: z.enum(['auto', 'manual']).default('auto'),
      ids: z.array(id).max(5).default([]),
      kicker: z.string().trim().max(40).default(''),
      interval: z.number().int().min(-1).max(30).default(0), // 자동 넘김(초): 0이면 기본(6.5초), -1이면 끔
    })
    .prefault({}),
  sections: z
    .array(z.object({ id: z.enum(SECTION_IDS), visible: z.boolean().default(true), title: z.string().trim().max(40).default(''), subtitle: z.string().trim().max(60).default('') }))
    .max(SECTION_IDS.length)
    .default([]),
  curated: z.object({ ids: z.array(id).max(12).default([]) }).prefault({}),
  editorial: z
    .object({
      eyebrow: z.string().trim().max(40).default(''),
      title: z.string().trim().max(60).default(''),
      button: z.string().trim().max(20).default(''),
      link: link.default(''),
    })
    .prefault({}),
  notice: z
    .object({
      enabled: z.boolean().default(false),
      text: z.string().trim().max(80).default(''),
      link: link.default(''),
      tone: z.enum(['lime', 'violet', 'red', 'neutral']).default('lime'),
      start: when.default(''),
      end: when.default(''),
    })
    .prefault({}),
});
// 저장된 값을 읽을 때: 빠진 섹션은 기본 순서대로 뒤에 붙이고, 같은 섹션이 두 번 있으면 하나만 둡니다.
export function normalizeLayout(value) {
  const seen = new Set();
  const sections = [];
  for (const s of value.sections || []) if (!seen.has(s.id)) seen.add(s.id), sections.push(s);
  // 에디터 추천은 작품을 고르기 전에는 숨겨 둔 채로 시작합니다.
  for (const s of HOME_SECTIONS) if (!seen.has(s.id)) sections.push({ id: s.id, visible: s.id !== 'curated', title: '', subtitle: '' });
  return { ...value, sections };
}
export function layoutOf(raw) {
  try {
    return normalizeLayout(layoutSchema.parse(raw ? JSON.parse(raw) : {}));
  } catch {
    return normalizeLayout(layoutSchema.parse({}));
  }
}
