import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Eye,
  Image as ImageIcon,
  Layers,
  Palette,
  Plus,
  Radio,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { api, count, type Channel, type ChannelCategory, type Drama, type User } from './api';
import { Empty, navigate } from './App';
import { ChannelBanner, ChannelLogo, channelStyle, channelThemes } from './Channels';
import { asset } from './platform';

type StudioChannel = { channel: Channel | null; categories: ChannelCategory[]; dramas: Drama[] };
const channelBannerPresets = [
  {
    id: 'neon',
    name: '네온 스튜디오',
    mood: '도시의 밤과 촬영 현장',
    image: '/images/channel-neon.webp',
    accent: '#c4f562',
    theme: 'lime',
    overlay: 45,
  },
  {
    id: 'romance',
    name: '봄날 로맨스',
    mood: '화사하고 따뜻한 설렘',
    image: '/images/channel-romance.webp',
    accent: '#ff9d7a',
    theme: 'coral',
    overlay: 25,
  },
  {
    id: 'noir',
    name: '미스터리 누아르',
    mood: '깊은 밤과 긴장감',
    image: '/images/channel-noir.webp',
    accent: '#7ec8f5',
    theme: 'ocean',
    overlay: 40,
  },
  {
    id: 'fantasy',
    name: '달빛 판타지',
    mood: '신비롭고 장대한 세계',
    image: '/images/channel-fantasy.webp',
    accent: '#bda7f0',
    theme: 'violet',
    overlay: 30,
  },
  {
    id: 'atelier',
    name: '창작 작업실',
    mood: '차분하고 따뜻한 제작 공간',
    image: '/images/channel-atelier.webp',
    accent: '#e7c89a',
    theme: 'sand',
    overlay: 20,
  },
] as const;
const blank = {
  name: '',
  slug: '',
  tagline: '',
  greeting: '',
  description: '',
  banner: '',
  logo: '',
  accent: '#c4f562',
  theme: 'lime',
  banner_fit: 'contain',
  overlay: 45,
  status: 'draft',
};
type Form = typeof blank;
const statusLabel: Record<string, string> = {
  draft: '비공개 (준비 중)',
  active: '공개 중',
  hidden: '숨김',
};
const dramaStatus: Record<string, string> = {
  published: '공개 중',
  pending: '심사 대기',
  draft: '임시저장',
  rejected: '반려',
  hidden: '노출 중단',
};

