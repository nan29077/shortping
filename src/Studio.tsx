import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Clapperboard,
  Clock3,
  Eye,
  FileVideo,
  Film,
  LayoutDashboard,
  Plus,
  Send,
  ShieldCheck,
  Ticket,
  Upload,
  Users,
  Wallet,
  ScrollText,
  Settings2,
  BookOpen,
  Crown,
  Search,
  RefreshCw,
  LogOut,
  MessageCircle,
  Home,
  Palette,
  Radio,
  Tag,
  Banknote,
  Receipt,
  SlidersHorizontal,
  UserCog,
} from 'lucide-react';
import {
  api,
  count,
  won,
  type Drama,
  type HomeAppearance as Appearance,
  type Order,
  type User,
} from './api';
import ContentReview, { reviewStatus, type ManagedDrama } from './ContentReview';
import { Brand, Empty, Modal, navigate } from './App';
import {
  StudioInsights,
  StudioOrders,
  StudioAudit,
  StudioSubscriptions,
  StudioOperations,
  StudioGuide,
} from './StudioPanels';
import Support from './Support';
import AccountSettings, { Avatar } from './AccountSettings';
import HomeAppearance from './HomeAppearance';
import ChannelStudio from './ChannelStudio';
import Settlement from './Settlement';
import AdminMembers from './AdminMembers';
import {
  AdminChannelsPanel,
  AdminPricingPanel,
  AdminSettingsPanel,
  AdminSettlementPanel,
  AdminTaxPanel,
} from './AdminSettlement';

