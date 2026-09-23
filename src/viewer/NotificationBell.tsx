import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '../api';
import { navigate } from '../App';
import './viewer.css';

export type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  created_at: string;
};

const POLL_MS = 60_000;

// ‘방금 전’, ‘5분 전’, ‘3시간 전’, ‘2일 전’, 그 이상은 날짜로 보여 줍니다.
export function relativeTime(value: string, now = Date.now()) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return '방금 전';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}일 전`;
  const d = new Date(t);
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${d.getMonth() + 1}월 ${d.getDate()}일`
    : d.toLocaleDateString('ko-KR');
}

// 로그인한 사용자의 알림 종. 시청자 헤더와 스튜디오 헤더에서 함께 씁니다.
export default function NotificationBell({
  align = 'header',
  onNavigate = (link: string) => navigate(link),
  className = '',
}: {
  align?: 'header' | 'rail';
  onNavigate?: (link: string) => void;
  className?: string;
}) {
  const [list, setList] = useState<NotificationItem[]>([]),
    [unread, setUnread] = useState(0),
    [open, setOpen] = useState(false),
    [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ list: NotificationItem[]; unread: number }>('/notifications');
      setList(r.list || []);
      setUnread(Number(r.unread) || 0);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoaded(true);
    }
  }, []);
  // 탭이 보일 때만 1분마다 새 알림을 확인하고, 다시 보이면 곧바로 한 번 확인합니다.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load();
        start();
      } else stop();
    };
    void load();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);
  // 바깥을 누르거나 Esc를 누르면 닫습니다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>('.viewer-bell-button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const markRead = async (ids?: string[]) => {
    const stamp = new Date().toISOString();
    // 화면에는 바로 읽음으로 표시하고, 서버 반영은 뒤에서 합니다.
    setList((cur) => cur.map((n) => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at || stamp } : n)));
    setUnread((cur) => (ids ? Math.max(0, cur - list.filter((n) => ids.includes(n.id) && !n.read_at).length) : 0));
    try {
      await api('/notifications/read', 'POST', ids ? { ids } : {});
    } catch {
      void load();
    }
  };
  const openItem = (n: NotificationItem) => {
    if (!n.read_at) void markRead([n.id]);
    setOpen(false);
    const link = n.link.replace(/^#?\/?/, '');
    if (link) onNavigate(link);
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };
  return (
    <div className={`viewer-bell ${align} ${className}`} ref={root}>
      <button
        className="viewer-bell-button"
        aria-label={unread ? `알림 ${unread}개 읽지 않음` : '알림'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <Bell size={20} />
        {unread > 0 && <span className="viewer-bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="viewer-bell-panel" role="dialog" aria-label="알림">
          <div className="viewer-bell-head">
            <strong>알림</strong>
            {unread > 0 && (
              <button onClick={() => void markRead()}>
                <CheckCheck size={15} /> 모두 읽음
              </button>
            )}
          </div>
          {!loaded ? (
            <p className="viewer-bell-empty">
              <span className="spinner" />
            </p>
          ) : failed && !list.length ? (
            <div className="viewer-bell-empty">
              알림을 불러오지 못했어요.
              <button className="text-link" onClick={() => void load()}>
                다시 시도
              </button>
            </div>
          ) : !list.length ? (
            <p className="viewer-bell-empty">새로운 알림이 없어요.</p>
          ) : (
            <ul className="viewer-bell-list">
              {list.map((n) => (
                <li key={n.id}>
                  <button className={n.read_at ? '' : 'unread'} onClick={() => openItem(n)}>
                    <span className="viewer-bell-title">
                      {!n.read_at && <i aria-label="읽지 않음" />}
                      {n.title}
                    </span>
                    {n.body && <span className="viewer-bell-body">{n.body}</span>}
                    <time dateTime={n.created_at}>{relativeTime(n.created_at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
