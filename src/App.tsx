import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
} from 'lucide-react';
import {
  api,
  count,
  defaultHomeAppearance,
  emptyLibrary,
  won,
  type Detail,
  type Drama,
  type HomeAppearance,
  type Channel,
  type Library,
  type Role,
  type User,
} from './api';
import Studio from './Studio';
import {
  ChannelListPage,
  ChannelPage,
  ChannelLogo,
  FeaturedChannels,
} from './Channels';
import Support from './Support';
import AccountSettings, { Avatar } from './AccountSettings';

type Route = { page: string; id?: string; episode?: number };
// 구매 대상: 작품 전체 소장, 숏핑 패스, 회차 단건.
export type Purchase = Drama | 'subscription' | { drama: Drama; episode: number };
const isEpisodeBuy = (p: Purchase): p is { drama: Drama; episode: number } =>
  typeof p === 'object' && 'episode' in p;
const readRoute = (): Route => {
  const p = location.hash.replace('#', '').split('/').filter(Boolean);
  return { page: p[0] || 'home', id: p[1], episode: Number(p[2]) || 1 };
};
export const navigate = (page: string) => {
  location.hash = '/' + page;
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
      onClick={onClick || (() => navigate('drama/' + d.id))}
      aria-label={d.title + ' 작품 보기'}
    >
      <div className="poster">
        <img src={d.image} alt={d.title + ' 드라마 포스터'} loading="lazy" />
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
      subscriptionPrice: 7900,
      subscriptionDays: 30,
      defaultPrice: 3900,
      defaultFreeEpisodes: 3,
      defaultEpisodePrice: 500,
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
    } catch {
      setLib(emptyLibrary);
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
      .then(([u, c, d, ch]) => {
        setUser(u.user);
        setConfig(c);
        setDramas(d);
        setChannels(ch);
        if (u.user) void reloadLibrary();
      })
      .catch((e) => setLoadError(e.message))
      .finally(() => setReady(true));
  }, [reloadLibrary]);
  useEffect(() => {
    const fn = () => {
      setRoute(readRoute());
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
  useEffect(() => {
    if (route.page !== 'home') return;
    const t = setInterval(() => setHeroIndex((i) => (i + 1) % 3), 6500);
    return () => clearInterval(t);
  }, [route.page]);
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
      navigate(role === 'viewer' ? 'home' : 'studio');
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
      navigate('login');
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
      navigate('login');
      return;
    }
    setCheckout(d);
  };
  const pay = async () => {
    if (!checkout || busy) return;
    setBusy(true);
    try {
      const episodeBuy = isEpisodeBuy(checkout);
      await api('/checkout', 'POST', {
        kind:
          checkout === 'subscription' ? 'subscription' : episodeBuy ? 'episode' : 'drama',
        dramaId:
          checkout === 'subscription' ? undefined : episodeBuy ? checkout.drama.id : checkout.id,
        episode: episodeBuy ? checkout.episode : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      await reloadLibrary();
      setCheckout(null);
      notify(
        episodeBuy
          ? `${(checkout as { episode: number }).episode}화를 구매했어요. 바로 이어서 보세요!`
          : '테스트 결제가 완료됐어요. 지금 시청해 보세요!',
      );
    } catch (e) {
      notify((e as Error).message);
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
  const hero = dramas.find((d) => d.id === ['midnight', 'spring', 'moon'][heroIndex]) || dramas[0];
  const filtered = dramas.filter(
    (d) =>
      (genre === '전체' || d.genre === genre) &&
      (!query || `${d.title} ${d.genre} ${d.tagline}`.includes(query)),
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
  const freePicks = dramas.filter((d) => d.price === 0 || d.free_episodes >= 5);
  const featuredChannels = channels.filter((c) => c.featured);
  const followedChannels = channels.filter((c) => lib.channels.includes(c.id));
  const activeNav =
    route.page === 'settings'
      ? 'my'
      : ['drama', 'watch'].includes(route.page)
        ? 'home'
        : route.page === 'channel'
          ? 'channels'
          : route.page;
  const managing = route.page === 'studio' && !!user && user.role !== 'viewer';
  const siteStyle = {
    '--home-wallpaper': `url("${config.homeAppearance.image}")`,
  } as CSSProperties;
  return (
    <div className={managing ? 'site-layout management-layout' : 'site-layout'} style={siteStyle}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <aside className="left-rail">
        <a href="#/home" className="rail-brand">
          <Brand />
        </a>
        <div className="rail-copy">
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
        <div className="rail-caption">
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
              <button
                className="notification-button"
                aria-label="알림"
                onClick={() =>
                  info(
                    '숏핑에서 온 소식',
                    '숏핑에 오신 것을 환영해요! 모든 작품의 첫 3개 회차를 무료로 만나보세요. 새로운 이야기가 매일 당신을 기다립니다.',
                  )
                }
              >
                <Bell size={20} />
                <i />
              </button>
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
                <nav className="feed-tabs">
                  <a className="desktop-feed-brand" href="#/home" aria-label="숏핑 홈">
                    <Brand small />
                  </a>
                  {['추천', '인기', '신작', '완결'].map((t) => (
                    <button
                      key={t}
                      className={feed === t ? 'active' : ''}
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
                      src={hero.image}
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
                      <span className="hero-kicker">오늘의 발견 · 숏핑 독점 공개</span>
                      <p>{hero.tagline}</p>
                      <h2>{hero.title}</h2>
                      <div className="hero-meta">
                        <span>{hero.genre}</span>
                        <i />
                        12부작
                        <i />
                        <span>첫 3화 무료</span>
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
                        {[0, 1, 2].map((i) => (
                          <button
                            className={heroIndex === i ? 'active' : ''}
                            aria-label={`추천 작품 ${i + 1}`}
                            key={i}
                            onClick={() => setHeroIndex(i)}
                          />
                        ))}
                      </div>
                      <span>
                        0{heroIndex + 1}
                        <i>/ 03</i>
                        <button
                          aria-label="다음 추천 작품"
                          onClick={() => setHeroIndex((heroIndex + 1) % 3)}
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
                      key={g}
                      onClick={() => setGenre(g)}
                    >
                      {g === '전체' && <Sparkles size={13} />} {g}
                    </button>
                  ))}
                </div>
                {lib.history.length > 0 && feed === '추천' && genre === '전체' && (
                  <section className="continue-section">
                    <SectionTitle title="멈춘 곳부터, 이어보기" />
                    <div className="continue-row">
                      {lib.history.slice(0, 3).map((h) => {
                        const d = dramas.find((x) => x.id === h.drama_id);
                        return d ? (
                          <button
                            key={d.id}
                            className="continue-card"
                            onClick={() => navigate('watch/' + d.id + '/' + h.episode)}
                          >
                            <img src={d.image} alt="" />
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
                )}
                {channels.length > 0 && feed === '추천' && genre === '전체' && (
                  <section className="content-section">
                    <SectionTitle
                      title="지금 주목할 방송국"
                      subtitle="PD가 직접 운영하는 방송국에서 골라 보기"
                      eyebrow="SHORTPING CHANNELS"
                      icon={<Radio size={19} className="lime" />}
                      onMore={() => navigate('channels')}
                    />
                    <FeaturedChannels
                      channels={featuredChannels.length ? featuredChannels : channels}
                    />
                  </section>
                )}
                <section className="content-section">
                  <SectionTitle
                    title={
                      feed === '신작'
                        ? '새로운 이야기, 새로운 설렘'
                        : feed === '완결'
                          ? '기다림 없이, 정주행'
                          : genre !== '전체'
                            ? genre + '에 빠져볼 시간'
                            : '지금 가장 핫한 숏핑'
                    }
                    eyebrow={feed === '추천' ? 'TRENDING NOW' : undefined}
                    icon={<Flame size={21} className="lime" />}
                    onMore={() => navigate('explore')}
                  />
                  <div className="poster-grid">
                    {feedItems.slice(0, 4).map((d, i) => (
                      <Poster
                        key={d.id}
                        d={d}
                        rank={feed === '추천' || feed === '인기' ? i + 1 : undefined}
                      />
                    ))}
                  </div>
                  {feedItems.length === 0 && (
                    <Empty
                      title="새로운 이야기를 준비 중이에요"
                      text="다른 장르의 작품도 만나보세요."
                    />
                  )}
                </section>
                <button className="membership-banner" onClick={() => navigate('membership')}>
                  <div className="banner-icon">
                    <Crown size={24} />
                  </div>
                  <div>
                    <span>취향껏, 마음껏, 끊김 없이.</span>
                    <strong>숏핑 패스로 모든 이야기를 만나세요</strong>
                  </div>
                  <ChevronRight size={21} />
                  <span className="banner-orbit" />
                </button>
                <section className="content-section">
                  <SectionTitle
                    title={genre === '전체' ? '오늘부터 정주행 각' : '이런 이야기는 어때요?'}
                    subtitle="한 번 시작하면 멈출 수 없는 이야기"
                    onMore={() => navigate('explore')}
                  />
                  <div className="poster-grid">
                    {(genre === '전체'
                      ? dramas.slice(4, 8)
                      : dramas.filter((d) => d.genre !== genre).slice(0, 4)
                    ).map((d) => (
                      <Poster key={d.id} d={d} />
                    ))}
                  </div>
                </section>
                {feed === '추천' && genre === '전체' && (
                  <>
                    <section className="content-section">
                      <SectionTitle
                        title="새로 올라온 이야기"
                        subtitle="가장 최근 공개된 숏핑 오리지널"
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
                    {freePicks.length > 0 && (
                      <section className="content-section">
                        <SectionTitle
                          title="무료로 먼저 만나보세요"
                          subtitle="첫 화부터 부담 없이 시작하는 작품"
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
                    )}
                    {followedChannels.length > 0 && (
                      <section className="content-section">
                        <SectionTitle
                          title="구독 중인 방송국의 새 소식"
                          subtitle="내가 구독한 방송국의 작품"
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
                    )}
                  </>
                )}
                <section className="editorial-banner">
                  <span>SHORT STORIES, BIG FEELINGS.</span>
                  <h3>
                    당신의 다음 이야기는
                    <br />
                    어떤 장르인가요?
                  </h3>
                  <button onClick={() => navigate('explore')}>
                    나만의 드라마 찾기 <ArrowRight size={15} />
                  </button>
                  <Clapperboard className="editorial-icon" size={96} />
                </section>
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
                    placeholder="작품명, 장르로 찾아보세요"
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
                  navigate(u.role === 'viewer' ? 'home' : 'studio');
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
                          label: '구매 회차',
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
                                <img src={d.image} alt="" />
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
                        구매 · 구독 관리 <ChevronDown size={17} />
                      </summary>
                      {lib.orders.length ? (
                        lib.orders.map((o) => (
                          <div className="order-row" key={o.id}>
                            <div>
                              <strong>
                                <span className={'order-kind ' + o.kind}>
                                  {o.kind === 'subscription'
                                    ? '패스'
                                    : o.kind === 'episode'
                                      ? '회차'
                                      : '소장'}
                                </span>
                                {o.kind === 'subscription'
                                  ? `숏핑 패스 ${config.subscriptionDays}일`
                                  : o.kind === 'episode'
                                    ? `${o.title} ${o.episode}화`
                                    : o.title}
                              </strong>
                              <span>
                                {new Date(o.created_at).toLocaleString('ko-KR')} · 테스트 결제 ·
                                주문번호 {o.id.slice(0, 8)}
                              </span>
                            </div>
                            <b>{won(o.amount)}</b>
                          </div>
                        ))
                      ) : (
                        <p className="muted">아직 구매 내역이 없어요.</p>
                      )}
                      <p className="order-note">
                        결제 취소·환불이 필요하면 문의하기로 알려 주세요. 현재는 개발용 테스트
                        결제라 실제 청구가 발생하지 않습니다.
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
                <button className="back-link" onClick={() => navigate('my')}>
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
                />
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
            <strong>첫 3화는 무료로</strong>
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
              onClick={async () => {
                try {
                  await api('/subscription/cancel', 'POST');
                  await reloadLibrary();
                  setModal(null);
                  notify('테스트 구독을 종료했어요.');
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              테스트 구독 종료하기
            </button>
          ) : (
            <button className="primary full" onClick={() => setModal(null)}>
              확인
            </button>
          )}
        </Modal>
      )}
      {checkout && (
        <Modal
          title={
            checkout === 'subscription'
              ? '숏핑 패스 시작하기'
              : isEpisodeBuy(checkout)
                ? '이 회차만 보기'
                : '작품 전체 소장하기'
          }
          close={() => !busy && setCheckout(null)}
        >
          <div className="checkout-product">
            {checkout === 'subscription' ? (
              <Crown size={42} className="lime" />
            ) : (
              <img src={isEpisodeBuy(checkout) ? checkout.drama.image : checkout.image} alt="" />
            )}
            <div>
              <h3>
                {checkout === 'subscription'
                  ? `숏핑 패스 · ${config.subscriptionDays}일`
                  : isEpisodeBuy(checkout)
                    ? `${checkout.drama.title} ${checkout.episode}화`
                    : checkout.title}
              </h3>
              <p>
                {checkout === 'subscription'
                  ? '모든 공개 작품 무제한 시청'
                  : isEpisodeBuy(checkout)
                    ? '이 회차만 바로 시청'
                    : `전체 ${checkout.episode_count}회차 · 소장`}
              </p>
            </div>
          </div>
          <div className="checkout-price">
            <span>결제 금액</span>
            <strong>
              {won(
                checkout === 'subscription'
                  ? config.subscriptionPrice
                  : isEpisodeBuy(checkout)
                    ? checkout.drama.episode_price || config.defaultEpisodePrice
                    : checkout.price,
              )}
            </strong>
          </div>
          {isEpisodeBuy(checkout) && (
            <button
              className="upsell"
              onClick={() => setCheckout(checkout.drama)}
              disabled={busy}
            >
              <Ticket size={17} />
              <span>
                <strong>전체 소장이 더 좋아요</strong>
                <small>
                  {won(checkout.drama.price)}에 {checkout.drama.episode_count}회차 전부 소장
                </small>
              </span>
              <ChevronRight size={16} />
            </button>
          )}
          <div className="info-box">
            <ShieldCheck size={18} />
            {config.demo
              ? '개발용 테스트 결제입니다. 실제 결제나 청구는 발생하지 않으며, DB에 테스트 구매 내역과 시청 권한이 저장됩니다.'
              : '실제 결제 연동을 준비하고 있어요.'}
          </div>
          <button className="primary full" disabled={busy || !config.demo} onClick={pay}>
            {busy ? '처리 중…' : '테스트 결제하고 시청하기'}
          </button>
        </Modal>
      )}
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
        <button className="primary full" disabled={submitting}>
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
              <button key={role} disabled={busy} onClick={() => login(role)}>
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
}: {
  id: string;
  user: User | null;
  lib: Library;
  favorite: (d: Drama) => void;
  buy: (d: Purchase) => void;
  notify: (s: string) => void;
  pass: number;
}) {
  const [d, setD] = useState<Detail | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    api<Detail>('/dramas/' + id)
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
        <img src={d.image} alt={d.title + ' 포스터'} />
        <div className="detail-shade" />
        <button className="back-button" aria-label="뒤로" onClick={() => navigate('home')}>
          <ArrowLeft />
        </button>
        <span className="detail-original">SHORTPING ORIGINAL</span>
        <h1>{d.title}</h1>
      </div>
      <div className="page-content detail-body">
        <span className="detail-tag">{d.badge} · 숏핑 오리지널</span>
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
        </div>
        <div className="episode-heading">
          <h3>
            전체 에피소드 <span>{d.episode_count}</span>
          </h3>
          <span>
            {d.price === 0
              ? '전 회차 무료'
              : `첫 ${Math.min(d.free_episodes, d.episode_count)}화 무료`}
          </span>
        </div>
        <div className="episode-grid">
          {d.episodes.map((e) => (
            <button
              key={e.id}
              className={e.locked ? 'locked' : e.owned ? 'owned' : ''}
              onClick={() => navigate('watch/' + d.id + '/' + e.number)}
            >
              <span>{e.number}</span>
              {e.locked ? <LockKeyhole size={12} /> : <Play size={11} />}
            </button>
          ))}
        </div>
        <div className="purchase-options">
          {!d.entitled && d.price > 0 && (
            <button onClick={() => buy({ drama: d, episode: firstLocked })}>
              <Play size={20} />
              <span>
                <strong>회차별로 보기</strong>
                <small>
                  {won(d.episode_price)} · {firstLocked}화부터 한 편씩 결제
                </small>
              </span>
              <ChevronRight size={18} />
            </button>
          )}
          <button onClick={() => buy(d)} disabled={d.entitled}>
            <Ticket size={21} />
            <span>
              <strong>{d.entitled ? '시청 권한이 있어요' : '이 작품 전체 소장하기'}</strong>
              <small>
                {d.entitled ? '모든 회차를 시청할 수 있어요' : won(d.price) + ' · 전체 회차'}
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
          onClick={() => {
            navigator.clipboard
              .writeText(location.href)
              .then(() => notify('작품 링크를 복사했어요.'))
              .catch(() => notify('브라우저 주소창에서 링크를 복사해 주세요.'));
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
}) {
  const [d, setD] = useState<Detail | null>(null),
    [error, setError] = useState(''),
    [episodesOpen, setEpisodesOpen] = useState(false),
    [videoError, setVideoError] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    lastSave = useRef(0);
  useEffect(() => {
    api<Detail>('/dramas/' + id)
      .then(setD)
      .catch((e) => setError(e.message));
  }, [id]);
  const save = async (force = false) => {
    if (!user || !video.current || !d) return;
    const t = video.current.currentTime;
    if (!force && Date.now() - lastSave.current < 7000) return;
    lastSave.current = Date.now();
    try {
      await api('/history', 'POST', { dramaId: id, episode: number, progress: t });
      if (force) await reloadLibrary();
    } catch {
      /* A transient save failure should not interrupt playback. */
    }
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
  const ep = d.episodes.find((e) => e.number === number);
  if (!ep)
    return (
      <Empty
        title="회차를 찾을 수 없어요"
        text="전체 회차에서 다시 선택해 주세요."
        action={() => navigate('drama/' + id)}
        label="작품으로"
      />
    );
  return (
    <div className="watch-page">
      <div className="watch-top">
        <button
          onClick={() => {
            void save(true);
            navigate('drama/' + id);
          }}
          aria-label="작품으로 돌아가기"
        >
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
          className={lib.favorites.includes(id) ? 'lime' : ''}
          onClick={() => favorite(d)}
        >
          <Bookmark />
        </button>
      </div>
      <div className="video-stage">
        {ep.locked ? (
          <>
            <img className="locked-poster" src={d.image} alt="" />
            <div className="paywall">
              <LockKeyhole size={32} />
              <h2>이야기는 계속돼요</h2>
              <p>
                {number}화부터는 회차 구매, 작품 소장 또는
                <br />
                숏핑 패스로 시청할 수 있어요.
              </p>
              <button className="primary full" onClick={() => buy({ drama: d, episode: number })}>
                <Play size={16} fill="currentColor" />이 회차만 보기 · {won(d.episode_price)}
              </button>
              <button className="secondary full" onClick={() => buy(d)}>
                <Ticket size={17} />
                전체 소장 · {won(d.price)}
              </button>
              <button className="secondary full" onClick={() => buy('subscription')}>
                <Crown size={18} /> 숏핑 패스 · {won(pass)}
              </button>
              <small>구매한 회차와 작품은 마이페이지에서 확인할 수 있어요.</small>
            </div>
          </>
        ) : (
          <>
            <video
              ref={video}
              src={'/api/play/' + id + '/' + number}
              poster={d.image}
              controls
              playsInline
              preload="metadata"
              onError={() => setVideoError(true)}
              onLoadedMetadata={() => {
                const h = lib.history.find((x) => x.drama_id === id && x.episode === number);
                if (video.current && h && h.progress < video.current.duration - 2)
                  video.current.currentTime = h.progress;
              }}
              onTimeUpdate={() => void save()}
              onPause={() => void save(true)}
              onEnded={() => {
                void save(true);
                if (
                  user?.auto_next !== false &&
                  number < d.episode_count &&
                  !d.episodes.find((e) => e.number === number + 1)?.locked
                )
                  navigate('watch/' + id + '/' + (number + 1));
              }}
            />
            {videoError && (
              <div className="video-error">
                <h3>영상이 아직 준비되지 않았어요</h3>
                <p>PD 스튜디오에서 회차 영상을 등록할 수 있어요.</p>
                <button
                  className="secondary"
                  onClick={() => {
                    setVideoError(false);
                    video.current?.load();
                  }}
                >
                  다시 시도
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
        <button
          disabled={number <= 1}
          onClick={() => {
            void save(true);
            navigate('watch/' + id + '/' + (number - 1));
          }}
        >
          <ChevronLeft size={20} />
          이전 화
        </button>
        <button onClick={() => setEpisodesOpen(!episodesOpen)}>
          <Clapperboard size={18} />
          전체 회차 <ChevronDown size={15} />
        </button>
        <button
          disabled={number >= d.episode_count}
          onClick={() => {
            void save(true);
            navigate('watch/' + id + '/' + (number + 1));
          }}
        >
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
                onClick={() => navigate('watch/' + id + '/' + e.number)}
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
        <span>자동으로 다음 회차가 재생됩니다.</span>
      </div>
    </div>
  );
}
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
        : tab === '구매한 회차'
          ? Object.keys(owned)
          : lib.history.map((h) => h.drama_id);
  return (
    <>
      <div className="library-tabs">
        {['찜한 작품', '최근 시청', '소장 작품', '구매한 회차'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
            {t === '구매한 회차' && lib.episodes.length > 0 && <i>{lib.episodes.length}</i>}
          </button>
        ))}
      </div>
      {tab === '구매한 회차' ? (
        <div className="owned-episodes">
          {ids.map((id) => {
            const d = dramas.find((x) => x.id === id);
            if (!d) return null;
            return (
              <div className="owned-row" key={id}>
                <img src={d.image} alt="" />
                <div>
                  <strong>{d.title}</strong>
                  <small>
                    {d.genre} · 구매한 회차 {owned[id].length}화
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
                : tab === '구매한 회차'
                  ? '구매한 회차가 아직 없어요'
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
