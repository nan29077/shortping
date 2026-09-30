import { z } from 'zod';
import { randomUUID, randomBytes } from 'node:crypto';
import { ROLES, ROLE_NAME, permsOf, can } from './team.mjs';
import { notify } from '../notify.mjs';

// 협업 1단계(2026-09-25): 초대(이메일·링크) · 역할 · 결제(실행자 부담 + 소유자 지원) · 승인(대본 → 합성본)
// · 댓글(@멘션) · 지금 편집 중 · 활동 기록. 결과물과 수익은 프로젝트 소유자 몫이에요.
const INVITE_DAYS = 7;
const PRESENCE_MS = 40000;
const ACTION_TEXT = {
  invite: '초대를 보냈어요',
  link: '초대 링크를 만들었어요',
  join: '팀에 들어왔어요',
  role: '역할을 바꿨어요',
  remove: '팀에서 내보냈어요',
  leave: '팀에서 나갔어요',
  review_request: '승인을 요청했어요',
  review_approve: '승인했어요',
  review_changes: '수정을 요청했어요',
  review_reset: '승인을 초기화했어요',
  comment: '댓글을 남겼어요',
  ai_run: 'AI 작업을 시작했어요',
  compose: '회차 합성을 시작했어요',
  export: '작품으로 내보냈어요',
  approval_mode: '승인 방식을 바꿨어요',
};
const STAGE_TEXT = { script: '대본', final: '회차 합성본' };

