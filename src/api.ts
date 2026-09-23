import { apiUrl, asset, authHeaders, authToken, fetchCredentials, isNativeApp, refreshMediaToken } from './platform';
export { asset } from './platform';
export type Role = 'admin' | 'pd' | 'viewer';
export type CopyKey = 'eyebrow' | 'headline' | 'highlight' | 'description' | 'caption' | 'copyright';
// PC 여백 디자인: 글자 색(빈 값이면 기본 색), 글자 크기, 카피 배경 상자, 글자 그림자, 배경 어둡기·사진·초점
export type HomeStyle = {
  colors: Record<CopyKey, string>;
  size: 's' | 'm' | 'l';
  box: boolean;
  shadow: boolean;
  shade: number;
  image: string;
  focus: 'center' | 'top' | 'bottom' | 'left' | 'right';
  rotate: boolean;
  rotateCopy: boolean;
};
export type HomeRotationTheme = { id: string; image: string; eyebrow: string; headline: string; highlight: string; description: string; caption: string };
export type HomeRotation = { hours: number; copy: boolean; themes: HomeRotationTheme[] };
// 여백 로테이션: 한국 시각 기준 N시간 단위 칸 번호(서버와 같은 계산)
export const rotationSlot = (hours: number, now = Date.now()) => Math.floor((now + 9 * 3600000) / (hours * 3600000));
export const rotationAt = (rotation: HomeRotation, now = Date.now()) => rotation.themes[rotationSlot(rotation.hours, now) % rotation.themes.length];
// 다음 교체 시각(ms)
export const nextRotationAt = (hours: number, now = Date.now()) => (rotationSlot(hours, now) + 1) * hours * 3600000 - 9 * 3600000;
export const defaultHomeStyle: HomeStyle = {
  colors: { eyebrow: '', headline: '', highlight: '', description: '', caption: '', copyright: '' },
  size: 'm',
  box: false,
  shadow: true,
  shade: 0,
  image: '',
  focus: 'center',
  rotate: false,
  rotateCopy: false,
};
export type HomeAppearance = {
  theme: 'cinematic' | 'bright' | 'fantasy' | 'classic' | 'medieval';
  image: string;
  themeImage?: string;
  style?: HomeStyle;
  rotation?: HomeRotation;
  eyebrow: string;
  headline: string;
  highlight: string;
  description: string;
  caption: string;
  copyright: string;
};
// 메인 화면 구성(최고관리자 편성)
export type HomeSectionId = 'continue' | 'curated' | 'channels' | 'trending' | 'membership' | 'binge' | 'newest' | 'free' | 'followed' | 'editorial';
export type HomeSectionSetting = { id: HomeSectionId; visible: boolean; title: string; subtitle: string };
export type HomeNotice = { enabled?: boolean; text: string; link: string; tone: 'lime' | 'violet' | 'red' | 'neutral'; start?: string; end?: string };
export type HomeLayout = {
  hero: { mode: 'auto' | 'manual'; ids: string[]; kicker: string; interval: number };
  sections: HomeSectionSetting[];
  curated: { ids: string[] };
  editorial: { eyebrow: string; title: string; button: string; link: string };
  notice: HomeNotice | null;
};
export const defaultHomeLayout: HomeLayout = {
  hero: { mode: 'auto', ids: [], kicker: '', interval: 0 },
  sections: (['continue', 'curated', 'channels', 'trending', 'membership', 'binge', 'newest', 'free', 'followed', 'editorial'] as HomeSectionId[]).map((id) => ({
    id,
    visible: id !== 'curated',
    title: '',
    subtitle: '',
  })),
  curated: { ids: [] },
  editorial: { eyebrow: '', title: '', button: '', link: '' },
  notice: null,
};
export type HomeTheme = Omit<HomeAppearance, 'theme' | 'copyright'> & {
  id: HomeAppearance['theme'];
  name: string;
  mood: string;
};
export const defaultHomeAppearance: HomeAppearance = {
  theme: 'cinematic',
  image: '/images/home-cinematic.webp',
  eyebrow: 'SHORT STORIES, DEEP MOMENTS',
  headline: '짧은 순간,',
  highlight: '깊은 이야기.',
  description: '다양한 장르의 숏폼 드라마를\n언제 어디서나 만나보세요.',
  caption: '오늘의 장면이 내일의 취향이 됩니다.',
  copyright: '© 2026 SHORTPING',
};
export type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  avatar: string;
  bio: string;
  auto_next: boolean;
  auto_unlock: boolean;
};
export type Drama = {
  id: string;
  owner_id: string;
  channel_id?: string | null;
  channel_name?: string | null;
  channel_slug?: string | null;
  category_id?: string | null;
  published_at?: string | null;
  title: string;
  tagline: string;
  synopsis: string;
  genre: string;
  image: string;
  accent: string;
  badge: string;
  status: string;
  free: number;
  episode_pings: number;
  free_episodes: number;
  views: number;
  episode_count: number;
  review_note: string;
  created_at: string;
  rights_confirmed?: number;
  likeness_confirmed?: number;
  ai_usage?: 'none' | 'partial' | 'full';
  studio_episodes?: number;
  ai_label?: boolean;
  episode_total?: number;
  pending_episodes?: number;
  trailer?: string;
  hashtags?: string;
  subtitle_style?: string;
  thumb_id?: string;
};
export const aiUsageLabel: Record<string, string> = {
  none: 'AI 미사용',
  partial: 'AI 일부 사용',
  full: 'AI 제작',
};
export type Episode = {
  id: string;
  number: number;
  title: string;
  duration: number;
  is_demo: number;
  locked: boolean;
  owned?: boolean;
  source?: 'upload' | 'studio';
  has_subtitles?: number;
  warnings?: string[];
  width?: number | null;
  height?: number | null;
  thumbnail?: string;
  review_status?: 'approved' | 'draft' | 'pending' | 'rejected' | 'scheduled';
  review_note?: string;
  publish_at?: string | null;
};
export type Detail = Drama & {
  episodes: Episode[];
  entitled: boolean;
  title_pings: number;
  title_discount: number;
  locked_count: number;
};
export type Wallet = { paid: number; bonus: number; total: number };
export const emptyWallet: Wallet = { paid: 0, bonus: 0, total: 0 };
export type PingProduct = {
  id: string;
  channel: 'web' | 'app_store' | 'google_play';
  name: string;
  price: number;
  pings: number;
  bonus_pings: number;
  badge: string;
  active?: number;
  sort_order?: number;
  sold?: number;
};
export type PingLedgerRow = {
  id: string;
  type: 'charge' | 'spend' | 'grant' | 'revoke' | string;
  paid_delta: number;
  bonus_delta: number;
  paid_after: number;
  bonus_after: number;
  drama_id: string | null;
  episode: number | null;
  memo: string;
  created_at: string;
  title?: string | null;
  value_milli?: number;
  user_id?: string;
  user_name?: string;
  user_email?: string;
  actor_name?: string | null;
};
export type PingState = {
  wallet: Wallet;
  products: PingProduct[];
  ledger: PingLedgerRow[];
  policy: { unit_won: number; default_episode_pings: number; title_unlock_discount: number };
};
export const isPingSpend = (o: Pick<Order, 'kind'>) =>
  o.kind === 'ping_episode' || o.kind === 'ping_title';
