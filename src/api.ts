export type Role = 'admin' | 'pd' | 'viewer';
export type HomeAppearance = {
  theme: 'cinematic' | 'bright' | 'fantasy' | 'classic' | 'medieval';
  image: string;
  eyebrow: string;
  headline: string;
  highlight: string;
  description: string;
  caption: string;
  copyright: string;
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
};
export type Episode = {
  id: string;
  number: number;
  title: string;
  duration: number;
  is_demo: number;
  locked: boolean;
  owned?: boolean;
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
export async function api<T = unknown>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    credentials: 'include',
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: '서버에 연결할 수 없습니다.' }));
  if (!res.ok)
    throw new ApiError(data.error || '요청을 처리하지 못했습니다.', {
      code: data.code,
      need: data.need,
      balance: data.balance,
    });
  return data;
}
export const won = (n: number) => new Intl.NumberFormat('ko-KR').format(n) + '원';
export const pings = (n: number) => new Intl.NumberFormat('ko-KR').format(Number(n) || 0) + '핑';
export const day = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString('ko-KR') : '-';
export const moment = (value?: string | null) =>
  value ? new Date(value).toLocaleString('ko-KR') : '-';
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const count = (n: number) =>
  n >= 10000 ? (n / 10000).toFixed(1) + '만' : n.toLocaleString();
