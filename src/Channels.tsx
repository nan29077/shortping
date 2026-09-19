import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  ChevronRight,
  Clapperboard,
  Eye,
  Heart,
  Play,
  Radio,
  Share2,
  Users,
} from 'lucide-react';
import { api, count, type Channel, type ChannelDetail, type Library, type User } from './api';
import { Empty, Poster, navigate } from './App';

// 방송국 분위기 프리셋. PD가 고르면 대표 색과 배경 톤이 함께 바뀝니다.
export const channelThemes = [
  { id: 'lime', name: '라임 네온', accent: '#c4f562', mood: '선명하고 경쾌한 숏핑 기본' },
  { id: 'coral', name: '코랄 로맨스', accent: '#ff9d7a', mood: '설렘과 따뜻함' },
  { id: 'ocean', name: '오션 블루', accent: '#7ec8f5', mood: '시원하고 서늘한' },
  { id: 'violet', name: '바이올렛 판타지', accent: '#bda7f0', mood: '몽환적이고 신비로운' },
  { id: 'sand', name: '샌드 클래식', accent: '#e7c89a', mood: '고전적이고 차분한' },
  { id: 'mono', name: '모노 느와르', accent: '#cfd6d2', mood: '담백하고 묵직한' },
];
export const themeOf = (id: string) => channelThemes.find((t) => t.id === id) || channelThemes[0];
type BannerSource = Pick<Channel, 'banner' | 'accent' | 'banner_fit' | 'overlay'>;
export const channelStyle = (c: Pick<Channel, 'accent' | 'overlay'>) =>
  ({
    '--channel-accent': c.accent || '#c4f562',
    '--channel-veil': String(Math.min(90, Math.max(0, c.overlay ?? 45)) / 100),
  }) as React.CSSProperties;

// 배너는 잘라내지 않습니다. 원본을 전부 보여주고 빈 자리는 같은 이미지를 흐리게 깔아 채웁니다.
export function ChannelBanner({ channel, tall = false }: { channel: BannerSource; tall?: boolean }) {
  return (
    <div className={'channel-hero' + (tall ? ' tall' : '')} style={channelStyle(channel)}>
      {channel.banner ? (
        <>
          <img
            className="channel-hero-backdrop"
            src={channel.banner}
            alt=""
            aria-hidden="true"
          />
          <img
            className={
              'channel-hero-image ' + (channel.banner_fit === 'cover' ? 'cover' : 'contain')
            }
            src={channel.banner}
            alt=""
          />
        </>
      ) : (
        <span className="channel-hero-empty" />
      )}
      <span className="channel-hero-veil" />
    </div>
  );
}
export function ChannelLogo({ channel, size = 46 }: { channel: Partial<Channel>; size?: number }) {
  const src = channel.logo || channel.owner_avatar;
  return (
    <span
      className="channel-logo"
      style={{ width: size, height: size, borderColor: channel.accent || '#c4f562' }}
    >
      {src ? <img src={src} alt="" /> : <Radio size={size * 0.46} />}
    </span>
  );
}
export function ChannelCard({ channel }: { channel: Channel }) {
  return (
    <button
      className="channel-card"
      style={channelStyle(channel)}
      onClick={() => navigate('channel/' + channel.id)}
    >
      <ChannelBanner channel={channel} />
      <div className="channel-card-body">
        <ChannelLogo channel={channel} size={52} />
        <div>
          <strong>
            {channel.name}
            {channel.featured ? <BadgeCheck size={15} className="channel-verified" /> : null}
          </strong>
          <span>{channel.tagline || channel.owner_name + ' 스튜디오'}</span>
        </div>
        <ChevronRight size={18} />
      </div>
      <div className="channel-card-meta">
        <span>
          <Clapperboard size={13} /> {channel.drama_count}편
        </span>
        <span>
          <Eye size={13} /> {count(channel.views)}
        </span>
        <span>
          <Users size={13} /> 구독 {count(channel.followers)}
        </span>
      </div>
      {channel.posters && channel.posters.length > 0 && (
        <div className="channel-card-posters">
          {channel.posters.map((image, i) => (
            <img src={image} alt="" key={image + i} />
          ))}
        </div>
      )}
    </button>
  );
}
export function FeaturedChannels({ channels }: { channels: Channel[] }) {
  if (!channels.length) return null;
  return (
    <div className="channel-strip">
      {channels.slice(0, 6).map((c) => (
        <button
          key={c.id}
          className="channel-chip"
          style={channelStyle(c)}
          onClick={() => navigate('channel/' + c.id)}
        >
          <ChannelLogo channel={c} size={54} />
          <strong>{c.name}</strong>
          <span>{c.drama_count}편</span>
        </button>
      ))}
      <button className="channel-chip more" onClick={() => navigate('channels')}>
        <span className="channel-more-icon">
          <ChevronRight size={20} />
        </span>
        <strong>전체 방송국</strong>
        <span>둘러보기</span>
      </button>
    </div>
  );
}
export function ChannelListPage({ channels }: { channels: Channel[] }) {
  const [query, setQuery] = useState('');
  const filtered = channels.filter((c) =>
    `${c.name} ${c.tagline} ${c.owner_name}`.toLowerCase().includes(query.toLowerCase()),
  );
  const featured = filtered.filter((c) => c.featured);
  return (
    <div className="page-content">
      <span className="eyebrow lime">SHORTPING CHANNELS</span>
      <h1>방송국</h1>
      <p className="page-lead">
        PD가 직접 운영하는 방송국에서 그 스튜디오의 숏폼 드라마를 한 번에 만나보세요.
      </p>
      <label className="search-field">
        <Radio size={19} />
        <input
          aria-label="방송국 검색"
          placeholder="방송국 이름 또는 PD 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {featured.length > 0 && (
        <>
          <div className="section-divider">
            <span>추천 방송국</span>
          </div>
          <div className="channel-grid">
            {featured.map((c) => (
              <ChannelCard channel={c} key={c.id} />
            ))}
          </div>
        </>
      )}
      <div className="section-divider">
        <span>전체 방송국 {filtered.length}</span>
      </div>
      <div className="channel-grid">
        {filtered.map((c) => (
          <ChannelCard channel={c} key={c.id} />
        ))}
      </div>
      {!filtered.length && (
        <Empty title="아직 공개된 방송국이 없어요" text="PD가 방송국을 열면 이곳에 표시됩니다." />
      )}
    </div>
  );
}

