import { useCallback, useEffect, useState } from 'react';
import {
  Ban,
  Crown,
  Download,
  Heart,
  LogOut,
  Mail,
  NotebookPen,
  Radio,
  Search,
  ShieldCheck,
  Ticket,
  UserRound,
  Wallet,
} from 'lucide-react';
import {
  api,
  count,
  day,
  moment,
  won,
  type Member,
  type MemberDetail,
  type User,
} from './api';
import { Empty, Modal, navigate } from './App';
import { Avatar } from './AccountSettings';
import { downloadCsv } from './StudioPanels';
import { payoutStatus } from './Settlement';

const roleLabel: Record<string, string> = {
  admin: '슈퍼관리자',
  pd: '업로더 (PD)',
  viewer: '시청자',
};
const statusLabel: Record<string, string> = {
  active: '정상',
  suspended: '이용 제한',
  withdrawn: '탈퇴',
};
const tabs = [
  { id: 'all', name: '전체 회원', icon: UserRound },
  { id: 'viewer', name: '시청자', icon: Heart },
  { id: 'pd', name: 'PD · 방송국', icon: Radio },
  { id: 'admin', name: '관리자', icon: ShieldCheck },
  { id: 'suspended', name: '이용 제한 · 탈퇴', icon: Ban },
];