// 관리자는 실제로 들어온 돈(충전·구독)을, PD는 자기 작품에서 쓰인 핑의 판매액을 매출로 봅니다.
export const orderRevenue = (o: Order, admin: boolean) =>
  admin ? Number(o.amount || 0) : isPingSpend(o) ? Number(o.sale_value || 0) : Number(o.amount || 0);
export const settleKindLabel = (kind: string) =>
  kind === 'ping'
    ? '핑 사용'
    : kind === 'subscription'
      ? '구독 배분'
      : kind === 'episode'
        ? '회차 구매'
        : '개별 구매';
export const pingChannelLabel: Record<string, string> = {
  web: '웹 결제',
  app_store: 'App Store',
  google_play: 'Google Play',
  admin: '관리자 지급',
  ping: '핑 사용',
};
export const pingTypeLabel: Record<string, string> = {
  charge: '충전',
  spend: '사용',
  grant: '지급',
  revoke: '회수',
};
export const orderKindLabel = (kind: string) =>
  (
    ({
      subscription: '숏핑 패스',
      ping_charge: '핑 충전',
      lama_charge: '라마 충전',
      ping_episode: '회차 열기',
      ping_title: '작품 전체 열기',
      drama: '작품 소장',
      episode: '회차 구매',
    }) as Record<string, string>
  )[kind] || kind;
