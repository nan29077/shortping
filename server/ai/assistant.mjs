import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assistantPrompt, assistantSchema, assistantActionSchema, parseJson, ASSISTANT_ACTIONS } from './prompts.mjs';

// AI 조수(작업 공간 채팅, 2026-09-24)
// PD가 말로 요청 → 글쓰기 AI가 '실행 계획'(작업 목록 + 예상 라마)을 제안 → PD가 승인하면 실행 → 직접 고친 내용은 되돌리기 가능.
// 대화 자체는 무료(플랫폼 부담)이고, 계획 안의 AI 작업만 평소처럼 라마가 들어요.
const KST = 9 * 3600000;
const kstDayStart = () => {
  const d = new Date(Date.now() + KST);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - KST).toISOString();
};
const AI_TYPES = new Set(Object.keys(ASSISTANT_ACTIONS).filter((k) => !k.startsWith('edit_')));
const CAP_OF = {
  shot_image: 'image', shot_image_edit: 'image', character_image: 'image', location_image: 'image', batch_shot_image: 'image', poster: 'image',
  shot_video: 'video', batch_shot_video: 'video', shot_tts: 'tts', batch_shot_tts: 'tts', shot_sfx: 'sfx', shot_lipsync: 'lipsync', music: 'music',
  rewrite_shot: 'text', rewrite_range: 'text', script: 'text', diagnose: 'text', metadata: 'text',
};
export const assistantCapOf = CAP_OF;
const LABEL = {
  shot_image: '컷 이미지 만들기', shot_image_edit: '컷 이미지 고치기', shot_video: '컷 영상 만들기', shot_tts: '대사 음성 만들기', shot_sfx: '효과음 만들기',
  shot_lipsync: '입 모양 맞추기', rewrite_shot: '컷 다시 쓰기', rewrite_range: '여러 컷 다시 쓰기', script: '대본 새로 쓰기', diagnose: '대본 진단',
  character_image: '인물 기준 이미지', location_image: '장소 이미지', batch_shot_image: '빈 컷 이미지 모두', batch_shot_tts: '빈 대사 음성 모두',
  batch_shot_video: '빈 컷 영상 모두', music: '배경음악', poster: '포스터', metadata: '제목·소개 추천',
  edit_shot: '컷 내용 고치기', edit_character: '인물 설정 고치기', edit_episode: '회차 제목·줄거리 고치기', edit_project: '작품 톤·스타일 고치기',
};
// 직접 고치기에서 바꿀 수 있는 칸과 규칙
const SHOT_FIELDS = {
  dialogue: (v) => String(v).slice(0, 300),
  visual: (v) => String(v).slice(0, 800),
  emotion: (v) => String(v).slice(0, 30),
  camera: (v) => String(v).slice(0, 40),
  camera_move: (v) => String(v).slice(0, 40),
  seconds: (v) => Math.min(10, Math.max(2, Math.round(Number(v) || 5))),
  speed: (v) => Math.min(2, Math.max(0.5, Number(v) || 1)),
};
const CHAR_FIELDS = { description: (v) => String(v).slice(0, 500), look: (v) => String(v).slice(0, 500), voice_style: (v) => String(v).slice(0, 60) };
const EP_FIELDS = { title: (v) => String(v).slice(0, 70), summary: (v) => String(v).slice(0, 1000) };
const PROJECT_FIELDS = { tone: (v) => String(v).slice(0, 200), style: (v) => String(v).slice(0, 500) };