export type StudioData = {
  dramas: Drama[];
  orders: Order[];
  users: User[];
  logs: { id: string; name: string; action: string; target_id: string; created_at: string }[];
  subscriptions: {
    user_id: string;
    name: string;
    email: string;
    expires_at: string;
    auto_renew: number;
  }[];
  operations: {
    database: string;
    environment: string;
    demo: boolean;
    androidReady: boolean;
    iosReady: boolean;
  } | null;
};
const statusLabel: Record<string, string> = {
  published: '공개 중',
  pending: '심사 대기',
  draft: '임시저장',
  rejected: '반려',
};
const initialForm = {
  title: '',
  tagline: '',
  synopsis: '',
  genre: '로맨스',
  price: 3900,
  episode_price: 500,
  free_episodes: 3,
  image: '/images/hero.webp',
};
export default function Studio({
  user,
  demo,
  notify,
  reloadCatalog,
  section,
  logout,
  onUser,
  reloadLibrary,
  onAppearance,
  reloadChannels,
}: {
  user: User;
  demo: boolean;
  notify: (s: string) => void;
  reloadCatalog: () => Promise<void>;
  section?: string;
  logout: () => Promise<void>;
  onUser: (user: User) => void;
  reloadLibrary: () => Promise<void>;
  onAppearance: (appearance: Appearance) => void;
  reloadChannels: () => Promise<void>;
}) {
  const [data, setData] = useState<StudioData | null>(null),
    [error, setError] = useState(''),
    [editor, setEditor] = useState<Drama | 'new' | null>(null),
    [episodeEditor, setEpisodeEditor] = useState<Drama | null>(null),
    [review, setReview] = useState<Drama | null>(null),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState('all'),
    [contentSearch, setContentSearch] = useState('');
  const admin = user.role === 'admin';
  // 1차 분류(성격)와 2차 분류(메뉴). 관리자와 PD가 같은 구조를 공유합니다.
  const groups = admin
    ? [
        {
          id: 'status',
          name: '운영 현황',
          items: [
            { id: 'overview', name: '대시보드', icon: LayoutDashboard },
            { id: 'operations', name: '서비스 상태', icon: Settings2 },
          ],
        },
        {
          id: 'content',
          name: '콘텐츠 관리',
          items: [
            { id: 'contents', name: '콘텐츠 · 심사', icon: Film },
            { id: 'pricing', name: '작품 판매 설정', icon: Tag },
            { id: 'channels', name: '방송국 관리', icon: Radio },
            { id: 'home', name: '메인페이지 관리', icon: Palette },
          ],
        },
        {
          id: 'member',
          name: '회원 관리',
          items: [
            { id: 'members', name: '전체 회원', icon: Users },
            { id: 'subscriptions', name: '구독 현황', icon: Crown },
            { id: 'support', name: '고객 문의', icon: MessageCircle },
          ],
        },
        {
          id: 'money',
          name: '정산 · 세무',
          items: [
            { id: 'settlement', name: '정산 관리', icon: Wallet },
            { id: 'payouts', name: '출금 승인', icon: Banknote },
            { id: 'tax', name: '세무 관리', icon: Receipt },
            { id: 'orders', name: '주문 내역', icon: Ticket },
          ],
        },
        {
          id: 'ops',
          name: '설정 · 기록',
          items: [
            { id: 'policy', name: '요금 · 정책 설정', icon: SlidersHorizontal },
            { id: 'audit', name: '운영 기록', icon: ScrollText },
            { id: 'guide', name: '운영 가이드', icon: BookOpen },
            { id: 'settings', name: '내 계정', icon: UserCog },
          ],
        },
      ]
    : [
        {
          id: 'status',
          name: '스튜디오 현황',
          items: [
            { id: 'overview', name: '대시보드', icon: LayoutDashboard },
            { id: 'orders', name: '판매 주문', icon: Ticket },
          ],
        },
        {
          id: 'content',
          name: '콘텐츠 · 방송국',
          items: [
            { id: 'contents', name: '내 작품 · 회차', icon: Film },
            { id: 'channel', name: '마이 방송국', icon: Radio },
          ],
        },
        {
          id: 'money',
          name: '정산 · 출금',
          items: [
            { id: 'settlement', name: '정산 현황', icon: Wallet },
            { id: 'payouts', name: '출금 관리', icon: Banknote },
            { id: 'tax', name: '세무 · 정산 정보', icon: Receipt },
          ],
        },
        {
          id: 'ops',
          name: '운영',
          items: [
            { id: 'guide', name: '운영 가이드', icon: BookOpen },
            { id: 'settings', name: '내 계정', icon: UserCog },
          ],
        },
      ];
  const tabs = groups.flatMap((g) => g.items);
  const tab = tabs.some((t) => t.id === section) ? section || 'overview' : 'overview';
  const setTab = (next: string) => navigate('studio/' + next);
  async function reload() {
    try {
      setData(await api<StudioData>('/studio'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void reload();
  }, [user.id, section]);
  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      await reload();
      await reloadCatalog();
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
        title="스튜디오를 불러오지 못했어요"
        text={error}
        action={() => {
          setError('');
          void reload();
        }}
        label="다시 시도"
      />
    );
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const pending = data.dramas.filter((d) => d.status === 'pending'),
    revenue = data.orders.reduce((sum, o) => sum + o.amount, 0);
  return (
    <>
      <header className="management-topbar">
        <a href="#/studio">
          <Brand small />
          <span>{admin ? 'ADMIN CONSOLE' : 'CREATOR STUDIO'}</span>
        </a>
        <div>
          <span className="environment-pill">{demo ? '테스트 운영' : '서비스 운영'}</span>
          <button onClick={() => navigate('home')}>
            <Eye size={16} />
            시청자 화면
          </button>
          <button onClick={() => navigate('my')}>
            <Users size={16} />
            마이페이지
          </button>
        </div>
      </header>
      <aside className="management-sidebar">
        <span className="sidebar-caption">WORKSPACE</span>
        <nav aria-label="관리자 메뉴">
          {groups.map((group) => (
            <div className="sidebar-group" key={group.id}>
              <span className="sidebar-group-label">{group.name}</span>
              {group.items.map(({ id, name, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={tab === id ? 'active' : ''}
                  aria-current={tab === id ? 'page' : undefined}
                >
                  <Icon size={18} />
                  <span>{name}</span>
                  {id === 'contents' && pending.length > 0 && <i>{pending.length}</i>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className="sidebar-profile"
            onClick={() => setTab('settings')}
            aria-label="내 프로필 보기"
          >
            <span className="sidebar-profile-avatar">
              <Avatar user={user} />
            </span>
            <span className="sidebar-profile-details">
              <strong>{user.name}</strong>
              <small>{admin ? '슈퍼관리자' : '업로더 (PD)'}</small>
              <span title={user.email}>{user.email}</span>
            </span>
            <ChevronRight size={14} />
          </button>
          <button className="sidebar-home" onClick={() => navigate('home')}>
            <Home size={17} />
            메인으로
            <ArrowRight size={15} />
          </button>
          <button className="sidebar-logout" onClick={logout}>
            <LogOut size={16} />
            로그아웃
          </button>
        </div>
      </aside>
      <div className="studio-page">
        <div className="management-breadcrumb">
          {admin ? '슈퍼관리자' : 'PD 스튜디오'}
          <ChevronRight size={13} />
          {groups.find((g) => g.items.some((t) => t.id === tab))?.name}
          <ChevronRight size={13} />
          {tabs.find((t) => t.id === tab)?.name}
          <button disabled={busy} onClick={() => act(async () => {}, '최신 데이터를 불러왔어요.')}>
            <RefreshCw size={15} />
            새로고침
          </button>
        </div>
        <div className="studio-header">
          <div>
            <span className="eyebrow lime">{admin ? 'SHORTPING ADMIN' : 'SHORTPING STUDIO'}</span>
            <h1>
              {tab === 'overview'
                ? admin
                  ? '오늘의 숏핑 한눈에'
                  : '나의 크리에이터 스튜디오'
                : tabs.find((t) => t.id === tab)?.name}
            </h1>
            <p>
              {admin
                ? '콘텐츠, 시청자, 운영 흐름을 한곳에서 관리하세요.'
                : `${user.name}님, 다음 이야기를 기다리는 시청자를 만나보세요.`}
            </p>
          </div>
          <div className="studio-avatar">
            <Avatar user={user} />
          </div>
        </div>
        <div className="studio-tabs">
          {tabs.map(({ id, name, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)} className={tab === id ? 'active' : ''}>
              <Icon size={16} />
              {name}
              {id === 'contents' && pending.length > 0 && <i>{pending.length}</i>}
            </button>
          ))}
        </div>
        {tab === 'overview' && (
          <>
            <div className="stats-grid">
              <Stat
                icon={<Film size={18} />}
                label="등록 작품"
                value={data.dramas.length + '편'}
                detail={`공개 중 ${data.dramas.filter((d) => d.status === 'published').length}편`}
              />
              <Stat
                icon={<Eye size={18} />}
                label="콘텐츠 조회"
                value={count(data.dramas.reduce((n, d) => n + d.views, 0))}
                detail="데모 초기 데이터 포함"
              />
              <Stat
                icon={<Wallet size={18} />}
                label="테스트 매출"
                value={won(revenue)}
                detail="실제 청구 금액 아님"
              />
              <Stat
                icon={<Clock3 size={18} />}
                label="심사 대기"
                value={pending.length + '편'}
                detail="새로운 이야기를 기다려요"
              />
            </div>
            <StudioInsights data={data} />
            <div className="studio-callout">
              <Clapperboard size={30} />
              <div>
                <h3>{admin ? '좋은 이야기가 세상에 닿도록' : '다음 히트작, 여기서 시작하세요'}</h3>
                <p>
                  {admin
                    ? '작품과 회차를 검토하고 공개를 승인하세요.'
                    : '작품 등록부터 회차 업로드, 심사 요청까지.'}
                </p>
              </div>
              <button
                className="primary"
                onClick={() => {
                  if (admin) {
                    setFilter('pending');
                    setTab('contents');
                  } else setEditor('new');
                }}
              >
                {admin ? '심사하기' : '작품 등록'}
                <Plus size={16} />
              </button>
            </div>
            <div className="section-heading">
              <h2>콘텐츠 현황</h2>
              <button onClick={() => setTab('contents')}>
                전체보기
                <ChevronRight size={14} />
              </button>
            </div>
            {data.dramas.slice(0, 4).map((d) => (
              <ContentRow
                key={d.id}
                d={d}
                onClick={() => {
                  setTab('contents');
                  setFilter('all');
                }}
              />
            ))}
            {admin && (
              <div className="audit-panel">
                <h3>최근 운영 기록</h3>
                {data.logs.length ? (
                  data.logs.slice(0, 6).map((l) => (
                    <div className="audit-row" key={l.id}>
                      <ShieldCheck size={16} />
                      <span>
                        {l.name} ·{' '}
                        {reviewStatus[l.action]
                          ? reviewStatus[l.action]
                          : l.action === 'support:replied'
                            ? '문의 답변 등록'
                            : '회원 권한 변경'}
                      </span>
                      <small>{new Date(l.created_at).toLocaleDateString('ko-KR')}</small>
                    </div>
                  ))
                ) : (
                  <p className="muted">작품 심사와 회원 권한 변경 이력이 기록됩니다.</p>
                )}
              </div>
            )}
          </>
        )}
        {tab === 'contents' && (
          <>
            <div className="section-heading">
              <h2>
                {admin ? '전체 콘텐츠' : '내 작품'}{' '}
                <span className="lime">{data.dramas.length}</span>
              </h2>
              <button className="primary compact" onClick={() => setEditor('new')}>
                <Plus size={15} />새 작품
              </button>
            </div>
            <label className="management-search">
              <Search size={18} />
              <input
                aria-label="작품 검색"
                placeholder="작품명 또는 장르 검색"
                value={contentSearch}
                onChange={(e) => setContentSearch(e.target.value)}
              />
            </label>
            <div className="studio-filters">
              {[
                ['all', '전체'],
                ['pending', '심사 대기'],
                ['published', '공개 중'],
                ['draft', '임시저장'],
                ['rejected', '반려'],
              ].map(([v, t]) => (
                <button
                  className={filter === v ? 'active' : ''}
                  key={v}
                  onClick={() => setFilter(v)}
                >
                  {t}
                </button>
              ))}
            </div>
            {data.dramas
              .filter(
                (d) =>
                  (filter === 'all' || d.status === filter) &&
                  `${d.title} ${d.genre}`.toLowerCase().includes(contentSearch.toLowerCase()),
              )
              .map((d) => (
                <div key={d.id} className="manage-content">
                  <ContentRow d={d} onClick={() => setReview(d)} />
                  {d.review_note && <div className="review-note">검토 의견: {d.review_note}</div>}
                  <div className="content-tools">
                    {['draft', 'rejected'].includes(d.status) && (
                      <>
                        <button onClick={() => setEditor(d)}>작품 수정</button>
                        <button onClick={() => setEpisodeEditor(d)}>
                          <FileVideo size={14} />
                          회차 관리
                        </button>
                        <button
                          className="lime"
                          disabled={busy}
                          onClick={() =>
                            act(
                              () => api('/studio/dramas/' + d.id + '/submit', 'POST'),
                              '심사를 요청했어요. 관리자 승인 후 공개됩니다.',
                            )
                          }
                        >
                          <Send size={14} />
                          심사 요청
                        </button>
                      </>
                    )}
                    {d.status === 'pending' &&
                      (admin ? (
                        <button
                          className="lime"
                          onClick={() => {
                            setReview(d);
                          }}
                        >
                          작품 검토 · 승인
                          <ArrowRight size={14} />
                        </button>
                      ) : (
                        <span className="muted">관리자가 작품을 검토하고 있어요.</span>
                      ))}
                    {d.status === 'published' && (
                      <button onClick={() => navigate('drama/' + d.id)}>
                        공개 페이지 보기
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            {!data.dramas.some(
              (d) =>
                (filter === 'all' || d.status === filter) &&
                `${d.title} ${d.genre}`.toLowerCase().includes(contentSearch.toLowerCase()),
            ) && <Empty title="해당 상태의 작품이 없어요" text="새로운 작품을 등록해 보세요." />}
          </>
        )}
        {tab === 'channel' && !admin && (
          <ChannelStudio user={user} notify={notify} reloadChannels={reloadChannels} />
        )}
        {tab === 'settlement' &&
          (admin ? (
            <AdminSettlementPanel section="settlements" notify={notify} />
          ) : (
            <Settlement user={user} section="settlement" notify={notify} />
          ))}
        {tab === 'payouts' &&
          (admin ? (
            <AdminSettlementPanel section="payouts" notify={notify} />
          ) : (
            <Settlement user={user} section="payouts" notify={notify} />
          ))}
        {tab === 'tax' &&
          (admin ? (
            <AdminTaxPanel notify={notify} />
          ) : (
            <Settlement user={user} section="tax" notify={notify} />
          ))}
        {tab === 'members' && admin && <AdminMembers user={user} notify={notify} />}
        {tab === 'channels' && admin && (
          <AdminChannelsPanel notify={notify} reloadChannels={reloadChannels} />
        )}
        {tab === 'pricing' && admin && (
          <AdminPricingPanel
            dramas={data.dramas}
            notify={notify}
            reload={async () => {
              await reload();
              await reloadCatalog();
            }}
          />
        )}
        {tab === 'policy' && admin && <AdminSettingsPanel notify={notify} />}
        {tab === 'orders' && <StudioOrders orders={data.orders} />}
        {tab === 'support' && admin && <Support user={user} managing notify={notify} />}
        {tab === 'subscriptions' && admin && (
          <StudioSubscriptions subscriptions={data.subscriptions} />
        )}
        {tab === 'audit' && admin && (
          <StudioAudit logs={data.logs} dramas={data.dramas} users={data.users} />
        )}
        {tab === 'operations' && admin && <StudioOperations operations={data.operations} />}
        {tab === 'home' && admin && <HomeAppearance notify={notify} onAppearance={onAppearance} />}
        {tab === 'guide' && <StudioGuide admin={admin} onCreate={() => setEditor('new')} />}
        {tab === 'settings' && (
          <AccountSettings
            key={user.id}
            user={user}
            onUser={onUser}
            notify={notify}
            onHistoryCleared={reloadLibrary}
          />
        )}
        {editor && (
          <DramaEditor
            drama={editor}
            notify={notify}
            close={() => setEditor(null)}
            onSaved={async () => {
              setEditor(null);
              await reload();
              await reloadCatalog();
            }}
          />
        )}
        {episodeEditor && (
          <EpisodeEditor
            d={episodeEditor}
            demo={demo}
            notify={notify}
            close={() => {
              setEpisodeEditor(null);
              void reload();
            }}
          />
        )}
        {review && (
          <ContentReview
            drama={review}
            admin={admin}
            close={() => setReview(null)}
            onReviewed={async () => {
              await reload();
              await reloadCatalog();
              notify('심사 결과를 저장했어요.');
            }}
          />
        )}
      </div>
    </>
  );
}
function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="stat-card">
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function ContentRow({ d, onClick }: { d: Drama; onClick: () => void }) {
  return (
    <button className="content-row" onClick={onClick}>
      <img src={d.image} alt="" />
      <div>
        <span className={'status ' + d.status}>{statusLabel[d.status]}</span>
        <h3>{d.title}</h3>
        <p>
          {d.genre} · {d.episode_count}회차 · {count(d.views)} 조회
        </p>
      </div>
      <ChevronRight size={18} />
    </button>
  );
}
function DramaEditor({
  drama,
  notify,
  close,
  onSaved,
}: {
  drama: Drama | 'new';
  notify: (s: string) => void;
  close: () => void;
  onSaved: () => Promise<void>;
}) {
  const [f, setF] = useState(
      drama === 'new'
        ? initialForm
        : {
            title: drama.title,
            tagline: drama.tagline,
            synopsis: drama.synopsis,
            genre: drama.genre,
            price: drama.price,
            episode_price: drama.episode_price ?? 0,
            free_episodes: drama.free_episodes,
            image: drama.image,
          },
    ),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false);
  async function upload(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      notify('포스터 이미지는 10MB 이하로 등록해 주세요.');
      return;
    }
    setUploading(true);
    try {
      const b = new FormData();
      b.set('file', file);
      const r = await api<{ url: string }>('/studio/upload', 'POST', b);
      setF((prev) => ({ ...prev, image: r.url }));
      notify('포스터를 업로드했어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  return (
    <Modal
      title={drama === 'new' ? '새로운 이야기 등록' : '작품 정보 수정'}
      close={() => {
        if (!busy && !uploading) close();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(
              '/studio/dramas' + (drama === 'new' ? '' : '/' + drama.id),
              drama === 'new' ? 'POST' : 'PATCH',
              f,
            );
            notify('작품을 임시저장했어요. 회차를 추가한 뒤 심사를 요청하세요.');
            await onSaved();
          } catch (err) {
            notify((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          작품 제목
          <input
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            required
            minLength={2}
            maxLength={70}
            placeholder="기억에 남을 제목을 지어주세요"
          />
        </label>
        <label>
          한 줄 소개
          <input
            value={f.tagline}
            onChange={(e) => setF({ ...f, tagline: e.target.value })}
            required
            minLength={2}
            maxLength={120}
            placeholder="이 이야기를 한 문장으로 표현한다면?"
          />
        </label>
        <label>
          줄거리
          <textarea
            value={f.synopsis}
            onChange={(e) => setF({ ...f, synopsis: e.target.value })}
            required
            minLength={10}
            maxLength={3000}
            placeholder="작품의 줄거리를 10자 이상 작성해 주세요"
          />
        </label>
        <div className="form-columns">
          <label>
            장르
            <select value={f.genre} onChange={(e) => setF({ ...f, genre: e.target.value })}>
              {['로맨스', '스릴러', '판타지', '코미디', '청춘'].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
          <label>
            전체 소장 가격 (원)
            <input
              type="number"
              value={f.price}
              min={0}
              max={100000}
              onChange={(e) => setF({ ...f, price: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            회차 구매 가격 (원 · 0이면 기본값)
            <input
              type="number"
              value={f.episode_price}
              min={0}
              max={100000}
              onChange={(e) => setF({ ...f, episode_price: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            무료 회차 수
            <input
              type="number"
              value={f.free_episodes}
              min={1}
              max={50}
              onChange={(e) => setF({ ...f, free_episodes: Number(e.target.value) })}
              required
            />
          </label>
        </div>
        <p className="field-hint">
          시청자는 잠긴 회차에서 회차 구매 가격으로 한 편씩 결제하거나, 전체 소장 가격으로 모든
          회차를 소장할 수 있어요.
        </p>
        <label>작품 포스터</label>
        <img className="editor-poster-preview" src={f.image} alt="선택한 작품 포스터 미리보기" />
        <div className="poster-picker">
          {['hero', 'spring', 'shadow', 'moon'].map((i) => (
            <button
              type="button"
              key={i}
              className={f.image === `/images/${i}.webp` ? 'selected' : ''}
              onClick={() => setF({ ...f, image: `/images/${i}.webp` })}
            >
              <img src={'/images/' + i + '.webp'} alt={i + ' 포스터 선택'} />
              {f.image === `/images/${i}.webp` && <Check size={20} />}
            </button>
          ))}
        </div>
        <label className="upload-button">
          <Upload size={17} />
          {uploading
            ? '업로드 중…'
            : f.image.startsWith('/uploads/')
              ? '업로드한 포스터 선택됨'
              : '내 포스터 업로드 (JPG · PNG · WEBP)'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={uploading}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </label>
        <button className="primary full" disabled={busy || uploading}>
          {busy ? '저장 중…' : '작품 임시저장'}
        </button>
      </form>
    </Modal>
  );
}
function EpisodeEditor({
  d,
  demo,
  notify,
  close,
}: {
  d: Drama;
  demo: boolean;
  notify: (s: string) => void;
  close: () => void;
}) {
  const [detail, setDetail] = useState<ManagedDrama | null>(null),
    [f, setF] = useState({ number: 1, title: '', video: '', duration: 90 }),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [editing, setEditing] = useState(false),
    [removeNumber, setRemoveNumber] = useState<number | null>(null),
    [loadError, setLoadError] = useState('');
  const load = async () => {
    try {
      const r = await api<ManagedDrama>('/studio/dramas/' + d.id);
      setDetail(r);
      setF({
        number: Math.max(0, ...r.episodes.map((e) => e.number)) + 1,
        title: '',
        video: '',
        duration: 90,
      });
      setEditing(false);
      setRemoveNumber(null);
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [d.id]);
  return (
    <Modal
      title={d.title + ' · 회차 관리'}
      close={() => {
        if (!busy && !uploading) close();
      }}
    >
      {loadError && (
        <p role="alert" className="review-alert">
          {loadError}
          <button className="secondary compact" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
      {detail && detail.episodes.length > 0 && (
        <div className="registered-episodes">
          {detail.episodes.map((e) => (
            <div key={e.id}>
              <FileVideo size={16} />
              <span>
                {e.number}화 · {e.title}
              </span>
              <small>{e.duration}초</small>
              <button
                type="button"
                className="secondary compact"
                disabled={busy || uploading}
                onClick={() => {
                  setF({ number: e.number, title: e.title, video: e.video, duration: e.duration });
                  setEditing(true);
                  setRemoveNumber(null);
                }}
              >
                수정
              </button>
              {e.number === Math.max(...detail.episodes.map((ep) => ep.number)) && (
                <button
                  type="button"
                  className="secondary compact"
                  disabled={busy || uploading}
                  onClick={() => setRemoveNumber(e.number)}
                >
                  삭제
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {removeNumber !== null && (
        <div className="review-alert">
          {removeNumber}화 등록을 삭제할까요? 원본 파일은 유지됩니다.
          <div className="form-actions">
            <button className="secondary" disabled={busy} onClick={() => setRemoveNumber(null)}>
              취소
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/studio/dramas/' + d.id + '/episodes/' + removeNumber, 'DELETE');
                  await load();
                  notify('회차 등록을 삭제했어요.');
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              회차 삭제 확인
            </button>
          </div>
        </div>
      )}
      {detail?.issues.length ? <div className="info-box">{detail.issues.join(' ')}</div> : null}
      {editing && (
        <div className="info-box">
          {f.number}화 수정 중 · 영상 교체 없이 제목을 수정할 수 있어요.
          <button
            type="button"
            className="secondary compact"
            disabled={busy || uploading}
            onClick={() => void load()}
          >
            새 회차 등록으로
          </button>
        </div>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('/studio/dramas/' + d.id + '/episodes', 'POST', f);
            await load();
            notify('회차 영상을 저장했어요.');
          } catch (err) {
            notify((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-columns">
          <label>
            회차
            <input type="number" min={1} max={500} value={f.number} readOnly required />
          </label>
          <label>
            재생 시간 (초 · 자동 측정)
            <input type="number" min={1} max={3600} value={f.duration} readOnly required />
          </label>
        </div>
        <label>
          회차 제목
          <input
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            placeholder="이 회차의 제목"
            required
            maxLength={100}
          />
        </label>
        <label className="video-drop">
          <Upload size={27} />
          <strong>
            {uploading ? '영상 업로드 중…' : f.video ? '영상이 준비됐어요' : 'MP4 영상 업로드'}
          </strong>
          <small>H.264 MP4 · 세로형 권장 · 최대 250MB / 60분</small>
          <input
            type="file"
            accept="video/mp4"
            disabled={uploading}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 250 * 1024 * 1024) {
                notify('250MB 이하 영상을 선택해 주세요.');
                return;
              }
              setUploading(true);
              try {
                const body = new FormData();
                body.set('file', file);
                const r = await api<{ url: string; duration: number }>(
                  '/studio/upload',
                  'POST',
                  body,
                );
                setF((prev) => ({ ...prev, video: r.url, duration: r.duration }));
                notify('파일 검사가 완료됐어요. 회차 저장을 눌러 등록하세요.');
              } catch (err) {
                notify((err as Error).message);
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
        {demo && (
          <button
            className="secondary full"
            type="button"
            disabled={uploading || busy}
            onClick={() => setF({ ...f, video: '/demo/preview.mp4', duration: 12 })}
          >
            <PlayIcon />
            개발용 샘플 영상 사용
          </button>
        )}
        <button className="primary full" disabled={busy || uploading || !f.video || !detail}>
          {busy ? '저장 중…' : `${f.number}화 ${editing ? '수정 저장' : '저장'}`}
        </button>
        <p className="demo-footnote">
          기존 회차는 목록의 수정 버튼으로 수정할 수 있어요.
          <br />
          영상 등록 후 작품 목록에서 심사를 요청하세요.
        </p>
      </form>
    </Modal>
  );
}
function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="m6 3 15 9-15 9z" />
    </svg>
  );
}