// 마이 방송국: PD가 자기 방송국의 분위기를 직접 꾸미고 작품을 진열하는 화면입니다.
export default function ChannelStudio({
  user,
  notify,
  reloadChannels,
}: {
  user: User;
  notify: (s: string) => void;
  reloadChannels: () => Promise<void>;
}) {
  const [data, setData] = useState<StudioChannel | null>(null),
    [error, setError] = useState(''),
    [form, setForm] = useState<Form>(blank),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(''),
    [category, setCategory] = useState('');
  // keepForm: 카테고리·진열처럼 폼과 무관한 작업 뒤에는 편집 중인 배너·문구를 서버 값으로 덮어쓰지 않습니다.
  const load = useCallback(async (keepForm = false) => {
    try {
      const r = await api<StudioChannel>('/studio/channel');
      setData(r);
      if (r.channel && keepForm) {
        /* 편집 중인 폼 유지 */
      } else if (r.channel)
        setForm({
          name: r.channel.name,
          slug: r.channel.slug,
          tagline: r.channel.tagline,
          greeting: r.channel.greeting || '',
          description: r.channel.description,
          banner: r.channel.banner,
          logo: r.channel.logo,
          accent: r.channel.accent,
          theme: r.channel.theme || 'lime',
          banner_fit: r.channel.banner_fit || 'contain',
          overlay: r.channel.overlay ?? 45,
          status: r.channel.status,
        });
      else
        setForm({
          ...blank,
          name: user.name + ' 스튜디오',
          slug: 'studio-' + user.id.slice(0, 6),
        });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [user.id, user.name]);
  useEffect(() => {
    void load();
  }, [load]);
  async function upload(field: 'banner' | 'logo', file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return notify('이미지는 10MB 이하로 등록해 주세요.');
    setUploading(field);
    try {
      const body = new FormData();
      body.set('file', file);
      const r = await api<{ url: string }>('/studio/upload', 'POST', body);
      setForm((prev) => ({ ...prev, [field]: r.url }));
      notify(field === 'banner' ? '배너를 등록했어요.' : '로고를 등록했어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading('');
    }
  }
  async function act(fn: () => Promise<unknown>, message: string, keepForm = true) {
    setBusy(true);
    try {
      await fn();
      await load(keepForm);
      await reloadChannels();
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return (
      <Empty
        title="방송국 정보를 불러오지 못했어요"
        text={error}
        action={() => void load()}
        label="다시 시도"
      />
    );
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const preview = {
    ...form,
    id: data.channel?.id || 'preview',
    owner_name: user.name,
    owner_avatar: user.avatar,
    drama_count:
      data.channel?.drama_count ?? data.dramas.filter((d) => d.status === 'published').length,
    views: data.channel?.views ?? 0,
    followers: data.channel?.followers ?? 0,
  } as unknown as Channel;
  return (
    <>
      {data.channel && (
        <div className="stats-grid">
          <div className="stat-card">
            <div>
              <Radio size={18} />
              <span>방송국 상태</span>
            </div>
            <strong>{statusLabel[data.channel.status]}</strong>
            <small>{data.channel.featured ? '메인 추천 노출 중' : '관리자 추천 대기'}</small>
          </div>
          <div className="stat-card">
            <div>
              <Layers size={18} />
              <span>공개 작품</span>
            </div>
            <strong>{data.channel.drama_count}편</strong>
            <small>카테고리 {data.categories.length}개</small>
          </div>
          <div className="stat-card">
            <div>
              <Eye size={18} />
              <span>누적 시청</span>
            </div>
            <strong>{count(data.channel.views)}</strong>
            <small>공개 작품 합계</small>
          </div>
          <div className="stat-card">
            <div>
              <Users size={18} />
              <span>구독자</span>
            </div>
            <strong>{count(data.channel.followers)}</strong>
            <small>방송국을 구독한 시청자</small>
          </div>
        </div>
      )}

      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">CHANNEL DESIGN</span>
            <h3>방송국 꾸미기</h3>
            <p>시청자에게 보이는 그대로 미리 보면서 분위기를 바꿀 수 있어요.</p>
          </div>
          {data.channel && data.channel.status === 'active' && (
            <button
              className="secondary compact"
              onClick={() => navigate('channel/' + data.channel!.id)}
            >
              마이방송국 바로가기
              <ArrowRight size={14} />
            </button>
          )}
        </div>

        <div className="channel-mock" style={channelStyle(preview)}>
          <ChannelBanner channel={preview} />
          <div className="channel-mock-intro">
            {form.greeting && <span className="channel-greeting">{form.greeting}</span>}
            <ChannelLogo channel={preview} size={58} />
            <strong>{form.name || '방송국 이름'}</strong>
            <span>{form.tagline || '한 줄 소개를 입력해 보세요'}</span>
            <div className="channel-metrics">
              <div>
                <strong>{preview.drama_count}</strong>
                <span>작품</span>
              </div>
              <div>
                <strong>{count(preview.views)}</strong>
                <span>누적 시청</span>
              </div>
              <div>
                <strong>{count(preview.followers)}</strong>
                <span>구독자</span>
              </div>
            </div>
          </div>
        </div>

        <h4 className="spaced-title">
          <ImageIcon size={15} /> 생성형 배너 선택
        </h4>
        <p className="channel-design-help">
          숏핑 방송국을 위해 제작한 5종의 배너입니다. 선택한 뒤 아래 저장 버튼을 눌러 적용하세요.
        </p>
        <div className="channel-banner-picker" role="radiogroup" aria-label="방송국 배너 선택">
          {channelBannerPresets.map((preset) => (
            <button
              type="button"
              role="radio"
              aria-checked={form.banner === preset.image}
              key={preset.id}
              className={form.banner === preset.image ? 'selected' : ''}
              onClick={() =>
                setForm({
                  ...form,
                  banner: preset.image,
                  accent: preset.accent,
                  theme: preset.theme,
                  banner_fit: 'cover',
                  overlay: preset.overlay,
                })
              }
            >
              <img src={asset(preset.image)} alt={`${preset.name} 방송국 배너`} />
              <span>
                <strong>{preset.name}</strong>
                <small>{preset.mood}</small>
              </span>
              {form.banner === preset.image && (
                <i aria-hidden="true">
                  <Check size={13} />
                </i>
              )}
            </button>
          ))}
        </div>

        <h4 className="spaced-title">
          <Palette size={15} /> 분위기 테마
        </h4>
        <div className="theme-picker">
          {channelThemes.map((t) => (
            <button
              type="button"
              key={t.id}
              className={form.theme === t.id ? 'selected' : ''}
              style={{ ['--swatch' as string]: t.accent }}
              onClick={() => setForm({ ...form, theme: t.id, accent: t.accent })}
            >
              <span className="theme-swatch" />
              <strong>
                {t.name}
                {form.theme === t.id && <Check size={13} />}
              </strong>
              <small>{t.mood}</small>
            </button>
          ))}
        </div>

        <div className="form-columns">
          <label>
            대표 색상 직접 지정
            <input
              type="color"
              value={form.accent}
              onChange={(e) => setForm({ ...form, accent: e.target.value })}
            />
          </label>
          <label>
            배너 표시 방식
            <select
              value={form.banner_fit}
              onChange={(e) => setForm({ ...form, banner_fit: e.target.value })}
            >
              <option value="contain">원본 전체 보이기 (잘림 없음)</option>
              <option value="cover">배너 영역 꽉 채우기</option>
            </select>
          </label>
          <label>
            배너 어둡기 {form.overlay}%
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={form.overlay}
              onChange={(e) => setForm({ ...form, overlay: Number(e.target.value) })}
            />
          </label>
        </div>

        <div className="form-columns">
          <label className="upload-button compact">
            <Upload size={16} />
            {uploading === 'banner' ? '업로드 중…' : form.banner ? '배너 교체' : '배너 업로드'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={!!uploading}
              onChange={(e) => void upload('banner', e.target.files?.[0])}
            />
          </label>
          <label className="upload-button compact">
            <ImageIcon size={16} />
            {uploading === 'logo' ? '업로드 중…' : form.logo ? '로고 교체' : '로고 업로드'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={!!uploading}
              onChange={(e) => void upload('logo', e.target.files?.[0])}
            />
          </label>
          {(form.banner || form.logo) && (
            <div className="reset-images">
              {form.banner && (
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => setForm({ ...form, banner: '' })}
                >
                  배너 비우기
                </button>
              )}
              {form.logo && (
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => setForm({ ...form, logo: '' })}
                >
                  로고 비우기
                </button>
              )}
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api('/studio/channel', 'PUT', form), '방송국 정보를 저장했어요.', false);
          }}
        >
          <h4 className="spaced-title">방송국 정보</h4>
          <div className="form-columns">
            <label>
              방송국 이름
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                minLength={2}
                maxLength={40}
                required
              />
            </label>
            <label>
              방송국 주소
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                pattern="[a-z0-9][a-z0-9-]{1,29}"
                placeholder="moonlight"
                required
              />
            </label>
          </div>
          <label>
            배너 위 인사말
            <input
              value={form.greeting}
              onChange={(e) => setForm({ ...form, greeting: e.target.value })}
              maxLength={120}
              placeholder="예: 매주 목요일 밤 10시, 새 이야기가 열립니다"
            />
          </label>
          <label>
            한 줄 소개
            <input
              value={form.tagline}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
              maxLength={80}
              placeholder="어떤 이야기를 만드는 방송국인가요?"
            />
          </label>
          <label>
            방송국 소개
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={1500}
              placeholder="제작 방향, 공개 주기, 대표작 등을 소개해 주세요."
            />
          </label>
          <label>
            공개 상태
            <select
              value={form.status}
              disabled={!!data.channel?.admin_hidden}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option value="draft">비공개 (준비 중)</option>
              <option value="active">공개</option>
              <option value="hidden">숨김</option>
            </select>
            {!!data.channel?.admin_hidden && (
              <small className="field-hint">관리자가 운영 정책에 따라 숨긴 방송국이에요. 공개하려면 고객센터로 문의해 주세요.</small>
            )}
          </label>
          <button className="primary full" disabled={busy || !!uploading}>
            {busy ? '저장 중…' : data.channel ? '방송국 정보 저장' : '방송국 개설하기'}
          </button>
        </form>
      </section>

      {data.channel && (
        <>
          <section className="management-panel">
            <div className="panel-heading">
              <div>
                <h3>카테고리</h3>
                <p>방송국 안에서 작품을 묶어 보여주는 진열대입니다. 최대 12개.</p>
              </div>
            </div>
            <div className="category-chips">
              {data.categories.map((c) => (
                <span key={c.id}>
                  {c.name}
                  <button
                    aria-label={c.name + ' 삭제'}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api('/studio/channel/categories/' + c.id, 'DELETE'),
                        '카테고리를 삭제했어요.',
                      )
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              ))}
              {!data.categories.length && <p className="muted">아직 카테고리가 없어요.</p>}
            </div>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!category.trim()) return;
                void act(async () => {
                  await api('/studio/channel/categories', 'POST', { name: category.trim() });
                  setCategory('');
                }, '카테고리를 추가했어요.');
              }}
            >
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="예: 신작, 로맨스, 완결작"
                maxLength={20}
                aria-label="카테고리 이름"
              />
              <button className="primary compact" disabled={busy}>
                <Plus size={15} />
                추가
              </button>
            </form>
          </section>

          <section className="management-panel">
            <div className="panel-heading">
              <div>
                <h3>작품 진열</h3>
                <p>내 작품을 방송국 카테고리에 배치합니다. 공개 중인 작품도 바꿀 수 있어요.</p>
              </div>
              <span className="tag-outline">{data.dramas.length}편</span>
            </div>
            {data.dramas.length ? (
              <div className="shelf-grid">
                {data.dramas.map((d) => (
                  <article className="shelf-card" key={d.id}>
                    <img src={asset(d.image)} alt="" />
                    <div className="shelf-card-body">
                      <span
                        className={'status-chip ' + (d.status === 'published' ? '' : 'neutral')}
                      >
                        {dramaStatus[d.status] || d.status}
                      </span>
                      <strong>{d.title}</strong>
                      <small>
                        {d.genre} · {d.episode_count}회차 ·{' '}
                        {d.free ? '무료' : d.episode_pings ? `회차 ${d.episode_pings}핑` : '회차 기본 핑'}
                      </small>
                      <label className="shelf-select">
                        진열 카테고리
                        <select
                          aria-label={d.title + ' 진열 카테고리'}
                          value={d.category_id || ''}
                          disabled={busy}
                          onChange={(e) =>
                            void act(
                              () =>
                                api('/studio/dramas/' + d.id + '/category', 'PATCH', {
                                  category_id: e.target.value || null,
                                }),
                              '작품 진열을 변경했어요.',
                            )
                          }
                        >
                          <option value="">미분류</option>
                          {data.categories.map((c) => (
                            <option value={c.id} key={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <Empty
                title="등록한 작품이 없어요"
                text="작품을 등록하면 방송국에 진열할 수 있어요."
              />
            )}
          </section>
        </>
      )}
    </>
  );
}
