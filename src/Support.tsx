import { useEffect, useState } from 'react';
import { MessageCircle, Send, Search } from 'lucide-react';
import { api, type User } from './api';
import { Empty, navigate } from './App';

type Ticket = {
  id: string;
  name: string;
  category: string;
  title: string;
  body: string;
  reply: string;
  status: string;
  created_at: string;
  replied_at: string | null;
};
export default function Support({
  user,
  managing = false,
  notify,
}: {
  user: User | null;
  managing?: boolean;
  notify: (s: string) => void;
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('이용 문의'),
    [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState('all');
  const [replies, setReplies] = useState<Record<string, string>>({});
  async function reload() {
    try {
      setTickets(await api<Ticket[]>('/support'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (user) void reload();
    else setLoading(false);
  }, [user?.id]);
  if (!user)
    return (
      <div className="page-content">
        <span className="eyebrow lime">SHORTPING HELP</span>
        <h1>문의하기</h1>
        <Empty
          title="무엇을 도와드릴까요?"
          text="로그인 후 문의를 남기면 답변을 이곳에서 확인할 수 있어요."
          label="로그인하고 문의하기"
          action={() => navigate('login')}
        />
      </div>
    );
  const filtered = tickets.filter(
    (t) =>
      (status === 'all' || t.status === status) &&
      `${t.title} ${t.name} ${t.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className={managing ? 'support-workspace' : 'page-content support-page'}>
      {!managing && (
        <>
          <span className="eyebrow lime">WE'RE HERE FOR YOU</span>
          <h1>문의하기</h1>
          <p className="support-intro">
            궁금한 점을 남겨 주세요.
            <br />
            문의 내역에서 관리자 답변을 확인할 수 있어요.
          </p>
        </>
      )}
      {!managing && (
        <form
          className="support-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            try {
              await api('/support', 'POST', { category, title, body });
              setTitle('');
              setBody('');
              await reload();
              notify('문의를 접수했어요. 답변은 아래 내역에서 확인해 주세요.');
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            문의 유형
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {['이용 문의', '결제 · 구독', '콘텐츠 신고', 'PD · 제휴'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            제목
            <input
              required
              minLength={2}
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="문의 제목을 입력해 주세요"
            />
          </label>
          <label>
            문의 내용
            <textarea
              required
              minLength={10}
              maxLength={5000}
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="10자 이상 입력해 주세요. 비밀번호나 카드번호는 포함하지 마세요."
            />
          </label>
          <small className="muted">{body.length.toLocaleString()} / 5,000</small>
          <button className="primary full" disabled={busy}>
            <Send size={16} />
            {busy ? '접수 중…' : '문의 접수하기'}
          </button>
        </form>
      )}
      <div className="section-heading">
        <h2>{managing ? '전체 고객 문의' : '문의 내역'}</h2>
        <button onClick={() => void reload()}>새로고침</button>
      </div>
      {managing && (
        <div className="management-toolbar">
          <label className="management-search">
            <Search size={17} />
            <input
              aria-label="문의 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="제목, 내용 또는 작성자 검색"
            />
          </label>
          <select aria-label="문의 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">전체 {tickets.length}건</option>
            <option value="open">
              답변 대기 {tickets.filter((t) => t.status === 'open').length}건
            </option>
            <option value="answered">답변 완료</option>
          </select>
        </div>
      )}
      {error ? (
        <Empty
          title="문의를 불러오지 못했어요"
          text={error}
          action={() => void reload()}
          label="다시 시도"
        />
      ) : loading ? (
        <p className="muted">문의를 불러오는 중이에요.</p>
      ) : !filtered.length ? (
        <Empty
          title="표시할 문의가 없어요"
          text={
            managing
              ? '문의가 접수되면 여기서 확인하고 답변할 수 있습니다.'
              : '문의가 접수되면 진행 상태를 확인할 수 있어요.'
          }
        />
      ) : (
        filtered.map((t) => (
          <details className="support-ticket" key={t.id}>
            <summary>
              <MessageCircle size={18} />
              <div>
                <strong>{t.title}</strong>
                <small>
                  {t.category} · {new Date(t.created_at).toLocaleDateString('ko-KR')}
                  {managing ? ' · ' + t.name : ''}
                </small>
              </div>
              <span className={'status-chip ' + (t.status === 'open' ? 'neutral' : '')}>
                {t.status === 'open' ? '답변 대기' : '답변 완료'}
              </span>
            </summary>
            <div className="ticket-content">
              <p>{t.body}</p>
              {t.reply && (
                <div className="ticket-reply">
                  <strong>숏핑 운영팀 답변</strong>
                  <p>{t.reply}</p>
                  <small>{t.replied_at && new Date(t.replied_at).toLocaleString('ko-KR')}</small>
                </div>
              )}
              {managing && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy) return;
                    setBusy(true);
                    try {
                      await api('/admin/support/' + t.id, 'PATCH', {
                        reply: replies[t.id] ?? t.reply,
                      });
                      await reload();
                      notify('답변을 저장했어요. 작성자의 문의 내역에 표시됩니다.');
                    } catch (e) {
                      notify((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <label>
                    관리자 답변
                    <textarea
                      required
                      minLength={2}
                      maxLength={5000}
                      rows={4}
                      value={replies[t.id] ?? t.reply}
                      onChange={(e) => setReplies({ ...replies, [t.id]: e.target.value })}
                      placeholder="문의자에게 전달할 답변을 입력하세요"
                    />
                  </label>
                  <button className="primary compact" disabled={busy}>
                    <Send size={15} />
                    {t.reply ? '답변 수정' : '답변 등록'}
                  </button>
                </form>
              )}
            </div>
          </details>
        ))
      )}
    </div>
  );
}