export function assistantRoutes({ app, db, fail, now, roles, engine, project, requireTerms, plan, runSpecs, runSchema, estimateSpecs, charactersOf, episodesOf, shotsOf, locationsOf, queueTranslate, settingsOf }) {
  const parse = (raw, fallback) => {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  // 대상 코드(E1S3·E2·C1·L1)를 실제 ID로
  async function resolver(p) {
    const eps = await episodesOf(p.id);
    const cast = await charactersOf(p.id);
    const places = await locationsOf(p.id);
    const shotsByEp = new Map();
    for (const e of eps) shotsByEp.set(e.number, await shotsOf(e.id));
    const shot = (ref) => {
      const m = /^E(\d+)S(\d+)$/i.exec(String(ref || '').trim());
      if (!m) return null;
      const list = shotsByEp.get(Number(m[1])) || [];
      const s = list[Number(m[2]) - 1];
      return s ? { ...s, ref: `E${m[1]}S${m[2]}`, episode_number: Number(m[1]) } : null;
    };
    const episode = (ref) => {
      const m = /^E(\d+)(?:S\d+)?$/i.exec(String(ref || '').trim());
      return m ? eps.find((e) => e.number === Number(m[1])) || null : null;
    };
    const character = (ref) => {
      const m = /^C(\d+)$/i.exec(String(ref || '').trim());
      if (m) return cast[Number(m[1]) - 1] || null;
      return cast.find((c) => c.name === String(ref || '').trim()) || null;
    };
    const location = (ref) => {
      const m = /^L(\d+)$/i.exec(String(ref || '').trim());
      if (m) return places[Number(m[1]) - 1] || null;
      return places.find((l) => l.name === String(ref || '').trim()) || null;
    };
    return { shot, episode, character, location, eps, cast, places, shotsByEp };
  }
  const fake = (p) => ({ user: { id: p.owner_id, role: 'pd' }, params: {} });
  // AI가 제안한 작업 하나를 검사해 실행할 수 있는 형태(run 본문 또는 직접 수정)로 바꿉니다.
  async function normalize(p, raw, r) {
    const parsed = assistantActionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, label: '알 수 없는 작업', note: '형식이 맞지 않아 뺐어요.' };
    const a = parsed.data;
    const label = LABEL[a.type] || a.type;
    const out = { type: a.type, label, reason: a.reason, cap: CAP_OF[a.type] || '', ok: true };
    const bad = (note) => ({ ...out, ok: false, note });
    if (a.type === 'edit_shot') {
      const s = r.shot(a.target);
      if (!s) return bad(`컷(${a.target || '미지정'})을 찾을 수 없어요.`);
      const fields = {};
      for (const [k, v] of Object.entries(a.fields || {})) if (SHOT_FIELDS[k]) fields[k] = SHOT_FIELDS[k](v);
      if (!Object.keys(fields).length) return bad('바꿀 내용이 없어요.');
      return { ...out, target: s.ref, targetId: s.id, fields, before: Object.fromEntries(Object.keys(fields).map((k) => [k, s[k]])), what: `${s.episode_number}화 ${s.ref.split('S')[1]}번 컷` };
    }
    if (a.type === 'edit_character') {
      const c = r.character(a.target);
      if (!c) return bad('인물을 찾을 수 없어요.');
      const fields = {};
      for (const [k, v] of Object.entries(a.fields || {})) if (CHAR_FIELDS[k]) fields[k] = CHAR_FIELDS[k](v);
      if (!Object.keys(fields).length) return bad('바꿀 내용이 없어요.');
      return { ...out, targetId: c.id, fields, what: c.name };
    }
    if (a.type === 'edit_episode') {
      const e = r.episode(a.target);
      if (!e) return bad('회차를 찾을 수 없어요.');
      const fields = {};
      for (const [k, v] of Object.entries(a.fields || {})) if (EP_FIELDS[k]) fields[k] = EP_FIELDS[k](v);
      if (!Object.keys(fields).length) return bad('바꿀 내용이 없어요.');
      return { ...out, targetId: e.id, fields, what: `${e.number}화` };
    }
    if (a.type === 'edit_project') {
      const fields = {};
      for (const [k, v] of Object.entries(a.fields || {})) if (PROJECT_FIELDS[k]) fields[k] = PROJECT_FIELDS[k](v);
      if (!Object.keys(fields).length) return bad('바꿀 내용이 없어요.');
      return { ...out, targetId: p.id, fields, what: '작품 전체' };
    }
    // AI 작업: 대상 → run 본문
    const body = { action: a.type, options: {} };
    let what = '작품 전체';
    if (a.type.startsWith('shot_') || a.type === 'rewrite_shot') {
      const s = r.shot(a.target);
      if (!s) return bad(`컷(${a.target || '미지정'})을 찾을 수 없어요.`);
      body.targetId = s.id;
      what = `${s.episode_number}화 ${s.ref.split('S')[1]}번 컷`;
    } else if (['script', 'diagnose', 'batch_shot_image', 'batch_shot_tts', 'batch_shot_video'].includes(a.type)) {
      const e = r.episode(a.target);
      if (!e) return bad('회차를 찾을 수 없어요.');
      body.targetId = e.id;
      what = `${e.number}화`;
    } else if (a.type === 'rewrite_range') {
      const list = (a.targets.length ? a.targets : [a.target]).map((t) => r.shot(t)).filter(Boolean);
      if (!list.length) return bad('다시 쓸 컷을 찾을 수 없어요.');
      const ep = list[0].episode_number;
      const same = list.filter((s) => s.episode_number === ep);
      body.targetId = r.eps.find((e) => e.number === ep).id;
      body.options.shotIds = same.map((s) => s.id);
      what = `${ep}화 컷 ${same.length}개`;
    } else if (a.type === 'character_image') {
      const c = r.character(a.target);
      if (!c) return bad('인물을 찾을 수 없어요.');
      body.targetId = c.id;
      what = c.name;
    } else if (a.type === 'location_image') {
      const l = r.location(a.target);
      if (!l) return bad('장소를 찾을 수 없어요.');
      body.targetId = l.id;
      what = l.name;
    } else if (a.type === 'music') {
      const e = r.episode(a.target);
      body.targetId = e ? e.id : p.id;
      if (a.mood) body.options.mood = a.mood.slice(0, 200);
      what = e ? `${e.number}화` : '작품 전체';
    }
    if (['shot_image_edit', 'rewrite_shot', 'rewrite_range', 'script'].includes(a.type)) {
      if (a.instruction.trim().length < 2 && a.type !== 'script') return bad('무엇을 바꿀지 알 수 없어 뺐어요.');
      if (a.instruction.trim()) body.instruction = a.instruction.trim().slice(0, 300);
    }
    if (a.type === 'shot_sfx') {
      if (!a.prompt.trim() && !a.instruction.trim()) return bad('어떤 효과음인지 알 수 없어 뺐어요.');
      body.options.prompt = (a.prompt || a.instruction).trim().slice(0, 200);
    }
    return { ...out, body, what };
  }
  // 계획의 AI 작업마다 예상 라마(지금 설정 기준)
  async function priceOf(p, act, choice) {
    try {
      const b = runSchema.parse({ ...act.body, requested: choice?.requested || 'auto', tier: choice?.tier || 'standard' });
      const specs = await plan(fake(p), p, b);
      const { lama, label } = await estimateSpecs(p, b, specs);
      return { lama, jobs: specs.length, model: label };
    } catch (e) {
      return { error: String(e.message || '지금은 실행할 수 없어요.').slice(0, 200) };
    }
  }
  engine.registerHandler('assistant', {
    async onSuccess({ job, result }) {
      const row = await db.get('SELECT * FROM studio_chat WHERE id=?', [job.target_id]);
      if (!row) return { skipped: true };
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [row.project_id]);
      if (!p) return { skipped: true };
      const out = parseJson(result.text, assistantSchema);
      const r = await resolver(p);
      const input = parse(job.input, {});
      const choices = input.choices || {};
      const actions = [];
      for (const raw of out.actions.slice(0, 12)) {
        const act = await normalize(p, raw, r);
        if (act.ok && act.body) Object.assign(act, await priceOf(p, act, choices[act.cap]));
        actions.push(act);
      }
      const runnable = actions.filter((a) => a.ok && !a.error);
      await db.run('UPDATE studio_chat SET content=?,plan=?,status=? WHERE id=?', [out.reply, JSON.stringify(actions), runnable.length ? 'ready' : 'done', row.id]);
      return { actions: actions.length };
    },
    async onFail({ job }) {
      await db.run("UPDATE studio_chat SET status='failed',content=? WHERE id=?", ['답을 만들지 못했어요. 잠시 후 다시 말씀해 주세요. (대화는 무료예요)', job.target_id]);
    },
  });

  const chatOf = async (pid) => {
    // 답을 만들던 작업이 취소·실패로 끝났는데 기록이 남아 있으면 정리합니다.
    await db.run("UPDATE studio_chat SET status='failed',content=? WHERE project_id=? AND status='thinking' AND job_id IN (SELECT id FROM ai_jobs WHERE status IN ('failed','canceled'))", ['답을 만들지 못했어요. 잠시 후 다시 말씀해 주세요. (대화는 무료예요)', pid]);
    return rawChat(pid);
  };
  const rawChat = (pid) => db.all('SELECT id,role,content,plan,status,result,episode_id,created_at FROM studio_chat WHERE project_id=? ORDER BY created_at DESC LIMIT 40', [pid]);
  const view = (m) => ({ ...m, plan: parse(m.plan, []), result: parse(m.result, null) });
  app.get('/api/studio/ai/projects/:id/assistant', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    res.json((await chatOf(p.id)).reverse().map(view));
  });
  const choiceSchema = z.object({ requested: z.string().max(80).default('auto'), tier: z.enum(['draft', 'standard', 'premium']).default('standard') });
  app.post('/api/studio/ai/projects/:id/assistant', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req);
    const b = z
      .object({
        message: z.string().trim().min(1, '하고 싶은 말을 적어 주세요.').max(600),
        episodeId: z.string().max(80).optional(),
        focus: z.string().max(80).optional(), // 지금 고른 컷 ID
        choices: z.record(z.string(), choiceSchema).optional(),
      })
      .parse(req.body);
    const settings = await settingsOf();
    if (!Number(settings.ai_assistant_enabled)) fail(403, 'AI 조수를 잠시 쓸 수 없어요. 관리자에게 문의해 주세요.');
    const limit = Number(settings.ai_assistant_daily_limit || 0);
    if (limit > 0) {
      const used = Number((await db.get("SELECT COUNT(*) AS n FROM studio_chat WHERE user_id=? AND role='user' AND created_at>=?", [req.user.id, kstDayStart()]))?.n || 0);
      if (used >= limit) fail(429, `오늘 AI 조수와 나눌 수 있는 대화(${limit}번)를 모두 썼어요. 내일 다시 이용해 주세요.`);
    }
    const thinking = await db.get("SELECT id FROM studio_chat WHERE project_id=? AND status='thinking'", [p.id]);
    if (thinking) fail(409, 'AI 조수가 앞의 말에 답하는 중이에요. 잠시만 기다려 주세요.');
    await engine.screen({ userId: req.user.id, kind: 'assistant', texts: [b.message] });
    const eps = await episodesOf(p.id);
    const episode = eps.find((e) => e.id === b.episodeId) || eps[0] || null;
    const shots = episode ? await shotsOf(episode.id) : [];
    const cast = await charactersOf(p.id);
    const focusIndex = shots.findIndex((s) => s.id === b.focus);
    const history = (await chatOf(p.id)).slice(0, 6).reverse();
    const counts = new Map();
    for (const e of eps) counts.set(e.id, Number((await db.get('SELECT COUNT(*) AS n FROM studio_shots WHERE episode_id=?', [e.id]))?.n || 0));
    const shotsView = shots.map((s) => ({ ...s, speaker: cast.find((c) => c.id === s.speaker_id)?.name || (Number(s.narration) ? '내레이션' : '') }));
    const input = {
      ...assistantPrompt({
        project: p,
        characters: cast,
        episodes: eps.map((e) => ({ ...e, shot_count: counts.get(e.id) })),
        episode,
        shots: shotsView,
        locations: await locationsOf(p.id),
        message: b.message,
        history,
        focus: episode && focusIndex >= 0 ? `E${episode.number}S${focusIndex + 1}` : '',
      }),
      userText: b.message,
      choices: b.choices || {},
    };
    const userId = randomUUID();
    const botId = randomUUID();
    const stamp = now();
    const later = new Date(Date.parse(stamp) + 1).toISOString();
    await db.transaction(async () => {
      await db.run('INSERT INTO studio_chat (id,project_id,user_id,role,content,status,episode_id,created_at) VALUES (?,?,?,?,?,?,?,?)', [userId, p.id, req.user.id, 'user', b.message, '', episode?.id || null, stamp]);
      await db.run('INSERT INTO studio_chat (id,project_id,user_id,role,content,status,episode_id,created_at) VALUES (?,?,?,?,?,?,?,?)', [botId, p.id, req.user.id, 'assistant', '', 'thinking', episode?.id || null, later]);
      // 대화는 무료: 라마를 예약·차감하지 않습니다(bill=false, 원가는 플랫폼 부담으로 기록).
      const job = await engine.enqueue({ userId: req.user.id, kind: 'assistant', capability: 'text', requested: 'auto', tier: 'standard', tags: ['korean', 'story'], input, target: { type: 'chat', id: botId }, projectId: p.id, bill: false, excludeCn: !!Number(p.exclude_cn) });
      await db.run('UPDATE studio_chat SET job_id=? WHERE id=?', [job.id, botId]);
    });
    res.status(201).json({ id: botId });
  });

  // 계획 실행: 고른 작업만(skip으로 뺄 수 있음). 직접 수정은 바로 반영하고 되돌리기 기록을 남깁니다.
  app.post('/api/studio/ai/projects/:id/assistant/:mid/apply', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req);
    const b = z.object({ skip: z.array(z.number().int().min(0).max(20)).max(20).default([]), choices: z.record(z.string(), choiceSchema).optional(), budgetOk: z.boolean().optional() }).parse(req.body || {});
    const m = await db.get("SELECT * FROM studio_chat WHERE id=? AND project_id=? AND role='assistant'", [req.params.mid, p.id]);
    if (!m) fail(404, '계획을 찾을 수 없어요.');
    if (m.status !== 'ready') fail(409, m.status === 'applied' ? '이미 실행한 계획이에요.' : '실행할 수 있는 계획이 아니에요.');
    // 동시에 두 번 눌러도 한 번만 실행
    const claimed = await db.run("UPDATE studio_chat SET status='applying' WHERE id=? AND status='ready'", [m.id]);
    if (Number(claimed?.rowCount ?? claimed?.changes ?? 1) === 0) fail(409, '이미 실행 중인 계획이에요.');
    const acts = parse(m.plan, []);
    const results = [];
    const undo = [];
    const jobIds = [];
    const req2 = { ...req, params: { id: p.id } };
    try {
      // 예산 확인은 AI 작업 전체를 한 번에
      const aiActs = acts.map((a, i) => ({ a, i })).filter(({ a, i }) => a.ok && a.body && !a.error && !b.skip.includes(i));
      if (Number(p.budget_lama) > 0 && !b.budgetOk && aiActs.length) {
        const spent = Number((await db.get("SELECT COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_lama WHEN status IN ('queued','running') THEN estimate_lama ELSE 0 END),0) AS n FROM ai_jobs WHERE project_id=? AND billed=1", [p.id]))?.n || 0);
        const add = aiActs.reduce((n, { a }) => n + Number(a.lama || 0), 0);
        if (spent + add > Number(p.budget_lama))
          throw Object.assign(new Error(`프로젝트 예산(${Number(p.budget_lama).toLocaleString('ko-KR')}라마)을 넘어요. 이번 계획은 약 ${add.toLocaleString('ko-KR')}라마예요.`), { status: 409, code: 'project_budget' });
      }
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i];
        if (!a.ok || a.error || b.skip.includes(i)) {
          results.push({ i, skipped: true });
          continue;
        }
        try {
          if (a.type === 'edit_shot') {
            const s = await db.get('SELECT s.*, e.project_id FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=?', [a.targetId]);
            if (!s || s.project_id !== p.id) throw new Error('컷이 지워졌어요.');
            const before = { ...Object.fromEntries(Object.keys(a.fields).map((k) => [k, s[k]])), audio: s.audio, audio_seconds: s.audio_seconds, lipsync: s.lipsync };
            const audioReset = ['dialogue', 'emotion', 'speed'].some((k) => k in a.fields && String(a.fields[k]) !== String(s[k]));
            const sets = Object.keys(a.fields).map((k) => `${k}=?`);
            if (audioReset) sets.push("audio=''", 'audio_seconds=0', "lipsync=''");
            await db.run(`UPDATE studio_shots SET ${sets.join(',')} WHERE id=?`, [...Object.values(a.fields), s.id]);
            await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
            if (a.fields.visual && a.fields.visual !== s.visual) await queueTranslate(p.id, p.owner_id, [{ id: 'shot:' + s.id, ko: a.fields.visual }]).catch(() => {});
            undo.push({ table: 'studio_shots', id: s.id, values: before, episode: s.episode_id });
            results.push({ i, ok: true, message: audioReset ? '고쳤어요. 대사가 바뀌어 음성은 다시 만들어야 해요.' : '고쳤어요.' });
          } else if (a.type === 'edit_character' || a.type === 'edit_episode' || a.type === 'edit_project') {
            const table = { edit_character: 'studio_characters', edit_episode: 'studio_episodes', edit_project: 'studio_projects' }[a.type];
            const where = a.type === 'edit_project' ? 'id=?' : 'id=? AND project_id=?';
            const row = await db.get(`SELECT * FROM ${table} WHERE ${where}`, a.type === 'edit_project' ? [p.id] : [a.targetId, p.id]);
            if (!row) throw new Error('대상이 지워졌어요.');
            const before = Object.fromEntries(Object.keys(a.fields).map((k) => [k, row[k]]));
            await db.run(`UPDATE ${table} SET ${Object.keys(a.fields).map((k) => `${k}=?`).join(',')} WHERE id=?`, [...Object.values(a.fields), row.id]);
            undo.push({ table, id: row.id, values: before });
            results.push({ i, ok: true, message: '고쳤어요.' });
          } else {
            const choice = b.choices?.[a.cap];
            const body = runSchema.parse({ ...a.body, requested: choice?.requested || 'auto', tier: choice?.tier || 'standard', budgetOk: true });
            // 되돌리기용: AI 결과가 덮어쓸 컷의 지금 이미지·음성·영상
            if (body.targetId && (a.type.startsWith('shot_') || a.type === 'rewrite_shot')) {
              const s = await db.get('SELECT id,image,audio,audio_seconds,video,lipsync,sfx,scene,visual,dialogue,camera,seconds FROM studio_shots WHERE id=?', [body.targetId]);
              if (s) undo.push({ table: 'studio_shots', id: s.id, values: Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'id')), ai: true });
            }
            const specs = await plan(req2, p, body);
            const jobs = await runSpecs(req2, p, body, specs);
            jobIds.push(...jobs.map((j) => j.id));
            results.push({ i, ok: true, jobs: jobs.length, message: `시작했어요 · 예약 ${jobs.reduce((n, j) => n + Number(j.estimate_lama), 0)}라마` });
          }
        } catch (e) {
          results.push({ i, ok: false, message: String(e.message || '실행하지 못했어요.').slice(0, 200) });
        }
      }
    } catch (e) {
      await db.run("UPDATE studio_chat SET status='ready' WHERE id=?", [m.id]);
      throw e;
    }
    const any = results.some((r) => r.ok);
    await db.run('UPDATE studio_chat SET status=?,result=? WHERE id=?', [any ? 'applied' : 'ready', JSON.stringify({ results, undo, jobs: jobIds, at: now() }), m.id]);
    if (any) await db.run('UPDATE studio_projects SET updated_at=? WHERE id=?', [now(), p.id]);
    res.json({ results });
  });
  // 되돌리기: 직접 고친 내용은 원래대로, AI 작업은 진행 중이면 멈추고(라마 반환) 이전 결과로 돌려놓습니다(새 결과는 버전 기록에 남음).
  app.post('/api/studio/ai/projects/:id/assistant/:mid/undo', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const m = await db.get("SELECT * FROM studio_chat WHERE id=? AND project_id=? AND role='assistant'", [req.params.mid, p.id]);
    if (!m || m.status !== 'applied') fail(400, '되돌릴 수 있는 계획이 아니에요.');
    const r = parse(m.result, {});
    for (const id of r.jobs || []) {
      const j = await db.get('SELECT status FROM ai_jobs WHERE id=?', [id]);
      if (j && (j.status === 'queued' || j.status === 'running')) await engine.cancel(id, req.user).catch(() => {});
    }
    const allowed = { studio_shots: Object.keys(SHOT_FIELDS).concat(['audio', 'audio_seconds', 'lipsync', 'image', 'video', 'sfx', 'scene']), studio_characters: Object.keys(CHAR_FIELDS), studio_episodes: Object.keys(EP_FIELDS), studio_projects: Object.keys(PROJECT_FIELDS) };
    await db.transaction(async () => {
      for (const u of [...(r.undo || [])].reverse()) {
        const cols = Object.keys(u.values || {}).filter((k) => allowed[u.table]?.includes(k));
        if (!cols.length) continue;
        const own =
          u.table === 'studio_projects'
            ? u.id === p.id
            : u.table === 'studio_shots'
              ? !!(await db.get('SELECT s.id FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=? AND e.project_id=?', [u.id, p.id]))
              : !!(await db.get(`SELECT id FROM ${u.table} WHERE id=? AND project_id=?`, [u.id, p.id]));
        if (!own) continue;
        await db.run(`UPDATE ${u.table} SET ${cols.map((k) => `${k}=?`).join(',')} WHERE id=?`, [...cols.map((k) => u.values[k] ?? ''), u.id]);
        if (u.table === 'studio_shots') await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=(SELECT episode_id FROM studio_shots WHERE id=?)", [u.id]);
      }
      await db.run("UPDATE studio_chat SET status='undone' WHERE id=?", [m.id]);
    });
    res.json({ ok: true });
  });
  app.post('/api/studio/ai/projects/:id/assistant/:mid/dismiss', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    await db.run("UPDATE studio_chat SET status='declined' WHERE id=? AND project_id=? AND status='ready'", [req.params.mid, p.id]);
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id/assistant', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    await db.run("DELETE FROM studio_chat WHERE project_id=? AND status NOT IN ('thinking','applying')", [p.id]);
    res.json({ ok: true });
  });
  return { chatOf: async (pid) => (await chatOf(pid)).reverse().map(view) };
}
