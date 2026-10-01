import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Check, CheckCircle2, Copy, Link2, LogOut, Mail, MessageSquare, RefreshCw, Send, ShieldCheck, Trash2, UserPlus, Users, X } from 'lucide-react';
import {
  api,
  lama,
  teamRoleHint,
  teamRoleName,
  type TeamActivity,
  type StudioComment,
  type StudioEpisode,
  type StudioTeam,
  type TeamInvite,
  type TeamMember,
  type TeamPerm,
  type TeamRole,
} from '../../api';
import { Modal, navigate } from '../../App';
import { API_ORIGIN, asset } from '../../platform';
import type { WS } from './shared';
import { usePanelFocus } from '../hooks';
import NumberInput from '../../NumberInput';

// 협업(팀 제작, 2026-09-25): 공유(초대·링크) · 팀원 역할·결제 · 승인 · 댓글 · 지금 편집 중 · 활동 기록

const ROLES = ['producer', 'writer', 'editor', 'reviewer'] as const;
type MemberRole = (typeof ROLES)[number];
const when = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const inviteUrl = (token: string) => `${API_ORIGIN || location.origin}/#/studio/ai/join/${token}`;
// 작업 → 필요한 권한(서버 team.mjs와 같은 규칙)
const SCRIPT_ACTIONS = new Set(['plan', 'adapt', 'bible', 'season', 'metadata', 'parse_script', 'reverse_script', 'script', 'diagnose', 'rewrite_range', 'variants', 'rewrite_shot', 'bridge_shot']);
export const actionNeed = (action: string): TeamPerm => (SCRIPT_ACTIONS.has(action.replace(/^batch_/, '')) ? 'script' : 'scene');
const NEED_TEXT: Record<TeamPerm, string> = { view: '보기', script: '기획·대본 편집', scene: '장면 편집', approve: '승인', manage: '프로젝트 관리' };
export const teamCan = (team: StudioTeam | undefined, need: TeamPerm | TeamPerm[]) => !team || team.role === 'owner' || (Array.isArray(need) ? need : [need]).some((n) => team.perms.includes(n));
export const needMessage = (team: StudioTeam | undefined, need: TeamPerm) => `${team?.role_name || ''} 역할은 ${NEED_TEXT[need]} 권한이 없어요. 소유자에게 역할 변경을 요청해 주세요.`;
const copy = async (text: string, notify: (s: string) => void, done = '복사했어요.') => {
  try {
    await navigator.clipboard.writeText(text);
    notify(done);
  } catch {
    window.prompt('아래 주소를 복사해 주세요.', text);
  }
};

// ── 머리 영역: 팀 · 지금 편집 중 ──────────────────────────
const TAB_NAME: Record<string, string> = { plan: '기획', script: '대본', scene: '장면', finish: '완성' };
export function TeamChips({ ws, tab, openShare, openComments }: { ws: WS; tab: string; openShare: () => void; openComments: () => void }) {
  const team = ws.data.team;
  const [live, setLive] = useState(team?.presence || []);
  const pid = ws.data.project.id;
  const shared = !!team && team.enabled && team.members.length > 0;
  // 팀이 있을 때만 20초마다 '여기 있어요' 신호(화면이 보일 때만)
  useEffect(() => {
    if (!shared) return;
    let stop = false;
    const ping = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const list = await api<{ user_id: string; name: string; target: string }[]>(`/studio/ai/projects/${pid}/presence`, 'POST', { target: tab });
        if (!stop) setLive(list);
      } catch {
        // 무시(다음 신호에서 다시)
      }
    };
    void ping();
    const t = setInterval(() => void ping(), 20000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [shared, pid, tab]);
  if (!team?.enabled) return null;
  return (
    <>
      {shared && live.length > 0 && (
        <span className="team-live" title={live.map((x) => `${x.name} · ${TAB_NAME[x.target] || '작업 공간'}`).join('\n')}>
          {live.slice(0, 3).map((x) => (
            <i key={x.user_id} aria-label={`${x.name} 지금 ${TAB_NAME[x.target] || ''} 탭`}>
              {x.name.slice(-2)}
            </i>
          ))}
          <small>{live.some((x) => x.target === tab) ? '같은 탭에서 편집 중' : '지금 접속 중'}</small>
        </span>
      )}
      {/* 팀원이 모두 빠져도 남은(해결 안 된) 의견은 열어 볼 수 있어야 해요. */}
      {(shared || !!team.comments_open) && (
        <button className={'ws-head-chip' + (team.comments_open ? ' note' : '')} onClick={openComments} title="의견">
          <MessageSquare size={14} /> 의견{team.comments_open ? ` ${team.comments_open}` : ''}
        </button>
      )}
      <button className="ws-head-chip" onClick={openShare} title={team.role === 'owner' ? '공유 · 팀' : '팀'}>
        <Users size={14} /> {team.role === 'owner' ? (shared ? `팀 ${team.members.length + 1}` : '공유') : team.role_name}
      </button>
    </>
  );
}

