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
  price: number;
  episode_price: number;
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
export type Detail = Drama & { episodes: Episode[]; entitled: boolean };
export type Order = {
  id: string;
  title: string | null;
  kind: string;
  episode?: number | null;
  amount: number;
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
  subscription: { expires_at: string; auto_renew: number } | null;
};
export const emptyLibrary: Library = {
  favorites: [],
  purchases: [],
  channels: [],
  episodes: [],
  history: [],
  orders: [],
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
  pg_fee_rate: number;
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
  default_drama_price: number;
  default_free_episodes: number;
  default_episode_price: number;
  platform_fee_rate: number;
  pg_fee_rate: number;
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
};
export async function api<T = unknown>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    credentials: 'include',
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: '서버에 연결할 수 없습니다.' }));
  if (!res.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}
export const won = (n: number) => new Intl.NumberFormat('ko-KR').format(n) + '원';
export const day = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString('ko-KR') : '-';
export const moment = (value?: string | null) =>
  value ? new Date(value).toLocaleString('ko-KR') : '-';
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const count = (n: number) =>
  n >= 10000 ? (n / 10000).toFixed(1) + '만' : n.toLocaleString();
