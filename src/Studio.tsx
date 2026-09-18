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
  X,
  ScrollText,
  Settings2,
  BookOpen,
  Crown,
  Search,
  RefreshCw,
  LogOut,
  MessageCircle,
  Home,
} from 'lucide-react';
import { api, count, won, type Detail, type Drama, type Order, type User } from './api';
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
}: {
  user: User;
  demo: boolean;
  notify: (s: string) => void;
  reloadCatalog: () => Promise<void>;
  section?: string;
  logout: () => Promise<void>;
}) {
  const [data, setData] = useState<StudioData | null>(null),
    [error, setError] = useState(''),
    [editor, setEditor] = useState<Drama | 'new' | null>(null),
    [episodeEditor, setEpisodeEditor] = useState<Drama | null>(null),
    [review, setReview] = useState<Drama | null>(null),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState('all'),
    [userEdit, setUserEdit] = useState<User | null>(null),
    [contentSearch, setContentSearch] = useState(''),
    [userSearch, setUserSearch] = useState(''),
    [userRole, setUserRole] = useState('all');
  const admin = user.role === 'admin';
  const tabs = [
    { id: 'overview', name: '대시보드', icon: LayoutDashboard },
    { id: 'contents', name: admin ? '콘텐츠 · 심사' : '내 작품 · 회차', icon: Film },
    { id: 'revenue', name: '매출 · 정산', icon: Wallet },
    { id: 'orders', name: '주문 내역', icon: Ticket },
    ...(admin
      ? [
          { id: 'users', name: '회원 · 권한', icon: Users },
          { id: 'subscriptions', name: '구독 현황', icon: Crown },
          { id: 'support', name: '고객 문의', icon: MessageCircle },
          { id: 'audit', name: '운영 기록', icon: ScrollText },
          { id: 'operations', name: '서비스 상태', icon: Settings2 },
        ]
      : []),
    { id: 'guide', name: '운영 가이드', icon: BookOpen },
  ];
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
  const reviewed = async (status: 'published' | 'rejected') => {
    if (!review) return;
    await act(
      async () => {
        await api('/admin/dramas/' + review.id + '/review', 'POST', { status, note });
        setReview(null);
        setNote('');
      },
      status === 'published' ? '작품을 승인하고 공개했어요.' : '반려 사유를 PD에게 전달했어요.',
    );
  };
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
          {tabs.map(({ id, name, icon: Icon }) => (
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
        </nav>
        <div className="sidebar-footer">
          <button
            className="sidebar-profile"
            onClick={() => navigate('my')}
            aria-label="내 프로필 보기"
          >
            <span className="sidebar-profile-avatar">{user.name[0]}</span>
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
          {admin ? '관리자' : 'PD 스튜디오'}
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
            {admin ? <ShieldCheck size={28} /> : <Clapperboard size={28} />}
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
                        {l.action === 'published'
                          ? '작품 공개 승인'
                          : l.action === 'rejected'
                            ? '작품 반려'
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
                  <ContentRow d={d} onClick={() => navigate('drama/' + d.id)} />
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
                            setNote('');
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
        {tab === 'revenue' && (
          <>
            <div className="section-heading">
              <h2>매출 · 정산</h2>
              <span className="tag-outline">테스트 데이터</span>
            </div>
            <div className="stats-grid two">
              <Stat
                icon={<Ticket size={18} />}
                label="구매 건수"
                value={data.orders.length + '건'}
                detail="완료된 테스트 결제"
              />
              <Stat
                icon={<Wallet size={18} />}
                label="테스트 매출 합계"
                value={won(revenue)}
                detail="실제 정산은 연동 예정"
              />
            </div>
            <div className="info-box">
              현재 결제 내역은 기능 검증용입니다. 실제 수익 배분율, 정산 주기, 세금 처리는 계약과
              결제사 연동 시 적용합니다. PD 내역에는 본인 작품의 개별 구매만 표시됩니다.
            </div>
            <h3 className="spaced-title">최근 거래</h3>
            {data.orders.length ? (
              data.orders.map((o) => (
                <div className="order-row" key={o.id}>
                  <div>
                    <strong>{o.title || '숏핑 패스 구독'}</strong>
                    <span>{new Date(o.created_at).toLocaleString('ko-KR')} · 테스트 완료</span>
                  </div>
                  <b>{won(o.amount)}</b>
                </div>
              ))
            ) : (
              <Empty
                title="첫 구매를 기다리고 있어요"
                text="시청자 계정에서 테스트 구매를 진행하면 이곳에 표시됩니다."
              />
            )}
          </>
        )}
        {tab === 'users' && admin && (
          <>
            <div className="section-heading">
              <h2>회원 관리</h2>
              <span className="muted">총 {data.users.length}명</span>
            </div>
            <div className="info-box">
              가입한 시청자를 PD로 승격하거나 이용 상태를 변경할 수 있어요. 권한 변경은 운영 기록에
              남습니다.
            </div>
            <div className="management-toolbar">
              <label className="management-search">
                <Search size={18} />
                <input
                  aria-label="회원 검색"
                  placeholder="이름 또는 이메일 검색"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                />
              </label>
              <select
                aria-label="회원 역할 필터"
                value={userRole}
                onChange={(e) => setUserRole(e.target.value)}
              >
                <option value="all">모든 계정</option>
                <option value="viewer">시청자</option>
                <option value="pd">업로더 (PD)</option>
                <option value="admin">슈퍼관리자</option>
              </select>
            </div>
            {!data.users.some(
              (u) =>
                (userRole === 'all' || u.role === userRole) &&
                `${u.name} ${u.email}`.toLowerCase().includes(userSearch.toLowerCase()),
            ) && <Empty title="검색 결과가 없어요" text="검색어나 계정 유형을 변경해 보세요." />}
            {data.users
              .filter(
                (u) =>
                  (userRole === 'all' || u.role === userRole) &&
                  `${u.name} ${u.email}`.toLowerCase().includes(userSearch.toLowerCase()),
              )
              .map((u) => (
                <div className="user-row" key={u.id}>
                  <div className="user-avatar">{u.name[0]}</div>
                  <div>
                    <strong>{u.name}</strong>
                    <span>{u.email}</span>
                    <small>
                      {u.role === 'admin'
                        ? '슈퍼관리자'
                        : u.role === 'pd'
                          ? '업로더 (PD)'
                          : '시청자'}{' '}
                      · {u.status === 'active' ? '정상' : '이용 제한'}
                    </small>
                  </div>
                  <button
                    className="secondary compact"
                    disabled={u.id === user.id || u.id === 'demo-admin'}
                    onClick={() => setUserEdit({ ...u })}
                  >
                    관리
                  </button>
                </div>
              ))}
          </>
        )}
        {tab === 'orders' && <StudioOrders orders={data.orders} />}
        {tab === 'support' && admin && <Support user={user} managing notify={notify} />}
        {tab === 'subscriptions' && admin && (
          <StudioSubscriptions subscriptions={data.subscriptions} />
        )}
        {tab === 'audit' && admin && (
          <StudioAudit logs={data.logs} dramas={data.dramas} users={data.users} />
        )}
        {tab === 'operations' && admin && <StudioOperations operations={data.operations} />}
        {tab === 'guide' && <StudioGuide admin={admin} onCreate={() => setEditor('new')} />}
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
          <Modal title="작품 심사" close={() => setReview(null)}>
            <div className="checkout-product">
              <img src={review.image} alt="" />
              <div>
                <h3>{review.title}</h3>
                <p>
                  {review.genre} · {review.episode_count}회차
                </p>
              </div>
            </div>
            <p className="modal-text">{review.synopsis}</p>
            <button
              className="secondary full"
              onClick={() => {
                setReview(null);
                navigate('watch/' + review.id + '/1');
              }}
            >
              1화 영상 검토하기
              <Film size={16} />
            </button>
            <label className="spaced-title">
              검토 의견
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="반려 시 사유를 꼭 입력해 주세요"
              />
            </label>
            <div className="form-actions">
              <button
                className="secondary"
                disabled={busy || !note.trim()}
                onClick={() => reviewed('rejected')}
              >
                <X size={17} />
                반려
              </button>
              <button className="primary" disabled={busy} onClick={() => reviewed('published')}>
                <Check size={17} />
                승인 및 공개
              </button>
            </div>
          </Modal>
        )}
        {userEdit && (
          <Modal title="회원 권한 관리" close={() => setUserEdit(null)}>
            <h3>{userEdit.name}</h3>
            <p className="muted">{userEdit.email}</p>
            <label>
              계정 유형
              <select
                value={userEdit.role}
                onChange={(e) => setUserEdit({ ...userEdit, role: e.target.value as User['role'] })}
              >
                <option value="viewer">시청자</option>
                <option value="pd">업로더 (PD)</option>
                <option value="admin">슈퍼관리자</option>
              </select>
            </label>
            <label>
              이용 상태
              <select
                value={userEdit.status}
                onChange={(e) => setUserEdit({ ...userEdit, status: e.target.value })}
              >
                <option value="active">정상</option>
                <option value="suspended">이용 제한</option>
              </select>
            </label>
            <button
              className="primary full"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api('/admin/users/' + userEdit.id, 'PATCH', {
                    role: userEdit.role,
                    status: userEdit.status,
                  });
                  setUserEdit(null);
                }, '회원 정보를 변경했어요.')
              }
            >
              변경 저장
            </button>
          </Modal>
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
      setF({ ...f, image: r.url });
      notify('포스터를 업로드했어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  return (
    <Modal title={drama === 'new' ? '새로운 이야기 등록' : '작품 정보 수정'} close={close}>
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
        <label>작품 포스터</label>
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
  const [detail, setDetail] = useState<Detail | null>(null),
    [f, setF] = useState({ number: 1, title: '', video: '', duration: 90 }),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false);
  const load = async () => {
    try {
      const r = await api<Detail>('/dramas/' + d.id);
      setDetail(r);
      setF((v) => ({ ...v, number: r.episodes.length + 1, title: '', video: '' }));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [d.id]);
  return (
    <Modal title={d.title + ' · 회차 관리'} close={close}>
      {detail && detail.episodes.length > 0 && (
        <div className="registered-episodes">
          {detail.episodes.map((e) => (
            <div key={e.id}>
              <FileVideo size={16} />
              <span>
                {e.number}화 · {e.title}
              </span>
              <small>{e.duration}초</small>
            </div>
          ))}
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
            <input
              type="number"
              min={1}
              max={500}
              value={f.number}
              onChange={(e) => setF({ ...f, number: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            재생 시간 (초)
            <input
              type="number"
              min={1}
              max={3600}
              value={f.duration}
              onChange={(e) => setF({ ...f, duration: Number(e.target.value) })}
              required
            />
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
          <small>세로형 영상 권장 · 최대 250MB</small>
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
                const r = await api<{ url: string }>('/studio/upload', 'POST', body);
                setF({ ...f, video: r.url });
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
            onClick={() => setF({ ...f, video: '/demo/preview.mp4', duration: 12 })}
          >
            <PlayIcon />
            개발용 샘플 영상 사용
          </button>
        )}
        <button className="primary full" disabled={busy || uploading || !f.video}>
          {busy ? '저장 중…' : `${f.number}화 저장`}
        </button>
        <p className="demo-footnote">
          기존 회차 번호로 저장하면 해당 회차를 수정합니다.
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
