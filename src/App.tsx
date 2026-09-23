import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { apiUrl, authHeaders, fetchCredentials } from './platform';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bell,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Clapperboard,
  Coins,
  Clock3,
  Crown,
  Flame,
  Heart,
  Home,
  LockKeyhole,
  LogOut,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Ticket,
  UserRound,
  X,
  Zap,
  MessageCircle,
  Radio,
  Star,
  Megaphone,
} from 'lucide-react';
import {
  api,
  ApiError,
  count,
  defaultHomeAppearance,
  defaultHomeLayout,
  defaultHomeStyle,
  type CopyKey,
  type HomeLayout,
  emptyLibrary,
  lama,
  orderKindLabel,
  pings,
  SESSION_EXPIRED_EVENT,
  uuid,
  won,
  type Detail,
  type Drama,
  type HomeAppearance,
  type Channel,
  type Library,
  type Role,
  type User,
} from './api';
import { asset } from './platform';
// 관리 화면(스튜디오·관리자·AI 제작)은 시청자에게 필요 없으므로 필요할 때만 불러옵니다.
const Studio = lazy(() => import('./Studio'));
import {
  ChannelListPage,
  ChannelPage,
  ChannelLogo,
  FeaturedChannels,
} from './Channels';
import Support from './Support';
import AccountSettings, { Avatar } from './AccountSettings';
import PingsPage from './Pings';
import NotificationBell from './viewer/NotificationBell';
import TrailerModal from './viewer/TrailerModal';
import './viewer/viewer.css';

type Route = { page: string; id?: string; episode?: number };
// 결제 대상: 숏핑 패스(원화 구독) 또는 핑으로 열기(회차 한 편 / episode 없으면 작품 전체).
export type Purchase = 'subscription' | { drama: Detail; episode?: number };
const isEpisodeBuy = (p: Purchase): p is { drama: Detail; episode: number } =>
  typeof p === 'object' && !!p.episode;
const unlockPings = (p: Exclude<Purchase, 'subscription'>) =>
  p.episode ? p.drama.episode_pings : p.drama.title_pings;