// 시청자가 보는 방송국 페이지. 배너 → 겹쳐 올라온 소개 카드 → 작품 진열 순서입니다.
export function ChannelPage({
  id,
  user,
  lib,
  notify,
  reloadLibrary,
}: {
  id: string;
  user: User | null;
  lib: Library;
  notify: (s: string) => void;
  reloadLibrary: () => Promise<void>;
}) {
  const [channel, setChannel] = useState<ChannelDetail | null>(null),
    [error, setError] = useState(''),
    [category, setCategory] = useState('all'),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<ChannelDetail>('/channels/' + id)
      .then((r) => active && setChannel(r))
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [id]);
  if (error)
    return (
      <Empty
        title="방송국을 찾을 수 없어요"
        text={error}
        action={() => navigate('channels')}
        label="방송국 목록"
      />
    );
  if (!channel)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const following = lib.channels.includes(channel.id);
  const dramas =
    category === 'all' ? channel.dramas : channel.dramas.filter((d) => d.category_id === category);
  const latest = channel.dramas[0];
  const follow = async () => {
    if (!user) return navigate('login');
    setBusy(true);
    try {
      await api('/channels/' + channel.id + '/follow', 'POST', { active: !following });
      await reloadLibrary();
      notify(following ? '방송국 구독을 해제했어요.' : '방송국을 구독했어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    const url = `${location.origin}/#/channel/${channel.slug || channel.id}`;
    try {
      if (navigator.share) await navigator.share({ title: channel.name, url });
      else {
        await navigator.clipboard.writeText(url);
        notify('방송국 주소를 복사했어요.');
      }
    } catch {
      notify('주소를 복사하지 못했어요.');
    }
  };
  return (
    <div className="channel-page" style={channelStyle(channel)}>
      <button
        className="back-button floating"
        aria-label="뒤로"
        onClick={() => navigate('channels')}
      >
        <ArrowLeft size={19} />
      </button>
      <ChannelBanner channel={channel} tall />
      <div className="channel-intro">
        {channel.greeting && <span className="channel-greeting">{channel.greeting}</span>}
        <ChannelLogo channel={channel} size={74} />
        <h1>
          {channel.name}
          {channel.featured ? <BadgeCheck size={19} className="channel-verified" /> : null}
        </h1>
        {channel.tagline && <p className="channel-tagline">{channel.tagline}</p>}
        <div className="channel-metrics">
          <div>
            <strong>{channel.drama_count}</strong>
            <span>작품</span>
          </div>
          <div>
            <strong>{count(channel.views)}</strong>
            <span>누적 시청</span>
          </div>
          <div>
            <strong>{count(channel.followers)}</strong>
            <span>구독자</span>
          </div>
        </div>
        {channel.description && <p className="channel-note">{channel.description}</p>}
        <div className="channel-cta">
          {latest && (
            <button className="primary" onClick={() => navigate('drama/' + latest.id)}>
              <Play size={16} fill="currentColor" />
              대표작 보기
            </button>
          )}
          <button className={following ? 'secondary following' : 'secondary'} disabled={busy} onClick={follow}>
            <Heart size={16} fill={following ? 'currentColor' : 'none'} />
            {following ? '구독 중' : '구독하기'}
          </button>
          <button className="secondary" onClick={share} aria-label="방송국 공유">
            <Share2 size={16} />
            공유
          </button>
        </div>
        <p className="channel-owner">
          운영 PD · <strong>{channel.owner_name}</strong>
          {channel.owner_bio ? ` · ${channel.owner_bio}` : ''}
        </p>
      </div>
      <div className="page-content channel-body">
        <div className="section-divider">
          <span>이 방송국의 작품 {channel.dramas.length}</span>
        </div>
        {channel.categories.length > 0 && (
          <div className="genre-chips no-padding">
            <button
              className={category === 'all' ? 'active' : ''}
              onClick={() => setCategory('all')}
            >
              전체
            </button>
            {channel.categories.map((c) => (
              <button
                key={c.id}
                className={category === c.id ? 'active' : ''}
                onClick={() => setCategory(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div className="poster-grid explore-grid">
          {dramas.map((d) => (
            <Poster d={d} key={d.id} />
          ))}
        </div>
        {!dramas.length && (
          <Empty
            title="이 진열대에는 아직 작품이 없어요"
            text="다른 카테고리를 선택해 보세요."
          />
        )}
      </div>
    </div>
  );
}