export type Order = {
  id: string;
  title: string | null;
  kind: string;
  episode?: number | null;
  amount: number;
  pings?: number;
  bonus_pings?: number;
  channel?: string;
  channel_fee?: number;
  sale_value?: number | null;
  status: string;
  created_at: string;
};
export type Library = {
  favorites: string[];
  purchases: string[];
  channels: string[];
  episodes: { drama_id: string; episode: number }[];
  history: { drama_id: string; episode: number; progress: number; updated_at: string }[];
  orders: Order[];
  wallet: Wallet;
  subscription: { expires_at: string; auto_renew: number } | null;
};
export const emptyLibrary: Library = {
  favorites: [],
  purchases: [],
  channels: [],
  episodes: [],
  history: [],
  orders: [],
  wallet: emptyWallet,
  subscription: null,
};
export type Channel = {
  id: string;
  owner_id: string;
  owner_name: string;
  owner_avatar: string;
  owner_bio: string;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  banner: string;
  logo: string;
  accent: string;
  theme: string;
  banner_fit: string;
  overlay: number;
  greeting: string;
  status: string;
  admin_hidden?: number;
  featured: number;
  featured_order: number;
  drama_count: number;
  views: number;
  followers: number;
  created_at: string;
  posters?: string[];
};
export type ChannelCategory = { id: string; channel_id: string; name: string; sort_order: number };
export type ChannelDetail = Channel & {
  categories: ChannelCategory[];
  dramas: Drama[];
  following: boolean;
};
export type SettlementEntry = {
  id: string;
  pd_id: string;
  pd_name?: string;
  order_id: string | null;
  drama_id: string | null;
  drama_title: string | null;
  kind: string;
  period: string;
  gross: number;
  platform_fee: number;
  pg_fee: number;
  net: number;
  fee_rate: number;
  status: string;
  confirm_at: string;
  payout_id: string | null;
  created_at: string;
};
export type Payout = {
  id: string;
  pd_id: string;
  pd_name?: string;
  pd_email?: string;
  amount: number;
  vat: number;
  income_tax: number;
  local_tax: number;
  payable: number;
  method?: string;
  lama?: number;
  business_type: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  status: string;
  memo: string;
  requested_at: string;
  processed_at: string | null;
};
export type TaxProfile = {
  user_id: string;
  business_type: 'individual' | 'business';
  business_no: string;
  business_name: string;
  rep_name: string;
  business_class: string;
  business_item: string;
  tax_email: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  contact: string;
  address: string;
  verified: number;
  verified_note: string;
  updated_at: string;
};
export type SettlementRules = {
  platform_fee_rate: number;
  default_platform_fee_rate?: number;
  pg_fee_rate: number;
  app_store_fee_rate?: number;
  google_play_fee_rate?: number;
  ping_unit_won?: number;
  settle_hold_days: number;
  payout_min: number;
  withholding_rate: number;
  vat_rate: number;
  payout_notice: string;
};
export type Balance = {
  pending: number;
  available: number;
  requested: number;
  paid: number;
  gross: number;
  fee: number;
};
export type StudioSettlement = {
  balance: Balance;
  entries: SettlementEntry[];
  payouts: Payout[];
  profile: TaxProfile;
  settings: SettlementRules;
};
export type PlatformSettings = {
  subscription_price: number;
  subscription_days: number;
  default_free_episodes: number;
  ping_unit_won: number;
  default_episode_pings: number;
  title_unlock_discount: number;
  platform_fee_rate: number;
  pg_fee_rate: number;
  app_store_fee_rate: number;
  google_play_fee_rate: number;
  settle_hold_days: number;
  payout_min: number;
  withholding_rate: number;
  vat_rate: number;
  payout_notice: string;
  media_retention_days?: number;
};
export type AdminSettlement = {
  settings: PlatformSettings;
  month: string;
  totals: Balance & { gross: number; fee: number; net: number };
  creators: {
    id: string;
    name: string;
    email: string;
    status: string;
    business_type: string;
    verified: number;
    gross: number;
    fee: number;
    net: number;
    pending: number;
    available: number;
    requested: number;
    paid: number;
  }[];
  entries: SettlementEntry[];
  payouts: Payout[];
  payoutStats?: { paid_bank: number; paid_lama: number; waiting: number; count: number };
  closed: { period: string; creators: number; gross: number }[];
};
export type TaxCreator = TaxProfile & { id: string; name: string; email: string };
export type AdminTax = {
  year: string;
  creators: TaxCreator[];
  paid: {
    pd_id: string;
    count: number;
    amount: number;
    vat: number;
    income_tax: number;
    local_tax: number;
    payable: number;
  }[];
};
export type Member = User & {
  created_at: string;
  last_login_at: string | null;
  phone: string;
  order_count: number;
  spend: number;
  owned: number;
  favorites: number;
  watched: number;
  drama_count: number;
  tickets: number;
  channel_id: string | null;
  channel_name: string | null;
  channel_status: string | null;
  subscription_expires: string | null;
  settle_available: number;
  settle_paid: number;
  ping_paid?: number | null;
  ping_bonus?: number | null;
  custom_rate?: number | null;
};
export type MemberDetail = {
  member: Member;
  orders: (Order & { title: string | null })[];
  entitlements: { drama_id: string; title: string; image: string }[];
  history: { drama_id: string; title: string; episode: number; updated_at: string }[];
  dramas: Drama[];
  channel: Channel | null;
  tickets: { id: string; category: string; title: string; status: string; created_at: string }[];
  notes: { id: string; note: string; actor_name: string; created_at: string }[];
  sessions: number;
  settlement: Balance | null;
  payouts: Payout[];
  tax: TaxProfile | null;
  wallet?: Wallet;
  pingLedger?: PingLedgerRow[];
};
export type AdminPings = {
  settings: PlatformSettings;
  summary: {
    issued_paid: number;
    issued_bonus: number;
    spent: number;
    revoked: number;
    outstanding_paid: number;
    outstanding_bonus: number;
    liability: number;
  };
  charges: {
    channel: string;
    count: number;
    amount: number;
    channel_fee: number;
    pings: number;
    bonus: number;
  }[];
  sales: { count: number; gross: number; platform_fee: number; net: number };
  products: PingProduct[];
  rates: {
    id: string;
    name: string;
    email: string;
    role: string;
    platform_fee_rate: number | null;
    updated_at: string | null;
  }[];
  ledger: PingLedgerRow[];
  channels: { id: string; fee_rate: number }[];
};
// 서버 오류 중 화면이 다음 행동을 고를 수 있는 것(예: 핑 부족 → 충전)은 코드와 수치를 함께 받습니다.
export class ApiError extends Error {
  code?: string;
  need?: number;
  balance?: number;
  constructor(message: string, extra: { code?: string; need?: number; balance?: number } = {}) {
    super(message);
    Object.assign(this, extra);
  }
}
// 세션이 끝났을 때(다른 기기에서 로그아웃·비밀번호 변경 등) 앱 전체가 알 수 있도록 이벤트를 올립니다.
export const SESSION_EXPIRED_EVENT = 'shortping:session-expired';
export async function api<T = unknown>(url: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(url), {
      method,
      credentials: fetchCredentials,
      headers: { ...authHeaders(), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.', { code: 'network' });
  }
  const data = await res.json().catch(() => ({ error: '서버에 연결할 수 없습니다.' }));
  // 앱: 로그인 · 가입 응답의 토큰을 기억하고, 로그아웃하거나 세션이 끝나면 지웁니다.
  if (isNativeApp && url.startsWith('/auth/')) {
    if (res.ok && typeof data?.token === 'string' && data.token) {
      authToken.set(data.token);
      await refreshMediaToken();
    } else if (url === '/auth/logout' || (url === '/auth/me' && res.ok && !data?.user)) authToken.clear();
  }
  if (!res.ok) {
    if (res.status === 401 && url !== '/auth/me' && !url.startsWith('/auth/'))
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(data.error || '요청을 처리하지 못했습니다.', {
      code: res.status === 401 ? data.code || 'unauthorized' : data.code,
      need: data.need,
      balance: data.balance,
    });
  }
  return data;
}
// crypto.randomUUID는 HTTPS(또는 localhost)에서만 있습니다. LAN 주소(http://192.168…)로 폰에서
// 열어도 결제·작업 요청이 깨지지 않도록 v4 UUID를 직접 만듭니다.
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const won = (n: number | string) => new Intl.NumberFormat('ko-KR').format(Number(n) || 0) + '원';
export const pings = (n: number) => new Intl.NumberFormat('ko-KR').format(Number(n) || 0) + '핑';
export const day = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString('ko-KR') : '-';
export const moment = (value?: string | null) =>
  value ? new Date(value).toLocaleString('ko-KR') : '-';
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const count = (value: number | string) => {
  const n = Number(value) || 0;
  return n >= 10000 ? (n / 10000).toFixed(1) + '만' : n.toLocaleString('ko-KR');
};

// ── 라마(제작 포인트) · 숏핑 스튜디오(AI 제작) ─────────────────────────
// 라마 표시: 1 미만 단가(예: 초당 0.2라마)는 소수점으로, 그 밖은 정수로 보여 줍니다.
export const lama = (n: number) => {
  const v = Number(n) || 0;
  if (v > 0 && v < 1) return v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '라마';
  return new Intl.NumberFormat('ko-KR').format(Math.round(v)) + '라마';
};
export type LamaWallet = { paid: number; bonus: number; held: number; total: number };
export type LamaLedgerRow = {
  id: string;
  type: string;
  paid_delta: number;
  bonus_delta: number;
  held_delta: number;
  paid_after: number;
  bonus_after: number;
  held_after: number;
  memo: string;
  created_at: string;
  job_id?: string | null;
  user_name?: string;
  user_email?: string;
  actor_name?: string | null;
};
export type LamaProduct = {
  id: string;
  name: string;
  price: number;
  lama: number;
  bonus_lama: number;
  badge: string;
  active?: number;
  sort_order?: number;
  sold?: number;
};
export type LamaState = {
  wallet: LamaWallet;
  products: LamaProduct[];
  ledger: LamaLedgerRow[];
  policy: {
    unit_won: number;
    convert_min: number;
    convert_bonus_rate: number;
    withholding_rate: number;
    vat_rate: number;
    daily_limit: number;
  };
  convertible: number;
  demo: boolean;
};
export const lamaTypeLabel: Record<string, string> = {
  welcome: '체험 지급',
  charge: '충전',
  convert: '정산 전환',
  grant: '관리자 지급',
  revoke: '관리자 회수',
  hold: 'AI 작업 예약',
  spend: 'AI 작업 사용',
  release: '예약 반환',
};
export type Capability = 'text' | 'image' | 'video' | 'tts' | 'stt' | 'music' | 'sfx' | 'lipsync';
export const capabilityLabel: Record<Capability, string> = {
  text: '기획·대본',
  image: '이미지',
  video: '영상',
  tts: '음성',
  stt: '자막 인식',
  music: '배경음악',
  sfx: '효과음',
  lipsync: '입 모양 맞추기',
};
export const unitLabel: Record<string, string> = {
  per_1k_tokens: '1천 토큰',
  per_image: '장',
  per_second: '초',
  per_1k_chars: '1천 자',
  per_minute: '분',
};
export const tierLabel: Record<string, string> = { draft: '초안(저렴)', standard: '표준', premium: '고급' };
export type AiModelOption = {
  id: string;
  capability: Capability;
  label: string;
  provider: string;
  country: string;
  tier: string;
  unit: string;
  lama_per_unit: number;
  max_seconds: number;
  tags: string;
  cooling?: boolean;
};
export type StudioProject = {
  id: string;
  owner_id: string;
  drama_id: string | null;
  title: string;
  logline: string;
  genre: string;
  tone: string;
  style: string;
  synopsis: string;
  episode_count: number;
  episode_seconds: number;
  poster: string;
  status: string;
  exclude_cn?: number;
  autopilot?: string;
  bible?: string;
  season?: string;
  source_text?: string;
  subtitle_style?: string;
  narrator_model?: string;
  narrator_voice?: string;
  bgm?: string;
  bgm_volume?: number;
  trailer?: string;
  trailer_status?: string;
  meta?: string;
  resolution?: string;
  created_at: string;
  updated_at: string;
  episode_total?: number;
  composed?: number;
  spent?: number;
};
export type AiOverview = {
  terms_version: string;
  agreed_at: string | null;
  wallet: LamaWallet;
  enabled: boolean;
  models: AiModelOption[];
  genres: string[];
  projects: StudioProject[];
};
export type StudioCharacter = {
  id: string;
  name: string;
  role: string;
  description: string;
  look: string;
  image: string;
  voice_model: string;
  voice: string;
  voice_sample?: string;
  look_en?: string;
  look_en_src?: string;
  outfit?: string;
  refs?: string;
  voice_style?: string;
};
export type StudioLocation = { id: string; name: string; look: string; look_en: string; look_en_src: string; image: string; sort_order: number };
export type StudioRender = { id: string; kind: 'episode' | 'trailer'; target_id: string; status: string; progress: number; error: string; created_at: string };
export type StudioShot = {
  id: string;
  episode_id: string;
  sort_order: number;
  scene: string;
  visual: string;
  dialogue: string;
  speaker_id: string | null;
  camera: string;
  seconds: number;
  image: string;
  audio: string;
  audio_seconds: number;
  video: string;
  visual_en?: string;
  visual_en_src?: string;
  cast_ids?: string;
  location_id?: string | null;
  camera_move?: string;
  emotion?: string;
  speed?: number;
  narration?: number;
  seed?: number | null;
  seed_lock?: number;
  end_frame?: number;
  lipsync?: string;
  sfx?: string;
  sfx_prompt?: string;
  sfx_volume?: number;
  transition?: string;
  caption?: string | null;
};
export type StudioEpisode = {
  id: string;
  number: number;
  title: string;
  summary: string;
  status: string;
  video: string;
  duration: number;
  subtitles: string;
  exported_at: string | null;
  hook?: string;
  cliffhanger?: string;
  bgm?: string;
  bgm_volume?: number;
  thumbnail?: string;
  intro_card?: string;
  outro_card?: string;
  compose_progress?: number;
  compose_error?: string;
  script_version?: number;
  diagnosis?: string;
  shots: StudioShot[];
};
export type StudioJob = {
  id: string;
  kind: string;
  target_type: string;
  target_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  estimate_lama: number;
  charged_lama: number;
  error: string;
  created_at: string;
  finished_at: string | null;
  model_label: string | null;
  requested_model: string;
};
export type StudioAsset = {
  id: string;
  target_type: string;
  target_id: string;
  kind: string;
  url: string;
  model_label: string;
  created_at: string;
};
export type StudioProjectDetail = {
  project: StudioProject;
  characters: StudioCharacter[];
  episodes: StudioEpisode[];
  jobs: StudioJob[];
  assets: StudioAsset[];
  spent: number;
  drama: { id: string; title: string; status: string; review_note: string; tagline?: string; free?: number; episode_pings?: number; free_episodes?: number; image?: string } | null;
  wallet: LamaWallet;
  costs: { kind: string; jobs: number; lama: number; failed: number }[];
  autopilot: Autopilot | null;
  locations?: StudioLocation[];
  renders?: StudioRender[];
};
export type AutopilotChoice = { requested: string; tier: 'draft' | 'standard' | 'premium' };
export type Autopilot = {
  status: 'running' | 'paused' | 'done' | 'stopped';
  stage: string;
  message: string;
  cap: number;
  estimate?: number;
  includeVideo: boolean;
  started_at: string;
  updated_at: string;
  spent?: number;
  includeBible?: boolean;
  includeLipsync?: boolean;
  includeSfx?: boolean;
  includeMusic?: boolean;
  musicMood?: string;
  choices: Record<'text' | 'image' | 'tts' | 'video', AutopilotChoice> & Partial<Record<'music' | 'sfx' | 'lipsync', AutopilotChoice>>;
};
export type AutopilotEstimate = {
  stages: { stage: string; label: string; count: number; lama: number | null }[];
  total: number;
  unavailable: string[];
  wallet: LamaWallet;
};
export type StudioActivity = {
  active: number;
  running: number;
  failedLastHour: number;
  autopilots: (Partial<Autopilot> & { id: string; title: string })[];
  wallet: LamaWallet;
};
// 스튜디오 결과물(영상·음성)은 본인만 받을 수 있는 경로로 재생합니다. 이미지는 공개 경로 그대로.
export const studioMedia = (url: string) =>
  asset(!url ? '' : /\.(mp4|mp3|wav)$/.test(url) ? '/api/studio/media/' + url.split('/').pop() : url);
// 스튜디오 알림
export type AppNotification = { id: string; kind: string; title: string; body: string; link: string; read_at: string | null; created_at: string };
// 목소리 라이브러리
export type VoiceOption = { id: string; gender: string; age: string; tone: string; sample: string };
export type VoiceModel = { model: string; label: string; provider: string; voices: VoiceOption[] };
export type StudioVersion = { id: string; version: number; source: string; note: string; created_at: string; shots: Partial<StudioShot>[] };
export const parseJson = <T,>(raw: string | undefined | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
export type AiProviderView = {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  region: string;
  country: string;
  active: number;
  status: string;
  last_error: string;
  last_checked_at: string | null;
  key_hint: string;
  has_key: boolean;
  has_secret: boolean;
  sort_order: number;
  max_concurrency: number;
  monthly_budget_won: number;
  fail_streak: number;
  cooldown_until: string | null;
  month_cost: number;
  has_list: boolean;
};
export type AiRouteRule = { id: string; capability: Capability; tier: string; model_ids: string; active: number; updated_at: string };
export type AiAnalytics = {
  days: number;
  series: { day: string; jobs: number; failed: number; cost_won: number; lama: number }[];
  models: {
    model_ref: string;
    label: string;
    provider: string;
    country: string;
    capability: Capability;
    jobs: number;
    succeeded: number;
    failed: number;
    retries: number;
    success_rate: number;
    avg_seconds: number | null;
    cost_won: number;
    lama: number;
  }[];
};
export type AiProjectRow = {
  id: string;
  title: string;
  genre: string;
  status: string;
  episode_count: number;
  autopilot: string;
  exclude_cn: number;
  updated_at: string;
  drama_id: string | null;
  owner_name: string;
  owner_email: string;
  drama_status: string | null;
  composed: number;
  shots: number;
  spent: number;
  cost_won: number;
  active: number;
};
export type AiSafetyRow = { id: string; user_id: string; user_name: string; user_email: string; term: string; excerpt: string; kind: string; created_at: string };
export type AiModelRow = {
  id: string;
  provider_id: string;
  provider_name: string;
  kind: string;
  capability: Capability;
  model_id: string;
  label: string;
  tier: string;
  unit: string;
  cost_usd: number;
  price_lama: number;
  lama_per_unit: number;
  tags: string;
  max_seconds: number;
  image_input: number;
  active: number;
  priority: number;
  notes: string;
};
export type AdminAi = {
  settings: PlatformSettings & Record<string, number | string>;
  catalog: Record<string, { label: string; capabilities: Capability[]; base: string; secretLabel: string }>;
  presets: { kind: string; name: string; country: string; base_url: string; models: number; capabilities: Capability[] }[];
  tags: string[];
  capabilities: Record<string, string>;
  providers: AiProviderView[];
  routes: AiRouteRule[];
  models: AiModelRow[];
  usage: {
    month: { jobs: number; cost_won: number; lama: number; failed: number; active: number };
    byModel: { model_ref: string; label: string | null; capability: string; jobs: number; cost_won: number; lama: number; failed: number }[];
    byUser: { user_id: string; name: string; email: string; jobs: number; lama: number; cost_won: number }[];
  };
  jobs: {
    id: string;
    user_id: string;
    user_name: string;
    kind: string;
    capability: string;
    status: string;
    requested_model: string;
    tier: string;
    estimate_lama: number;
    charged_lama: number;
    cost_won: number;
    error: string;
    // 공급사 오류 원문(관리자 전용). PD 화면에는 error(정리된 문구)만 보입니다.
    error_detail?: string;
    attempts: number;
    created_at: string;
    finished_at: string | null;
    billed: number;
    model_label: string | null;
    provider_name: string | null;
  }[];
  limits: { id: string; name: string; email: string; role: string; daily_lama: number | null; monthly_lama: number | null; blocked: number }[];
};
export type AdminLama = {
  summary: {
    outstanding_paid: number;
    outstanding_bonus: number;
    held: number;
    charge_count: number;
    charge_amount: number;
    charge_fee: number;
    convert_count: number;
    convert_amount: number;
    convert_lama: number;
    spent_lama: number;
    spent_won: number;
    ai_cost_won: number;
  };
  flows: { type: string; paid: number; bonus: number; count: number }[];
  products: LamaProduct[];
  wallets: { id: string; name: string; email: string; role: string; paid: number; bonus: number; held: number }[];
  ledger: LamaLedgerRow[];
};
export const jobKindLabel: Record<string, string> = {
  plan: '기획안',
  script: '대본',
  character_image: '인물 이미지',
  shot_image: '스토리보드',
  shot_tts: '대사 음성',
  shot_video: '컷 영상',
  poster: '포스터',
  tool_poster: 'AI 포스터(업로드 작품)',
  tool_subtitles: '자동 자막',
  rewrite_shot: '컷 AI 고치기',
  voice_sample: '목소리 미리듣기',
  playground: '관리자 시험',
  adapt: '원작 각색',
  bible: '작품 설정집',
  season: '회차별 훅·반전 설계',
  diagnose: '대본 진단',
  rewrite_range: '구간 다시 쓰기',
  metadata: '제목·소개 제안',
  translate: '영어 묘사 준비(무료)',
  character_ref: '인물 참고 이미지',
  location_image: '장소 이미지',
  shot_image_edit: '이미지 부분 수정',
  shot_lipsync: '입 모양 맞추기',
  shot_sfx: '효과음',
  music: '배경음악',
  thumb_bg: '썸네일 배경',
  voice_preview: '목소리 샘플(무료)',
};
export const jobStatusLabel: Record<string, string> = {
  queued: '대기 중',
  running: '만드는 중',
  succeeded: '완료',
  failed: '실패',
  canceled: '취소',
};
