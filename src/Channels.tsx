import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  ChevronRight,
  Clapperboard,
  Eye,
  Heart,
  Radio,
  Users,
} from 'lucide-react';
import { api, count, type Channel, type ChannelDetail, type Library, type User } from './api';
import { Empty, Poster, navigate } from './App';

export function ChannelBanner({ channel }: { channel: Channel }) {
  return (
    <div className="channel-banner" style={{ borderColor: channel.accent + '55' }}>
      {channel.banner ? (
        <img src={channel.banner} alt="" />
      ) : (
        <span className="channel-banner-fallback" style={{ background: channel.accent + '22' }} />
      )}
      <span className="channel-banner-shade" />
    </div>
  );
}
export function ChannelLogo({ channel, size = 46 }: { channel: Channel; size?: number }) {
  const src = channel.logo || channel.owner_avatar;
  return (
    <span className="channel-logo" style={{ width: size, height: size, borderColor: channel.accent }}>
      {src ? <img src={src} alt="" /> : <Radio size={size * 0.5} />}
    </span>
  );
}
export function ChannelCard({ channel }: { channel: Channel }) {
  return (
    <button className="channel-card" onClick={() => navigate('channel/' + channel.id)}>
      <ChannelBanner channel={channel} />
      <div className="channel-card-body">
        <ChannelLogo channel={channel} />
        <div>
          <strong>
            {channel.name}
            {channel.featured ? <BadgeCheck size={15} className="lime" /> : null}
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
        <button key={c.id} className="channel-chip" onClick={() => navigate('channel/' + c.id)}>
          <ChannelLogo channel={c} size={52} />
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
          <div className="section-heading">
            <h3>
              추천 방송국 <span className="lime">{featured.length}</span>
            </h3>
          </div>
          <div className="channel-grid">
            {featured.map((c) => (
              <ChannelCard channel={c} key={c.id} />
            ))}
          </div>
        </>
      )}
      <div className="section-heading">
        <h3>
          전체 방송국 <span className="lime">{filtered.length}</span>
        </h3>
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
  return (
    <div className="channel-page">
      <button className="back-button floating" aria-label="뒤로" onClick={() => navigate('channels')}>
        <ArrowLeft size={20} />
      </button>
      <ChannelBanner channel={channel} />
      <div className="page-content channel-head">
        <ChannelLogo channel={channel} size={68} />
        <h1>
          {channel.name}
          {channel.featured ? <BadgeCheck size={20} className="lime" /> : null}
        </h1>
        <p className="channel-tagline">{channel.tagline}</p>
        <div className="channel-stats">
          <span>
            <strong>{channel.drama_count}</strong> 작품
          </span>
          <i />
          <span>
            <strong>{count(channel.views)}</strong> 시청
          </span>
          <i />
          <span>
            <strong>{count(channel.followers)}</strong> 구독자
          </span>
        </div>
        <div className="channel-actions">
          <button className={following ? 'secondary' : 'primary'} disabled={busy} onClick={follow}>
            <Heart size={16} fill={following ? 'currentColor' : 'none'} />
            {following ? '구독 중' : '방송국 구독'}
          </button>
          <button className="secondary" onClick={() => navigate('explore')}>
            다른 작품 보기
          </button>
        </div>
        {channel.description && <p className="channel-description">{channel.description}</p>}
        <div className="channel-owner">
          <Clapperboard size={16} />
          <span>
            운영 PD · <strong>{channel.owner_name}</strong>
          </span>
        </div>
        {channel.categories.length > 0 && (
          <div className="genre-chips no-padding">
            <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>
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
        <div className="section-heading">
          <h3>
            작품 <span className="lime">{dramas.length}</span>
          </h3>
        </div>
        <div className="poster-grid explore-grid">
          {dramas.map((d) => (
            <Poster d={d} key={d.id} />
          ))}
        </div>
        {!dramas.length && (
          <Empty
            title="이 카테고리에는 아직 작품이 없어요"
            text="다른 카테고리를 선택해 보세요."
          />
        )}
      </div>
    </div>
  );
}