export default function AdminMembers({
  user,
  notify,
}: {
  user: User;
  notify: (s: string) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null),
    [error, setError] = useState(''),
    [tab, setTab] = useState('all'),
    [query, setQuery] = useState(''),
    [sort, setSort] = useState('recent'),
    [detail, setDetail] = useState<MemberDetail | null>(null),
    [editing, setEditing] = useState<Member | null>(null),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<{ members: Member[] }>('/admin/members');
      setMembers(r.members);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const openDetail = async (id: string) => {
    try {
      setDetail(await api<MemberDetail>('/admin/members/' + id));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  async function act(fn: () => Promise<unknown>, message: string, refreshId?: string) {
    setBusy(true);
    try {
      await fn();
      await load();
      if (refreshId) await openDetail(refreshId);
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return <Empty title="회원 정보를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!members)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const matched = members
    .filter((m) =>
      tab === 'all'
        ? true
        : tab === 'suspended'
          ? m.status !== 'active'
          : m.role === tab && m.status === 'active',
    )
    .filter((m) => `${m.name} ${m.email} ${m.channel_name || ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      sort === 'spend'
        ? b.spend - a.spend
        : sort === 'name'
          ? a.name.localeCompare(b.name)
          : new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  const tally = (id: string) =>
    id === 'all'
      ? members.length
      : id === 'suspended'
        ? members.filter((m) => m.status !== 'active').length
        : members.filter((m) => m.role === id && m.status === 'active').length;
  return (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <div>
            <UserRound size={18} />
            <span>전체 회원</span>
          </div>
          <strong>{members.length}명</strong>
          <small>시청자 {tally('viewer')}명 · PD {tally('pd')}명</small>
        </div>
        <div className="stat-card">
          <div>
            <Crown size={18} />
            <span>구독 중</span>
          </div>
          <strong>
            {
              members.filter(
                (m) => m.subscription_expires && new Date(m.subscription_expires) > new Date(),
              ).length
            }
            명
          </strong>
          <small>숏핑 패스 이용</small>
        </div>
        <div className="stat-card">
          <div>
            <Wallet size={18} />
            <span>누적 결제</span>
          </div>
          <strong>{won(members.reduce((n, m) => n + m.spend, 0))}</strong>
          <small>테스트 결제 합계</small>
        </div>
        <div className="stat-card">
          <div>
            <Ban size={18} />
            <span>이용 제한 · 탈퇴</span>
          </div>
          <strong>{tally('suspended')}명</strong>
          <small>로그인 차단 상태</small>
        </div>
      </div>
      <div className="member-tabs">
        {tabs.map(({ id, name, icon: Icon }) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon size={15} />
            {name}
            <i>{tally(id)}</i>
          </button>
        ))}
      </div>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>{tabs.find((t) => t.id === tab)?.name}</h3>
            <p>{matched.length}명</p>
          </div>
          <button
            className="secondary compact"
            disabled={!matched.length}
            onClick={() =>
              downloadCsv('숏핑-회원.csv', [
                ['이름', '이메일', '유형', '상태', '가입일', '최근 로그인', '결제 건수', '결제 금액', '소장', '찜', '작품', '방송국'],
                ...matched.map((m) => [
                  m.name,
                  m.email,
                  roleLabel[m.role],
                  statusLabel[m.status] || m.status,
                  day(m.created_at),
                  m.last_login_at ? moment(m.last_login_at) : '-',
                  m.order_count,
                  m.spend,
                  m.owned,
                  m.favorites,
                  m.drama_count,
                  m.channel_name || '',
                ]),
              ])
            }
          >
            <Download size={16} />
            회원 CSV
          </button>
        </div>
        <div className="management-toolbar">
          <label className="management-search">
            <Search size={17} />
            <input
              aria-label="회원 검색"
              placeholder="이름, 이메일, 방송국 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select aria-label="정렬" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">최근 가입순</option>
            <option value="spend">결제 금액순</option>
            <option value="name">이름순</option>
          </select>
        </div>
        {matched.length ? (
          matched.map((m) => (
            <div className="member-row" key={m.id}>
              <div className="member-avatar">
                <Avatar user={m} />
              </div>
              <div className="member-info">
                <strong>
                  {m.name}
                  <span className={'role-chip ' + m.role}>{roleLabel[m.role]}</span>
                  {m.status !== 'active' && (
                    <span className="role-chip warn">{statusLabel[m.status]}</span>
                  )}
                </strong>
                <span>{m.email}</span>
                <small>
                  가입 {day(m.created_at)}
                  {m.last_login_at ? ` · 최근 로그인 ${day(m.last_login_at)}` : ' · 로그인 기록 없음'}
                  {m.channel_name ? ` · 방송국 ${m.channel_name}` : ''}
                </small>
                <div className="member-metrics">
                  {m.role === 'viewer' ? (
                    <>
                      <span>결제 {m.order_count}건</span>
                      <span>{won(m.spend)}</span>
                      <span>소장 {m.owned}</span>
                      <span>찜 {m.favorites}</span>
                      <span>시청 {m.watched}</span>
                    </>
                  ) : (
                    <>
                      <span>작품 {m.drama_count}편</span>
                      <span>출금 가능 {won(m.settle_available)}</span>
                      <span>지급 완료 {won(m.settle_paid)}</span>
                      {m.channel_name && <span>방송국 {m.channel_status === 'active' ? '공개' : '준비'}</span>}
                      <span>문의 {m.tickets}</span>
                    </>
                  )}
                  {m.subscription_expires && new Date(m.subscription_expires) > new Date() && (
                    <span className="lime">패스 {day(m.subscription_expires)}까지</span>
                  )}
                </div>
              </div>
              <div className="member-actions">
                <button className="secondary compact" onClick={() => void openDetail(m.id)}>
                  상세 정보
                </button>
                <button
                  className="secondary compact"
                  disabled={m.id === user.id || m.id === 'demo-admin'}
                  onClick={() => setEditing({ ...m })}
                >
                  회원 정보 수정
                </button>
                {m.channel_id && (
                  <button
                    className="secondary compact"
                    onClick={() => navigate('channel/' + m.channel_id)}
                  >
                    방송국 보기
                  </button>
                )}
                <button
                  className="secondary compact"
                  disabled={busy || m.id === user.id}
                  onClick={() =>
                    void act(
                      () => api('/admin/members/' + m.id + '/logout', 'POST'),
                      '모든 기기에서 로그아웃 처리했어요.',
                    )
                  }
                >
                  <LogOut size={13} />
                  세션 종료
                </button>
                <a className="secondary compact mail" href={'mailto:' + m.email}>
                  <Mail size={13} />
                  메일
                </a>
              </div>
            </div>
          ))
        ) : (
          <Empty title="해당 회원이 없어요" text="검색어나 탭을 변경해 보세요." />
        )}
      </section>

      {detail && (
        <Modal title="회원 상세" close={() => setDetail(null)} className="wide">
          <div className="member-detail-head">
            <span className="member-avatar">
              <Avatar user={detail.member} />
            </span>
            <div>
              <h3>
                {detail.member.name}
                <span className={'role-chip ' + detail.member.role}>
                  {roleLabel[detail.member.role]}
                </span>
              </h3>
              <p className="muted">{detail.member.email}</p>
              <small className="muted">
                가입 {moment(detail.member.created_at)} · 활성 세션 {detail.sessions}개
                {detail.member.phone ? ` · ${detail.member.phone}` : ''}
              </small>
            </div>
          </div>
          <div className="detail-grid">
            <div>
              <span>결제 금액</span>
              <strong>{won(detail.member.spend)}</strong>
            </div>
            <div>
              <span>소장 작품</span>
              <strong>{detail.member.owned}편</strong>
            </div>
            <div>
              <span>찜 / 시청</span>
              <strong>
                {detail.member.favorites} / {detail.member.watched}
              </strong>
            </div>
            <div>
              <span>구독</span>
              <strong>
                {detail.member.subscription_expires &&
                new Date(detail.member.subscription_expires) > new Date()
                  ? day(detail.member.subscription_expires) + '까지'
                  : '없음'}
              </strong>
            </div>
          </div>
          {detail.channel && (
            <div className="detail-block">
              <h4>
                <Radio size={15} /> 방송국
              </h4>
              <div className="shelf-row">
                <div>
                  <strong>{detail.channel.name}</strong>
                  <small>
                    /{detail.channel.slug} · 작품 {detail.channel.drama_count}편 · 구독{' '}
                    {count(detail.channel.followers)}
                  </small>
                </div>
                <button
                  className="secondary compact"
                  onClick={() => navigate('channel/' + detail.channel!.id)}
                >
                  이동
                </button>
              </div>
            </div>
          )}
          {detail.settlement && detail.member.role !== 'viewer' && (
            <div className="detail-block">
              <h4>
                <Wallet size={15} /> 정산
              </h4>
              <div className="detail-grid">
                <div>
                  <span>정산 예정</span>
                  <strong>{won(detail.settlement.pending)}</strong>
                </div>
                <div>
                  <span>출금 가능</span>
                  <strong>{won(detail.settlement.available)}</strong>
                </div>
                <div>
                  <span>지급 완료</span>
                  <strong>{won(detail.settlement.paid)}</strong>
                </div>
                <div>
                  <span>세무 구분</span>
                  <strong>
                    {detail.tax?.business_type === 'business' ? '사업자' : '비사업자'}
                    {detail.tax?.verified ? ' · 검증' : ''}
                  </strong>
                </div>
              </div>
              {detail.payouts.length > 0 && (
                <ul className="detail-list">
                  {detail.payouts.slice(0, 5).map((p) => (
                    <li key={p.id}>
                      <span>{day(p.requested_at)}</span>
                      <strong>{won(p.payable)}</strong>
                      <small>{payoutStatus[p.status]}</small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {detail.dramas.length > 0 && (
            <div className="detail-block">
              <h4>등록 작품 {detail.dramas.length}편</h4>
              <ul className="detail-list">
                {detail.dramas.slice(0, 8).map((d) => (
                  <li key={d.id}>
                    <span>{d.title}</span>
                    <strong>{d.status === 'published' ? '공개 중' : d.status}</strong>
                    <small>{won(d.price)}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.orders.length > 0 && (
            <div className="detail-block">
              <h4>
                <Ticket size={15} /> 최근 결제
              </h4>
              <ul className="detail-list">
                {detail.orders.slice(0, 8).map((o) => (
                  <li key={o.id}>
                    <span>{o.title || '숏핑 패스'}</span>
                    <strong>{won(o.amount)}</strong>
                    <small>{day(o.created_at)}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.history.length > 0 && (
            <div className="detail-block">
              <h4>최근 시청</h4>
              <ul className="detail-list">
                {detail.history.slice(0, 6).map((h) => (
                  <li key={h.drama_id}>
                    <span>{h.title}</span>
                    <strong>{h.episode}화</strong>
                    <small>{day(h.updated_at)}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.tickets.length > 0 && (
            <div className="detail-block">
              <h4>문의 {detail.tickets.length}건</h4>
              <ul className="detail-list">
                {detail.tickets.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <span>{t.title}</span>
                    <strong>{t.status === 'open' ? '답변 대기' : '답변 완료'}</strong>
                    <small>{day(t.created_at)}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="detail-block">
            <h4>
              <NotebookPen size={15} /> 운영 메모
            </h4>
            {detail.notes.length ? (
              <ul className="detail-list notes">
                {detail.notes.map((n) => (
                  <li key={n.id}>
                    <span>{n.note}</span>
                    <small>
                      {n.actor_name} · {moment(n.created_at)}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">아직 메모가 없어요.</p>
            )}
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!note.trim()) return;
                void act(
                  async () => {
                    await api('/admin/members/' + detail.member.id + '/notes', 'POST', {
                      note: note.trim(),
                    });
                    setNote('');
                  },
                  '운영 메모를 저장했어요.',
                  detail.member.id,
                );
              }}
            >
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="상담 내용, 제재 사유 등을 남겨보세요"
                maxLength={1000}
                aria-label="운영 메모"
              />
              <button className="primary compact" disabled={busy}>
                저장
              </button>
            </form>
          </div>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={detail.member.id === user.id || detail.member.id === 'demo-admin'}
              onClick={() => {
                setEditing({ ...detail.member });
                setDetail(null);
              }}
            >
              회원 정보 수정
            </button>
            <button className="primary" onClick={() => setDetail(null)}>
              닫기
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="회원 정보 관리" close={() => !busy && setEditing(null)}>
          <h3>{editing.name}</h3>
          <p className="muted">{editing.email}</p>
          <label>
            이름
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              minLength={2}
              maxLength={30}
            />
          </label>
          <label>
            연락처
            <input
              value={editing.phone || ''}
              onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
              placeholder="010-0000-0000"
              maxLength={20}
            />
          </label>
          <div className="form-columns">
            <label>
              계정 유형
              <select
                value={editing.role}
                onChange={(e) => setEditing({ ...editing, role: e.target.value as Member['role'] })}
              >
                <option value="viewer">시청자</option>
                <option value="pd">업로더 (PD)</option>
                <option value="admin">슈퍼관리자</option>
              </select>
            </label>
            <label>
              이용 상태
              <select
                value={editing.status}
                onChange={(e) => setEditing({ ...editing, status: e.target.value })}
              >
                <option value="active">정상</option>
                <option value="suspended">이용 제한</option>
                <option value="withdrawn">탈퇴 처리</option>
              </select>
            </label>
          </div>
          <div className="info-box">
            이용 제한 또는 탈퇴로 변경하면 모든 로그인 세션이 즉시 종료됩니다. 구매 내역과 정산
            기록은 보존됩니다. 변경 이력은 운영 기록에 남습니다.
          </div>
          <button
            className="primary full"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api('/admin/members/' + editing.id, 'PATCH', {
                  role: editing.role,
                  status: editing.status,
                  name: editing.name,
                  phone: editing.phone || '',
                });
                setEditing(null);
              }, '회원 정보를 변경했어요.')
            }
          >
            {busy ? '저장 중…' : '변경 저장'}
          </button>
        </Modal>
      )}
    </>
  );
}