export function collabRoutes({ app, db, fail, now, roles, project, memberOf, settings }) {
  const presence = new Map(); // projectId → Map(userId → {name, target, at})
  const enabled = async () => !!Number((await settings()).studio_collab_enabled);
  const maxMembers = async () => Math.max(1, Math.min(50, Number((await settings()).studio_collab_max_members || 10)));
  const memberCount = async (pid) => Number((await db.get('SELECT COUNT(*) AS n FROM studio_members WHERE project_id=?', [pid]))?.n || 0);
  const log = async (projectId, userId, action, detail = '') => {
    try {
      await db.run('INSERT INTO studio_activity (id,project_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)', [randomUUID(), projectId, userId || null, action, String(detail).slice(0, 300), now()]);
    } catch (e) {
      console.error('activity', e.message);
    }
  };
  // 승인이 켜져 있나: on이면 항상, auto면 협업자가 1명 이상일 때
  const approvalsActive = async (p) => p.approval_mode === 'on' || (p.approval_mode !== 'off' && (await enabled()) && (await memberCount(p.id)) > 0);
  const link = (pid, tab = '') => `studio/ai/${pid}${tab ? '/' + tab : ''}`;
  const teamIds = async (p) => [p.owner_id, ...(await db.all('SELECT user_id FROM studio_members WHERE project_id=?', [p.id])).map((r) => r.user_id)];
  const notifyTeam = async (p, exceptId, msg, filter = () => true) => {
    const members = await db.all('SELECT user_id,role FROM studio_members WHERE project_id=?', [p.id]);
    const list = [{ user_id: p.owner_id, role: 'owner' }, ...members].filter((m) => m.user_id !== exceptId && filter(m));
    for (const m of list) await notify(db, m.user_id, msg);
  };
  const tokenOf = () => randomBytes(18).toString('base64url');
  const inviteView = (i) => ({
    id: i.id, email: i.email || '', role: i.role, pay_mode: i.pay_mode, sponsor_limit: Number(i.sponsor_limit), max_uses: Number(i.max_uses), uses: Number(i.uses),
    active: !!Number(i.active), expires_at: i.expires_at, created_at: i.created_at, token: i.email ? undefined : i.token, expired: new Date(i.expires_at).getTime() < Date.now(),
  });

  // 작업 공간 상세에 붙는 팀 정보
  async function summary(req, p) {
    const on = await enabled();
    const role = req.teamRole || 'owner';
    const members = on
      ? await db.all('SELECT m.user_id,m.role,m.pay_mode,m.sponsor_limit,m.created_at,u.name,u.email FROM studio_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.created_at', [p.id])
      : [];
    const owner = await db.get('SELECT id,name,email FROM users WHERE id=?', [p.owner_id]);
    const live = [...(presence.get(p.id)?.entries() || [])].filter(([uid, v]) => uid !== req.user.id && Date.now() - v.at < PRESENCE_MS).map(([uid, v]) => ({ user_id: uid, name: v.name, target: v.target }));
    const unresolved = Number((await db.get('SELECT COUNT(*) AS n FROM studio_comments WHERE project_id=? AND resolved=0', [p.id]))?.n || 0);
    return {
      enabled: on,
      user_id: req.user.id,
      role,
      role_name: ROLE_NAME[role],
      perms: permsOf(role),
      owner: owner ? { id: owner.id, name: owner.name, email: role === 'owner' ? owner.email : undefined } : null,
      members: members.map((m) => ({ user_id: m.user_id, name: m.name, email: role === 'owner' ? m.email : undefined, role: m.role, pay_mode: m.pay_mode, sponsor_limit: Number(m.sponsor_limit), created_at: m.created_at })),
      me: req.teamMember ? { pay_mode: req.teamMember.pay_mode, sponsor_limit: Number(req.teamMember.sponsor_limit) } : null,
      approval: { mode: p.approval_mode || 'auto', active: await approvalsActive(p) },
      presence: live,
      comments_open: unresolved,
      max_members: await maxMembers(),
    };
  }
  // 협업 미디어는 소유자 단위가 아니라 파일이 실제로 연결된 프로젝트 단위로 확인합니다.
  // project_id가 생기기 전 파일도 기존 프로젝트 필드·자산 이력을 확인해 안전하게 호환합니다.
  async function sharesWith(user, ownerId, url) {
    if (!user || !url || !['pd', 'admin'].includes(user.role) || !(await enabled())) return false;
    return !!(await db.get(
      `SELECT 1 AS ok
         FROM studio_members m JOIN studio_projects p ON p.id=m.project_id
        WHERE m.user_id=? AND p.owner_id=? AND (
          EXISTS (SELECT 1 FROM media_files f WHERE f.url=? AND f.project_id=p.id) OR
          EXISTS (SELECT 1 FROM studio_assets a WHERE a.url=? AND a.project_id=p.id) OR
          p.poster=? OR p.bgm=? OR p.trailer=? OR
          EXISTS (SELECT 1 FROM studio_characters c WHERE c.project_id=p.id AND (c.image=? OR c.voice_sample=?)) OR
          EXISTS (SELECT 1 FROM studio_locations l WHERE l.project_id=p.id AND l.image=?) OR
          EXISTS (SELECT 1 FROM studio_props pr WHERE pr.project_id=p.id AND pr.image=?) OR
          EXISTS (SELECT 1 FROM studio_episodes e WHERE e.project_id=p.id AND (e.video=? OR e.intro_card=? OR e.outro_card=? OR e.thumbnail=? OR e.bgm=?)) OR
          EXISTS (SELECT 1 FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=p.id AND (s.image=? OR s.audio=? OR s.video=? OR s.lipsync=? OR s.sfx=? OR s.end_image=?))
        ) LIMIT 1`,
      [user.id, ownerId, ...Array(20).fill(url)],
    ));
  }
  async function myInvites(user) {
    if (!user?.email || !(await enabled())) return [];
    const rows = await db.all(
      "SELECT i.id,i.token,i.role,i.expires_at,p.id AS project_id,p.title,u.name AS owner_name FROM studio_invites i JOIN studio_projects p ON p.id=i.project_id JOIN users u ON u.id=p.owner_id WHERE LOWER(i.email)=? AND i.active=1 AND i.uses<i.max_uses AND i.expires_at>? ORDER BY i.created_at DESC LIMIT 20",
      [String(user.email).toLowerCase(), now()],
    );
    const out = [];
    for (const r of rows) if (!(await db.get('SELECT 1 AS ok FROM studio_members WHERE project_id=? AND user_id=?', [r.project_id, user.id]))) out.push({ ...r, role_name: ROLE_NAME[r.role] });
    return out;
  }
  const requireOn = async () => {
    if (!(await enabled())) fail(403, '지금은 협업 기능을 쓸 수 없어요. 관리자에게 문의해 주세요.');
  };

  // ── 팀 보기 ─────────────────────────────────────────
  app.get('/api/studio/ai/projects/:id/team', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const base = await summary(req, p);
    const invites = req.teamRole === 'owner' ? (await db.all('SELECT * FROM studio_invites WHERE project_id=? ORDER BY created_at DESC LIMIT 50', [p.id])).map(inviteView) : [];
    const usage = {};
    for (const r of await db.all(
      "SELECT actor_id, COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_lama WHEN status IN ('queued','running') THEN estimate_lama ELSE 0 END),0) AS n FROM ai_jobs WHERE project_id=? AND user_id=? AND actor_id<>user_id AND billed=1 GROUP BY actor_id",
      [p.id, p.owner_id],
    ))
      usage[r.actor_id] = Number(r.n);
    res.json({ ...base, invites, sponsor_used: req.teamRole === 'owner' ? usage : req.teamMember ? { [req.user.id]: usage[req.user.id] || 0 } : {} });
  });

  // ── 초대: 이메일(여러 명) · 링크 ─────────────────────────
  const inviteBody = z.object({
    emails: z.array(z.string().trim().toLowerCase().email().max(120)).max(10).default([]),
    link: z.boolean().default(false),
    role: z.enum(ROLES),
    pay_mode: z.enum(['self', 'sponsor']).default('self'),
    sponsor_limit: z.number().int().min(0).max(1000000).default(0),
    max_uses: z.number().int().min(1).max(50).default(5),
  });
  app.post('/api/studio/ai/projects/:id/invites', roles('pd', 'admin'), async (req, res) => {
    await requireOn();
    const p = await project(req, req.params.id, 'manage');
    const b = inviteBody.parse(req.body);
    if (!b.emails.length && !b.link) fail(400, '초대할 이메일을 넣거나 초대 링크를 만들어 주세요.');
    const seats = (await maxMembers()) - (await memberCount(p.id));
    if (seats <= 0) fail(409, `팀은 최대 ${await maxMembers()}명까지예요. 멤버를 먼저 정리해 주세요.`);
    const expires = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString();
    const owner = await db.get('SELECT name,email FROM users WHERE id=?', [p.owner_id]);
    const results = [];
    for (const email of [...new Set(b.emails)]) {
      const u = await db.get('SELECT id,role,name,status FROM users WHERE LOWER(email)=?', [email]);
      if (email === String(owner?.email || '').toLowerCase()) {
        results.push({ email, ok: false, message: '프로젝트 소유자 본인이에요.' });
        continue;
      }
      if (u && u.role === 'viewer') {
        results.push({ email, ok: false, message: '시청자 계정은 제작에 참여할 수 없어요. PD 계정으로 가입한 이메일을 넣어 주세요.' });
        continue;
      }
      if (u && (await db.get('SELECT 1 AS ok FROM studio_members WHERE project_id=? AND user_id=?', [p.id, u.id]))) {
        results.push({ email, ok: false, message: '이미 팀원이에요.' });
        continue;
      }
      // 같은 이메일로 보낸 초대가 살아 있으면 역할·결제만 새로 고치고 기한을 늘립니다.
      const same = await db.get('SELECT id FROM studio_invites WHERE project_id=? AND LOWER(email)=? AND active=1 AND uses<max_uses', [p.id, email]);
      if (same) await db.run('UPDATE studio_invites SET role=?,pay_mode=?,sponsor_limit=?,expires_at=? WHERE id=?', [b.role, b.pay_mode, b.sponsor_limit, expires, same.id]);
      else
        await db.run('INSERT INTO studio_invites (id,token,project_id,email,role,pay_mode,sponsor_limit,max_uses,uses,active,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,1,0,1,?,?,?)', [
          randomUUID(), tokenOf(), p.id, email, b.role, b.pay_mode, b.sponsor_limit, expires, req.user.id, now(),
        ]);
      if (u) await notify(db, u.id, { kind: 'studio_invite', title: `${owner?.name || 'PD'}님이 「${p.title}」 제작에 초대했어요`, body: `역할: ${ROLE_NAME[b.role]} · ${INVITE_DAYS}일 안에 수락해 주세요.`, link: 'studio/ai' });
      results.push({ email, ok: true, message: u ? '초대를 보냈어요. 알림에서 수락할 수 있어요.' : '아직 가입하지 않은 이메일이에요. 이 이메일로 PD 가입을 하면 스튜디오에서 수락할 수 있어요.' });
    }
    let created = null;
    if (b.link) {
      const token = tokenOf();
      const id = randomUUID();
      await db.run('INSERT INTO studio_invites (id,token,project_id,email,role,pay_mode,sponsor_limit,max_uses,uses,active,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,0,1,?,?,?)', [
        id, token, p.id, null, b.role, b.pay_mode, b.sponsor_limit, Math.min(b.max_uses, seats), expires, req.user.id, now(),
      ]);
      created = inviteView(await db.get('SELECT * FROM studio_invites WHERE id=?', [id]));
      await log(p.id, req.user.id, 'link', `${ROLE_NAME[b.role]} · ${created.max_uses}명`);
    }
    const sent = results.filter((r) => r.ok).length;
    if (sent) await log(p.id, req.user.id, 'invite', `${ROLE_NAME[b.role]} ${sent}명`);
    res.status(201).json({ results, link: created });
  });
  // 초대 링크 켜기·끄기 · 새 주소로 바꾸기(예전 링크는 바로 막혀요) · 지우기
  app.patch('/api/studio/ai/projects/:id/invites/:iid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'manage');
    const b = z.object({ active: z.boolean().optional(), reset: z.boolean().optional() }).parse(req.body);
    const i = await db.get('SELECT * FROM studio_invites WHERE id=? AND project_id=?', [req.params.iid, p.id]);
    if (!i) fail(404, '초대를 찾을 수 없어요.');
    if (b.active !== undefined) await db.run('UPDATE studio_invites SET active=? WHERE id=?', [b.active ? 1 : 0, i.id]);
    if (b.reset) await db.run('UPDATE studio_invites SET token=?,expires_at=?,active=1 WHERE id=?', [tokenOf(), new Date(Date.now() + INVITE_DAYS * 86400000).toISOString(), i.id]);
    res.json(inviteView(await db.get('SELECT * FROM studio_invites WHERE id=?', [i.id])));
  });
  app.delete('/api/studio/ai/projects/:id/invites/:iid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'manage');
    await db.run('DELETE FROM studio_invites WHERE id=? AND project_id=?', [req.params.iid, p.id]);
    res.json({ ok: true });
  });
  // 받은 초대(이메일 초대)
  app.get('/api/studio/ai/invites', roles('pd', 'admin'), async (req, res) => {
    res.json(await myInvites(req.user));
  });
  const openInvite = async (token) => {
    const i = await db.get('SELECT * FROM studio_invites WHERE token=?', [token]);
    if (!i) fail(404, '초대를 찾을 수 없어요. 링크가 바뀌었거나 지워졌을 수 있어요.');
    return i;
  };
  const inviteProblem = (i, user) => {
    if (!Number(i.active)) return '소유자가 이 초대를 멈췄어요.';
    if (new Date(i.expires_at).getTime() < Date.now()) return '초대 기한(7일)이 지났어요. 소유자에게 새 초대를 요청해 주세요.';
    if (Number(i.uses) >= Number(i.max_uses)) return '초대 인원이 다 찼어요.';
    if (i.email && String(user.email || '').toLowerCase() !== String(i.email).toLowerCase()) return '다른 이메일로 보낸 초대예요. 초대받은 이메일로 로그인해 주세요.';
    return '';
  };
  // 초대 미리 보기(시청자 계정은 roles에서 막혀요)
  app.get('/api/studio/ai/invites/:token', roles('pd', 'admin'), async (req, res) => {
    await requireOn();
    const i = await openInvite(req.params.token);
    const p = await db.get('SELECT p.id,p.title,p.genre,p.poster,p.logline,p.owner_id,u.name AS owner_name FROM studio_projects p JOIN users u ON u.id=p.owner_id WHERE p.id=?', [i.project_id]);
    if (!p) fail(404, '프로젝트가 지워졌어요.');
    const member = p.owner_id === req.user.id || !!(await db.get('SELECT 1 AS ok FROM studio_members WHERE project_id=? AND user_id=?', [p.id, req.user.id]));
    res.json({
      project: { id: p.id, title: p.title, genre: p.genre, poster: p.poster, logline: p.logline, owner_name: p.owner_name },
      role: i.role,
      role_name: ROLE_NAME[i.role],
      perms: permsOf(i.role),
      pay_mode: i.pay_mode,
      sponsor_limit: Number(i.sponsor_limit),
      expires_at: i.expires_at,
      member,
      problem: member ? '' : inviteProblem(i, req.user),
    });
  });
  app.post('/api/studio/ai/invites/:token/accept', roles('pd', 'admin'), async (req, res) => {
    await requireOn();
    const out = await db.transaction(async () => {
      const i = await db.get('SELECT * FROM studio_invites WHERE token=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''), [req.params.token]);
      if (!i) fail(404, '초대를 찾을 수 없어요. 링크가 바뀌었거나 지워졌을 수 있어요.');
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''), [i.project_id]);
      if (!p) fail(404, '프로젝트가 지워졌어요.');
      if (p.owner_id === req.user.id) return { project_id: p.id, already: true };
      if (await db.get('SELECT 1 AS ok FROM studio_members WHERE project_id=? AND user_id=?', [p.id, req.user.id])) return { project_id: p.id, already: true };
      const problem = inviteProblem(i, req.user);
      if (problem) fail(409, problem);
      if ((await memberCount(p.id)) >= (await maxMembers())) fail(409, `팀 인원(최대 ${await maxMembers()}명)이 다 찼어요.`);
      await db.run('INSERT INTO studio_members (project_id,user_id,role,pay_mode,sponsor_limit,invited_by,created_at) VALUES (?,?,?,?,?,?,?)', [p.id, req.user.id, i.role, i.pay_mode, i.sponsor_limit, i.created_by, now()]);
      await db.run('UPDATE studio_invites SET uses=uses+1 WHERE id=?', [i.id]);
      await log(p.id, req.user.id, 'join', ROLE_NAME[i.role]);
      return { project_id: p.id, p, role: i.role };
    });
    if (out.p) await notify(db, out.p.owner_id, { kind: 'studio_team', title: `${req.user.name}님이 「${out.p.title}」 팀에 들어왔어요`, body: `역할: ${ROLE_NAME[out.role]}`, link: link(out.p.id) });
    res.json({ project_id: out.project_id, already: !!out.already });
  });

  // ── 멤버 역할 · 결제 · 내보내기 · 나가기 ─────────────────────
  app.patch('/api/studio/ai/projects/:id/members/:uid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'manage');
    const b = z.object({ role: z.enum(ROLES).optional(), pay_mode: z.enum(['self', 'sponsor']).optional(), sponsor_limit: z.number().int().min(0).max(1000000).optional() }).parse(req.body);
    const m = await db.get('SELECT * FROM studio_members WHERE project_id=? AND user_id=?', [p.id, req.params.uid]);
    if (!m) fail(404, '팀원을 찾을 수 없어요.');
    await db.run('UPDATE studio_members SET role=?,pay_mode=?,sponsor_limit=? WHERE project_id=? AND user_id=?', [b.role || m.role, b.pay_mode || m.pay_mode, b.sponsor_limit ?? Number(m.sponsor_limit), p.id, m.user_id]);
    const u = await db.get('SELECT name FROM users WHERE id=?', [m.user_id]);
    if (b.role && b.role !== m.role) {
      await log(p.id, req.user.id, 'role', `${u?.name || ''}: ${ROLE_NAME[m.role]} → ${ROLE_NAME[b.role]}`);
      await notify(db, m.user_id, { kind: 'studio_team', title: `「${p.title}」에서 역할이 ${ROLE_NAME[b.role]}(으)로 바뀌었어요`, link: link(p.id) });
    }
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id/members/:uid', roles('pd', 'admin'), async (req, res) => {
    const self = req.params.uid === req.user.id;
    const p = await project(req, req.params.id, self ? 'view' : 'manage');
    const m = await db.get('SELECT * FROM studio_members WHERE project_id=? AND user_id=?', [p.id, req.params.uid]);
    if (!m) fail(404, '팀원을 찾을 수 없어요.');
    await db.run('DELETE FROM studio_members WHERE project_id=? AND user_id=?', [p.id, m.user_id]);
    presence.get(p.id)?.delete(m.user_id);
    const u = await db.get('SELECT name FROM users WHERE id=?', [m.user_id]);
    await log(p.id, req.user.id, self ? 'leave' : 'remove', u?.name || '');
    if (self) await notify(db, p.owner_id, { kind: 'studio_team', title: `${u?.name || '팀원'}님이 「${p.title}」 팀에서 나갔어요`, link: link(p.id) });
    else await notify(db, m.user_id, { kind: 'studio_team', title: `「${p.title}」 팀에서 빠졌어요`, body: '소유자가 팀원 목록에서 뺐어요.', link: 'studio/ai' });
    res.json({ ok: true });
  });

  // ── 승인(대본 → 회차 합성본) ─────────────────────────────
  app.patch('/api/studio/ai/projects/:id/approval', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'manage');
    const b = z.object({ mode: z.enum(['auto', 'on', 'off']) }).parse(req.body);
    await db.run('UPDATE studio_projects SET approval_mode=?,updated_at=? WHERE id=?', [b.mode, now(), p.id]);
    await log(p.id, req.user.id, 'approval_mode', { auto: '팀이 있으면 자동', on: '항상 켜기', off: '끄기' }[b.mode]);
    res.json({ mode: b.mode, active: await approvalsActive({ ...p, approval_mode: b.mode }) });
  });
  app.post('/api/studio/ai/projects/:id/episodes/:eid/review', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ stage: z.enum(['script', 'final']), action: z.enum(['request', 'approve', 'changes', 'reset']), note: z.string().trim().max(500).default('') }).parse(req.body);
    const need = b.action === 'request' ? (b.stage === 'script' ? 'script' : 'scene') : b.action === 'reset' ? 'manage' : 'approve';
    const p = await project(req, req.params.id, need);
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    const col = b.stage === 'script' ? 'script_review' : 'final_review';
    if (b.stage === 'script' && b.action !== 'reset' && !(await db.get('SELECT id FROM studio_shots WHERE episode_id=? LIMIT 1', [e.id]))) fail(400, '대본(컷)이 아직 없어요.');
    if (b.stage === 'final' && b.action !== 'reset' && (!e.video || e.status !== 'composed')) fail(400, '합성이 끝난 회차만 승인할 수 있어요. 먼저 합성해 주세요.');
    if (b.action === 'changes' && !b.note) fail(400, '무엇을 고치면 좋을지 한 줄 남겨 주세요.');
    const value = { request: 'requested', approve: 'approved', changes: 'changes', reset: '' }[b.action];
    await db.run(`UPDATE studio_episodes SET ${col}=?,review_note=? WHERE id=?`, [value, b.action === 'reset' ? '' : b.note, e.id]);
    const what = `${e.number}화 ${STAGE_TEXT[b.stage]}`;
    await log(p.id, req.user.id, 'review_' + b.action, what + (b.note ? ` · ${b.note}` : ''));
    const tab = b.stage === 'script' ? 'script' : 'finish';
    if (b.action === 'request')
      await notifyTeam(p, req.user.id, { kind: 'studio_review', title: `「${p.title}」 ${what} 승인 요청`, body: `${req.user.name}님이 승인을 요청했어요.${b.note ? ' ' + b.note : ''}`, link: link(p.id, tab) }, (m) => can(m.role, 'approve'));
    else if (b.action !== 'reset')
      await notifyTeam(p, req.user.id, {
        kind: 'studio_review',
        title: `「${p.title}」 ${what} ${b.action === 'approve' ? '승인됨' : '수정 요청'}`,
        body: `${req.user.name}님${b.action === 'approve' ? '이 승인했어요.' : ': ' + b.note}`,
        link: link(p.id, tab),
      });
    res.json({ [col]: value });
  });

  // ── 댓글(@멘션) ────────────────────────────────────
  const targetOk = async (p, type, id) => {
    if (type === 'project') return id === p.id;
    if (type === 'episode') return !!(await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [id, p.id]));
    return !!(await db.get('SELECT s.id FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=? AND e.project_id=?', [id, p.id]));
  };
  app.get('/api/studio/ai/projects/:id/comments', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const q = z.object({ target_type: z.enum(['project', 'episode', 'shot']).optional(), target_id: z.string().max(80).optional() }).parse(req.query);
    const where = q.target_type && q.target_id ? ' AND c.target_type=? AND c.target_id=?' : '';
    const rows = await db.all(
      `SELECT c.*, u.name AS user_name FROM studio_comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.project_id=?${where} ORDER BY c.created_at DESC LIMIT 200`,
      where ? [p.id, q.target_type, q.target_id] : [p.id],
    );
    res.json(rows.map((c) => ({ ...c, resolved: !!Number(c.resolved), mine: c.user_id === req.user.id })));
  });
  app.post('/api/studio/ai/projects/:id/comments', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const b = z.object({ target_type: z.enum(['project', 'episode', 'shot']), target_id: z.string().max(80), body: z.string().trim().min(1).max(1000) }).parse(req.body);
    if (!(await targetOk(p, b.target_type, b.target_id))) fail(404, '댓글을 남길 대상을 찾을 수 없어요.');
    const id = randomUUID();
    await db.run('INSERT INTO studio_comments (id,project_id,target_type,target_id,user_id,body,resolved,created_at) VALUES (?,?,?,?,?,?,0,?)', [id, p.id, b.target_type, b.target_id, req.user.id, b.body, now()]);
    await log(p.id, req.user.id, 'comment', b.body.slice(0, 60));
    // @이름 으로 부른 팀원에게 알림(이름이 긴 사람부터 맞춰 '김지' · '김지수'가 겹치지 않게)
    const ids = await teamIds(p);
    const people = (await db.all(`SELECT id,name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).sort((x, y) => y.name.length - x.name.length);
    let text = b.body;
    const mentioned = [];
    for (const u of people) {
      if (u.id === req.user.id || !text.includes('@' + u.name)) continue;
      mentioned.push(u.id);
      text = text.split('@' + u.name).join(' ');
    }
    for (const uid of mentioned) await notify(db, uid, { kind: 'studio_mention', title: `「${p.title}」에서 ${req.user.name}님이 나를 불렀어요`, body: b.body.slice(0, 200), link: link(p.id) });
    res.status(201).json({ id, mentioned: mentioned.length });
  });
  app.patch('/api/studio/ai/projects/:id/comments/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const b = z.object({ resolved: z.boolean() }).parse(req.body);
    const c = await db.get('SELECT id FROM studio_comments WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    if (!c) fail(404, '댓글을 찾을 수 없어요.');
    await db.run('UPDATE studio_comments SET resolved=? WHERE id=?', [b.resolved ? 1 : 0, c.id]);
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id/comments/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const c = await db.get('SELECT id,user_id FROM studio_comments WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    if (!c) fail(404, '댓글을 찾을 수 없어요.');
    if (c.user_id !== req.user.id && req.teamRole !== 'owner') fail(403, '내가 쓴 댓글만 지울 수 있어요.');
    await db.run('DELETE FROM studio_comments WHERE id=?', [c.id]);
    res.json({ ok: true });
  });

  // ── 지금 편집 중(40초 안에 신호를 보낸 사람) ─────────────────
  app.post('/api/studio/ai/projects/:id/presence', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const b = z.object({ target: z.string().max(120).default('') }).parse(req.body || {});
    let m = presence.get(p.id);
    if (!m) presence.set(p.id, (m = new Map()));
    m.set(req.user.id, { name: req.user.name, target: b.target, at: Date.now() });
    for (const [uid, v] of m) if (Date.now() - v.at > PRESENCE_MS * 3) m.delete(uid);
    res.json([...m.entries()].filter(([uid, v]) => uid !== req.user.id && Date.now() - v.at < PRESENCE_MS).map(([uid, v]) => ({ user_id: uid, name: v.name, target: v.target })));
  });

  // ── 활동 기록 ─────────────────────────────────────
  app.get('/api/studio/ai/projects/:id/activity', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const rows = await db.all('SELECT a.*, u.name AS user_name FROM studio_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.project_id=? ORDER BY a.created_at DESC LIMIT 100', [p.id]);
    res.json(rows.map((r) => ({ ...r, text: ACTION_TEXT[r.action] || r.action })));
  });

  // ── 복사본 만들기(소유자): 시즌 2 · 다른 버전 실험용. 결과물 파일은 같은 소유자라 그대로 이어 써요. ──
  app.post('/api/studio/ai/projects/:id/duplicate', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'manage');
    const map = new Map([[p.id, randomUUID()]]);
    const chars = await db.all('SELECT * FROM studio_characters WHERE project_id=?', [p.id]);
    const locs = await db.all('SELECT * FROM studio_locations WHERE project_id=?', [p.id]);
    const props = await db.all('SELECT * FROM studio_props WHERE project_id=?', [p.id]);
    const eps = await db.all('SELECT * FROM studio_episodes WHERE project_id=? ORDER BY number', [p.id]);
    const shots = eps.length ? await db.all(`SELECT * FROM studio_shots WHERE episode_id IN (${eps.map(() => '?').join(',')})`, eps.map((e) => e.id)) : [];
    for (const r of [...chars, ...locs, ...props, ...eps, ...shots]) map.set(r.id, randomUUID());
    // 인물·장소·소품 ID가 들어 있는 칸(화자·출연·상태·관계 등)을 새 ID로 바꿔요(UUID라 겹치지 않아요).
    const swap = (v) => {
      if (typeof v !== 'string' || v.length < 36) return map.get(v) ?? v;
      let out = v;
      for (const [a, b] of map) if (out.includes(a)) out = out.split(a).join(b);
      return out;
    };
    const copy = async (table, row, over) => {
      const next = { ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, swap(v)])), ...over };
      const keys = Object.keys(next);
      await db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => next[k]));
    };
    const stamp = now();
    const newId = map.get(p.id);
    await db.transaction(async () => {
      await copy('studio_projects', p, {
        id: newId, owner_id: p.owner_id, drama_id: null, title: `${p.title} 복사본`.slice(0, 70), status: 'draft', autopilot: '', trailer: '', trailer_status: '', approval_mode: p.approval_mode || 'auto', created_at: stamp, updated_at: stamp,
      });
      for (const r of chars) await copy('studio_characters', r, {});
      for (const r of locs) await copy('studio_locations', r, {});
      for (const r of props) await copy('studio_props', r, {});
      for (const r of eps)
        await copy('studio_episodes', r, {
          video: '', duration: 0, subtitles: '', exported_at: null, status: ['composed', 'composing', 'compose_failed'].includes(r.status) ? 'scripted' : r.status,
          compose_progress: 0, compose_error: '', compose_claimed_by: null, compose_queued_at: null, script_version: 0, script_review: '', final_review: '', review_note: '', compose_dirty: 0,
        });
      for (const r of shots) await copy('studio_shots', r, { verify: r.verify || '', updated_at: null, updated_by: null });
    });
    res.status(201).json({ id: newId });
  });

  // 관리자 통계
  async function stats() {
    const one = async (sql, params = []) => Number((await db.get(sql, params))?.n || 0);
    return {
      projects: await one('SELECT COUNT(DISTINCT project_id) AS n FROM studio_members'),
      members: await one('SELECT COUNT(*) AS n FROM studio_members'),
      people: await one('SELECT COUNT(DISTINCT user_id) AS n FROM studio_members'),
      open_invites: await one('SELECT COUNT(*) AS n FROM studio_invites WHERE active=1 AND uses<max_uses AND expires_at>?', [now()]),
      comments_30d: await one('SELECT COUNT(*) AS n FROM studio_comments WHERE created_at>=?', [new Date(Date.now() - 30 * 86400000).toISOString()]),
      sponsored_lama_30d: await one(
        "SELECT COALESCE(SUM(j.charged_lama),0) AS n FROM ai_jobs j JOIN studio_projects p ON p.id=j.project_id WHERE j.status='succeeded' AND j.user_id=p.owner_id AND j.actor_id<>j.user_id AND j.created_at>=?",
        [new Date(Date.now() - 30 * 86400000).toISOString()],
      ),
    };
  }
  return { summary, sharesWith, myInvites, log, approvalsActive, stats };
}
