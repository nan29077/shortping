import { useEffect, useState } from 'react';
import { ChevronRight, Save, ShieldCheck, Upload } from 'lucide-react';
import {
  api,
  won,
  type AdminSettlement,
  type Channel,
  type Library,
  type StudioSettlement,
  type User,
} from './api';
import { Modal, navigate } from './App';

const roleName: Record<string, string> = {
  admin: '슈퍼관리자',
  pd: '업로더 (PD)',
  viewer: '시청자',
};

export function Avatar({ user }: { user: Pick<User, 'name' | 'avatar'> }) {
  return (
    <img
      className="profile-image"
      src={user.avatar || '/avatars/block-01.webp'}
      alt={user.name + ' 프로필'}
      onError={(e) => {
        e.currentTarget.onerror = null;
        if (!e.currentTarget.src.endsWith('/avatars/block-01.webp'))
          e.currentTarget.src = '/avatars/block-01.webp';
      }}
    />
  );
}
// 내 계정 첫 화면에 역할별 요약과 바로가기를 보여줍니다.
type Tile = { label: string; value: string; hint?: string };
function AccountOverview({ user }: { user: User }) {
  const [tiles, setTiles] = useState<Tile[] | null>(null);
  const links =
    user.role === 'pd'
      ? [
          { label: '마이 방송국', to: 'studio/channel' },
          { label: '정산 현황', to: 'studio/settlement' },
          { label: '출금 관리', to: 'studio/payouts' },
          { label: '세무 · 정산 정보', to: 'studio/tax' },
        ]
      : user.role === 'admin'
        ? [
            { label: '정산 관리', to: 'studio/settlement' },
            { label: '출금 승인', to: 'studio/payouts' },
            { label: '회원 관리', to: 'studio/members' },
            { label: '요금 · 정책 설정', to: 'studio/policy' },
          ]
        : [
            { label: '마이페이지', to: 'my' },
            { label: '방송국', to: 'channels' },
            { label: '숏핑 패스', to: 'membership' },
            { label: '문의하기', to: 'support' },
          ];
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (user.role === 'viewer') {
          const lib = await api<Library>('/library');
          const days = lib.subscription
            ? Math.max(
                0,
                Math.ceil((new Date(lib.subscription.expires_at).getTime() - Date.now()) / 86400000),
              )
            : 0;
          if (active)
            setTiles([
              { label: '소장 작품', value: lib.purchases.length + '편' },
              { label: '구매 회차', value: lib.episodes.length + '화' },
              { label: '찜한 작품', value: lib.favorites.length + '편' },
              {
                label: '숏핑 패스',
                value: lib.subscription ? days + '일 남음' : '미이용',
                hint: lib.subscription ? '자동 갱신 없음' : '패스로 전 작품 무제한',
              },
            ]);
        } else if (user.role === 'pd') {
          const [settlement, channel] = await Promise.all([
            api<StudioSettlement>('/studio/settlement'),
            api<{ channel: Channel | null; dramas: unknown[] }>('/studio/channel'),
          ]);
          if (active)
            setTiles([
              {
                label: '내 방송국',
                value: channel.channel
                  ? channel.channel.status === 'active'
                    ? '공개 중'
                    : '준비 중'
                  : '미개설',
                hint: channel.channel ? channel.channel.name : '방송국을 열어보세요',
              },
              { label: '등록 작품', value: channel.dramas.length + '편' },
              {
                label: '출금 가능',
                value: won(settlement.balance.available),
                hint: '정산 예정 ' + won(settlement.balance.pending),
              },
              {
                label: '세무 정보',
                value: settlement.profile.verified ? '검증 완료' : '검증 대기',
                hint:
                  settlement.profile.business_type === 'business'
                    ? '사업자 · 세금계산서'
                    : '비사업자 · 원천징수 3.3%',
              },
            ]);
        } else {
          const admin = await api<AdminSettlement>('/admin/settlements');
          if (active)
            setTiles([
              { label: '총 판매액', value: won(admin.totals.gross) },
              { label: '정산 예정', value: won(admin.totals.pending) },
              { label: '출금 가능', value: won(admin.totals.available) },
              {
                label: '출금 승인 대기',
                value: admin.payouts.filter((p) => p.status === 'requested').length + '건',
              },
            ]);
        }
      } catch {
        if (active) setTiles([]);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [user.id, user.role]);
  return (
    <section className="settings-card account-overview">
      <div className="panel-heading">
        <div>
          <h2>내 계정 한눈에</h2>
          <p>
            {user.role === 'viewer'
              ? '구매와 시청 상태를 확인하고 바로 이동할 수 있어요.'
              : '운영에 필요한 화면으로 바로 이동할 수 있어요.'}
          </p>
        </div>
        <span className={'role-chip ' + user.role}>{roleName[user.role]}</span>
      </div>
      {tiles === null ? (
        <div className="loading compact">
          <span className="spinner" />
        </div>
      ) : tiles.length ? (
        <div className="overview-tiles">
          {tiles.map((t) => (
            <div key={t.label}>
              <span>{t.label}</span>
              <strong>{t.value}</strong>
              {t.hint && <small>{t.hint}</small>}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">요약 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
      )}
      <div className="overview-links">
        {links.map((l) => (
          <button key={l.to} className="secondary compact" onClick={() => navigate(l.to)}>
            {l.label}
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
    </section>
  );
}

export default function AccountSettings({
  user,
  onUser,
  notify,
  onHistoryCleared,
}: {
  user: User;
  onUser: (user: User) => void;
  notify: (text: string) => void;
  onHistoryCleared: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: user.name,
    bio: user.bio || '',
    avatar: user.avatar,
    auto_next: user.auto_next !== false,
  });
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false);
  const [sessions, setSessions] = useState<{ current: boolean; expires_at: string }[]>([]);
  const [sessionError, setSessionError] = useState('');
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [confirmation, setConfirmation] = useState<'history' | 'sessions' | null>(null);
  async function loadSessions() {
    try {
      setSessions(await api('/account/sessions'));
      setSessionError('');
    } catch (e) {
      setSessionError((e as Error).message);
    }
  }
  useEffect(() => {
    void loadSessions();
  }, [user.id]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-settings">
      <AccountOverview user={user} />
      <form
        className="settings-card"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const r = await api<{ user: User }>('/account/profile', 'PATCH', form);
            onUser(r.user);
            notify('프로필과 시청 설정을 저장했어요.');
          });
        }}
      >
        <div className="panel-heading">
          <div>
            <h2>프로필 설정</h2>
            <p>기본 아바타는 블록 토이 캐릭터 30종 중 하나가 자동으로 배정됩니다.</p>
          </div>
          <span className="settings-avatar">
            <Avatar user={{ ...user, avatar: form.avatar }} />
          </span>
        </div>
        <label>
          닉네임
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            minLength={2}
            maxLength={30}
            autoComplete="nickname"
          />
        </label>
        <label>
          {user.role === 'pd' ? '스튜디오 소개' : '한 줄 소개'}
          <textarea
            value={form.bio}
            onChange={(e) => setForm({ ...form, bio: e.target.value })}
            maxLength={160}
            placeholder="나를 소개하는 문장을 남겨 주세요."
          />
        </label>
        <div className="assigned-avatar">
          <Avatar user={{ ...user, avatar: form.avatar }} />
          <div>
            <strong>자동 배정된 숏핑 블록 아바타</strong>
            <p>계정 생성 시 무작위로 한 번 배정되며 직접 선택하거나 다시 뽑을 수 없어요.</p>
          </div>
        </div>
        <label className="upload-button">
          <Upload size={16} />
          {uploading ? '이미지 검사 및 업로드 중…' : '내 프로필 이미지 업로드'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={uploading || busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > 10 * 1024 * 1024) {
                notify('10MB 이하의 이미지를 선택해 주세요.');
                return;
              }
              setUploading(true);
              try {
                const body = new FormData();
                body.set('file', file);
                const r = await api<{ url: string }>('/account/avatar', 'POST', body);
                setForm((v) => ({ ...v, avatar: r.url }));
                notify('프로필 저장을 누르면 이미지가 적용됩니다.');
              } catch (err) {
                notify((err as Error).message);
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
        <p className="muted settings-note">
          JPG · PNG · WEBP / 최대 10MB. 저장한 이미지는 다시 로그인해도 유지됩니다.
        </p>
        <label className="settings-toggle">
          <span>
            <strong>다음 회차 자동 이동</strong>
            <small>영상이 끝나면 시청 가능한 다음 회차로 이동합니다.</small>
          </span>
          <input
            type="checkbox"
            checked={form.auto_next}
            onChange={(e) => setForm({ ...form, auto_next: e.target.checked })}
          />
        </label>
        <button className="primary full" disabled={busy || uploading}>
          <Save size={16} />
          {busy ? '저장 중…' : '프로필 · 시청 설정 저장'}
        </button>
      </form>
      <section className="settings-card">
        <h2>
          <ShieldCheck size={19} />
          계정 · 보안
        </h2>
        <dl className="account-facts">
          <div>
            <dt>로그인 이메일</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>계정 권한</dt>
            <dd>
              {user.role === 'admin' ? '슈퍼관리자' : user.role === 'pd' ? '업로더 (PD)' : '시청자'}
            </dd>
          </div>
        </dl>
        {user.id.startsWith('demo-') ? (
          <p className="info-box">
            공용 테스트 계정의 비밀번호는 변경할 수 없습니다. 이메일로 가입한 계정에서는 비밀번호를
            변경할 수 있어요.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (password.newPassword !== password.confirm) {
                notify('새 비밀번호 확인이 일치하지 않습니다.');
                return;
              }
              void action(async () => {
                await api('/account/password', 'POST', {
                  currentPassword: password.currentPassword,
                  newPassword: password.newPassword,
                });
                setPassword({ currentPassword: '', newPassword: '', confirm: '' });
                await loadSessions();
                notify('비밀번호를 변경하고 다른 기기를 로그아웃했어요.');
              });
            }}
          >
            <label>
              현재 비밀번호
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={password.currentPassword}
                onChange={(e) => setPassword({ ...password, currentPassword: e.target.value })}
              />
            </label>
            <label>
              새 비밀번호
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={password.newPassword}
                onChange={(e) => setPassword({ ...password, newPassword: e.target.value })}
              />
            </label>
            <label>
              새 비밀번호 확인
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={password.confirm}
                onChange={(e) => setPassword({ ...password, confirm: e.target.value })}
              />
            </label>
            <button className="secondary full" disabled={busy}>
              비밀번호 변경
            </button>
          </form>
        )}
        <div className="settings-session">
          <h3>로그인 상태</h3>
          {sessionError ? (
            <p role="alert">
              {sessionError}
              <button onClick={() => void loadSessions()}>다시 확인</button>
            </p>
          ) : (
            <p className="muted">
              현재 계정의 유효한 로그인 {sessions.length}개 · 이 기기를 제외한 로그인{' '}
              {sessions.filter((s) => !s.current).length}개
            </p>
          )}
          <button
            className="secondary full"
            disabled={busy || !sessions.some((s) => !s.current)}
            onClick={() => setConfirmation('sessions')}
          >
            다른 기기 모두 로그아웃
          </button>
        </div>
      </section>
      <section className="settings-card">
        <h2>시청 기록 관리</h2>
        <p className="muted">
          시청 기록을 삭제하면 이어보기 위치가 초기화됩니다. 찜과 구매한 작품은 유지됩니다.
        </p>
        <button
          className="secondary full"
          disabled={busy}
          onClick={() => setConfirmation('history')}
        >
          내 시청 기록 삭제
        </button>
      </section>
      {confirmation && (
        <Modal
          title={
            confirmation === 'history' ? '시청 기록을 삭제할까요?' : '다른 기기를 로그아웃할까요?'
          }
          close={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <p className="modal-text">
            {confirmation === 'history'
              ? '이 계정의 모든 시청 기록이 삭제됩니다. 삭제한 기록은 복원할 수 없습니다.'
              : '현재 기기는 로그인 상태를 유지하며, 다른 기기는 다시 로그인해야 합니다.'}
          </p>
          <div className="form-actions">
            <button className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>
              취소
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (confirmation === 'history') {
                    await api('/account/history', 'DELETE');
                    await onHistoryCleared();
                    notify('시청 기록을 삭제했어요.');
                  } else {
                    await api('/account/revoke-sessions', 'POST');
                    await loadSessions();
                    notify('다른 기기를 로그아웃했어요.');
                  }
                  setConfirmation(null);
                })
              }
            >
              확인
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
