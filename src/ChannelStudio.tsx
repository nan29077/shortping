import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Eye,
  Image as ImageIcon,
  Layers,
  Plus,
  Radio,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import {
  api,
  count,
  type Channel,
  type ChannelCategory,
  type Drama,
  type User,
} from './api';
import { Empty, navigate } from './App';
import { ChannelLogo } from './Channels';

type StudioChannel = { channel: Channel | null; categories: ChannelCategory[]; dramas: Drama[] };
const blank = {
  name: '',
  slug: '',
  tagline: '',
  description: '',
  banner: '',
  logo: '',
  accent: '#c4f562',
  status: 'draft',
};
const statusLabel: Record<string, string> = {
  draft: '비공개 (준비 중)',
  active: '공개 중',
  hidden: '숨김',
};

// 마이 방송국: a PD's own station page — banner, shelves and the titles shown on it.
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
    [form, setForm] = useState(blank),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(''),
    [category, setCategory] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<StudioChannel>('/studio/channel');
      setData(r);
      if (r.channel)
        setForm({
          name: r.channel.name,
          slug: r.channel.slug,
          tagline: r.channel.tagline,
          description: r.channel.description,
          banner: r.channel.banner,
          logo: r.channel.logo,
          accent: r.channel.accent,
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
      notify(field === 'banner' ? '배너를 업로드했어요.' : '로고를 업로드했어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading('');
    }
  }
  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      await load();
      await reloadChannels();
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return <Empty title="방송국 정보를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
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
            <span className="eyebrow">MY CHANNEL</span>
            <h3>{data.channel ? '방송국 정보' : '나의 방송국 개설'}</h3>
            <p>
              {data.channel
                ? '시청자가 보는 방송국 페이지를 직접 꾸며보세요.'
                : '내 숏폼 드라마를 한곳에 모아 보여주는 나만의 방송국을 만들어요.'}
            </p>
          </div>
          {data.channel && data.channel.status === 'active' && (
            <button
              className="secondary compact"
              onClick={() => navigate('channel/' + data.channel!.id)}
            >
              공개 페이지
              <ArrowRight size={14} />
            </button>
          )}
        </div>
        <div className="channel-preview" style={{ borderColor: form.accent + '55' }}>
          {form.banner ? (
            <img src={form.banner} alt="방송국 배너 미리보기" />
          ) : (
            <span className="channel-preview-empty" style={{ background: form.accent + '1f' }}>
              <ImageIcon size={22} />
              배너 이미지를 등록하면 이곳에 표시됩니다
            </span>
          )}
          <div className="channel-preview-body">
            <ChannelLogo
              channel={
                {
                  logo: form.logo,
                  owner_avatar: user.avatar,
                  accent: form.accent,
                } as Channel
              }
              size={52}
            />
            <div>
              <strong>{form.name || '방송국 이름'}</strong>
              <span>{form.tagline || '한 줄 소개를 입력해 주세요'}</span>
            </div>
          </div>
        </div>
        <div className="form-columns">
          <label className="upload-button compact">
            <Upload size={16} />
            {uploading === 'banner' ? '업로드 중…' : '배너 업로드'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={!!uploading}
              onChange={(e) => void upload('banner', e.target.files?.[0])}
            />
          </label>
          <label className="upload-button compact">
            <Upload size={16} />
            {uploading === 'logo' ? '업로드 중…' : '로고 업로드'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={!!uploading}
              onChange={(e) => void upload('logo', e.target.files?.[0])}
            />
          </label>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api('/studio/channel', 'PUT', form), '방송국 정보를 저장했어요.');
          }}
        >
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
          <div className="form-columns">
            <label>
              대표 색상
              <input
                type="color"
                value={form.accent}
                onChange={(e) => setForm({ ...form, accent: e.target.value })}
              />
            </label>
            <label>
              공개 상태
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value="draft">비공개 (준비 중)</option>
                <option value="active">공개</option>
                <option value="hidden">숨김</option>
              </select>
            </label>
          </div>
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
            </div>
            {data.dramas.length ? (
              <div className="shelf-list">
                {data.dramas.map((d) => (
                  <div className="shelf-row" key={d.id}>
                    <img src={d.image} alt="" />
                    <div>
                      <strong>{d.title}</strong>
                      <small>
                        {d.genre} · {d.episode_count}회차
                      </small>
                    </div>
                    <select
                      aria-label={d.title + ' 카테고리'}
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
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="등록한 작품이 없어요" text="작품을 등록하면 방송국에 진열할 수 있어요." />
            )}
          </section>
        </>
      )}
    </>
  );
}