const readRoute = (): Route => {
  const p = location.hash.replace('#', '').split('/').filter(Boolean);
  return { page: p[0] || 'home', id: p[1], episode: Number(p[2]) || 1 };
};
// ── 앱 안 이동 기록 ─────────────────────────────────────────────
// 각 기록 항목의 history.state에 앱 안에서 몇 번째 화면인지(spIdx)와 직전 화면(spPrev)을 남깁니다.
// 앱 안의 ‘뒤로’ 버튼은 이 값으로 브라우저 뒤로 가기를 쓸지, 상위 화면으로 대체 이동할지 정합니다.
type NavState = { spIdx: number; spPrev?: string };
const currentHash = () => location.hash.replace(/^#\/?/, '');
const readNavState = (): NavState | null => {
  const s = history.state as NavState | null;
  return s && typeof s.spIdx === 'number' ? s : null;
};
let navIdx = readNavState()?.spIdx ?? 0;
let lastHash = currentHash();
if (!readNavState()) history.replaceState({ ...(history.state || {}), spIdx: navIdx }, '');
window.addEventListener('hashchange', () => {
  const s = readNavState();
  if (s) navIdx = s.spIdx; // 뒤로·앞으로 이동이거나 replace로 바꾼 항목
  else {
    // 새로 쌓인 항목(링크·navigate·주소창 입력)
    navIdx += 1;
    history.replaceState({ ...(history.state || {}), spIdx: navIdx, spPrev: lastHash }, '');
  }
  lastHash = currentHash();
});
export const navigate = (page: string, opts: { replace?: boolean } = {}) => {
  if (opts.replace) {
    // 현재 기록 항목을 바꿉니다(회차 이동 등). 뒤로 가기가 회차마다 쌓이지 않습니다.
    const prev = readNavState();
    history.replaceState({ spIdx: navIdx, spPrev: prev?.spPrev }, '', '#/' + page);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  location.hash = '/' + page;
};
// 앱 안에서 들어온 화면이면 브라우저 뒤로 가기를, 바로 들어온 화면(딥링크)이면 상위 화면으로 이동합니다.
export const goBack = (fallback: string) => {
  if (navIdx > 0) history.back();
  else navigate(fallback, { replace: true });
};
// 직전 화면이 정확히 target일 때만 뒤로 가기를 쓰고, 아니면 target으로 현재 항목을 바꿉니다.
export const backTo = (target: string) => {
  if (navIdx > 0 && readNavState()?.spPrev === target) history.back();
  else navigate(target, { replace: true });
};
// 로그인 후 돌아올 곳. 앱 안의 해시 경로만 허용합니다.
const safeNext = (s?: string) => {
  if (!s) return '';
  try {
    const v = decodeURIComponent(s);
    return /^[a-z][\w\-/]*$/i.test(v) && !/^login\b/.test(v) ? v : '';
  } catch {
    return '';
  }
};
export const loginWithReturn = (next?: string) => {
  const target = next ?? currentHash();
  navigate('login' + (target && !/^login\b/.test(target) ? '/' + encodeURIComponent(target) : ''));
};
// 썸네일 A/B: 카드에서 작품을 열면 어떤 후보 이미지를 보고 눌렀는지 한 번만 서버에 알립니다.
const THUMB_KEY = 'sp:thumb:';
const rememberThumb = (d: ViewerDrama) => {
  if (!d.thumb_id) return;
  try {
    sessionStorage.setItem(THUMB_KEY + d.id, d.thumb_id);
  } catch {
    /* 저장소를 못 쓰면 집계만 빠집니다. */
  }
};
const consumeThumb = (id: string) => {
  try {
    const t = sessionStorage.getItem(THUMB_KEY + id);
    if (t) sessionStorage.removeItem(THUMB_KEY + id);
    return t || '';
  } catch {
    return '';
  }
};
// 다음 회차 자동 재생 표시. 끝난 회차에서 넘어온 경우에만(1분 이내) 새 회차를 바로 재생합니다.
const AUTOPLAY_KEY = 'sp:autoplay';
const markAutoplay = (id: string, n: number) => {
  try {
    sessionStorage.setItem(AUTOPLAY_KEY, JSON.stringify({ key: `${id}/${n}`, at: Date.now() }));
  } catch {
    /* 자동 재생 표시를 못 남기면 일시정지 상태로 열립니다. */
  }
};
const takeAutoplay = (id: string, n: number) => {
  try {
    const raw = sessionStorage.getItem(AUTOPLAY_KEY);
    if (!raw) return false;
    const v = JSON.parse(raw) as { key: string; at: number };
    if (v.key !== `${id}/${n}`) return false;
    sessionStorage.removeItem(AUTOPLAY_KEY);
    return Date.now() - v.at < 60000;
  } catch {
    return false;
  }
};
// 서버가 새로 내려 주는 필드(api.ts 타입에 아직 없는 것)
type ViewerDrama = Drama & {
  thumb_id?: string;
  hashtags?: string;
  trailer?: string;
  subtitle_style?: string;
};
type ViewerEpisode = Detail['episodes'][number] & {
  thumbnail?: string;
  review_status?: 'approved' | 'draft' | 'pending' | 'rejected' | 'scheduled';
  publish_at?: string | null;
};
type ViewerDetail = Omit<Detail, 'episodes'> &
  Omit<ViewerDrama, keyof Drama> & { episodes: ViewerEpisode[] };
const tagsOf = (d: { hashtags?: string }) =>
  (d.hashtags || '')
    .split(',')
    .map((t) => t.trim().replace(/^#+/, ''))
    .filter(Boolean);
const reviewLabel: Record<string, string> = {
  draft: '작성 중',
  pending: '검수 대기',
  rejected: '반려',
  scheduled: '예약 공개',
};
const subtitleClass = (raw?: string) => {
  if (!raw) return '';
  try {
    const s = JSON.parse(raw) as { size?: string; background?: string };
    const size = ['s', 'm', 'l', 'xl'].includes(s.size || '') ? s.size : '';
    const bg = ['none', 'box', 'shadow'].includes(s.background || '') ? s.background : '';
    return [size && 'sub-size-' + size, bg && 'sub-bg-' + bg].filter(Boolean).join(' ');
  } catch {
    return '';
  }
};
const genres = ['전체', '로맨스', '스릴러', '판타지', '코미디', '청춘'];
const roleLabel = { admin: '슈퍼관리자', pd: '업로더 · PD', viewer: '시청자' };
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={'brand ' + (small ? 'small' : '')}>
      <img src="/icon.svg" alt="" />
      <b>
        숏핑<span>shortping</span>
      </b>
    </span>
  );
}
export function Poster({ d, rank, onClick }: { d: Drama; rank?: number; onClick?: () => void }) {
  return (
    <button
      className="poster-card"
      onClick={
        onClick ||
        (() => {
          rememberThumb(d);
          navigate('drama/' + d.id);
        })
      }
      aria-label={d.title + ' 작품 보기'}
    >
      <div className="poster">
        <img src={asset(d.image)} alt={d.title + ' 드라마 포스터'} loading="lazy" />
        <span className={'badge ' + (d.badge === 'NEW' ? 'new' : '')}>{d.badge}</span>
        <span className="poster-wordmark">SHORTPING ORIGINAL</span>
        <div className={'poster-title art-' + d.id}>{d.title}</div>
        <span className="poster-bottom">
          {d.genre} · {d.episode_count}부작
        </span>
        {rank && <span className="rank">{rank}</span>}
      </div>
      <strong>{d.title}</strong>
      <span className="card-meta">
        {d.genre} <i /> {count(d.views)} 시청
      </span>
    </button>
  );
}
export default function App() {
  const [route, setRoute] = useState<Route>(readRoute),
    [dramas, setDramas] = useState<Drama[]>([]),
    [user, setUser] = useState<User | null>(null),
    [lib, setLib] = useState<Library>(emptyLibrary),
    [config, setConfig] = useState({
      demo: false,
      androidUrl: null as string | null,
      iosUrl: null as string | null,
      homeAppearance: defaultHomeAppearance,
      homeLayout: defaultHomeLayout as HomeLayout,
      subscriptionPrice: 7900,
      subscriptionDays: 30,
      defaultFreeEpisodes: 3,
      pingUnitWon: 100,
      defaultEpisodePings: 5,
      titleUnlockDiscount: 20,
    }),
    [channels, setChannels] = useState<Channel[]>([]),
    [ready, setReady] = useState(false),
    [loadError, setLoadError] = useState(''),
    [toast, setToast] = useState(''),
    [modal, setModal] = useState<{ title: string; text: string } | null>(null),
    [genre, setGenre] = useState('전체'),
    [feed, setFeed] = useState('추천'),
    [query, setQuery] = useState(''),
    [heroIndex, setHeroIndex] = useState(0),
    [checkout, setCheckout] = useState<Purchase | null>(null),
    [busy, setBusy] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const notify = useCallback((s: string) => setToast(s), []);
  const reloadLibrary = useCallback(async () => {
    try {
      setLib(await api<Library>('/library'));
    } catch (e) {
      // 일시적인 네트워크 오류로 찜·지갑이 사라져 보이지 않게, 로그인이 풀린 경우에만 비웁니다.
      if ((e as ApiError).code === 'unauthorized') setLib(emptyLibrary);
    }
  }, []);
  const reloadCatalog = useCallback(async () => setDramas(await api<Drama[]>('/dramas')), []);
  const reloadChannels = useCallback(async () => {
    try {
      setChannels(await api<Channel[]>('/channels'));
    } catch {
      setChannels([]);
    }
  }, []);
  useEffect(() => {
    Promise.all([
      api<{ user: User | null }>('/auth/me'),
      api<typeof config>('/config'),
      api<Drama[]>('/dramas'),
      api<Channel[]>('/channels').catch(() => [] as Channel[]),
    ])
      .then(async ([u, c, d, ch]) => {
        setUser(u.user);
        setConfig((cur) => ({ ...cur, ...c, homeLayout: c.homeLayout || defaultHomeLayout }));
        setDramas(d);
        setChannels(ch);
        // 라이브러리(시청 기록·주문)까지 받은 뒤 화면을 열어야 딥링크 진입 시 이어보기가 동작합니다.
        if (u.user) await reloadLibrary();
      })
      .catch((e) => setLoadError(e.message))
      .finally(() => setReady(true));
  }, [reloadLibrary]);
  useEffect(() => {
    // 다른 기기에서 로그아웃하거나 비밀번호를 바꿔 세션이 끝나면 로그인 화면으로 보냅니다.
    const fn = () => {
      setUser((current) => {
        if (current) {
          setLib(emptyLibrary);
          setToast('로그인이 만료되었어요. 다시 로그인해 주세요.');
          loginWithReturn();
        }
        return null;
      });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, fn);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, fn);
  }, []);
  useEffect(() => {
    const fn = () => {
      const next = readRoute();
      setRoute(next);
      // 검색어는 검색·탐색 화면에서만 유효합니다. 홈으로 돌아오면 피드가 검색어로 걸러지지 않게 합니다.
      if (!['search', 'explore'].includes(next.page)) setQuery('');
      window.scrollTo({ top: 0, behavior: 'instant' });
    };
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  // 추천 배너 자동 넘김: 관리자 설정(0 = 기본 6.5초, -1 = 끄기, 그 밖은 초)
  const heroSetting = config.homeLayout?.hero || defaultHomeLayout.hero;
  const heroCount =
    heroSetting.mode === 'manual' && heroSetting.ids.some((id) => dramas.some((d) => d.id === id))
      ? heroSetting.ids.filter((id) => dramas.some((d) => d.id === id)).length
      : Math.min(3, dramas.length);
  useEffect(() => {
    const n = heroCount;
    const every = heroSetting.interval > 0 ? heroSetting.interval * 1000 : 6500;
    if (route.page !== 'home' || n < 2 || heroSetting.interval < 0) return;
    const t = setInterval(() => setHeroIndex((i) => (i + 1) % n), every);
    return () => clearInterval(t);
  }, [route.page, heroCount, heroSetting.interval]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModal(null);
        setCheckout(null);
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);
  const login = async (role: Role) => {
    try {
      setBusy(true);
      const r = await api<{ user: User }>('/auth/demo', 'POST', { role });
      setUser(r.user);
      await reloadLibrary();
      const next = safeNext(readRoute().page === 'login' ? readRoute().id : '');
      if (next) backTo(next);
      else navigate(role === 'viewer' ? 'home' : 'studio');
      notify(roleLabel[role] + '로 로그인했어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    try {
      await api('/auth/logout', 'POST');
      setUser(null);
      setLib(emptyLibrary);
      navigate('home');
      notify('로그아웃했어요.');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const favorite = async (d: Drama) => {
    if (!user) {
      loginWithReturn();
      return;
    }
    try {
      const active = !lib.favorites.includes(d.id);
      await api('/favorites/' + d.id, 'POST', { active });
      await reloadLibrary();
      notify(active ? '내 찜 목록에 담았어요.' : '찜 목록에서 삭제했어요.');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const buy = (d: Purchase) => {
    if (!user) {
      // 로그인 후 보던 회차(또는 작품)로 돌아옵니다.
      loginWithReturn();
      return;
    }
    setCheckout(d);
  };
  // 충전 화면에서 돌아올 곳(지금 보던 작품·회차)을 주소에 담아 보냅니다.
  const goCharge = (target?: Purchase | null) => {
    setCheckout(null);
    const back =
      target && target !== 'subscription'
        ? target.episode
          ? `watch/${target.drama.id}/${target.episode}`
          : `drama/${target.drama.id}`
        : '';
    navigate('pings' + (back ? '/' + back : ''));
  };
  const pay = async () => {
    if (!checkout || busy) return;
    setBusy(true);
    try {
      if (checkout === 'subscription') {
        await api('/checkout', 'POST', {
          kind: 'subscription',
          idempotencyKey: uuid(),
        });
        await reloadLibrary();
        setCheckout(null);
        notify('테스트 결제가 완료됐어요. 모든 작품을 마음껏 보세요!');
      } else {
        const r = await api<{ pings: number; unlocked: number; wallet: { total: number } }>(
          '/pings/unlock',
          'POST',
          {
            dramaId: checkout.drama.id,
            episode: checkout.episode,
            all: !checkout.episode,
            idempotencyKey: uuid(),
          },
        );
        await reloadLibrary();
        setCheckout(null);
        notify(
          (checkout.episode
            ? `${checkout.episode}화를 열었어요.`
            : `남은 ${r.unlocked}개 회차를 모두 열었어요.`) +
            ` ${pings(r.pings)} 사용 · 남은 핑 ${pings(r.wallet.total)}`,
        );
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'insufficient_pings') {
        await reloadLibrary();
        notify(e.message);
      } else notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const info = (title: string, text: string) => setModal({ title, text });
  const appLink = (platform: 'android' | 'ios') => {
    const url = platform === 'android' ? config.androidUrl : config.iosUrl;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else
      info(
        '앱으로 만날 날을 기다려 주세요',
        '숏핑의 Android · iOS 앱은 출시 준비 중이에요. 지금은 모바일 브라우저에서 이용할 수 있고, 브라우저 메뉴의 ‘홈 화면에 추가’로 더 편하게 만나보세요.',
      );
  };
  // 히어로 배너는 조회수 상위 3편(서버가 views 순으로 정렬해 줌). 시드 작품 ID에 의존하지 않습니다.
  // 관리자가 '직접 편성'으로 고른 작품이 있으면 그 순서대로, 없으면 조회수 상위 3편
  const homeLayout = config.homeLayout || defaultHomeLayout;
  const pickedHeroes =
    homeLayout.hero.mode === 'manual'
      ? homeLayout.hero.ids.map((id) => dramas.find((d) => d.id === id)).filter((d): d is Drama => !!d)
      : [];
  const heroes = pickedHeroes.length ? pickedHeroes : dramas.slice(0, 3);
  const heroPos = heroIndex % Math.max(1, heroes.length);
  // 관리자가 정한 링크 열기: https 주소는 새 창, 그 밖은 앱 안 화면(예: membership, drama/작품ID)
  const openHomeLink = (link: string) => {
    if (/^https:\/\//.test(link)) window.open(link, '_blank', 'noopener,noreferrer');
    else if (link) navigate(link.replace(/^#?\/?/, ''));
  };
  const hero = heroes[heroPos] || dramas[0];
  // 해시태그로도 찾을 수 있게 합니다. ‘#로맨스’처럼 #을 붙여 입력해도 됩니다.
  const needle = query.trim().toLowerCase().replace(/^#+/, '');
  const filtered = dramas.filter(
    (d) =>
      (genre === '전체' || d.genre === genre) &&
      (!needle ||
        `${d.title} ${d.genre} ${d.tagline} ${tagsOf(d as ViewerDrama).join(' ')}`
          .toLowerCase()
          .includes(needle)),
  );
  const feedItems =
    feed === '신작'
      ? [...filtered].sort((a, b) => Number(b.badge === 'NEW') - Number(a.badge === 'NEW'))
      : feed === '완결'
        ? filtered.filter((d) => d.badge === '완결')
        : filtered;
  const newest = [...dramas].sort(
    (a, b) =>
      new Date(b.published_at || b.created_at).getTime() -
      new Date(a.published_at || a.created_at).getTime(),
  );
  // 무료 추천: 전 회차 무료이거나 기본 무료 회차보다 더 많이 풀어 둔 작품
  const freePicks = dramas.filter((d) => !!d.free || d.free_episodes > config.defaultFreeEpisodes);
  const featuredChannels = channels.filter((c) => c.featured);
  const followedChannels = channels.filter((c) => lib.channels.includes(c.id));
  const activeNav =
    route.page === 'settings' || route.page === 'pings'
      ? 'my'
      : ['drama', 'watch'].includes(route.page)
        ? 'home'
        : route.page === 'channel'
          ? 'channels'
          : route.page;
  const managing = route.page === 'studio' && !!user && user.role !== 'viewer';
  // PC 여백: 관리자가 정한 배경 사진·초점·어둡기와 카피 글자 색을 CSS 변수로 넘깁니다(빈 값이면 기본 색).
  const homeStyle = { ...defaultHomeStyle, ...(config.homeAppearance.style || {}) };
  const copyColor = (k: CopyKey) => (homeStyle.colors?.[k] ? { [`--copy-${k}`]: homeStyle.colors[k] } : {});
  const siteStyle = {
    '--home-wallpaper': `url("${asset(config.homeAppearance.image)}")`,
    '--home-focus': homeStyle.focus,
    '--home-shade': String(Math.min(80, Math.max(0, Number(homeStyle.shade) || 0)) / 100),
    ...copyColor('eyebrow'),
    ...copyColor('headline'),
    ...copyColor('highlight'),
    ...copyColor('description'),
    ...copyColor('caption'),
    ...copyColor('copyright'),
  } as CSSProperties;
  return (
    <div className={managing ? 'site-layout management-layout' : 'site-layout'} style={siteStyle}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <aside className="left-rail">
        <a href="#/home" className="rail-brand">
          <Brand />
        </a>
        <div className={`rail-copy copy-${homeStyle.size}${homeStyle.box ? ' boxed' : ''}${homeStyle.shadow ? '' : ' no-shadow'}`}>
          <span className="eyebrow">
            <span /> {config.homeAppearance.eyebrow}
          </span>
          <h1>
            {config.homeAppearance.headline}
            <br />
            <em>{config.homeAppearance.highlight}</em>
          </h1>
          <p>{config.homeAppearance.description}</p>
        </div>
        <div className="rail-art">
          <div className="art-orbit" />
          <div className="rail-photo photo-back">
            <img src="/images/spring.webp" alt="다시, 스물아홉 오리지널 드라마" />
            <b>
              다시,
              <br />
              스물아홉
            </b>
          </div>
          <div className="rail-photo photo-front">
            <img src="/images/hero.webp" alt="자정의 계약 오리지널 드라마" />
            <span>SHORTPING ORIGINAL</span>
            <b>자정의 계약</b>
          </div>
          <span className="floating-chip">
            <Zap size={14} fill="currentColor" /> 1분이면 충분해
          </span>
          <span className="art-spark">✳</span>
        </div>
        <div className={'rail-caption' + (homeStyle.shadow ? '' : ' no-shadow')}>
          <span className="green-dot" /> {config.homeAppearance.caption}
        </div>
        <small className="rail-copyright">{config.homeAppearance.copyright}</small>
      </aside>
      <div
        className={'app-shell ' + (['watch'].includes(route.page) ? 'watch-shell' : '')}
        ref={shell}
      >
        {route.page !== 'watch' && !managing && (
          <header className="app-header">
            <a href="#/home" aria-label="숏핑 홈">
              <Brand small />
            </a>
            <div className="header-actions">
              <button aria-label="검색" onClick={() => navigate('search')}>
                <Search size={21} />
              </button>
              {user ? (
                <NotificationBell key={user.id} />
              ) : (
                <button
                  className="notification-button"
                  aria-label="알림"
                  onClick={() =>
                    info(
                      '숏핑에서 온 소식',
                      `숏핑에 오신 것을 환영해요! 작품마다 첫 ${config.defaultFreeEpisodes}개 회차 안팎을 무료로 만나보세요. 새로운 이야기가 매일 당신을 기다립니다.`,
                    )
                  }
                >
                  <Bell size={20} />
                  <i />
                </button>
              )}
              {user && (
                <button
                  className="wallet-chip"
                  onClick={() => navigate('pings')}
                  aria-label={'보유 핑 ' + lib.wallet.total + '핑 · 충전하기'}
                >
                  <Coins size={15} />
                  {new Intl.NumberFormat('ko-KR').format(lib.wallet.total)}
                </button>
              )}
              {user ? (
                <button className="avatar" onClick={() => navigate('my')} aria-label="내 계정">
                  <Avatar user={user} />
                </button>
              ) : (
                <button className="login-link" onClick={() => navigate('login')}>
                  로그인
                </button>
              )}
            </div>
          </header>
        )}
        {!ready ? (
          <div className="loading">
            <span className="spinner" />
            이야기를 불러오고 있어요
          </div>
        ) : loadError ? (
          <Empty
            title="서버에 연결하지 못했어요"
            text={loadError}
            action={() => location.reload()}
            label="다시 시도"
          />
        ) : (
          <>
            {route.page === 'home' && (
              <>
                {homeLayout.notice && (
                  <button
                    type="button"
                    className={'home-notice tone-' + homeLayout.notice.tone + (homeLayout.notice.link ? '' : ' static')}
                    onClick={() => homeLayout.notice?.link && openHomeLink(homeLayout.notice.link)}
                  >
                    <Megaphone size={15} />
                    <span>{homeLayout.notice.text}</span>
                    {homeLayout.notice.link && <ChevronRight size={15} />}
                  </button>
                )}
                <nav className="feed-tabs">
                  <a className="desktop-feed-brand" href="#/home" aria-label="숏핑 홈">
                    <Brand small />
                  </a>
                  {['추천', '인기', '신작', '완결'].map((t) => (
                    <button
                      key={t}
                      className={feed === t ? 'active' : ''}
                      aria-pressed={feed === t}
                      onClick={() => {
                        setFeed(t);
                        setGenre('전체');
                      }}
                    >
                      {t}
                      {t === '신작' && <i />}
                    </button>
                  ))}
                  <button className="original-tab" onClick={() => navigate('explore')}>
                    오리지널 <Sparkles size={13} />
                  </button>
                </nav>
                {hero && feed === '추천' && genre === '전체' && (
                  <section className={'hero hero-' + hero.id} key={hero.id}>
                    <img
                      className="hero-image"
                      src={asset(hero.image)}
                      alt={hero.title + ' 메인 포스터'}
                    />
                    <div className="hero-shade" />
                    <div className="hero-top">
                      <span>
                        <Zap size={12} fill="currentColor" /> SHORTPING ORIGINAL
                      </span>
                      <span className="hero-age">15</span>
                    </div>
                    <div className="hero-content">
                      <span className="hero-kicker">{homeLayout.hero.kicker || '오늘의 발견 · 숏핑 독점 공개'}</span>
                      <p>{hero.tagline}</p>
                      <h2>{hero.title}</h2>
                      <div className="hero-meta">
                        <span>{hero.genre}</span>
                        <i />
                        {hero.episode_count ? `${hero.episode_count}부작` : '연재 중'}
                        <i />
                        <span>{hero.free ? '전 회차 무료' : `첫 ${hero.free_episodes}화 무료`}</span>
                      </div>
                      <div className="hero-actions">
                        <button
                          className="primary"
                          onClick={() => navigate('watch/' + hero.id + '/1')}
                        >
                          <Play size={17} fill="currentColor" /> 지금 무료로 보기
                        </button>
                        <button
                          className={
                            'hero-save ' + (lib.favorites.includes(hero.id) ? 'saved' : '')
                          }
                          aria-label="메인 작품 찜하기"
                          aria-pressed={lib.favorites.includes(hero.id)}
                          onClick={() => favorite(hero)}
                        >
                          {lib.favorites.includes(hero.id) ? (
                            <Check size={22} />
                          ) : (
                            <Plus size={23} />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="hero-pagination">
                      <div>
                        {heroes.map((_, i) => (
                          <button
                            className={heroPos === i ? 'active' : ''}
                            aria-label={`추천 작품 ${i + 1}`}
                            aria-current={heroPos === i ? 'true' : undefined}
                            key={i}
                            onClick={() => setHeroIndex(i)}
                          />
                        ))}
                      </div>
                      <span>
                        {String(heroPos + 1).padStart(2, '0')}
                        <i>/ {String(heroes.length).padStart(2, '0')}</i>
                        <button
                          aria-label="다음 추천 작품"
                          onClick={() => setHeroIndex((heroPos + 1) % Math.max(1, heroes.length))}
                        >
                          <ChevronRight size={15} />
                        </button>
                      </span>
                    </div>
                  </section>
                )}
                <div className="genre-chips">
                  {genres.map((g) => (
                    <button
                      className={genre === g ? 'active' : ''}
                      aria-pressed={genre === g}
                      key={g}
                      onClick={() => setGenre(g)}
                    >
                      {g === '전체' && <Sparkles size={13} />} {g}
                    </button>
                  ))}
                </div>
                {homeLayout.sections.map((sec) => {
                  // 기본 화면(추천 · 전체)에서만 관리자 편성(숨김 · 제목)을 적용하고,
                  // 장르 · 탭을 고른 결과 목록은 항상 보여 줍니다.
                  const home = feed === '추천' && genre === '전체';
                  if (!sec.visible && (home || sec.id !== 'trending')) return null;
                  const title = (fallback: string) => (home && sec.title) || fallback;
                  const subtitle = (fallback?: string) => (home && sec.subtitle) || fallback;
                  let node: React.ReactNode = null;
                  if (sec.id === 'continue' && home && lib.history.length > 0)
                    node = (
                      <section className="continue-section">
                        <SectionTitle title={title('멈춘 곳부터, 이어보기')} subtitle={subtitle()} />
                        <div className="continue-row">
                          {lib.history.slice(0, 3).map((h) => {
                            const d = dramas.find((x) => x.id === h.drama_id);
                            return d ? (
                              <button
                                key={d.id}
                                className="continue-card"
                                onClick={() => navigate('watch/' + d.id + '/' + h.episode)}
                              >
                                <img src={asset(d.image)} alt="" />
                                <div>
                                  <strong>{d.title}</strong>
                                  <span>{h.episode}화 이어보기</span>
                                </div>
                                <CirclePlay size={25} />
                              </button>
                            ) : null;
                          })}
                        </div>
                      </section>
                    );
                  else if (sec.id === 'curated' && home) {
                    const picks = homeLayout.curated.ids
                      .map((id) => dramas.find((d) => d.id === id))
                      .filter((d): d is Drama => !!d);
                    if (picks.length)
                      node = (
                        <section className="content-section">
                          <SectionTitle
                            title={title('에디터가 고른 이야기')}
                            subtitle={subtitle('숏핑 에디터가 직접 골랐어요')}
                            eyebrow="EDITOR'S PICK"
                            icon={<Star size={19} className="lime" />}
                          />
                          <div className="poster-row">
                            {picks.map((d) => (
                              <Poster key={d.id} d={d} />
                            ))}
                          </div>
                        </section>
                      );
                  } else if (sec.id === 'channels' && home && channels.length > 0)
                    node = (
                      <section className="content-section">
                        <SectionTitle
                          title={title('지금 주목할 방송국')}
                          subtitle={subtitle('PD가 직접 운영하는 방송국에서 골라 보기')}
                          eyebrow="SHORTPING CHANNELS"
                          icon={<Radio size={19} className="lime" />}
                          onMore={() => navigate('channels')}
                        />
                        <FeaturedChannels channels={featuredChannels.length ? featuredChannels : channels} />
                      </section>
                    );
                  else if (sec.id === 'trending')
                    node = (
                      <section className="content-section">
                        <SectionTitle
                          title={
                            feed === '신작'
                              ? '새로운 이야기, 새로운 설렘'
                              : feed === '완결'
                                ? '기다림 없이, 정주행'
                                : genre !== '전체'
                                  ? genre + '에 빠져볼 시간'
                                  : title('지금 가장 핫한 숏핑')
                          }
                          subtitle={subtitle()}
                          eyebrow={feed === '추천' ? 'TRENDING NOW' : undefined}
                          icon={<Flame size={21} className="lime" />}
                          onMore={() => navigate('explore')}
                        />
                        <div className="poster-grid">
                          {feedItems.slice(0, 4).map((d, i) => (
                            <Poster key={d.id} d={d} rank={feed === '추천' || feed === '인기' ? i + 1 : undefined} />
                          ))}
                        </div>
                        {feedItems.length === 0 && (
                          <Empty title="새로운 이야기를 준비 중이에요" text="다른 장르의 작품도 만나보세요." />
                        )}
                      </section>
                    );
                  else if (sec.id === 'membership')
                    node = (
                      <button className="membership-banner" onClick={() => navigate('membership')}>
                        <div className="banner-icon">
                          <Crown size={24} />
                        </div>
                        <div>
                          <span>{subtitle('취향껏, 마음껏, 끊김 없이.')}</span>
                          <strong>{title('숏핑 패스로 모든 이야기를 만나세요')}</strong>
                        </div>
                        <ChevronRight size={21} />
                        <span className="banner-orbit" />
                      </button>
                    );
                  else if (sec.id === 'binge')
                    node = (
                      <section className="content-section">
                        <SectionTitle
                          title={genre === '전체' ? title('오늘부터 정주행 각') : '이런 이야기는 어때요?'}
                          subtitle={subtitle('한 번 시작하면 멈출 수 없는 이야기')}
                          onMore={() => navigate('explore')}
                        />
                        <div className="poster-grid">
                          {(genre === '전체' ? dramas.slice(4, 8) : dramas.filter((d) => d.genre !== genre).slice(0, 4)).map((d) => (
                            <Poster key={d.id} d={d} />
                          ))}
                        </div>
                      </section>
                    );
                  else if (sec.id === 'newest' && home)
                    node = (
                      <section className="content-section">
                        <SectionTitle
                          title={title('새로 올라온 이야기')}
                          subtitle={subtitle('가장 최근 공개된 숏핑 오리지널')}
                          eyebrow="JUST ARRIVED"
                          icon={<Sparkles size={19} className="lime" />}
                          onMore={() => setFeed('신작')}
                        />
                        <div className="poster-row">
                          {newest.slice(0, 6).map((d) => (
                            <Poster key={d.id} d={d} />
                          ))}
                        </div>
                      </section>
                    );
                  else if (sec.id === 'free' && home && freePicks.length > 0)
                    node = (
                      <section className="content-section">
                        <SectionTitle
                          title={title('무료로 먼저 만나보세요')}
                          subtitle={subtitle('첫 화부터 부담 없이 시작하는 작품')}
                          eyebrow="FREE TO START"
                          icon={<Ticket size={19} className="lime" />}
                          onMore={() => navigate('explore')}
                        />
                        <div className="poster-row">
                          {freePicks.slice(0, 6).map((d) => (
                            <Poster key={d.id} d={d} />
                          ))}
                        </div>
                      </section>
                    );
                  else if (sec.id === 'followed' && home && followedChannels.length > 0)
                    node = (
                      <section className="content-section">
                        <SectionTitle
                          title={title('구독 중인 방송국의 새 소식')}
                          subtitle={subtitle('내가 구독한 방송국의 작품')}
                          onMore={() => navigate('channels')}
                        />
                        <div className="poster-row">
                          {dramas
                            .filter((d) => followedChannels.some((c) => c.id === d.channel_id))
                            .slice(0, 6)
                            .map((d) => (
                              <Poster key={d.id} d={d} />
                            ))}
                        </div>
                      </section>
                    );
                  else if (sec.id === 'editorial') {
                    const ed = homeLayout.editorial;
                    const [first, ...rest] = (ed.title || '당신의 다음 이야기는\\n어떤 장르인가요?').split('\\n');
                    node = (
                      <section className="editorial-banner">
                        <span>{ed.eyebrow || 'SHORT STORIES, BIG FEELINGS.'}</span>
                        <h3>
                          {first}
                          {rest.map((line, i) => (
                            <span key={i}>
                              <br />
                              {line}
                            </span>
                          ))}
                        </h3>
                        <button onClick={() => openHomeLink(ed.link || 'explore')}>
                          {ed.button || '나만의 드라마 찾기'} <ArrowRight size={15} />
                        </button>
                        <Clapperboard className="editorial-icon" size={96} />
                      </section>
                    );
                  }
                  return node ? <Fragment key={sec.id}>{node}</Fragment> : null;
                })}
                <Footer info={info} />
              </>
            )}
            {['explore', 'search'].includes(route.page) && (
              <div className="page-content">
                <span className="eyebrow lime">FIND YOUR STORY</span>
                <h1>어떤 이야기에 빠져볼까요?</h1>
                <label className="search-field">
                  <Search size={20} />
                  <input
                    aria-label="작품 검색"
                    autoFocus={route.page === 'search'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="작품명, 장르, #해시태그로 찾아보세요"
                  />
                  {query && (
                    <button onClick={() => setQuery('')} aria-label="검색어 지우기">
                      <X size={18} />
                    </button>
                  )}
                </label>
                <div className="genre-chips no-padding">
                  {genres.map((g) => (
                    <button
                      key={g}
                      className={genre === g ? 'active' : ''}
                      aria-pressed={genre === g}
                      onClick={() => setGenre(g)}
                    >
                      {g}
                    </button>
                  ))}
                </div>
                <div className="section-heading">
                  <h3>
                    {query ? '검색 결과' : '모든 이야기'}{' '}
                    <span className="lime">{filtered.length}</span>
                  </h3>
                  <span className="muted">인기순</span>
                </div>
                <div className="poster-grid explore-grid">
                  {filtered.map((d) => (
                    <Poster d={d} key={d.id} />
                  ))}
                </div>
                {!filtered.length && (
                  <Empty
                    title="아직 찾는 이야기가 없어요"
                    text="다른 검색어나 장르를 선택해 보세요."
                  />
                )}
              </div>
            )}
            {route.page === 'pings' && (
              <PingsPage
                user={user}
                demo={config.demo}
                returnTo={location.hash.replace(/^#\/?pings\/?/, '')}
                notify={notify}
                onCharged={reloadLibrary}
              />
            )}
            {route.page === 'drama' && (
              <DramaPage
                key={route.id + String(lib.orders.length)}
                id={route.id!}
                user={user}
                lib={lib}
                favorite={favorite}
                buy={buy}
                notify={notify}
                pass={config.subscriptionPrice}
                onTag={(tag) => {
                  setGenre('전체');
                  setQuery(tag);
                  navigate('search');
                }}
              />
            )}
            {route.page === 'watch' && (
              <WatchPage
                key={route.id + '-' + route.episode + '-' + lib.orders.length}
                id={route.id!}
                number={route.episode || 1}
                user={user}
                lib={lib}
                buy={buy}
                favorite={favorite}
                notify={notify}
                reloadLibrary={reloadLibrary}
                pass={config.subscriptionPrice}
                setUser={setUser}
              />
            )}
            {route.page === 'membership' && (
              <div className="page-content membership-page">
                <div className="premium-symbol">
                  <Crown size={40} />
                </div>
                <span className="eyebrow lime">SHORTPING PASS</span>
                <h1>
                  이야기는 짧게.
                  <br />
                  즐거움은 무제한.
                </h1>
                <p>
                  다음 화가 궁금할 때, 망설이지 마세요.
                  <br />
                  숏핑의 모든 이야기를 하나의 패스로.
                </p>
                <div className="plan-card">
                  <span className="plan-ribbon">가장 자유로운 정주행</span>
                  <div className="section-heading">
                    <h2>숏핑 패스</h2>
                    <Crown size={25} className="lime" />
                  </div>
                  <div className="price">
                    {new Intl.NumberFormat('ko-KR').format(config.subscriptionPrice)}
                    <span>원 / {config.subscriptionDays}일</span>
                  </div>
                  <ul>
                    {[
                      '모든 드라마 · 모든 회차 무제한',
                      '광고 없이 몰입하는 시청 경험',
                      'PC와 모바일에서 끊김 없이',
                      '새롭게 공개되는 오리지널 포함',
                    ].map((s) => (
                      <li key={s}>
                        <Check size={18} />
                        {s}
                      </li>
                    ))}
                  </ul>
                  <button
                    className="primary full"
                    disabled={!!lib.subscription}
                    onClick={() => buy('subscription')}
                  >
                    {lib.subscription ? '숏핑 패스 이용 중' : '숏핑 패스 시작하기'}{' '}
                    <ArrowRight size={17} />
                  </button>
                  <small>
                    {config.demo
                      ? '개발 테스트 · 실제 금액이 청구되지 않아요'
                      : '결제 서비스 준비 중'}
                  </small>
                </div>
                {lib.subscription && (
                  <div className="info-box">
                    이용 기간: {new Date(lib.subscription.expires_at).toLocaleDateString('ko-KR')}
                    까지
                    <br />
                    테스트 구독은 자동 갱신되지 않아요.
                    <button
                      className="text-link"
                      onClick={() =>
                        info(
                          '구독 관리',
                          '마이페이지의 구매·구독 관리에서 테스트 구독을 종료할 수 있어요.',
                        )
                      }
                    >
                      구독 관리 안내
                    </button>
                  </div>
                )}
                <div className="faq">
                  <h3>궁금한 점이 있나요?</h3>
                  {[
                    [
                      '개별 구매와 구독은 어떻게 다른가요?',
                      '개별 구매는 해당 작품 전체 회차를 소장하는 방식이고, 구독은 이용 기간 동안 모든 공개 작품을 시청하는 방식이에요.',
                    ],
                    [
                      '무료로도 볼 수 있나요?',
                      '네. 각 작품의 무료 공개 회차는 로그인 없이도 시청할 수 있어요.',
                    ],
                    [
                      '어디서 시청할 수 있나요?',
                      '지금은 PC와 모바일 웹에서 시청할 수 있어요. Android와 iOS 앱도 준비 중이에요.',
                    ],
                  ].map(([q, a]) => (
                    <details key={q}>
                      <summary>
                        {q}
                        <ChevronDown size={16} />
                      </summary>
                      <p>{a}</p>
                    </details>
                  ))}
                </div>
              </div>
            )}
            {route.page === 'login' && (
              <LoginPage
                demo={config.demo}
                login={login}
                busy={busy}
                onLogin={async (u) => {
                  setUser(u);
                  await reloadLibrary();
                  // 결제창·찜 등에서 로그인하러 왔다면 보던 화면으로 돌아갑니다.
                  const next = safeNext(route.id);
                  if (next) backTo(next);
                  else navigate(u.role === 'viewer' ? 'home' : 'studio');
                  notify('숏핑에 오신 것을 환영해요.');
                }}
                info={info}
                notify={notify}
              />
            )}
            {route.page === 'my' && (
              <div className="page-content">
                <span className="eyebrow lime">MY SHORTPING</span>
                <h1>나의 숏핑</h1>
                {user ? (
                  <>
                    <div className="profile-card">
                      <button
                        className="large-avatar"
                        aria-label="프로필 설정"
                        onClick={() => navigate('settings')}
                      >
                        <Avatar user={user} />
                      </button>
                      <div>
                        <h2>
                          {user.name}
                          <span className="role-badge">{roleLabel[user.role]}</span>
                        </h2>
                        <p>{user.email}</p>
                        {user.bio && <p className="profile-bio">{user.bio}</p>}
                      </div>
                      <button onClick={logout} aria-label="로그아웃">
                        <LogOut size={21} />
                      </button>
                    </div>
                    <div className="my-summary">
                      {[
                        {
                          label: '소장 작품',
                          value: lib.purchases.length + '편',
                          icon: <Ticket size={16} />,
                        },
                        {
                          label: '찜한 작품',
                          value: lib.favorites.length + '편',
                          icon: <Heart size={16} />,
                        },
                        {
                          label: '연 회차',
                          value: lib.episodes.length + '화',
                          icon: <Ticket size={16} />,
                        },
                        {
                          label: '시청 중',
                          value: lib.history.length + '편',
                          icon: <CirclePlay size={16} />,
                        },
                        {
                          label: '숏핑 패스',
                          value: lib.subscription
                            ? Math.max(
                                0,
                                Math.ceil(
                                  (new Date(lib.subscription.expires_at).getTime() - Date.now()) /
                                    86400000,
                                ),
                              ) + '일 남음'
                            : '미이용',
                          icon: <Crown size={16} />,
                        },
                      ].map((card) => (
                        <div key={card.label}>
                          <span>
                            {card.icon}
                            {card.label}
                          </span>
                          <strong>{card.value}</strong>
                        </div>
                      ))}
                    </div>
                    <button className="my-wallet" onClick={() => navigate('pings')}>
                      <Coins className="lime" />
                      <div>
                        <strong>보유 핑 {pings(lib.wallet.total)}</strong>
                        <span>
                          충전 {pings(lib.wallet.paid)} · 보너스 {pings(lib.wallet.bonus)} · 충전하기
                        </span>
                      </div>
                      <ChevronRight size={20} />
                    </button>
                    <button className="my-pass" onClick={() => navigate('membership')}>
                      <Crown className="lime" />
                      <div>
                        <strong>
                          {lib.subscription ? '숏핑 패스 이용 중' : '다음 이야기를 무제한으로'}
                        </strong>
                        <span>
                          {lib.subscription
                            ? new Date(lib.subscription.expires_at).toLocaleDateString('ko-KR') +
                              '까지 이용 가능'
                            : '숏핑 패스 알아보기'}
                        </span>
                      </div>
                      <ChevronRight size={20} />
                    </button>
                    {lib.history.length > 0 && (
                      <div className="my-continue">
                        <div className="section-heading">
                          <h3>이어보기</h3>
                          <button onClick={() => navigate('explore')}>
                            더 찾아보기 <ChevronRight size={14} />
                          </button>
                        </div>
                        <div className="continue-row">
                          {lib.history.slice(0, 3).map((h) => {
                            const d = dramas.find((x) => x.id === h.drama_id);
                            return d ? (
                              <button
                                key={d.id}
                                className="continue-card"
                                onClick={() => navigate('watch/' + d.id + '/' + h.episode)}
                              >
                                <img src={asset(d.image)} alt="" />
                                <div>
                                  <strong>{d.title}</strong>
                                  <span>{h.episode}화 이어보기</span>
                                </div>
                                <CirclePlay size={25} />
                              </button>
                            ) : null;
                          })}
                        </div>
                      </div>
                    )}
                    <div className="my-shortcuts">
                      {[
                        { label: '핑 충전', icon: <Coins size={18} />, to: 'pings' },
                        { label: '방송국', icon: <Radio size={18} />, to: 'channels' },
                        { label: '숏핑 패스', icon: <Crown size={18} />, to: 'membership' },
                        { label: '문의하기', icon: <MessageCircle size={18} />, to: 'support' },
                        { label: '계정 설정', icon: <UserRound size={18} />, to: 'settings' },
                      ].map((item) => (
                        <button key={item.to} onClick={() => navigate(item.to)}>
                          {item.icon}
                          <span>{item.label}</span>
                        </button>
                      ))}
                    </div>
                    {user.role !== 'viewer' && (
                      <button className="studio-entry" onClick={() => navigate('studio')}>
                        <Clapperboard size={22} />
                        {user.role === 'admin'
                          ? '슈퍼관리자 페이지 바로가기'
                          : 'PD 관리자 페이지 바로가기'}
                        <ArrowRight size={18} />
                      </button>
                    )}
                    <LibraryView lib={lib} dramas={dramas} />
                    <div className="section-heading">
                      <h3>
                        구독 중인 방송국 <span className="lime">{followedChannels.length}</span>
                      </h3>
                      <button onClick={() => navigate('channels')}>
                        방송국 더 보기 <ChevronRight size={14} />
                      </button>
                    </div>
                    {followedChannels.length ? (
                      <div className="followed-channels">
                        {followedChannels.map((c) => (
                          <button
                            key={c.id}
                            className="followed-channel"
                            onClick={() => navigate('channel/' + c.id)}
                          >
                            <ChannelLogo channel={c} size={44} />
                            <div>
                              <strong>{c.name}</strong>
                              <span>
                                작품 {c.drama_count}편 · 구독자 {count(c.followers)}
                              </span>
                            </div>
                            <ChevronRight size={17} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">
                        마음에 드는 방송국을 구독하면 새 작품 소식을 여기에서 볼 수 있어요.
                      </p>
                    )}
                    <button className="studio-entry" onClick={() => navigate('settings')}>
                      <UserRound size={20} />
                      프로필 · 계정 설정
                      <ChevronRight size={18} />
                    </button>
                    <details className="order-details">
                      <summary>
                        결제 · 핑 사용 내역 <ChevronDown size={17} />
                      </summary>
                      {lib.orders.length ? (
                        lib.orders.map((o) => (
                          <div className="order-row" key={o.id}>
                            <div>
                              <strong>
                                <span className={'order-kind ' + o.kind}>
                                  {orderKindLabel(o.kind)}
                                </span>
                                {o.kind === 'subscription'
                                  ? `숏핑 패스 ${config.subscriptionDays}일`
                                  : o.kind === 'ping_charge'
                                    ? `${pings(o.pings || 0)}` +
                                      (o.bonus_pings ? ` + 보너스 ${pings(o.bonus_pings)}` : '')
                                    : o.kind === 'lama_charge'
                                      ? `${lama(o.pings || 0)}` +
                                        (o.bonus_pings ? ` + 보너스 ${lama(o.bonus_pings)}` : '')
                                      : o.kind === 'ping_episode' || o.kind === 'episode'
                                        ? `${o.title} ${o.episode}화`
                                        : `${o.title || '작품'} 전체`}
                              </strong>
                              <span>
                                {new Date(o.created_at).toLocaleString('ko-KR')} ·{' '}
                                {o.kind.startsWith('ping_') && o.kind !== 'ping_charge'
                                  ? '핑 사용'
                                  : '테스트 결제'}{' '}
                                · 주문번호 {o.id.slice(0, 8)}
                              </span>
                            </div>
                            <b>
                              {o.kind === 'ping_episode' || o.kind === 'ping_title'
                                ? '-' + pings(o.pings || 0)
                                : won(o.amount)}
                            </b>
                          </div>
                        ))
                      ) : (
                        <p className="muted">아직 구매 내역이 없어요.</p>
                      )}
                      <p className="order-note">
                        결제 취소·환불이 필요하면 문의하기로 알려 주세요. 사용하지 않은 충전 핑은
                        환불 기준에 따라 처리됩니다. 현재는 개발용 테스트 결제라 실제 청구가
                        발생하지 않습니다.
                      </p>
                      {lib.subscription && (
                        <button
                          className="secondary full"
                          onClick={() =>
                            setModal({
                              title: '테스트 구독 종료',
                              text: '현재 테스트 구독을 즉시 종료하려면 아래 버튼을 눌러 주세요. 개별 구매한 작품의 시청 권한은 유지됩니다.',
                            })
                          }
                        >
                          테스트 구독 종료
                        </button>
                      )}
                    </details>
                    <button className="support-link" onClick={() => navigate('support')}>
                      도움이 필요하신가요? <ChevronRight size={16} />
                    </button>
                  </>
                ) : (
                  <Empty
                    title="당신만의 이야기를 모아보세요"
                    text="로그인하면 찜한 작품과 시청 기록을 한곳에서 볼 수 있어요."
                    action={() => navigate('login')}
                    label="로그인 / 회원가입"
                  />
                )}
              </div>
            )}
            {route.page === 'channels' && <ChannelListPage channels={channels} />}
            {route.page === 'channel' && route.id && (
              <ChannelPage
                key={route.id}
                id={route.id}
                user={user}
                lib={lib}
                notify={notify}
                reloadLibrary={reloadLibrary}
              />
            )}
            {route.page === 'support' && <Support user={user} notify={notify} />}
            {route.page === 'settings' && (
              <div className="page-content">
                <button className="back-link" onClick={() => goBack('my')}>
                  <ArrowLeft size={16} />
                  마이페이지
                </button>
                {user ? (
                  <AccountSettings
                    key={user.id}
                    user={user}
                    onUser={setUser}
                    notify={notify}
                    onHistoryCleared={reloadLibrary}
                  />
                ) : (
                  <Empty
                    title="로그인이 필요해요"
                    text="로그인 후 계정 설정을 변경할 수 있어요."
                    action={() => navigate('login')}
                    label="로그인하기"
                  />
                )}
              </div>
            )}
            {route.page === 'studio' &&
              (user && user.role !== 'viewer' ? (
                <Suspense
                  fallback={
                    <div className="loading">
                      <span className="spinner" />
                    </div>
                  }
                >
                <Studio
                  user={user}
                  demo={config.demo}
                  notify={notify}
                  reloadCatalog={reloadCatalog}
                  reloadChannels={reloadChannels}
                  section={route.id}
                  logout={logout}
                  onUser={setUser}
                  reloadLibrary={reloadLibrary}
                  onAppearance={(homeAppearance: HomeAppearance) =>
                    setConfig((current) => ({ ...current, homeAppearance }))
                  }
                  onHomeLayout={() =>
                    void api<typeof config>('/config')
                      .then((c) => setConfig((cur) => ({ ...cur, homeLayout: c.homeLayout || defaultHomeLayout })))
                      .catch(() => {})
                  }
                />
                </Suspense>
              ) : (
                <Empty
                  title="스튜디오 접근 권한이 필요해요"
                  text="PD 또는 슈퍼관리자 계정으로 로그인해 주세요."
                  action={() => navigate('login')}
                  label="로그인하기"
                />
              ))}
            {![
              'home',
              'explore',
              'search',
              'drama',
              'watch',
              'pings',
              'channels',
              'channel',
              'membership',
              'login',
              'my',
              'studio',
              'support',
              'settings',
            ].includes(route.page) && (
              <Empty
                title="페이지를 찾을 수 없어요"
                text="숏핑 홈에서 새로운 이야기를 만나보세요."
                action={() => navigate('home')}
                label="홈으로"
              />
            )}
          </>
        )}
        {route.page !== 'watch' && !managing && (
          <nav className="bottom-nav" aria-label="주 메뉴">
            {[
              { id: 'home', label: '홈', icon: Home },
              { id: 'explore', label: '발견', icon: Clapperboard },
              { id: 'channels', label: '방송국', icon: Radio },
              { id: 'membership', label: '숏핑 패스', icon: Crown },
              { id: 'my', label: '마이', icon: UserRound },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={activeNav === id ? 'active' : ''}
                aria-current={activeNav === id ? 'page' : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={22} strokeWidth={activeNav === id ? 2.3 : 1.7} />
                <span>{label}</span>
                {activeNav === id && <i />}
              </button>
            ))}
          </nav>
        )}
      </div>
      <aside className="right-rail">
        <div className="desktop-account">
          <a href="#/home">
            <Brand small />
          </a>
          {user ? (
            <div className="rail-account-card">
              <button onClick={() => navigate('my')}>
                <span className="avatar">
                  <Avatar user={user} />
                </span>
                <span>
                  <strong>{user.name}</strong>
                  <small>{roleLabel[user.role]}</small>
                </span>
              </button>
              <NotificationBell key={user.id} align="rail" />
              <button onClick={logout} aria-label="사이드바 로그아웃">
                <LogOut size={18} />
              </button>
            </div>
          ) : (
            <>
              <p>오늘, 어떤 이야기에 빠져볼까요?</p>
              <button className="primary full" onClick={() => navigate('login')}>
                <UserRound size={17} />
                로그인 / 회원가입
              </button>
            </>
          )}
        </div>
        <nav className="desktop-menu" aria-label="PC 메뉴">
          {[
            { id: 'home', label: '홈', icon: Home },
            { id: 'explore', label: '작품 발견', icon: Clapperboard },
            { id: 'channels', label: '방송국', icon: Radio },
            { id: 'search', label: '검색', icon: Search },
            { id: 'membership', label: '숏핑 패스', icon: Crown },
            { id: 'my', label: '마이페이지', icon: UserRound },
            { id: 'support', label: '문의하기', icon: MessageCircle },
            ...(user && user.role !== 'viewer'
              ? [
                  {
                    id: 'studio',
                    label: user.role === 'admin' ? '슈퍼관리자 페이지' : 'PD 관리자 페이지',
                    icon: ShieldCheck,
                  },
                ]
              : []),
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={activeNav === id ? 'active' : ''}
              aria-current={activeNav === id ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{label}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
        <div className="app-intro">
          <span className="mini-label">
            <Smartphone size={13} /> TAKE YOUR STORIES WITH YOU
          </span>
          <h2>
            당신의 손안에,
            <br />
            새로운 <span>몰입.</span>
          </h2>
          <p>
            언제 어디서든 짧고 강렬하게.
            <br />
            숏핑을 앱으로 만나보세요.
          </p>
          <div className="app-icon">
            <img src="/icon.svg" alt="숏핑 앱 아이콘" />
          </div>
          <img className="app-mascot" src="/images/mascot.webp" alt="숏핑 마스코트 핑이" />
          <div className="app-name">
            숏핑 <span>shortping</span>
          </div>
          <button className="store-button" onClick={() => appLink('ios')}>
            <AppleIcon />
            <span>
              <small>Download on the</small>
              <b>App Store</b>
            </span>
            <ArrowDownToLine size={17} />
          </button>
          <button className="store-button" onClick={() => appLink('android')}>
            <Play size={25} />
            <span>
              <small>GET IT ON</small>
              <b>Google Play</b>
            </span>
            <ArrowDownToLine size={17} />
          </button>
          <span className="coming-soon">
            <span /> Android · iOS 출시 준비 중
          </span>
        </div>
        <div className="right-divider" />
        <div className="mini-benefit">
          <div>
            <CirclePlay size={20} />
          </div>
          <p>
            <strong>첫 {config.defaultFreeEpisodes}화는 무료로</strong>
            <span>나에게 맞는 이야기를 먼저 만나세요</span>
          </p>
        </div>
        <div className="mini-benefit">
          <div>
            <Heart size={20} />
          </div>
          <p>
            <strong>취향을 발견하는 즐거움</strong>
            <span>로맨스부터 스릴러까지, 매일 새롭게</span>
          </p>
        </div>
        <button
          className="pd-rail"
          onClick={() => (user && user.role !== 'viewer' ? navigate('studio') : navigate('login'))}
        >
          당신의 이야기를 세상에 <ArrowUpRightIcon />
        </button>
      </aside>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {modal && (
        <Modal title={modal.title} close={() => setModal(null)}>
          <p className="modal-text">{modal.text}</p>
          {modal.title === '테스트 구독 종료' ? (
            <button
              className="primary full"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  await api('/subscription/cancel', 'POST');
                  await reloadLibrary();
                  setModal(null);
                  notify('테스트 구독을 종료했어요.');
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '처리 중…' : '테스트 구독 종료하기'}
            </button>
          ) : (
            <button className="primary full" onClick={() => setModal(null)}>
              확인
            </button>
          )}
        </Modal>
      )}
      {checkout &&
        (checkout === 'subscription' ? (
          <Modal title="숏핑 패스 시작하기" close={() => !busy && setCheckout(null)}>
            <div className="checkout-product">
              <Crown size={42} className="lime" />
              <div>
                <h3>숏핑 패스 · {config.subscriptionDays}일</h3>
                <p>모든 공개 작품 무제한 시청</p>
              </div>
            </div>
            <div className="checkout-price">
              <span>결제 금액</span>
              <strong>{won(config.subscriptionPrice)}</strong>
            </div>
            <div className="info-box">
              <ShieldCheck size={18} />
              {config.demo
                ? '개발용 테스트 결제입니다. 실제 결제나 청구는 발생하지 않으며, DB에 테스트 구독 내역과 시청 권한이 저장됩니다.'
                : '실제 결제 연동을 준비하고 있어요.'}
            </div>
            <button className="primary full" disabled={busy || !config.demo} onClick={pay}>
              {busy ? '처리 중…' : '테스트 결제하고 시청하기'}
            </button>
          </Modal>
        ) : (
          (() => {
            const need = unlockPings(checkout);
            const short = Math.max(0, need - lib.wallet.total);
            const d = checkout.drama;
            const fullPrice = d.locked_count * d.episode_pings;
            return (
              <Modal
                title={checkout.episode ? '이 회차 열기' : '작품 전체 열기'}
                close={() => !busy && setCheckout(null)}
              >
                <div className="checkout-product">
                  <img src={asset(d.image)} alt="" />
                  <div>
                    <h3>{checkout.episode ? `${d.title} ${checkout.episode}화` : d.title}</h3>
                    <p>
                      {checkout.episode
                        ? '이 회차만 바로 시청'
                        : `잠긴 ${d.locked_count}개 회차 모두 열기` +
                          (d.title_discount ? ` · ${d.title_discount}% 할인` : '')}
                    </p>
                  </div>
                </div>
                <div className="checkout-price">
                  <span>
                    사용할 핑
                    {!checkout.episode && fullPrice > need && (
                      <s className="muted"> {pings(fullPrice)}</s>
                    )}
                  </span>
                  <strong>{pings(need)}</strong>
                </div>
                <div className="checkout-balance">
                  <span>보유 핑</span>
                  <b>{pings(lib.wallet.total)}</b>
                  <span>사용 후</span>
                  <b className={short ? 'danger' : ''}>
                    {short ? `${pings(short)} 부족` : pings(lib.wallet.total - need)}
                  </b>
                </div>
                {checkout.episode && d.locked_count > 1 && (
                  <button
                    className="upsell"
                    onClick={() => setCheckout({ drama: d })}
                    disabled={busy}
                  >
                    <Ticket size={17} />
                    <span>
                      <strong>전체 열기가 더 좋아요</strong>
                      <small>
                        {pings(d.title_pings)}으로 남은 {d.locked_count}개 회차 모두 열기
                        {d.title_discount ? ` · ${d.title_discount}% 할인` : ''}
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                )}
                <div className="info-box">
                  <Coins size={18} />
                  보너스 핑부터 먼저 사용돼요. 연 회차는 마이페이지에서 언제든 다시 볼 수 있어요.
                </div>
                {short ? (
                  <button className="primary full" onClick={() => goCharge(checkout)}>
                    <Coins size={16} /> 핑 충전하러 가기
                  </button>
                ) : (
                  <button className="primary full" disabled={busy} onClick={pay}>
                    {busy ? '처리 중…' : `${pings(need)}으로 열기`}
                  </button>
                )}
              </Modal>
            );
          })()
        ))}
    </div>
  );
}
function ArrowUpRightIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 18 18 6M6 6h12v12" />
    </svg>
  );
}
function AppleIcon() {
  return (
    <svg width="27" height="30" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.1 12.3c0-2 1.6-3 1.7-3.1-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.6.8-3.3.8-.7 0-1.7-.8-2.8-.7-1.5 0-2.8.8-3.6 2.1-1.5 2.6-.4 6.5 1 8.6.7 1 1.5 2.1 2.6 2.1 1.1 0 1.5-.7 2.9-.7s1.8.7 3 .7 1.9-1 2.6-2c.8-1.2 1.2-2.3 1.2-2.4-.1 0-2.1-.8-2.1-3.7ZM14.8 6.2c.6-.8 1.1-1.8 1-2.9-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.8 1 .1 2.1-.5 2.7-1.3Z" />
    </svg>
  );
}
function SectionTitle({
  title,
  subtitle,
  eyebrow,
  icon,
  onMore,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  icon?: React.ReactNode;
  onMore?: () => void;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="section-eyebrow">{eyebrow}</span>}
        <h2>
          {title} {icon}
        </h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {onMore && (
        <button onClick={onMore}>
          전체보기 <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
export function Empty({
  title,
  text,
  action,
  label,
}: {
  title: string;
  text: string;
  action?: () => void;
  label?: string;
}) {
  return (
    <div className="empty-state">
      <Clapperboard size={35} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button className="primary" onClick={action}>
          {label}
        </button>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () =>
      ref.current?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]');
    focusables()?.[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f?.length) return;
      const first = f[0],
        last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener('keydown', trap);
      prev?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className={'modal ' + className}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button onClick={close} aria-label="닫기">
            <X size={22} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Footer({ info }: { info: (a: string, b: string) => void }) {
  return (
    <footer>
      <Brand small />
      <p>짧지만, 깊게 빠지다.</p>
      <div>
        {['이용약관', '개인정보 처리방침', '고객센터'].map((t) => (
          <button
            key={t}
            onClick={() =>
              t === '고객센터'
                ? navigate('support')
                : info(
                    t,
                    '현재 로컬 개발 버전입니다. 정식 운영 전 사업자 정보와 서비스 정책을 확정하여 공개할 예정입니다. 이 화면의 작품과 결제는 기능 확인을 위한 데모입니다.',
                  )
            }
          >
            {t}
          </button>
        ))}
      </div>
      <small>© 2026 Shortping. All rights reserved.</small>
    </footer>
  );
}
function LoginPage({
  demo,
  login,
  busy,
  onLogin,
  info,
  notify,
}: {
  demo: boolean;
  login: (r: Role) => void;
  busy: boolean;
  onLogin: (u: User) => void;
  info: (a: string, b: string) => void;
  notify: (s: string) => void;
}) {
  const [register, setRegister] = useState(false),
    [submitting, setSubmitting] = useState(false);
  return (
    <div className="login-page">
      <div className="login-emblem">
        <img src="/icon.svg" alt="" />
      </div>
      <span className="eyebrow lime">WELCOME TO SHORTPING</span>
      <h1>
        당신의 다음 이야기가
        <br />
        기다리고 있어요.
      </h1>
      <p>짧은 순간, 오래 남는 이야기. 숏핑</p>
      <div className="social-logins">
        {[
          ['kakao', '카카오로 시작하기', '●'],
          ['naver', '네이버로 시작하기', 'N'],
          ['google', 'Google로 시작하기', 'G'],
        ].map(([id, label, icon]) => (
          <button
            key={id}
            className={id}
            onClick={() =>
              info(
                label,
                '소셜 로그인 연동 준비 중이에요. 현재는 이메일 가입 또는 아래 개발용 테스트 로그인으로 이용할 수 있어요.',
              )
            }
          >
            <b>{icon}</b>
            {label}
            <span>연동 예정</span>
          </button>
        ))}
      </div>
      <div className="or-divider">또는 이메일로 {register ? '가입' : '로그인'}</div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSubmitting(true);
          const f = new FormData(e.currentTarget);
          try {
            const r = await api<{ user: User }>(
              '/auth/' + (register ? 'register' : 'login'),
              'POST',
              Object.fromEntries(f),
            );
            onLogin(r.user);
          } catch (err) {
            notify((err as Error).message);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        {register && (
          <label>
            닉네임
            <input
              name="name"
              required
              minLength={2}
              maxLength={30}
              placeholder="숏핑에서 사용할 이름"
              autoComplete="nickname"
            />
          </label>
        )}
        <label>
          이메일
          <input
            name="email"
            type="email"
            placeholder="hello@shortping.com"
            autoComplete="email"
            required
          />
        </label>
        <label>
          비밀번호
          <input
            name="password"
            type="password"
            minLength={8}
            maxLength={128}
            placeholder="8자 이상 입력해 주세요"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
          />
        </label>
        <button className="primary full" disabled={submitting || busy}>
          {submitting
            ? '잠시만 기다려 주세요…'
            : register
              ? '이메일로 회원가입'
              : '이메일로 로그인'}
        </button>
      </form>
      <button className="switch-auth" onClick={() => setRegister(!register)}>
        {register ? '이미 계정이 있나요?' : '아직 숏핑 계정이 없나요?'}{' '}
        <b>{register ? '로그인' : '회원가입'}</b>
      </button>
      {demo && (
        <div className="test-login">
          <span>DEVELOPMENT ACCESS</span>
          <h3>개발용 테스트 로그인</h3>
          <p>계정 유형별로 숏핑을 미리 경험해 보세요.</p>
          <div>
            {(
              [
                { role: 'admin', icon: ShieldCheck, label: '슈퍼관리자' },
                { role: 'pd', icon: Clapperboard, label: '업로더 (PD)' },
                { role: 'viewer', icon: UserRound, label: '시청자' },
              ] as const
            ).map(({ role, icon: Icon, label }) => (
              <button key={role} disabled={busy || submitting} onClick={() => login(role)}>
                <Icon size={21} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function DramaPage({
  id,
  user,
  lib,
  favorite,
  buy,
  notify,
  pass,
  onTag,
}: {
  id: string;
  user: User | null;
  lib: Library;
  favorite: (d: Drama) => void;
  buy: (d: Purchase) => void;
  notify: (s: string) => void;
  pass: number;
  onTag: (tag: string) => void;
}) {
  const [d, setD] = useState<ViewerDetail | null>(null),
    [error, setError] = useState(''),
    [trailerOpen, setTrailerOpen] = useState(false);
  useEffect(() => {
    // 카드의 썸네일 후보(A/B)를 보고 들어왔다면 한 번만 클릭으로 집계합니다.
    const t = consumeThumb(id);
    api<ViewerDetail>('/dramas/' + id + (t ? '?t=' + encodeURIComponent(t) : ''))
      .then(setD)
      .catch((e) => setError(e.message));
  }, [id]);
  if (error)
    return (
      <Empty
        title={error}
        text="다른 작품을 만나보세요."
        action={() => navigate('home')}
        label="홈으로"
      />
    );
  if (!d)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const history = lib.history.find((h) => h.drama_id === d.id);
  const firstLocked = d.episodes.find((e) => e.locked)?.number || d.free_episodes + 1;
  return (
    <>
      <div className="detail-cover">
        <img src={asset(d.image)} alt={d.title + ' 포스터'} />
        <div className="detail-shade" />
        <button className="back-button" aria-label="뒤로" onClick={() => goBack('home')}>
          <ArrowLeft />
        </button>
        <span className="detail-original">SHORTPING ORIGINAL</span>
        <h1>{d.title}</h1>
      </div>
      {trailerOpen && d.trailer && (
        <TrailerModal
          src={asset(`/api/dramas/${encodeURIComponent(d.id)}/trailer`)}
          title={d.title}
          poster={asset(d.image)}
          close={() => setTrailerOpen(false)}
        />
      )}
      <div className="page-content detail-body">
        <span className="detail-tag">
          {d.badge} · 숏핑 오리지널
          {d.ai_label && <b className="ai-badge">AI 제작</b>}
        </span>
        <h2>{d.tagline}</h2>
        <div className="detail-meta">
          {d.genre}
          <i />
          15세 이상
          <i />
          {d.episode_count}부작
          <i />
          <span>
            <Flame size={14} />
            {count(d.views)}
          </span>
        </div>
        <p className="synopsis">{d.synopsis}</p>
        {tagsOf(d).length > 0 && (
          <div className="viewer-hashtags" aria-label="해시태그">
            {tagsOf(d).map((t) => (
              <button key={t} onClick={() => onTag(t)} aria-label={`#${t} 검색하기`}>
                #{t}
              </button>
            ))}
          </div>
        )}
        <div className="detail-actions">
          <button
            className="primary"
            onClick={() => navigate('watch/' + d.id + '/' + (history?.episode || 1))}
          >
            <Play size={17} fill="currentColor" />
            {history ? `${history.episode}화 이어보기` : '1화 무료로 보기'}
          </button>
          <button
            className={'secondary ' + (lib.favorites.includes(d.id) ? 'lime' : '')}
            onClick={() => favorite(d)}
          >
            <Bookmark size={18} />
            {lib.favorites.includes(d.id) ? '찜 완료' : '찜하기'}
          </button>
          {d.trailer && (
            <button className="secondary viewer-trailer-button" onClick={() => setTrailerOpen(true)}>
              <Clapperboard size={18} />
              예고편
            </button>
          )}
        </div>
        <div className="episode-heading">
          <h3>
            전체 에피소드 <span>{d.episode_count}</span>
          </h3>
          <span>
            {d.free
              ? '전 회차 무료'
              : `첫 ${Math.min(d.free_episodes, d.episode_count)}화 무료`}
          </span>
        </div>
        <div className={'episode-grid' + (d.episodes.some((e) => e.thumbnail) ? ' with-thumbs' : '')}>
          {d.episodes.map((e) => {
            // 작품 주인·관리자에게만 공개 전 회차가 내려옵니다. 상태를 작은 칩으로 알려 줍니다.
            const status =
              e.review_status && e.review_status !== 'approved'
                ? reviewLabel[e.review_status] || e.review_status
                : '';
            return (
              <button
                key={e.id}
                className={
                  (e.locked ? 'locked' : e.owned ? 'owned' : '') +
                  (e.thumbnail ? ' has-thumb' : '') +
                  (status ? ' unreleased' : '')
                }
                aria-label={`${e.number}화${e.locked ? ' (잠김)' : e.owned ? ' (열림)' : ''}${status ? ' · ' + status : ''}`}
                title={
                  status && e.review_status === 'scheduled' && e.publish_at
                    ? `${new Date(e.publish_at).toLocaleString('ko-KR')} 공개 예정`
                    : undefined
                }
                onClick={() => navigate('watch/' + d.id + '/' + e.number)}
              >
                {e.thumbnail && <img className="episode-thumb" src={asset(e.thumbnail)} alt="" loading="lazy" />}
                <span>{e.number}</span>
                {status && (
                  <em className={'episode-status ' + e.review_status}>{status}</em>
                )}
                {e.locked ? <LockKeyhole size={12} /> : <Play size={11} />}
              </button>
            );
          })}
        </div>
        <div className="purchase-options">
          {!d.entitled && d.locked_count > 0 && (
            <button onClick={() => buy({ drama: d, episode: firstLocked })}>
              <Coins size={20} />
              <span>
                <strong>회차별로 보기</strong>
                <small>
                  한 편 {pings(d.episode_pings)} · {firstLocked}화부터 한 편씩 열기
                </small>
              </span>
              <ChevronRight size={18} />
            </button>
          )}
          <button onClick={() => buy({ drama: d })} disabled={d.entitled || d.locked_count === 0}>
            <Ticket size={21} />
            <span>
              <strong>
                {d.entitled || d.locked_count === 0
                  ? '시청 권한이 있어요'
                  : `남은 ${d.locked_count}개 회차 전체 열기`}
              </strong>
              <small>
                {d.entitled || d.locked_count === 0
                  ? '모든 회차를 시청할 수 있어요'
                  : pings(d.title_pings) +
                    (d.title_discount
                      ? ` · ${pings(d.locked_count * d.episode_pings)}에서 ${d.title_discount}% 할인`
                      : '')}
              </small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button onClick={() => navigate('membership')}>
            <Crown size={21} />
            <span>
              <strong>숏핑 패스로 무제한 정주행</strong>
              <small>{won(pass)}으로 모든 이야기</small>
            </span>
            <ChevronRight size={18} />
          </button>
        </div>
        <p className="demo-footnote">
          오리지널 콘셉트 데모 작품 · 생성형 포스터 사용
          <br />
          시연 영상은 재생 기능 확인용 티저입니다.
        </p>
        <button
          className="text-link"
          onClick={async () => {
            const url = `${location.origin}/share/drama/${encodeURIComponent(d.id)}`;
            try {
              if (navigator.share) await navigator.share({ title: `${d.title} | 숏핑`, text: d.tagline, url });
              else {
                await navigator.clipboard.writeText(url);
                notify('작품 링크를 복사했어요.');
              }
            } catch (error) {
              if ((error as DOMException).name !== 'AbortError') notify('공유하지 못했어요. 다시 시도해 주세요.');
            }
          }}
        >
          작품 링크 공유하기
        </button>
      </div>
    </>
  );
}
function WatchPage({
  id,
  number,
  user,
  lib,
  buy,
  favorite,
  notify,
  reloadLibrary,
  pass,
  setUser,
}: {
  id: string;
  number: number;
  user: User | null;
  lib: Library;
  buy: (d: Purchase) => void;
  favorite: (d: Drama) => void;
  notify: (s: string) => void;
  reloadLibrary: () => Promise<void>;
  pass: number;
  setUser: (u: User) => void;
}) {
  const [d, setD] = useState<ViewerDetail | null>(null),
    [error, setError] = useState(''),
    [episodesOpen, setEpisodesOpen] = useState(false),
    [videoError, setVideoError] = useState<VideoProblem | null>(null),
    [needTap, setNeedTap] = useState(false),
    [autoBusy, setAutoBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    lastSave = useRef(0),
    lastPos = useRef(0),
    played = useRef(false),
    saved = useRef<{ pos: number; reloaded: boolean } | null>(null),
    autoTried = useRef(false);
  const playSrc = '/api/play/' + id + '/' + number;
  const loadDetail = useCallback(
    () =>
      api<ViewerDetail>('/dramas/' + id)
        .then(setD)
        .catch((e) => setError(e.message)),
    [id],
  );
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);
  const current = d?.episodes.find((e) => e.number === number);
  // 자동 열기: 사용자가 켜 두었고 핑이 충분하면 잠긴 회차를 바로 엽니다(화면마다 한 번만 시도).
  useEffect(() => {
    if (!d || !user?.auto_unlock || !current?.locked || autoTried.current) return;
    if (lib.wallet.total < d.episode_pings) return;
    autoTried.current = true;
    setAutoBusy(true);
    api<{ pings: number; wallet: { total: number } }>('/pings/unlock', 'POST', {
      dramaId: d.id,
      episode: number,
      idempotencyKey: uuid(),
    })
      .then(async (r) => {
        notify(`자동 열기로 ${number}화에 ${pings(r.pings)}을 썼어요. 남은 핑 ${pings(r.wallet.total)}`);
        await reloadLibrary();
      })
      .catch((e) => notify((e as Error).message))
      .finally(() => setAutoBusy(false));
  }, [d, current, user, lib.wallet.total, number, notify, reloadLibrary]);
  const toggleAutoUnlock = async (enabled: boolean) => {
    if (!user) return;
    // 지금 보고 있는 잠긴 회차는 켜는 순간 몰래 열지 않습니다. 다음에 들어가는 회차부터 적용됩니다.
    autoTried.current = true;
    try {
      await api('/account/auto-unlock', 'PUT', { enabled });
      setUser({ ...user, auto_unlock: enabled });
      notify(enabled ? '다음부터 잠긴 회차를 보유 핑으로 자동으로 열어요.' : '자동 열기를 껐어요.');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  // 시청 위치 저장. keepalive 요청이라 화면을 떠나거나 탭을 닫는 중에도 전송됩니다.
  // 같은 위치를 두 번 보내지 않습니다(끝날 때 pause·ended가 연달아 오는 경우 등).
  const persist = (reload = false) => {
    if (!user || !d || !played.current) return;
    const t = video.current ? video.current.currentTime : lastPos.current;
    const prev = saved.current;
    if (prev && Math.abs(prev.pos - t) < 0.5) {
      if (reload && !prev.reloaded) {
        prev.reloaded = true;
        void reloadLibrary();
      }
      return;
    }
    saved.current = { pos: t, reloaded: reload };
    lastSave.current = Date.now();
    fetch(apiUrl('/history'), {
      method: 'POST',
      credentials: fetchCredentials,
      keepalive: true,
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dramaId: id, episode: number, progress: t }),
    })
      .then(() => (reload ? reloadLibrary() : undefined))
      .catch(() => {
        /* 일시적인 저장 실패로 재생을 끊지 않습니다. */
      });
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    const onHide = () => persistRef.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persistRef.current();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      // 화면을 떠날 때(뒤로·다른 회차·다른 메뉴) 마지막 위치를 남기고 이어보기 목록을 새로 받습니다.
      persistRef.current(true);
    };
  }, []);
  const startPlayback = () => {
    const v = video.current;
    if (!v) return;
    v.play()
      .then(() => setNeedTap(false))
      .catch((e: DOMException) => {
        // iOS 등 자동 재생이 막힌 환경에서는 크게 누를 수 있는 재생 버튼을 보여 줍니다.
        if (e?.name !== 'AbortError') setNeedTap(true);
      });
  };
  const diagnose = async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setVideoError(videoProblems.network);
      return;
    }
    let status = -1;
    try {
      // 처음 바이트가 아닌 구간을 요청해 시청 기록이 따로 남지 않게 합니다.
      const r = await fetch(asset(playSrc), {
        headers: { ...authHeaders(), Range: 'bytes=1-1' },
        credentials: fetchCredentials,
        cache: 'no-store',
      });
      status = r.status;
      void r.body?.cancel().catch(() => {});
    } catch {
      status = -1;
    }
    const owner = !!user && (user.role === 'admin' || user.id === d?.owner_id);
    setVideoError(
      status === 403
        ? videoProblems.forbidden
        : status === 401
          ? videoProblems.login
          : status === 404
            ? owner
              ? videoProblems.missingOwner
              : videoProblems.missing
            : status === 429 || status === -1 || status >= 500
              ? videoProblems.busy
              : videoProblems.decode,
    );
  };
  const retryVideo = async () => {
    const kind = videoError?.kind;
    setVideoError(null);
    if (kind === 'forbidden' || kind === 'login') {
      // 권한이 바뀌었을 수 있으니 회차 정보와 라이브러리를 다시 받아 잠금 화면을 제대로 보여 줍니다.
      await Promise.all([loadDetail(), reloadLibrary()]);
      if (kind === 'login') loginWithReturn();
      return;
    }
    video.current?.load();
  };
  if (error)
    return (
      <Empty
        title={error}
        text="다른 작품을 선택해 주세요."
        action={() => navigate('home')}
        label="홈으로"
      />
    );
  if (!d)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const ep = current;
  if (!ep)
    return (
      <Empty
        title="회차를 찾을 수 없어요"
        text="전체 회차에서 다시 선택해 주세요."
        action={() => navigate('drama/' + id, { replace: true })}
        label="작품으로"
      />
    );
  // 회차 사이 이동은 기록을 쌓지 않고 현재 항목을 바꿉니다. 뒤로 가면 회차를 보기 전 화면으로 돌아갑니다.
  const goEpisode = (n: number) => navigate('watch/' + id + '/' + n, { replace: true });
  const next = d.episodes.find((e) => e.number === number + 1);
  const autoNext =
    user?.auto_next !== false &&
    !!next &&
    (!next.locked || (!!user?.auto_unlock && lib.wallet.total >= d.episode_pings));
  return (
    <div className="watch-page">
      <div className="watch-top">
        <button onClick={() => goBack('drama/' + id)} aria-label="작품으로 돌아가기">
          <ArrowLeft />
        </button>
        <div>
          <strong>{d.title}</strong>
          <span>
            {number}화 · {ep.title}
          </span>
        </div>
        <button
          aria-label="찜하기"
          aria-pressed={lib.favorites.includes(id)}
          className={lib.favorites.includes(id) ? 'lime' : ''}
          onClick={() => favorite(d)}
        >
          <Bookmark />
        </button>
      </div>
      <div className={'video-stage ' + subtitleClass(d.subtitle_style)}>
        {ep.locked ? (
          <>
            <img className="locked-poster" src={asset(d.image)} alt="" />
            <div className="paywall">
              <LockKeyhole size={32} />
              <h2>{autoBusy ? '회차를 여는 중이에요' : '이야기는 계속돼요'}</h2>
              <p>
                {number}화는 {pings(d.episode_pings)}으로 열 수 있어요.
                <br />
                {user ? `보유 핑 ${pings(lib.wallet.total)}` : '로그인하고 핑으로 이어 보세요.'}
              </p>
              <button
                className="primary full"
                disabled={autoBusy}
                onClick={() => buy({ drama: d, episode: number })}
              >
                <Coins size={16} />
                {pings(d.episode_pings)}으로 이 회차 보기
              </button>
              {d.locked_count > 1 && (
                <button
                  className="secondary full"
                  disabled={autoBusy}
                  onClick={() => buy({ drama: d })}
                >
                  <Ticket size={17} />
                  남은 {d.locked_count}화 전체 열기 · {pings(d.title_pings)}
                  {d.title_discount ? ` (${d.title_discount}%↓)` : ''}
                </button>
              )}
              <button className="secondary full" onClick={() => buy('subscription')}>
                <Crown size={18} /> 숏핑 패스 · {won(pass)}
              </button>
              {user && (
                <label className="auto-unlock-toggle">
                  <input
                    type="checkbox"
                    checked={!!user.auto_unlock}
                    onChange={(e) => void toggleAutoUnlock(e.target.checked)}
                  />
                  다음 회차부터 보유 핑으로 자동 열기
                </label>
              )}
              <small>연 회차와 핑 내역은 마이페이지에서 확인할 수 있어요.</small>
            </div>
          </>
        ) : (
          <>
            <video
              ref={video}
              src={asset(playSrc)}
              poster={asset(d.image)}
              controls
              playsInline
              preload="metadata"
              onError={() => void diagnose()}
              onLoadedMetadata={() => {
                const v = video.current;
                if (!v) return;
                const h = lib.history.find((x) => x.drama_id === id && x.episode === number);
                if (h && h.progress < v.duration - 2) v.currentTime = h.progress;
                // 앞 회차가 끝나서 넘어온 경우에만 이어서 재생합니다.
                if (takeAutoplay(id, number)) startPlayback();
              }}
              onPlay={() => {
                played.current = true;
                setNeedTap(false);
              }}
              onTimeUpdate={() => {
                const v = video.current;
                if (!v) return;
                lastPos.current = v.currentTime;
                if (Date.now() - lastSave.current >= 7000) persist();
              }}
              onPause={() => {
                // 끝까지 본 경우는 onEnded에서 한 번만 저장합니다.
                if (video.current?.ended) return;
                persist(true);
              }}
              onEnded={() => {
                persist(true);
                // 잠긴 다음 회차는 자동 열기를 켜고 핑이 충분할 때만 이어서 이동합니다.
                if (autoNext) {
                  markAutoplay(id, number + 1);
                  goEpisode(number + 1);
                }
              }}
            >
              {ep.has_subtitles ? (
                <track kind="subtitles" srcLang="ko" label="한국어" default src={asset(`/api/subtitles/${id}/${number}`)} />
              ) : null}
            </video>
            {needTap && !videoError && (
              <button className="viewer-play-overlay" onClick={startPlayback} aria-label={`${number}화 재생`}>
                <span>
                  <Play size={34} fill="currentColor" />
                </span>
                재생
              </button>
            )}
            {videoError && (
              <div className="video-error" role="alert">
                <h3>{videoError.title}</h3>
                <p>{videoError.text}</p>
                <button className="secondary" onClick={() => void retryVideo()}>
                  {videoError.action}
                </button>
              </div>
            )}
            <span className="video-label">
              SHORTPING · {ep.is_demo ? 'DEMO TEASER' : 'ORIGINAL'}
            </span>
          </>
        )}
      </div>
      <div className="watch-controls">
        <button disabled={number <= 1} onClick={() => goEpisode(number - 1)}>
          <ChevronLeft size={20} />
          이전 화
        </button>
        <button onClick={() => setEpisodesOpen(!episodesOpen)} aria-expanded={episodesOpen}>
          <Clapperboard size={18} />
          전체 회차 <ChevronDown size={15} />
        </button>
        <button disabled={number >= d.episode_count} onClick={() => goEpisode(number + 1)}>
          다음 화<ChevronRight size={20} />
        </button>
      </div>
      {episodesOpen && (
        <div className="watch-episodes">
          <h3>전체 {d.episode_count}화</h3>
          <div className="episode-grid">
            {d.episodes.map((e) => (
              <button
                className={e.number === number ? 'selected' : ''}
                key={e.id}
                aria-label={`${e.number}화${e.locked ? ' (잠김)' : ''}${e.number === number ? ' · 지금 보는 회차' : ''}`}
                aria-current={e.number === number ? 'true' : undefined}
                onClick={() => goEpisode(e.number)}
              >
                {e.number}
                {e.locked && <LockKeyhole size={12} />}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="watch-description">
        <b>{ep.title}</b>
        <p>{d.tagline}</p>
        <span>
          {(() => {
            // 끝나면 실제로 무엇이 일어나는지(onEnded와 같은 조건)를 그대로 안내합니다.
            if (!next) return '마지막 회차예요.';
            if (user?.auto_next === false) return '다음 회차 자동 재생이 꺼져 있어요.';
            if (!next.locked) return '자동으로 다음 회차가 재생됩니다.';
            if (autoNext)
              return `다음 회차는 자동 열기로 ${pings(d.episode_pings)}을 써서 이어 재생돼요.`;
            return '다음 회차는 잠겨 있어요. 핑으로 열면 이어서 볼 수 있어요.';
          })()}
        </span>
      </div>
    </div>
  );
}
type VideoProblem = {
  kind: 'forbidden' | 'login' | 'missing' | 'busy' | 'network' | 'decode';
  title: string;
  text: string;
  action: string;
};
const videoProblems: Record<string, VideoProblem> = {
  forbidden: {
    kind: 'forbidden',
    title: '이 회차를 볼 권한이 없어요',
    text: '숏핑 패스 기간이 끝났거나 회차 권한이 바뀌었을 수 있어요. 다시 확인해 볼게요.',
    action: '권한 다시 확인',
  },
  login: {
    kind: 'login',
    title: '로그인이 필요해요',
    text: '로그인이 만료되었어요. 다시 로그인하면 이어서 볼 수 있어요.',
    action: '로그인하기',
  },
  missing: {
    kind: 'missing',
    title: '영상을 준비하고 있어요',
    text: '이 회차 영상이 아직 등록되지 않았어요. 잠시 후 다시 확인해 주세요.',
    action: '다시 시도',
  },
  missingOwner: {
    kind: 'missing',
    title: '영상이 아직 준비되지 않았어요',
    text: 'PD 스튜디오에서 회차 영상을 등록할 수 있어요.',
    action: '다시 시도',
  },
  busy: {
    kind: 'busy',
    title: '영상을 불러오지 못했어요',
    text: '요청이 많거나 연결이 잠시 불안정해요. 잠시 후 다시 시도해 주세요.',
    action: '다시 시도',
  },
  network: {
    kind: 'network',
    title: '인터넷 연결이 끊겼어요',
    text: '연결 상태를 확인한 뒤 다시 시도해 주세요.',
    action: '다시 시도',
  },
  decode: {
    kind: 'decode',
    title: '영상을 재생하지 못했어요',
    text: '이 기기에서 재생할 수 없는 형식이거나 일시적인 문제예요. 잠시 후 다시 시도해 주세요.',
    action: '다시 시도',
  },
};
function LibraryView({ lib, dramas }: { lib: Library; dramas: Drama[] }) {
  const [tab, setTab] = useState('찜한 작품');
  const owned = lib.episodes.reduce<Record<string, number[]>>((acc, e) => {
    (acc[e.drama_id] = acc[e.drama_id] || []).push(e.episode);
    return acc;
  }, {});
  const ids =
    tab === '찜한 작품'
      ? lib.favorites
      : tab === '소장 작품'
        ? lib.purchases
        : tab === '연 회차'
          ? Object.keys(owned)
          : lib.history.map((h) => h.drama_id);
  return (
    <>
      <div className="library-tabs">
        {['찜한 작품', '최근 시청', '소장 작품', '연 회차'].map((t) => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
            {t === '연 회차' && lib.episodes.length > 0 && <i>{lib.episodes.length}</i>}
          </button>
        ))}
      </div>
      {tab === '연 회차' ? (
        <div className="owned-episodes">
          {ids.map((id) => {
            const d = dramas.find((x) => x.id === id);
            if (!d) return null;
            return (
              <div className="owned-row" key={id}>
                <img src={asset(d.image)} alt="" />
                <div>
                  <strong>{d.title}</strong>
                  <small>
                    {d.genre} · 연 회차 {owned[id].length}화
                  </small>
                  <div className="owned-chips">
                    {[...owned[id]]
                      .sort((a, b) => a - b)
                      .map((n) => (
                        <button key={n} onClick={() => navigate('watch/' + id + '/' + n)}>
                          {n}화
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="poster-grid library-grid">
          {ids.map((id) => {
            const d = dramas.find((x) => x.id === id);
            return d ? (
              <Poster
                d={d}
                key={id}
                onClick={
                  tab === '최근 시청'
                    ? () =>
                        navigate(
                          'watch/' + id + '/' + lib.history.find((h) => h.drama_id === id)?.episode,
                        )
                    : undefined
                }
              />
            ) : null;
          })}
        </div>
      )}
      {ids.length === 0 && (
        <Empty
          title={
            tab === '찜한 작품'
              ? '마음에 드는 이야기를 찜해보세요'
              : tab === '소장 작품'
                ? '소장한 작품이 아직 없어요'
                : tab === '연 회차'
                  ? '연 회차가 아직 없어요'
                  : '첫 번째 이야기를 시작해 보세요'
          }
          text="새로운 몰입이 당신을 기다려요."
          action={() => navigate('explore')}
          label="작품 둘러보기"
        />
      )}
    </>
  );
}
