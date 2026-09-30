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

// 알림 목록은 화면에 종이 여러 개(모바일 머리글·PC 오른쪽 메뉴·스튜디오) 있어도 한 곳에서만 받아 옵니다.
// 첫 종이 붙을 때 1분 주기 확인을 시작하고, 마지막 종이 사라지면 멈춥니다(요청이 두 배로 늘지 않게).
type BellState = { list: NotificationItem[]; unread: number; loaded: boolean; failed: boolean };
const store = {
  state: { list: [], unread: 0, loaded: false, failed: false } as BellState,
  listeners: new Set<(s: BellState) => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  inflight: null as Promise<void> | null,
  set(patch: Partial<BellState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  },
};
function loadNotifications() {
  if (store.inflight) return store.inflight;
  store.inflight = (async () => {
    try {
      const r = await api<{ list: NotificationItem[]; unread: number }>('/notifications');
      store.set({ list: r.list || [], unread: Number(r.unread) || 0, failed: false, loaded: true });
    } catch {
      store.set({ failed: true, loaded: true });
    } finally {
      store.inflight = null;
    }
  })();
  return store.inflight;
}
const startPolling = () => {
  if (store.timer) clearInterval(store.timer);
  store.timer = setInterval(() => void loadNotifications(), POLL_MS);
};
const stopPolling = () => {
  if (store.timer) clearInterval(store.timer);
  store.timer = undefined;
};
const onVisibility = () => {
  if (document.visibilityState === 'visible') {
    void loadNotifications();
    startPolling();
  } else stopPolling();
};
function subscribe(fn: (s: BellState) => void) {
  store.listeners.add(fn);
  if (store.listeners.size === 1) {
    // 다른 계정으로 바뀌었을 수 있으니 새로 시작할 때는 비우고 다시 받습니다.
    store.set({ list: [], unread: 0, loaded: false, failed: false });
    void loadNotifications();
    if (document.visibilityState === 'visible') startPolling();
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    store.listeners.delete(fn);
    if (!store.listeners.size) {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

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
  const [state, setState] = useState<BellState>(store.state),
    [open, setOpen] = useState(false);
  const { list, unread, loaded, failed } = state;
  const root = useRef<HTMLDivElement>(null);
  const load = useCallback(() => loadNotifications(), []);
  useEffect(() => subscribe(setState), []);
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
    // 화면에는 바로 읽음으로 표시하고(모든 종에 함께), 서버 반영은 뒤에서 합니다.
    const cur = store.state;
    store.set({
      list: cur.list.map((n) => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at || stamp } : n)),
      unread: ids ? Math.max(0, cur.unread - cur.list.filter((n) => ids.includes(n.id) && !n.read_at).length) : 0,
    });
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
