// 앱(안드로이드·iOS) 연결: 웹에서는 지금처럼 같은 주소의 서버와 쿠키로 로그인하고,
// 앱에서는 앱에 들어 있는 화면이 운영 서버(VITE_API_ORIGIN)와 토큰으로 통신합니다.
//  - API 요청: Authorization: Bearer <로그인 토큰>
//  - 영상·음성·자막처럼 태그(<video>, <audio>, <track>)로 불러오는 주소: 짧게 유효한 미디어 토큰(?mt=)
//  - 서버에 올린 이미지(/uploads/…): 운영 서버 주소를 앞에 붙여 불러옴
type CapacitorGlobal = { isNativePlatform?: () => boolean };
const cap = typeof window !== 'undefined' ? (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor : undefined;
export const isNativeApp = !!cap?.isNativePlatform?.();
export const API_ORIGIN = isNativeApp ? String(import.meta.env.VITE_API_ORIGIN || '').replace(/\/+$/, '') : '';

const TOKEN_KEY = 'shortping.auth';
let memoryToken = '';
export const authToken = {
  get(): string {
    if (!isNativeApp) return '';
    try {
      return localStorage.getItem(TOKEN_KEY) || memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(token: string) {
    memoryToken = token;
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // 저장 공간을 쓸 수 없으면 앱을 켜 둔 동안만 기억합니다.
    }
  },
  clear() {
    memoryToken = '';
    mediaToken = '';
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // 무시
    }
  },
};

export const apiUrl = (path: string) => API_ORIGIN + '/api' + path;
// 앱에서 보내는 요청 머리글(웹에서는 빈 값: 쿠키로 로그인)
export function authHeaders(): Record<string, string> {
  if (!isNativeApp) return {};
  const token = authToken.get();
  return token ? { 'X-Client': 'app', Authorization: 'Bearer ' + token } : { 'X-Client': 'app' };
}
export const fetchCredentials: RequestCredentials = isNativeApp ? 'omit' : 'include';

let mediaToken = '';
let mediaTimer: ReturnType<typeof setInterval> | null = null;
// 미디어 토큰을 새로 받습니다(로그인 직후·앱 시작 시, 이후 40분마다).
export async function refreshMediaToken() {
  if (!isNativeApp) return;
  if (!authToken.get()) {
    mediaToken = '';
    return;
  }
  try {
    const res = await fetch(apiUrl('/auth/media-token'), { headers: authHeaders(), credentials: 'omit' });
    if (res.ok) mediaToken = String((await res.json()).token || '');
    else if (res.status === 401) mediaToken = '';
  } catch {
    // 네트워크가 잠깐 끊겨도 기존 토큰(유효 기간 안)을 그대로 씁니다.
  }
  if (!mediaTimer) mediaTimer = setInterval(() => void refreshMediaToken(), 40 * 60 * 1000);
}

// 화면에 넣는 파일 주소를 앱에서도 열리게 바꿉니다. 웹에서는 받은 주소를 그대로 돌려줍니다.
export function asset(url?: string | null): string {
  if (!url) return '';
  if (!API_ORIGIN || !url.startsWith('/') || url.startsWith('//')) return url;
  if (url.startsWith('/api/')) return API_ORIGIN + url + (mediaToken ? (url.includes('?') ? '&' : '?') + 'mt=' + encodeURIComponent(mediaToken) : '');
  if (url.startsWith('/uploads/')) return API_ORIGIN + url;
  // /images, /avatars, /demo 처럼 앱에 함께 들어 있는 파일은 그대로
  return url;
}
