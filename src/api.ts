export type Role = 'admin' | 'pd' | 'viewer';
export type User = { id: string; name: string; email: string; role: Role; status: string };
export type Drama = {
  id: string;
  owner_id: string;
  title: string;
  tagline: string;
  synopsis: string;
  genre: string;
  image: string;
  accent: string;
  badge: string;
  status: string;
  price: number;
  free_episodes: number;
  views: number;
  episode_count: number;
  review_note: string;
};
export type Episode = {
  id: string;
  number: number;
  title: string;
  duration: number;
  is_demo: number;
  locked: boolean;
};
export type Detail = Drama & { episodes: Episode[]; entitled: boolean };
export type Order = {
  id: string;
  title: string | null;
  kind: string;
  amount: number;
  status: string;
  created_at: string;
};
export type Library = {
  favorites: string[];
  purchases: string[];
  history: { drama_id: string; episode: number; progress: number; updated_at: string }[];
  orders: Order[];
  subscription: { expires_at: string; auto_renew: number } | null;
};
export const emptyLibrary: Library = {
  favorites: [],
  purchases: [],
  history: [],
  orders: [],
  subscription: null,
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
export const count = (n: number) =>
  n >= 10000 ? (n / 10000).toFixed(1) + '만' : n.toLocaleString();