// 협업자에게만 보이는 안내 띠
export function RoleBanner({ ws }: { ws: WS }) {
  const t = ws.data.team;
  if (!t || t.role === 'owner') return null;
  return (
    <div className="team-banner" role="note">
      <ShieldCheck size={15} />
      <span>
        <b>
          {t.owner?.name}님의 프로젝트 · {t.role_name}로 참여 중
        </b>
        <small>
          {teamRoleHint[t.role as MemberRole]} · AI 작업 라마는{' '}
          {t.me?.pay_mode === 'sponsor' ? `소유자가 지원해요${t.me.sponsor_limit ? `(한도 ${lama(t.me.sponsor_limit)})` : ''}` : '내 라마로 내요'} · 결과물과 수익은 소유자 몫이에요.
        </small>
      </span>
    </div>
  );
}

// ── 공유 · 팀 창 ─────────────────────────────────────
type TeamData = StudioTeam & { invites: TeamInvite[]; sponsor_used: Record<string, number> };
export function ShareModal({ ws, close }: { ws: WS; close: () => void }) {
  const pid = ws.data.project.id;
  const owner = ws.data.team?.role === 'owner';
  const [tab, setTab] = useState<'team' | 'invite' | 'activity'>(owner && !(ws.data.team?.members.length) ? 'invite' : 'team');
  const [team, setTeam] = useState<TeamData | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setTeam(await api<TeamData>(`/studio/ai/projects/${pid}/team`));
    } catch (e) {
      ws.notify((e as Error).message);
    }
    // ws는 화면을 그릴 때마다 새로 만들어져요. 알림 함수(변하지 않음)만 기준으로 삼아 2초마다 다시 불러오지 않게 해요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, ws.notify]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (msg) ws.notify(msg);
      await load();
      await ws.load();
      return true;
    } catch (e) {
      ws.notify((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  };
  return (
    <Modal title={owner ? '공유 · 팀' : '팀'} close={close}>
      <div className="team-modal">
        <div className="hub-seg small" role="tablist" aria-label="공유 메뉴">
          {(
            [
              ['team', `팀 ${team ? team.members.length + 1 : ''}`],
              ...(owner ? [['invite', '초대하기']] : []),
              ['activity', '활동 기록'],
            ] as [typeof tab, string][]
          ).map(([k, t]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {t}
            </button>
          ))}
        </div>
        {!team ? (
          <div className="loading">
            <span className="spinner" />
          </div>
        ) : tab === 'team' ? (
          <TeamList ws={ws} team={team} busy={busy} act={act} close={close} />
        ) : tab === 'invite' ? (
          <InviteForm ws={ws} team={team} busy={busy} act={act} />
        ) : (
          <ActivityList pid={pid} />
        )}
      </div>
    </Modal>
  );
}

function TeamList({ ws, team, busy, act, close }: { ws: WS; team: TeamData; busy: string; act: (k: string, fn: () => Promise<unknown>, m?: string) => Promise<boolean>; close: () => void }) {
  const pid = ws.data.project.id;
  const owner = team.role === 'owner';
  const me = ws.data.team;
  return (
    <div className="team-list">
      <ul>
        {team.owner && (
          <li className="team-row">
            <span className="team-avatar">{team.owner.name.slice(-2)}</span>
            <span className="team-who">
              <b>{team.owner.name}</b>
              <small>소유자 · 모든 권한 · 결과물과 수익</small>
            </span>
          </li>
        )}
        {team.members.map((m) => (
          <MemberRow key={m.user_id} ws={ws} m={m} owner={owner} used={team.sponsor_used[m.user_id] || 0} busy={busy} act={act} />
        ))}
      </ul>
      {!team.members.length && <p className="muted">아직 함께하는 사람이 없어요.{owner ? ' ‘초대하기’에서 이메일이나 링크로 초대해 보세요.' : ''}</p>}
      {owner ? (
        <fieldset className="team-approval">
          <legend>승인 방식</legend>
          <select
            aria-label="승인 방식"
            value={team.approval.mode}
            disabled={busy === 'approval'}
            onChange={(e) => void act('approval', () => api(`/studio/ai/projects/${pid}/approval`, 'PATCH', { mode: e.target.value }), '승인 방식을 바꿨어요.')}
          >
            <option value="auto">팀원이 있으면 켜기(추천)</option>
            <option value="on">항상 켜기</option>
            <option value="off">끄기</option>
          </select>
          <small className="muted">
            {team.approval.active ? '지금 켜져 있어요. ' : '지금 꺼져 있어요. '}켜져 있으면 회차마다 대본 → 합성본 순서로 승인을 받고, 합성본 승인이 없는 회차는 작품으로 내보낼 수 없어요(소유자는 그대로 내보낼 수 있어요).
          </small>
        </fieldset>
      ) : null}
      {owner ? (
        <button
          type="button"
          className="secondary full"
          disabled={busy === 'dup'}
          onClick={async () => {
            if (!(await ws.ask({ title: '복사본을 만들까요?', text: '기획 · 인물 · 장소 · 소품 · 대본 · 컷 이미지와 음성까지 새 프로젝트로 복사해요(합성 영상 · 팀 · 작업 기록은 빼요). 시즌 2나 다른 버전을 실험할 때 좋아요.', ok: '복사본 만들기' }))) return;
            let id = '';
            if (await act('dup', async () => (id = (await api<{ id: string }>(`/studio/ai/projects/${pid}/duplicate`, 'POST')).id), '복사본을 만들었어요.')) {
              close();
              navigate('studio/ai/' + id);
            }
          }}
        >
          <Copy size={14} /> 이 프로젝트 복사본 만들기
        </button>
      ) : (
        me && (
          <button
            type="button"
            className="secondary full danger-text"
            disabled={busy === 'leave'}
            onClick={async () => {
              if (!(await ws.ask({ title: '팀에서 나갈까요?', text: '나가면 이 프로젝트를 더 볼 수 없어요. 다시 참여하려면 새 초대가 필요해요.', ok: '나가기', danger: true }))) return;
              const uid = me.user_id;
              if (await act('leave', () => api(`/studio/ai/projects/${pid}/members/${uid}`, 'DELETE'), '팀에서 나왔어요.')) {
                close();
                navigate('studio/ai');
              }
            }}
          >
            <LogOut size={14} /> 팀에서 나가기
          </button>
        )
      )}
    </div>
  );
}

function MemberRow({ ws, m, owner, used, busy, act }: { ws: WS; m: TeamMember; owner: boolean; used: number; busy: string; act: (k: string, fn: () => Promise<unknown>, msg?: string) => Promise<boolean> }) {
  const pid = ws.data.project.id;
  const [limit, setLimit] = useState(String(m.sponsor_limit || ''));
  const patch = (body: Record<string, unknown>, msg: string) => void act('m:' + m.user_id, () => api(`/studio/ai/projects/${pid}/members/${m.user_id}`, 'PATCH', body), msg);
  return (
    <li className="team-row">
      <span className="team-avatar">{m.name.slice(-2)}</span>
      <span className="team-who">
        <b>{m.name}</b>
        <small>
          {m.email ? m.email + ' · ' : ''}
          {m.pay_mode === 'sponsor' ? `소유자 지원${m.sponsor_limit ? ` ${lama(used)} / ${lama(m.sponsor_limit)}` : ` · 제한 없음 · ${lama(used)} 사용`}` : '자기 라마로 실행'}
        </small>
      </span>
      {owner ? (
        <span className="team-ctl">
          <select aria-label={`${m.name} 역할`} value={m.role} disabled={busy === 'm:' + m.user_id} onChange={(e) => patch({ role: e.target.value }, '역할을 바꿨어요.')}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {teamRoleName[r]}
              </option>
            ))}
          </select>
          <select aria-label={`${m.name} 라마 결제`} value={m.pay_mode} disabled={busy === 'm:' + m.user_id} onChange={(e) => patch({ pay_mode: e.target.value }, e.target.value === 'sponsor' ? '이제 내 라마로 지원해요.' : '이제 팀원이 자기 라마로 실행해요.')}>
            <option value="self">자기 라마</option>
            <option value="sponsor">내가 지원</option>
          </select>
          {m.pay_mode === 'sponsor' && (
            <NumberInput
              min={0}
              inputMode="numeric"
              aria-label={`${m.name} 지원 한도(라마)`}
              placeholder="한도(비우면 무제한)"
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))}
              onBlur={() => Number(limit || 0) !== m.sponsor_limit && patch({ sponsor_limit: Number(limit || 0) }, '지원 한도를 바꿨어요.')}
            />
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={`${m.name} 내보내기`}
            disabled={busy === 'm:' + m.user_id}
            onClick={async () => {
              if (await ws.ask({ title: `${m.name}님을 팀에서 뺄까요?`, text: '이 프로젝트를 더 볼 수 없게 돼요. 지금까지 만든 결과물은 그대로 남아요.', ok: '빼기', danger: true }))
                void act('m:' + m.user_id, () => api(`/studio/ai/projects/${pid}/members/${m.user_id}`, 'DELETE'), '팀에서 뺐어요.');
            }}
          >
            <Trash2 size={14} />
          </button>
        </span>
      ) : (
        <em className="team-role">{teamRoleName[m.role]}</em>
      )}
    </li>
  );
}

function InviteForm({ ws, team, busy, act }: { ws: WS; team: TeamData; busy: string; act: (k: string, fn: () => Promise<unknown>, m?: string) => Promise<boolean> }) {
  const pid = ws.data.project.id;
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<MemberRole>('writer');
  const [pay, setPay] = useState<'self' | 'sponsor'>('self');
  const [limit, setLimit] = useState('');
  const [seats, setSeats] = useState('3');
  const [results, setResults] = useState<{ email: string; ok: boolean; message: string }[]>([]);
  const list = useMemo(() => [...new Set(emails.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))], [emails]);
  const left = team.max_members - team.members.length;
  const common = { role, pay_mode: pay, sponsor_limit: pay === 'sponsor' ? Number(limit || 0) : 0 };
  const links = team.invites.filter((i) => !i.email);
  const pending = team.invites.filter((i) => i.email && i.uses < i.max_uses && i.active && !i.expired);
  return (
    <div className="team-invite">
      <p className="muted">
        PD 계정만 참여할 수 있어요(시청자 계정은 불가). 남은 자리 {Math.max(0, left)}명 / 최대 {team.max_members}명 · 초대는 7일 동안 유효해요.
      </p>
      <fieldset className="team-roles" aria-label="역할">
        {ROLES.map((r) => (
          <label key={r} className={'team-role-card' + (role === r ? ' active' : '')}>
            <input type="radio" name="invite-role" checked={role === r} onChange={() => setRole(r)} />
            <b>{teamRoleName[r]}</b>
            <small>{teamRoleHint[r]}</small>
          </label>
        ))}
      </fieldset>
      <div className="team-pay">
        <label>
          AI 작업 라마
          <select value={pay} onChange={(e) => setPay(e.target.value as 'self' | 'sponsor')}>
            <option value="self">팀원이 자기 라마로(기본)</option>
            <option value="sponsor">내 라마로 지원</option>
          </select>
        </label>
        {pay === 'sponsor' && (
          <label>
            지원 한도(라마 · 비우면 무제한)
            <NumberInput min={0} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} placeholder="예: 3000" />
          </label>
        )}
      </div>
      <label className="team-emails">
        <span>
          <Mail size={14} /> 이메일로 초대(여러 명은 쉼표나 줄바꿈으로)
        </span>
        <textarea rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="writer@example.com, editor@example.com" />
      </label>
      <button
        type="button"
        className="primary full"
        disabled={!list.length || list.length > 10 || busy === 'invite' || left <= 0}
        onClick={() =>
          void act('invite', async () => {
            const r = await api<{ results: { email: string; ok: boolean; message: string }[] }>(`/studio/ai/projects/${pid}/invites`, 'POST', { ...common, emails: list });
            setResults(r.results);
            if (r.results.every((x) => x.ok)) setEmails('');
          })
        }
      >
        <Send size={15} /> {list.length > 10 ? '한 번에 10명까지' : `${list.length || ''}명 초대 보내기`}
      </button>
      {results.length > 0 && (
        <ul className="team-results">
          {results.map((r) => (
            <li key={r.email} className={r.ok ? 'ok' : 'bad'}>
              {r.ok ? <Check size={13} /> : <X size={13} />} <b>{r.email}</b> <small>{r.message}</small>
            </li>
          ))}
        </ul>
      )}
      <div className="team-link-new">
        <label>
          링크 인원
          <NumberInput min={1} max={50} value={seats} onChange={(e) => setSeats(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy === 'link' || left <= 0}
          onClick={() =>
            void act('link', async () => {
              const r = await api<{ link: TeamInvite }>(`/studio/ai/projects/${pid}/invites`, 'POST', { ...common, link: true, max_uses: Math.max(1, Math.min(50, Number(seats) || 1)) });
              if (r.link.token) await copy(inviteUrl(r.link.token), ws.notify, `${teamRoleName[role]} 초대 링크를 만들고 복사했어요.`);
            })
          }
        >
          <Link2 size={14} /> {teamRoleName[role]} 초대 링크 만들기
        </button>
      </div>
      {links.length > 0 && (
        <ul className="team-links">
          {links.map((i) => (
            <li key={i.id} className={!i.active || i.expired || i.uses >= i.max_uses ? 'off' : ''}>
              <span>
                <b>{teamRoleName[i.role]} 링크</b>
                <small>
                  {i.uses}/{i.max_uses}명 · {i.expired ? '기한 지남' : `${when(i.expires_at)}까지`}
                  {i.pay_mode === 'sponsor' ? ' · 내가 지원' : ''}
                  {!i.active ? ' · 멈춤' : ''}
                </small>
              </span>
              <button type="button" className="icon-button" aria-label="링크 복사" disabled={!i.token} onClick={() => i.token && void copy(inviteUrl(i.token), ws.notify, '초대 링크를 복사했어요.')}>
                <Copy size={14} />
              </button>
              <label className="switch-row" title="링크 켜기·끄기">
                <input type="checkbox" checked={i.active} onChange={(e) => void act('l:' + i.id, () => api(`/studio/ai/projects/${pid}/invites/${i.id}`, 'PATCH', { active: e.target.checked }))} />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label="새 링크로 바꾸기"
                title="새 주소로 바꾸면 예전 링크는 바로 막혀요"
                onClick={() => void act('l:' + i.id, () => api(`/studio/ai/projects/${pid}/invites/${i.id}`, 'PATCH', { reset: true }), '새 링크로 바꿨어요. 예전 링크는 이제 쓸 수 없어요.')}
              >
                <RefreshCw size={14} />
              </button>
              <button type="button" className="icon-button" aria-label="링크 지우기" onClick={() => void act('l:' + i.id, () => api(`/studio/ai/projects/${pid}/invites/${i.id}`, 'DELETE'))}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <div className="team-pending">
          <small className="muted">수락을 기다리는 이메일 초대</small>
          <ul>
            {pending.map((i) => (
              <li key={i.id}>
                <span>
                  {i.email} · {teamRoleName[i.role]}
                </span>
                <button type="button" className="text-link" onClick={() => void act('l:' + i.id, () => api(`/studio/ai/projects/${pid}/invites/${i.id}`, 'DELETE'), '초대를 취소했어요.')}>
                  취소
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActivityList({ pid }: { pid: string }) {
  const [rows, setRows] = useState<TeamActivity[] | null>(null);
  useEffect(() => {
    api<TeamActivity[]>(`/studio/ai/projects/${pid}/activity`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [pid]);
  if (!rows)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  if (!rows.length) return <p className="muted">아직 기록이 없어요. 팀원이 들어오거나 승인·댓글·AI 작업이 생기면 여기에 남아요.</p>;
  return (
    <ul className="team-activity">
      {rows.map((r) => (
        <li key={r.id}>
          <b>{r.user_name || '알 수 없음'}</b> {r.text}
          {r.detail && <em> · {r.detail}</em>}
          <small>{when(r.created_at)}</small>
        </li>
      ))}
    </ul>
  );
}

// ── 의견(댓글 · @멘션) ────────────────────────────────
export type CommentTarget = { type: 'project' | 'episode' | 'shot'; id: string; label: string };
export function CommentsPanel({ ws, target, close }: { ws: WS; target: CommentTarget | null; close: () => void }) {
  const pid = ws.data.project.id;
  const [scope, setScope] = useState<'target' | 'all'>(target && target.type !== 'project' ? 'target' : 'all');
  const [rows, setRows] = useState<StudioComment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hideDone, setHideDone] = useState(true);
  const panelRef = useRef<HTMLElement>(null);
  usePanelFocus(panelRef, close);
  const here: CommentTarget = target || { type: 'project', id: pid, label: '작품 전체' };
  const load = useCallback(async () => {
    const q = scope === 'target' && here.type !== 'project' ? `?target_type=${here.type}&target_id=${here.id}` : '';
    try {
      setRows(await api<StudioComment[]>(`/studio/ai/projects/${pid}/comments${q}`));
    } catch (e) {
      ws.notify((e as Error).message);
      setRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, scope, here.type, here.id, ws.notify]);
  useEffect(() => {
    void load();
  }, [load]);
  const t = ws.data.team;
  // @ 부를 수 있는 사람(나는 빼고)
  const people = [...(t?.owner ? [{ id: t.owner.id, name: t.owner.name }] : []), ...(t?.members.map((m) => ({ id: m.user_id, name: m.name })) || [])]
    .filter((x) => x.id !== t?.user_id)
    .map((x) => x.name);
  const label = (c: StudioComment) => {
    if (c.target_type === 'project') return '작품 전체';
    if (c.target_type === 'episode') return (ws.data.episodes.find((e) => e.id === c.target_id)?.number ?? '?') + '화';
    for (const e of ws.data.episodes) {
      const i = e.shots.findIndex((s) => s.id === c.target_id);
      if (i >= 0) return `${e.number}화 ${i + 1}번 컷`;
    }
    return '지운 컷';
  };
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ mentioned: number }>(`/studio/ai/projects/${pid}/comments`, 'POST', { target_type: here.type, target_id: here.id, body: text.trim() });
      setText('');
      ws.notify(r.mentioned ? `의견을 남기고 ${r.mentioned}명에게 알렸어요.` : '의견을 남겼어요.');
      await load();
      void ws.load();
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const shown = (rows || []).filter((c) => !hideDone || !c.resolved);
  return (
    <aside className="team-comments" aria-label="의견" ref={panelRef} tabIndex={-1}>
      <header>
        <b>
          <MessageSquare size={15} /> 의견
        </b>
        <button type="button" className="icon-button" aria-label="의견 닫기" onClick={close}>
          <X size={16} />
        </button>
      </header>
      <div className="hub-seg small" role="tablist" aria-label="의견 범위">
        {here.type !== 'project' && (
          <button type="button" role="tab" aria-selected={scope === 'target'} className={scope === 'target' ? 'active' : ''} onClick={() => setScope('target')}>
            {here.label}
          </button>
        )}
        <button type="button" role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
          전체
        </button>
      </div>
      <label className="check-row small">
        <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> <span>해결한 의견 숨기기</span>
      </label>
      <ul className="team-comment-list">
        {!rows && <li className="muted">불러오는 중…</li>}
        {rows && !shown.length && <li className="muted">아직 의견이 없어요.</li>}
        {shown.map((c) => (
          <li key={c.id} className={c.resolved ? 'done' : ''}>
            <div>
              <b>{c.user_name}</b> <small>{label(c)} · {when(c.created_at)}</small>
            </div>
            <p>{c.body}</p>
            <div className="team-comment-tools">
              <button
                type="button"
                className="text-link"
                onClick={async () => {
                  try {
                    await api(`/studio/ai/projects/${pid}/comments/${c.id}`, 'PATCH', { resolved: !c.resolved });
                    await load();
                    void ws.load();
                  } catch (e) {
                    ws.notify((e as Error).message);
                  }
                }}
              >
                <CheckCircle2 size={12} /> {c.resolved ? '다시 열기' : '해결'}
              </button>
              {(c.mine || t?.role === 'owner') && (
                <button
                  type="button"
                  className="text-link"
                  onClick={async () => {
                    try {
                      await api(`/studio/ai/projects/${pid}/comments/${c.id}`, 'DELETE');
                      await load();
                      void ws.load();
                    } catch (e) {
                      ws.notify((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={12} /> 지우기
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="team-comment-form">
        <small className="muted">{here.label}에 의견 남기기</small>
        {people.length > 0 && (
          <div className="team-mention">
            <AtSign size={12} />
            {people.map((n) => (
              <button key={n} type="button" className="chip" onClick={() => setText((v) => (v.includes('@' + n) ? v : `@${n} ${v}`))}>
                {n}
              </button>
            ))}
          </div>
        )}
        <textarea rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="예: @작가 3번 컷 대사를 조금 더 짧게 해 주세요" />
        <button type="button" className="primary full" disabled={busy || !text.trim()} onClick={() => void send()}>
          <Send size={14} /> 남기기
        </button>
      </div>
    </aside>
  );
}

// ── 승인(대본 → 회차 합성본) ─────────────────────────────
const REVIEW_TEXT: Record<string, string> = { '': '승인 전', requested: '승인 요청됨', approved: '승인됨', changes: '수정 요청' };
export function ReviewBar({ ws, episode, stage }: { ws: WS; episode: StudioEpisode; stage: 'script' | 'final' }) {
  const t = ws.data.team;
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  if (!t?.approval.active) return null;
  const pid = ws.data.project.id;
  const value = (stage === 'script' ? episode.script_review : episode.final_review) || '';
  const canRequest = teamCan(t, stage === 'script' ? 'script' : 'scene');
  const canApprove = teamCan(t, 'approve');
  const ready = stage === 'script' ? episode.shots.length > 0 : !!episode.video && episode.status === 'composed';
  const send = (action: 'request' | 'approve' | 'changes' | 'reset', msg: string) =>
    void ws.act(async () => {
      await api(`/studio/ai/projects/${pid}/episodes/${episode.id}/review`, 'POST', { stage, action, note });
      setNote('');
      setOpen(false);
    }, msg);
  return (
    <div className={'team-review ' + (value || 'none')} role="group" aria-label={`${episode.number}화 ${stage === 'script' ? '대본' : '합성본'} 승인`}>
      <span className="team-review-state">
        <ShieldCheck size={14} /> {stage === 'script' ? '대본' : '합성본'} 승인 · <b>{REVIEW_TEXT[value] || value}</b>
        {(value === 'changes' || value === 'requested') && episode.review_note && <em> “{episode.review_note}”</em>}
      </span>
      {!ready ? (
        <small className="muted">{stage === 'script' ? '대본(컷)을 만든 뒤 승인을 받을 수 있어요.' : '합성이 끝나면 승인을 받을 수 있어요.'}</small>
      ) : (
        <span className="team-review-tools">
          {canRequest && value !== 'requested' && value !== 'approved' && (
            <button type="button" className="secondary compact" disabled={ws.busy} onClick={() => send('request', '승인을 요청했어요. 승인할 수 있는 팀원에게 알렸어요.')}>
              승인 요청
            </button>
          )}
          {canApprove && value !== 'approved' && (
            <>
              <button type="button" className="primary compact" disabled={ws.busy} onClick={() => send('approve', '승인했어요.')}>
                <Check size={13} /> 승인
              </button>
              <button type="button" className="secondary compact" disabled={ws.busy} onClick={() => setOpen(!open)}>
                수정 요청
              </button>
            </>
          )}
          {t.members.length > 0 && (
        <button type="button" className="text-link" onClick={() => ws.comment({ type: 'episode', id: episode.id, label: `${episode.number}화` })}>
          <MessageSquare size={12} /> 의견
        </button>
      )}
      {t.role === 'owner' && value && (
            <button type="button" className="text-link" disabled={ws.busy} onClick={() => send('reset', '승인 상태를 처음으로 돌렸어요.')}>
              초기화
            </button>
          )}
        </span>
      )}
      {open && (
        <div className="team-review-note">
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="무엇을 고치면 좋을지 한 줄로" aria-label="수정 요청 내용" />
          <button type="button" className="secondary compact" disabled={!note.trim() || ws.busy} onClick={() => send('changes', '수정을 요청했어요.')}>
            보내기
          </button>
        </div>
      )}
    </div>
  );
}

// ── 초대 링크로 들어왔을 때 ───────────────────────────────
type InvitePreview = {
  project: { id: string; title: string; genre: string; poster: string; logline: string; owner_name: string };
  role: TeamRole;
  role_name: string;
  perms: TeamPerm[];
  pay_mode: 'self' | 'sponsor';
  sponsor_limit: number;
  expires_at: string;
  member: boolean;
  problem: string;
};
export function JoinInvite({ token, notify, done }: { token: string; notify: (s: string) => void; done: (projectId: string | null) => void }) {
  const [data, setData] = useState<InvitePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 비공개 포스터는 팀에 들어오기 전에는 받을 수 없을 수 있어요. 그때는 빈 포스터 자리로 보여요.
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => {
    api<InvitePreview>('/studio/ai/invites/' + encodeURIComponent(token))
      .then(setData)
      .catch((e: Error) => setError(/접근 권한/.test(e.message) ? 'PD 계정으로 로그인해야 제작에 참여할 수 있어요. 시청자 계정은 참여할 수 없어요.' : e.message));
  }, [token]);
  if (error)
    return (
      <section className="management-panel team-join">
        <h3>초대를 열 수 없어요</h3>
        <p className="muted">{error}</p>
        <button className="secondary" onClick={() => done(null)}>
          스튜디오로 가기
        </button>
      </section>
    );
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const p = data.project;
  return (
    <section className="management-panel team-join">
      <span className="eyebrow">숏핑 스튜디오 · 함께 만들기</span>
      <div className="team-join-card">
        {p.poster && !posterFailed ? <img src={asset(p.poster)} alt="" onError={() => setPosterFailed(true)} /> : <span className="team-join-poster" aria-hidden="true" />}
        <div>
          <h3>{p.title}</h3>
          <p>
            {p.owner_name}님의 프로젝트 · {p.genre}
          </p>
          {p.logline && <small className="muted">{p.logline}</small>}
        </div>
      </div>
      <ul className="team-join-facts">
        <li>
          <b>역할</b> {data.role_name} — {teamRoleHint[data.role as MemberRole] || ''}
        </li>
        <li>
          <b>AI 작업 라마</b> {data.pay_mode === 'sponsor' ? `소유자가 지원해요${data.sponsor_limit ? `(한도 ${lama(data.sponsor_limit)}, 넘으면 내 라마)` : ''}` : '내 라마로 실행해요'}
        </li>
        <li>
          <b>결과물 · 수익</b> 프로젝트 소유자 몫이에요.
        </li>
      </ul>
      {data.member ? (
        <button className="primary full" onClick={() => done(p.id)}>
          이미 참여 중이에요 · 프로젝트 열기
        </button>
      ) : data.problem ? (
        <>
          <p className="danger">{data.problem}</p>
          <button className="secondary" onClick={() => done(null)}>
            스튜디오로 가기
          </button>
        </>
      ) : (
        <button
          className="primary full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ project_id: string }>(`/studio/ai/invites/${encodeURIComponent(token)}/accept`, 'POST');
              notify(`「${p.title}」 팀에 들어왔어요.`);
              done(r.project_id);
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <UserPlus size={16} /> 초대 수락하고 함께 만들기
        </button>
      )}
    </section>
  );
}
