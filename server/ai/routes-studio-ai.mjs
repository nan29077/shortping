import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadSettings } from '../settings.mjs';
import { lamaWalletOf } from '../lama.mjs';
import { runFfmpeg, precheck, probeMedia } from '../media.mjs';
import { toVtt } from '../routes-upload.mjs';
import { composeEpisode } from './compose.mjs';
import {
  characterImagePrompt,
  parseJson,
  planPrompt,
  planSchema,
  posterPrompt,
  rewriteShotPrompt,
  scriptPrompt,
  shotSchema as aiShotSchema,
  scriptSchema,
  shotImagePrompt,
  shotVideoPrompt,
} from './prompts.mjs';

// 숏핑 스튜디오(AI 제작) API: 프로젝트 → 기획 → 캐릭터 → 대본(컷) → 스토리보드 → 음성 → 영상 → 합성 → 작품으로 내보내기·검수 신청.
// 비용이 드는 단계는 모두 AI 작업 대기열(engine)을 거치고, 라마 예약·차감·반환은 엔진이 맡습니다.
export const GENRES = ['로맨스', '스릴러', '판타지', '코미디', '청춘'];
const parseAutopilot = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const AP_STAGES = {
  plan: '기획안',
  cast: '인물 이미지',
  script: '대본',
  board: '스토리보드',
  voice: '대사 음성',
  video: '컷 영상',
  compose: '회차 합성',
};
const TERMS_VERSION = '2026-09';

export function studioAiRoutes({ app, db, fail, now, roles, engine, uploadDir, owned: _owned, contentIssues }) {
  const subsDir = path.join(uploadDir, 'subtitles');
  const project = async (req, id = req.params.id) => {
    const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [id]);
    if (!p || (p.owner_id !== req.user.id && req.user.role !== 'admin')) fail(404, '프로젝트를 찾을 수 없어요.');
    return p;
  };
  const touch = (id) => db.run('UPDATE studio_projects SET updated_at=? WHERE id=?', [now(), id]);
  const charactersOf = (pid) => db.all('SELECT * FROM studio_characters WHERE project_id=? ORDER BY sort_order, name', [pid]);
  const episodesOf = (pid) => db.all('SELECT * FROM studio_episodes WHERE project_id=? ORDER BY number', [pid]);
  const shotsOf = (eid) => db.all('SELECT * FROM studio_shots WHERE episode_id=? ORDER BY sort_order', [eid]);
  const asset = (job, projectId, target, kind, url, model) =>
    db.run(
      'INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [randomUUID(), job.user_id, projectId, target.type, target.id, kind, url, job.id, model?.label || '', now()],
    );
  const shotTags = (shot) => {
    const tags = [];
    if (shot.dialogue) tags.push('dialogue');
    if (/클로즈|close/i.test(shot.camera || '')) tags.push('closeup');
    if (/달리|싸우|추격|폭발|액션|run|fight|chase|action/i.test(`${shot.visual} ${shot.scene}`)) tags.push('action');
    if (/와이드|풍경|wide|landscape|skyline/i.test(`${shot.camera} ${shot.visual}`)) tags.push('landscape');
    return tags.length ? tags : ['scene'];
  };
  const imageRef = (url) => (url && url.startsWith('/uploads/') ? { path: url, mime: /\.png$/.test(url) ? 'image/png' : 'image/jpeg' } : undefined);
  const loadShot = async (req, shotId) => {
    const s = await db.get(
      'SELECT s.*, e.project_id, e.number AS episode_number FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=?',
      [shotId],
    );
    if (!s) fail(404, '컷을 찾을 수 없어요.');
    await project(req, s.project_id);
    return s;
  };

  // ── 작업 종류별 처리(결과를 프로젝트에 반영) ──────────────────────────
  engine.registerHandler('playground', { onSuccess: async ({ result }) => (result.url ? { url: result.url } : { text: String(result.text || '').slice(0, 2000) }) });
  engine.registerHandler('plan', {
    async onSuccess({ job, result }) {
      const plan = parseJson(result.text, planSchema);
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [job.project_id]);
      if (!p) return { skipped: true };
      await db.run('UPDATE studio_projects SET title=?,logline=?,synopsis=?,style=?,updated_at=? WHERE id=?', [
        plan.title, plan.logline, plan.synopsis, plan.style || p.style, now(), p.id,
      ]);
      // 캐릭터는 이미 이미지를 만든 인물은 남기고 나머지를 새 기획으로 바꿉니다.
      const old = await charactersOf(p.id);
      for (const c of old) if (!c.image) await db.run('DELETE FROM studio_characters WHERE id=?', [c.id]);
      let order = old.filter((c) => c.image).length;
      for (const c of plan.characters) {
        const same = old.find((o) => o.name === c.name && o.image);
        if (same) await db.run('UPDATE studio_characters SET role=?,description=?,look=? WHERE id=?', [c.role, c.description, c.look, same.id]);
        else
          await db.run('INSERT INTO studio_characters (id,project_id,name,role,description,look,sort_order) VALUES (?,?,?,?,?,?,?)', [
            randomUUID(), p.id, c.name, c.role, c.description, c.look, order++,
          ]);
      }
      // 회차: 대본이 이미 있는 회차는 제목·요약만 바꾸고, 없는 회차는 새로 만듭니다.
      for (const e of plan.episodes.slice(0, Number(p.episode_count))) {
        const ex = await db.get('SELECT id FROM studio_episodes WHERE project_id=? AND number=?', [p.id, e.number]);
        if (ex) await db.run('UPDATE studio_episodes SET title=?,summary=? WHERE id=?', [e.title, e.summary, ex.id]);
        else
          await db.run("INSERT INTO studio_episodes (id,project_id,number,title,summary,status) VALUES (?,?,?,?,?,'outline')", [randomUUID(), p.id, e.number, e.title, e.summary]);
      }
      return { title: plan.title, characters: plan.characters.length, episodes: plan.episodes.length };
    },
  });
  engine.registerHandler('script', {
    async onSuccess({ job, result }) {
      const script = parseJson(result.text, scriptSchema);
      const e = await db.get('SELECT * FROM studio_episodes WHERE id=?', [job.target_id]);
      if (!e) return { skipped: true };
      const cast = await charactersOf(e.project_id);
      await db.run('DELETE FROM studio_shots WHERE episode_id=?', [e.id]);
      let i = 0;
      for (const s of script.shots) {
        const speaker = cast.find((c) => c.name === s.speaker.trim());
        await db.run(
          'INSERT INTO studio_shots (id,episode_id,sort_order,scene,visual,dialogue,speaker_id,camera,seconds) VALUES (?,?,?,?,?,?,?,?,?)',
          [randomUUID(), e.id, i++, s.scene, s.visual, s.dialogue, speaker?.id || null, s.camera, Math.round(Math.min(10, Math.max(2, s.seconds)))],
        );
      }
      await db.run("UPDATE studio_episodes SET status='scripted',video='',duration=0 WHERE id=?", [e.id]);
      await touch(e.project_id);
      return { shots: script.shots.length };
    },
  });
  const mediaHandler = (column, table, kind) => ({
    async onSuccess({ job, result, model }) {
      const row = await db.get(`SELECT * FROM ${table} WHERE id=?`, [job.target_id]);
      if (row) {
        await db.run(`UPDATE ${table} SET ${column}=?${column === 'audio' ? ',audio_seconds=?' : ''} WHERE id=?`, column === 'audio' ? [result.url, result.duration || 0, row.id] : [result.url, row.id]);
        // 컷이 바뀌면 이미 합성한 회차 영상은 다시 만들어야 합니다.
        if (table === 'studio_shots') await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [row.episode_id]);
      }
      if (job.project_id) await asset(job, job.project_id, { type: job.target_type, id: job.target_id }, kind, result.url, model);
      return { url: result.url, duration: result.duration || 0 };
    },
  });
  engine.registerHandler('rewrite_shot', {
    async onSuccess({ job, result }) {
      const next = parseJson(result.text, aiShotSchema);
      const s = await db.get('SELECT s.*, e.project_id FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=?', [job.target_id]);
      if (!s) return { skipped: true };
      const cast = await charactersOf(s.project_id);
      const speaker = cast.find((c) => c.name === next.speaker.trim());
      const speakerId = next.dialogue ? speaker?.id || s.speaker_id : null;
      const audioReset = next.dialogue !== s.dialogue || speakerId !== s.speaker_id;
      await db.run(
        `UPDATE studio_shots SET scene=?,visual=?,dialogue=?,speaker_id=?,camera=?,seconds=?${audioReset ? ",audio='',audio_seconds=0" : ''} WHERE id=?`,
        [next.scene, next.visual, next.dialogue, speakerId, next.camera, Math.round(Math.min(10, Math.max(2, next.seconds))), s.id],
      );
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
      return { audioReset };
    },
  });
  engine.registerHandler('voice_sample', mediaHandler('voice_sample', 'studio_characters', 'audio'));
  engine.registerHandler('character_image', mediaHandler('image', 'studio_characters', 'image'));
  engine.registerHandler('shot_image', mediaHandler('image', 'studio_shots', 'image'));
  engine.registerHandler('shot_tts', mediaHandler('audio', 'studio_shots', 'audio'));
  engine.registerHandler('shot_video', mediaHandler('video', 'studio_shots', 'video'));
  engine.registerHandler('poster', mediaHandler('poster', 'studio_projects', 'image'));
  // 업로드 영상용 AI 도구: 포스터 후보(작품에 바로 적용하지 않고 후보로만 남김), 자동 자막
  engine.registerHandler('tool_poster', { onSuccess: async ({ result }) => ({ url: result.url }) });
  engine.registerHandler('tool_subtitles', {
    async onSuccess({ job, result }) {
      const segments = (result.segments || []).filter((s) => String(s.text || '').trim());
      if (!segments.length) throw Object.assign(new Error('인식된 대사가 없어요.'), { retryable: false });
      const t = (x) => {
        const ms = Math.max(0, Math.round(Number(x) * 1000));
        return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
      };
      const text = 'WEBVTT\n\n' + segments.map((s) => `${t(s.start)} --> ${t(Math.max(Number(s.end), Number(s.start) + 0.5))}\n${s.text}`).join('\n\n') + '\n';
      const vtt = toVtt(text);
      const [dramaId, number] = String(job.target_id).split('#');
      const e = await db.get('SELECT e.id FROM episodes e JOIN dramas d ON d.id=e.drama_id WHERE e.drama_id=? AND e.number=? AND d.status IN (\'draft\',\'rejected\')', [dramaId, Number(number)]);
      if (!e || !vtt) return { skipped: true };
      const file = randomUUID() + '.vtt';
      await mkdir(subsDir, { recursive: true });
      await writeFile(path.join(subsDir, file), vtt, 'utf8');
      await db.run('UPDATE episodes SET subtitles=? WHERE id=?', [file, e.id]);
      return { cues: segments.length };
    },
  });

  // 실행할 작업을 만듭니다. 예상 라마 조회와 실제 실행이 같은 정의를 씁니다.
  async function buildJob(req, p, action, targetId, extra = {}) {
    const cast = await charactersOf(p.id);
    if (action === 'voice_sample') {
      const c = cast.find((x) => x.id === targetId);
      if (!c) fail(404, '인물을 찾을 수 없어요.');
      return {
        kind: 'voice_sample',
        capability: 'tts',
        tags: ['korean'],
        requestedOverride: c.voice_model && c.voice_model !== 'auto' ? c.voice_model : null,
        target: { type: 'character', id: c.id },
        input: { text: `안녕하세요, 저는 ${c.name}이에요. ${String(c.description || '').slice(0, 40) || '오늘 이야기, 기대해 주세요.'}`, voice: c.voice || '' },
      };
    }
    if (action === 'plan')
      return { kind: 'plan', capability: 'text', target: { type: 'project', id: p.id }, input: { ...planPrompt(p), userText: `${p.title} ${p.logline} ${p.tone}` } };
    if (action === 'poster')
      return { kind: 'poster', capability: 'image', target: { type: 'project', id: p.id }, input: { prompt: posterPrompt(p, cast), aspect: '9:16', refImage: imageRef(cast.find((c) => c.image)?.image) } };
    if (action === 'script') {
      const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [targetId, p.id]);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      if (!cast.length) fail(400, '기획안(등장인물)을 먼저 만들어 주세요.');
      const prev = await db.get('SELECT summary FROM studio_episodes WHERE project_id=? AND number=?', [p.id, e.number - 1]);
      return {
        kind: 'script',
        capability: 'text',
        target: { type: 'episode', id: e.id },
        input: { ...scriptPrompt({ project: p, characters: cast, episode: e, previous: prev?.summary, maxShotSeconds: 8 }), userText: `${e.title} ${e.summary}` },
      };
    }
    if (action === 'character_image') {
      const c = cast.find((x) => x.id === targetId);
      if (!c) fail(404, '인물을 찾을 수 없어요.');
      return { kind: 'character_image', capability: 'image', tags: ['character', 'consistency'], target: { type: 'character', id: c.id }, input: { prompt: characterImagePrompt(p, c), aspect: '9:16', userText: c.look } };
    }
    const shot = await loadShot(req, targetId);
    if (shot.project_id !== p.id) fail(404, '컷을 찾을 수 없어요.');
    const speaker = cast.find((c) => c.id === shot.speaker_id);
    if (action === 'rewrite_shot') {
      const instruction = String(extra.instruction || '').trim();
      if (instruction.length < 2) fail(400, '어떻게 고칠지 적어 주세요.');
      return {
        kind: 'rewrite_shot',
        capability: 'text',
        target: { type: 'shot', id: shot.id },
        input: { ...rewriteShotPrompt({ project: p, characters: cast, shot, speaker: speaker?.name, instruction }), userText: instruction },
      };
    }
    if (action === 'shot_image')
      return {
        kind: 'shot_image',
        capability: 'image',
        tags: ['character', 'consistency'],
        target: { type: 'shot', id: shot.id },
        input: { prompt: shotImagePrompt(p, shot, speaker ? [speaker] : cast.slice(0, 2)), aspect: '9:16', refImage: imageRef(speaker?.image), userText: shot.visual },
      };
    if (action === 'shot_tts') {
      if (!String(shot.dialogue || '').trim()) fail(400, '대사가 없는 컷이에요.');
      return {
        kind: 'shot_tts',
        capability: 'tts',
        tags: ['korean'],
        requestedOverride: speaker && speaker.voice_model && speaker.voice_model !== 'auto' ? speaker.voice_model : null,
        target: { type: 'shot', id: shot.id },
        input: { text: shot.dialogue, voice: speaker?.voice || '', userText: shot.dialogue },
      };
    }
    if (action === 'shot_video')
      return {
        kind: 'shot_video',
        capability: 'video',
        tags: shotTags(shot),
        target: { type: 'shot', id: shot.id },
        input: { prompt: shotVideoPrompt(p, shot), seconds: Number(shot.seconds) || 5, aspect: '9:16', image: imageRef(shot.image), userText: shot.visual },
      };
    fail(400, '알 수 없는 작업이에요.');
  }
  // 회차 단위 일괄 작업: 아직 결과가 없는 컷만 대상으로 합니다.
  async function batchTargets(p, action, episodeId) {
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [episodeId, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    const shots = await shotsOf(e.id);
    const busy = new Set(
      (await db.all("SELECT target_id FROM ai_jobs WHERE project_id=? AND target_type='shot' AND kind=? AND status IN ('queued','running')", [p.id, action])).map((r) => r.target_id),
    );
    const col = { shot_image: 'image', shot_tts: 'audio', shot_video: 'video' }[action];
    return shots.filter((s) => !s[col] && !busy.has(s.id) && (action !== 'shot_tts' || String(s.dialogue || '').trim()));
  }
  const runSchema = z.object({
    action: z.enum(['plan', 'poster', 'script', 'character_image', 'shot_image', 'shot_tts', 'shot_video', 'rewrite_shot', 'voice_sample', 'batch_shot_image', 'batch_shot_tts', 'batch_shot_video']),
    instruction: z.string().trim().max(300).optional(),
    targetId: z.string().max(80).optional(),
    requested: z.string().max(80).default('auto'),
    tier: z.enum(['draft', 'standard', 'premium']).default('standard'),
    idempotencyKey: z.string().uuid().optional(),
  });
  async function plan(req, p, b) {
    if (b.action.startsWith('batch_')) {
      const action = b.action.slice(6);
      const targets = await batchTargets(p, action, b.targetId);
      if (!targets.length) fail(400, '새로 만들 컷이 없어요. 이미 결과가 있거나 진행 중이에요.');
      const specs = [];
      for (const t of targets) specs.push(await buildJob(req, p, action, t.id));
      return specs;
    }
    return [await buildJob(req, p, b.action, b.targetId, { instruction: b.instruction })];
  }
  const settingsOf = () => loadSettings(db);

  // ── 이용 동의 · 모델 · 지갑 ──────────────────────────────────
  app.get('/api/studio/ai/overview', roles('pd', 'admin'), async (req, res) => {
    const profile = await db.get('SELECT studio_terms_at FROM user_profiles WHERE user_id=?', [req.user.id]);
    const settings = await settingsOf();
    res.json({
      terms_version: TERMS_VERSION,
      agreed_at: profile?.studio_terms_at || null,
      wallet: await lamaWalletOf(db, req.user.id),
      enabled: !!Number(settings.ai_enabled),
      models: await engine.listForPicker(null, settings),
      genres: GENRES,
      projects: await db.all(
        "SELECT p.*, (SELECT COUNT(*) FROM studio_episodes e WHERE e.project_id=p.id) AS episode_total, (SELECT COUNT(*) FROM studio_episodes e WHERE e.project_id=p.id AND e.video<>'') AS composed, (SELECT COALESCE(SUM(j.charged_lama),0) FROM ai_jobs j WHERE j.project_id=p.id AND j.status='succeeded') AS spent FROM studio_projects p WHERE p.owner_id=? ORDER BY p.updated_at DESC",
        [req.user.id],
      ),
    });
  });
  app.post('/api/studio/ai/terms', roles('pd', 'admin'), async (req, res) => {
    z.object({ agree: z.literal(true), version: z.literal(TERMS_VERSION) }).parse(req.body);
    await db.run('UPDATE user_profiles SET studio_terms_at=? WHERE user_id=?', [now(), req.user.id]);
    res.json({ ok: true });
  });
  const requireTerms = async (req) => {
    const profile = await db.get('SELECT studio_terms_at FROM user_profiles WHERE user_id=?', [req.user.id]);
    if (!profile?.studio_terms_at) fail(403, '숏핑 스튜디오 이용 약관에 먼저 동의해 주세요.');
  };

  // ── 프로젝트 ─────────────────────────────────────────────
  const projectSchema = z.object({
    title: z.string().trim().min(1).max(70),
    logline: z.string().trim().min(5).max(300),
    genre: z.enum(GENRES),
    tone: z.string().trim().max(100).default(''),
    style: z.string().trim().max(400).default(''),
    synopsis: z.string().trim().max(3000).default(''),
    episode_count: z.number().int().min(1).max(60),
    episode_seconds: z.number().int().min(20).max(180),
    exclude_cn: z.boolean().default(false),
  });
  app.post('/api/studio/ai/projects', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const b = projectSchema.parse(req.body);
    const id = randomUUID();
    await db.transaction(async () => {
      await db.run(
        "INSERT INTO studio_projects (id,owner_id,title,logline,genre,tone,style,synopsis,episode_count,episode_seconds,exclude_cn,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)",
        [id, req.user.id, b.title, b.logline, b.genre, b.tone, b.style, b.synopsis, b.episode_count, b.episode_seconds, b.exclude_cn ? 1 : 0, now(), now()],
      );
      for (let n = 1; n <= b.episode_count; n++)
        await db.run("INSERT INTO studio_episodes (id,project_id,number,title,summary,status) VALUES (?,?,?,?,?,'outline')", [randomUUID(), id, n, `${n}화`, '']);
    });
    res.status(201).json({ id });
  });
  app.get('/api/studio/ai/projects/:id', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const episodes = await episodesOf(p.id);
    const shots = await db.all(
      'SELECT s.* FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=? ORDER BY e.number, s.sort_order',
      [p.id],
    );
    res.json({
      project: p,
      characters: await charactersOf(p.id),
      episodes: episodes.map((e) => ({ ...e, shots: shots.filter((s) => s.episode_id === e.id) })),
      jobs: await db.all(
        "SELECT j.id,j.kind,j.target_type,j.target_id,j.status,j.estimate_lama,j.charged_lama,j.error,j.created_at,j.finished_at,j.attempts,j.requested_model,m.label AS model_label FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref WHERE j.project_id=? AND (j.status IN ('queued','running') OR j.created_at>=?) ORDER BY j.created_at DESC LIMIT 300",
        [p.id, new Date(Date.now() - 3 * 86400000).toISOString()],
      ),
      assets: await db.all('SELECT id,target_type,target_id,kind,url,model_label,created_at FROM studio_assets WHERE project_id=? ORDER BY created_at DESC LIMIT 500', [p.id]),
      spent: Number((await db.get("SELECT COALESCE(SUM(charged_lama),0) AS n FROM ai_jobs WHERE project_id=? AND status='succeeded'", [p.id]))?.n || 0),
      costs: await db.all(
        "SELECT kind, COUNT(*) AS jobs, COALESCE(SUM(charged_lama),0) AS lama, COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed FROM ai_jobs WHERE project_id=? AND status IN ('succeeded','failed') GROUP BY kind",
        [p.id],
      ),
      autopilot: parseAutopilot(p.autopilot),
      drama: p.drama_id ? await db.get('SELECT id,title,status,review_note FROM dramas WHERE id=?', [p.drama_id]) : null,
      wallet: await lamaWalletOf(db, req.user.id),
    });
  });
  app.patch('/api/studio/ai/projects/:id', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = projectSchema.partial().parse(req.body);
    const next = { ...p, ...b, exclude_cn: b.exclude_cn === undefined ? Number(p.exclude_cn) : b.exclude_cn ? 1 : 0 };
    await db.transaction(async () => {
      await db.run('UPDATE studio_projects SET title=?,logline=?,genre=?,tone=?,style=?,synopsis=?,episode_count=?,episode_seconds=?,exclude_cn=?,updated_at=? WHERE id=?', [
        next.title, next.logline, next.genre, next.tone, next.style, next.synopsis, next.episode_count, next.episode_seconds, next.exclude_cn, now(), p.id,
      ]);
      // 회차 수를 늘리면 빈 회차를 추가합니다(줄이면 대본이 없는 뒷 회차만 지웁니다).
      const eps = await episodesOf(p.id);
      for (let n = eps.length + 1; n <= next.episode_count; n++)
        await db.run("INSERT INTO studio_episodes (id,project_id,number,title,summary,status) VALUES (?,?,?,?,?,'outline')", [randomUUID(), p.id, n, `${n}화`, '']);
      for (const e of eps.filter((x) => x.number > next.episode_count)) {
        const has = await db.get('SELECT id FROM studio_shots WHERE episode_id=? LIMIT 1', [e.id]);
        if (has || e.exported_at) fail(409, `${e.number}화에 대본이 있어 회차 수를 줄일 수 없어요.`);
        await db.run('DELETE FROM studio_episodes WHERE id=?', [e.id]);
      }
    });
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const active = await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1", [p.id]);
    if (active) fail(409, '진행 중인 AI 작업이 끝난 뒤 삭제해 주세요.');
    await db.run('DELETE FROM studio_projects WHERE id=?', [p.id]);
    res.json({ ok: true });
  });
  app.put('/api/studio/ai/projects/:id/poster', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = z.object({ image: z.string().regex(/^\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/) }).parse(req.body);
    const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [b.image]);
    if (!f || (f.owner_id !== p.owner_id && req.user.role !== 'admin')) fail(403, '이 프로젝트에서 만든 이미지만 포스터로 쓸 수 있어요.');
    await db.run('UPDATE studio_projects SET poster=?,updated_at=? WHERE id=?', [b.image, now(), p.id]);
    res.json({ ok: true });
  });
  // ── 인물 · 회차 · 컷 편집 ──────────────────────────────────
  const characterSchema = z.object({
    name: z.string().trim().min(1).max(30),
    role: z.string().trim().max(60).default(''),
    description: z.string().trim().max(500).default(''),
    look: z.string().trim().max(500).default(''),
    voice_model: z.string().max(80).default('auto'),
    voice: z.string().trim().max(80).default(''),
  });
  app.post('/api/studio/ai/projects/:id/characters', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = characterSchema.parse(req.body);
    const count = (await charactersOf(p.id)).length;
    if (count >= 8) fail(400, '인물은 8명까지 만들 수 있어요.');
    const id = randomUUID();
    await db.run('INSERT INTO studio_characters (id,project_id,name,role,description,look,voice_model,voice,sort_order) VALUES (?,?,?,?,?,?,?,?,?)', [
      id, p.id, b.name, b.role, b.description, b.look, b.voice_model, b.voice, count,
    ]);
    await touch(p.id);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/projects/:id/characters/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = characterSchema.parse(req.body);
    const c = await db.get('SELECT id FROM studio_characters WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    if (!c) fail(404, '인물을 찾을 수 없어요.');
    await db.run('UPDATE studio_characters SET name=?,role=?,description=?,look=?,voice_model=?,voice=? WHERE id=?', [b.name, b.role, b.description, b.look, b.voice_model, b.voice, c.id]);
    await touch(p.id);
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id/characters/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    await db.run('UPDATE studio_shots SET speaker_id=NULL WHERE speaker_id=?', [req.params.cid]);
    await db.run('DELETE FROM studio_characters WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    await touch(p.id);
    res.json({ ok: true });
  });
  app.patch('/api/studio/ai/projects/:id/episodes/:eid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = z.object({ title: z.string().trim().min(1).max(100), summary: z.string().trim().max(800).default('') }).parse(req.body);
    const e = await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    await db.run('UPDATE studio_episodes SET title=?,summary=? WHERE id=?', [b.title, b.summary, e.id]);
    await touch(p.id);
    res.json({ ok: true });
  });
  const shotSchema = z.object({
    scene: z.string().trim().max(200).default(''),
    visual: z.string().trim().min(1).max(800),
    dialogue: z.string().trim().max(300).default(''),
    speaker_id: z.string().max(80).nullable().default(null),
    camera: z.string().trim().max(80).default(''),
    seconds: z.number().int().min(2).max(10),
  });
  app.post('/api/studio/ai/projects/:id/episodes/:eid/shots', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = shotSchema.parse(req.body);
    const e = await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    const last = await db.get('SELECT MAX(sort_order) AS n FROM studio_shots WHERE episode_id=?', [e.id]);
    const id = randomUUID();
    await db.run('INSERT INTO studio_shots (id,episode_id,sort_order,scene,visual,dialogue,speaker_id,camera,seconds) VALUES (?,?,?,?,?,?,?,?,?)', [
      id, e.id, Number(last?.n ?? -1) + 1, b.scene, b.visual, b.dialogue, b.speaker_id, b.camera, b.seconds,
    ]);
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status IN ('outline','composed') THEN 'scripted' ELSE status END WHERE id=?", [e.id]);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/shots/:sid', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid);
    const b = shotSchema.parse(req.body);
    // 대사가 바뀌면 이전 음성은 맞지 않으므로 지웁니다(버전 기록에는 남아 있음).
    const audioReset = b.dialogue !== s.dialogue || b.speaker_id !== s.speaker_id;
    await db.run(
      `UPDATE studio_shots SET scene=?,visual=?,dialogue=?,speaker_id=?,camera=?,seconds=?${audioReset ? ",audio='',audio_seconds=0" : ''} WHERE id=?`,
      [b.scene, b.visual, b.dialogue, b.speaker_id, b.camera, b.seconds, s.id],
    );
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
    res.json({ ok: true, audioReset });
  });
  app.delete('/api/studio/ai/shots/:sid', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid);
    await db.run('DELETE FROM studio_shots WHERE id=?', [s.id]);
    res.json({ ok: true });
  });
  app.post('/api/studio/ai/shots/:sid/move', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid);
    const b = z.object({ direction: z.enum(['up', 'down']) }).parse(req.body);
    await db.transaction(async () => {
      const shots = await shotsOf(s.episode_id);
      const i = shots.findIndex((x) => x.id === s.id);
      const j = b.direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= shots.length) return;
      [shots[i], shots[j]] = [shots[j], shots[i]];
      for (let k = 0; k < shots.length; k++) await db.run('UPDATE studio_shots SET sort_order=? WHERE id=?', [k, shots[k].id]);
    });
    res.json({ ok: true });
  });
  // 결과 버전 고르기: 예전에 만든 이미지·음성·영상으로 되돌립니다.
  app.post('/api/studio/ai/assets/:aid/use', roles('pd', 'admin'), async (req, res) => {
    const a = await db.get('SELECT * FROM studio_assets WHERE id=?', [req.params.aid]);
    if (!a) fail(404, '결과를 찾을 수 없어요.');
    await project(req, a.project_id);
    const map = {
      character: ['studio_characters', 'image'],
      shot: ['studio_shots', { image: 'image', audio: 'audio', video: 'video' }[a.kind]],
      project: ['studio_projects', 'poster'],
    }[a.target_type];
    if (!map || !map[1]) fail(400, '적용할 수 없는 결과예요.');
    if (a.target_type === 'shot' && a.kind === 'audio') {
      const meta = await db.get('SELECT duration FROM media_metadata WHERE url=?', [a.url]);
      await db.run('UPDATE studio_shots SET audio=?,audio_seconds=? WHERE id=?', [a.url, Number(meta?.duration || 0), a.target_id]);
    } else await db.run(`UPDATE ${map[0]} SET ${map[1]}=? WHERE id=?`, [a.url, a.target_id]);
    if (a.target_type === 'shot') {
      const shot = await db.get('SELECT episode_id FROM studio_shots WHERE id=?', [a.target_id]);
      if (shot) await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [shot.episode_id]);
    }
    res.json({ ok: true });
  });

  // ── AI 실행 · 예상 라마 ─────────────────────────────────────
  app.post('/api/studio/ai/projects/:id/estimate', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = runSchema.parse(req.body);
    const specs = await plan(req, p, b);
    const settings = await settingsOf();
    let lama = 0;
    let label = '';
    for (const spec of specs) {
      const e = await engine.estimate({ capability: spec.capability, requested: spec.requestedOverride || b.requested, tier: b.tier, tags: spec.tags, seconds: spec.input.seconds, needImage: !!spec.input.image, input: spec.input, excludeCn: !!Number(p.exclude_cn) });
      lama += e.lama;
      label = e.model.label;
    }
    res.json({ lama, jobs: specs.length, model: b.requested === 'auto' ? `자동 선택 (예: ${label})` : label, won: lama * 10, wallet: await lamaWalletOf(db, req.user.id), daily_limit: settings.ai_daily_limit_lama });
  });
  app.post('/api/studio/ai/projects/:id/run', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req);
    const b = runSchema.parse(req.body);
    const specs = await plan(req, p, b);
    // 입력 검사는 먼저, 중복 검사와 라마 예약은 같은 트랜잭션 안에서 합니다.
    for (const spec of specs) {
      await engine.screen({ userId: req.user.id, kind: spec.kind, texts: [spec.input.userText, spec.input.text] });
    }
    const jobs = await db.transaction(async () => {
      if (db.engine === 'postgresql') await db.get('SELECT id FROM studio_projects WHERE id=? FOR UPDATE', [p.id]);
      const out = [];
      for (const spec of specs) {
        const requestKey = b.idempotencyKey ? (b.action.startsWith('batch_') ? `${b.idempotencyKey}:${spec.kind}:${spec.target.id}` : b.idempotencyKey) : undefined;
        const previous = requestKey ? await db.get('SELECT * FROM ai_jobs WHERE idempotency_key=?', [requestKey]) : null;
        if (previous) {
          if (previous.user_id !== req.user.id || previous.project_id !== p.id || previous.kind !== spec.kind || previous.target_id !== spec.target.id)
            fail(409, '다른 AI 작업에 사용된 요청입니다. 다시 시작해 주세요.');
          out.push(previous);
          continue;
        }
        const active = await db.get("SELECT * FROM ai_jobs WHERE project_id=? AND kind=? AND target_id=? AND status IN ('queued','running')", [p.id, spec.kind, spec.target.id]);
        if (active) {
          if (!b.action.startsWith('batch_')) fail(409, '같은 작업이 이미 진행 중이에요.');
          out.push(active);
          continue;
        }
        out.push(
          await engine.enqueue({
            userId: req.user.id,
            kind: spec.kind,
            capability: spec.capability,
            requested: spec.requestedOverride || b.requested,
            tier: b.tier,
            tags: spec.tags || [],
            input: spec.input,
            target: spec.target,
            projectId: p.id,
            excludeCn: !!Number(p.exclude_cn),
            idempotencyKey: requestKey,
          }),
        );
      }
      await db.run("UPDATE studio_projects SET status=CASE WHEN status='draft' THEN 'producing' ELSE status END,updated_at=? WHERE id=?", [now(), p.id]);
      return out;
    });
    res.status(201).json({
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, estimate_lama: Number(j.estimate_lama), status: j.status })),
      lama: jobs.reduce((n, j) => n + Number(j.estimate_lama), 0),
      wallet: await lamaWalletOf(db, req.user.id),
    });
  });
  app.post('/api/studio/ai/jobs/:jid/cancel', roles('pd', 'admin'), async (req, res) => {
    res.json(await engine.cancel(req.params.jid, req.user));
  });
  app.get('/api/studio/ai/jobs', roles('pd', 'admin'), async (req, res) => {
    res.json(
      await db.all(
        'SELECT j.id,j.project_id,j.kind,j.capability,j.status,j.estimate_lama,j.charged_lama,j.error,j.created_at,j.finished_at,m.label AS model_label,p.title AS project_title FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref LEFT JOIN studio_projects p ON p.id=j.project_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT 200',
        [req.user.id],
      ),
    );
  });

  // ── 합성 · 내보내기 ─────────────────────────────────────────
  const composing = new Map();
  // 회차 합성 시작(검사 후 백그라운드 실행). 자동 제작에서도 같은 함수를 씁니다.
  async function startCompose(p, e) {
    if (composing.has(e.id)) fail(409, '이미 합성 중이에요.');
    const shots = await shotsOf(e.id);
    const busy = await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND target_type='shot' AND status IN ('queued','running') AND target_id IN (SELECT id FROM studio_shots WHERE episode_id=?) LIMIT 1", [p.id, e.id]);
    if (busy) fail(409, '이 회차의 AI 작업이 끝난 뒤 합성해 주세요.');
    if (!shots.length) fail(400, '대본(컷)이 없어요. 대본을 먼저 만들어 주세요.');
    const missing = shots.findIndex((s) => !s.video && !s.image);
    if (missing >= 0) fail(400, `${missing + 1}번째 컷에 영상이나 스토리보드 이미지가 없어요.`);
    const cast = await charactersOf(p.id);
    await db.run("UPDATE studio_episodes SET status='composing' WHERE id=?", [e.id]);
    composing.delete(e.id + ':error');
    const task = (async () => {
      try {
        const out = await composeEpisode({ shots, uploadDir, nameOf: (id) => cast.find((c) => c.id === id)?.name || '' });
        const sub = randomUUID() + '.vtt';
        await mkdir(subsDir, { recursive: true });
        await writeFile(path.join(subsDir, sub), out.vtt, 'utf8');
        await db.transaction(async () => {
          await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [out.url, p.owner_id, 'video/mp4', now()]);
          await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [out.url, out.duration, out.width, out.height, out.hasAudio ? 1 : 0]);
          await db.run("UPDATE studio_episodes SET status='composed',video=?,duration=?,subtitles=? WHERE id=?", [out.url, out.duration, sub, e.id]);
          await db.run(
            'INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [randomUUID(), p.owner_id, p.id, 'episode', e.id, 'video', out.url, null, '합성', now()],
          );
        });
      } catch (err) {
        await db.run("UPDATE studio_episodes SET status='compose_failed' WHERE id=?", [e.id]);
        composing.set(e.id + ':error', String(err.message || err).slice(0, 300));
      } finally {
        composing.delete(e.id);
      }
    })();
    composing.set(e.id, task);
  }
  // 서버가 합성 중에 꺼졌다면 다시 합성할 수 있게 상태를 되돌립니다.
  void db.run("UPDATE studio_episodes SET status='compose_failed' WHERE status='composing'").catch(() => {});
  app.post('/api/studio/ai/projects/:id/episodes/:eid/compose', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    await startCompose(p, e);
    res.status(202).json({ ok: true });
  });
  app.get('/api/studio/ai/projects/:id/episodes/:eid/compose', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const e = await db.get('SELECT id,status,video,duration FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    res.json({ ...e, error: composing.get(e.id + ':error') || '' });
  });
  // 테스트용: 합성이 끝날 때까지 기다립니다.
  const settle = async (id) => composing.get(id);
  app.locals.composeSettle = settle;

  // 작품으로 내보내기: 합성된 회차를 작품(드라마)의 회차로 등록하고, 원하면 바로 검수를 신청합니다.
  app.post('/api/studio/ai/projects/:id/export', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req);
    const b = z
      .object({
        tagline: z.string().trim().min(2).max(120),
        free: z.boolean().default(false),
        episode_pings: z.number().int().min(0).max(1000).default(0),
        free_episodes: z.number().int().min(1).max(50).default(1),
        image: z.string().regex(/^\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).optional(),
        submit: z.boolean().default(false),
      })
      .parse(req.body);
    const episodes = (await episodesOf(p.id)).filter((e) => e.video);
    if (!episodes.length) fail(400, '합성이 끝난 회차가 없어요. 회차를 먼저 합성해 주세요.');
    if (episodes.some((e, i) => e.number !== i + 1)) fail(400, '1화부터 빠짐없이 합성한 회차만 내보낼 수 있어요.');
    const image = b.image || p.poster || (await db.get("SELECT image FROM studio_characters WHERE project_id=? AND image<>'' LIMIT 1", [p.id]))?.image;
    if (!image) fail(400, '포스터를 먼저 만들거나 골라 주세요.');
    if (!existsSync(path.join(uploadDir, path.basename(image))) && image.startsWith('/uploads/')) fail(400, '포스터 파일을 찾을 수 없어요.');
    const result = await db.transaction(async () => {
      let drama = p.drama_id ? await db.get('SELECT * FROM dramas WHERE id=?', [p.drama_id]) : null;
      if (drama && !['draft', 'rejected'].includes(drama.status)) fail(409, '심사 중이거나 공개된 작품은 다시 내보낼 수 없어요. 반려되면 수정해 다시 보낼 수 있어요.');
      const synopsis = (p.synopsis || p.logline).padEnd(10, ' ').slice(0, 3000);
      const channel = await db.get('SELECT id FROM channels WHERE owner_id=?', [p.owner_id]);
      if (!drama) {
        const id = randomUUID();
        await db.run(
          "INSERT INTO dramas (id,owner_id,title,tagline,synopsis,genre,image,free,episode_pings,free_episodes,created_at,channel_id,rights_confirmed,likeness_confirmed,ai_usage,declared_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,'full',?)",
          [id, p.owner_id, p.title.slice(0, 70), b.tagline, synopsis, p.genre, image, b.free ? 1 : 0, b.episode_pings, b.free_episodes, now(), channel?.id || null, now()],
        );
        drama = await db.get('SELECT * FROM dramas WHERE id=?', [id]);
        await db.run('UPDATE studio_projects SET drama_id=? WHERE id=?', [id, p.id]);
      } else {
        await db.run(
          "UPDATE dramas SET title=?,tagline=?,synopsis=?,genre=?,image=?,free=?,episode_pings=?,free_episodes=?,rights_confirmed=1,likeness_confirmed=1,ai_usage=CASE WHEN ai_usage='none' THEN 'partial' ELSE ai_usage END,declared_at=? WHERE id=?",
          [p.title.slice(0, 70), b.tagline, synopsis, p.genre, image, b.free ? 1 : 0, b.episode_pings, b.free_episodes, now(), drama.id],
        );
      }
      for (const e of episodes) {
        await db.run(
          "INSERT INTO episodes (id,drama_id,number,title,video,duration,source,subtitles,studio_episode_id) VALUES (?,?,?,?,?,?,'studio',?,?) ON CONFLICT(drama_id,number) DO UPDATE SET title=excluded.title,video=excluded.video,duration=excluded.duration,source='studio',subtitles=excluded.subtitles,studio_episode_id=excluded.studio_episode_id",
          [randomUUID(), drama.id, e.number, e.title.slice(0, 100), e.video, Math.max(1, Number(e.duration)), e.subtitles || '', e.id],
        );
        await db.run('UPDATE studio_episodes SET exported_at=? WHERE id=?', [now(), e.id]);
      }
      await db.run("UPDATE studio_projects SET status='exported',updated_at=? WHERE id=?", [now(), p.id]);
      let submitted = false;
      if (b.submit) {
        const fresh = await db.get('SELECT * FROM dramas WHERE id=?', [drama.id]);
        const { issues } = await contentIssues(fresh);
        if (issues.length) fail(400, issues.join(' '));
        await db.run("UPDATE dramas SET status='pending',review_note='' WHERE id=?", [drama.id]);
        const stamp = now();
        await db.run('INSERT INTO content_reviews (id,drama_id,actor_id,status,note,created_at) VALUES (?,?,?,?,?,?)', [randomUUID(), drama.id, req.user.id, 'pending', '숏핑 스튜디오에서 검수 신청', stamp]);
        await db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), req.user.id, 'pending', drama.id, stamp]);
        submitted = true;
      }
      return { dramaId: drama.id, episodes: episodes.length, submitted };
    });
    res.json(result);
  });

  // ── 자동 제작(오토파일럿) ─────────────────────────────────────
  // 기획 → 인물 이미지 → 대본 → 스토리보드 → 대사 음성 → (선택) 컷 영상 → 회차 합성까지 빈 곳만 차례로 채웁니다.
  // PD가 정한 최대 라마를 넘으면 멈추고, 같은 단계가 두 번 연속 채워지지 않으면(실패) 멈춰서 알려 줍니다.
  const choiceSchema = z.object({ requested: z.string().max(80).default('auto'), tier: z.enum(['draft', 'standard', 'premium']).default('standard') });
  const autopilotSchema = z.object({
    choices: z
      .object({ text: choiceSchema.default({}), image: choiceSchema.default({}), tts: choiceSchema.default({}), video: choiceSchema.default({ requested: 'auto', tier: 'draft' }) })
      .default({}),
    includeVideo: z.boolean().default(false),
    cap: z.number().int().min(1).max(10000000).optional(),
  });
  const ownerReq = (p) => ({ user: { id: p.owner_id, role: 'pd' }, params: {} });
  async function stageWork(p, ap) {
    const req = ownerReq(p);
    const cast = await charactersOf(p.id);
    const eps = await episodesOf(p.id);
    const shots = await db.all('SELECT s.* FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=? ORDER BY e.number, s.sort_order', [p.id]);
    const specs = async (action, ids) => Promise.all(ids.map((id) => buildJob(req, p, action, id)));
    if (!cast.length) return { stage: 'plan', specs: [await buildJob(req, p, 'plan')] };
    const noImage = cast.filter((c) => !c.image);
    if (noImage.length) return { stage: 'cast', specs: await specs('character_image', noImage.map((c) => c.id)) };
    const withShots = new Set(shots.map((x) => x.episode_id));
    const unscripted = eps.filter((e) => !withShots.has(e.id));
    if (unscripted.length) return { stage: 'script', specs: await specs('script', unscripted.map((e) => e.id)) };
    const board = shots.filter((x) => !x.image);
    if (board.length) return { stage: 'board', specs: await specs('shot_image', board.map((x) => x.id)) };
    const voice = shots.filter((x) => String(x.dialogue || '').trim() && !x.audio);
    if (voice.length) return { stage: 'voice', specs: await specs('shot_tts', voice.map((x) => x.id)) };
    if (ap.includeVideo) {
      const video = shots.filter((x) => !x.video);
      if (video.length) return { stage: 'video', specs: await specs('shot_video', video.map((x) => x.id)) };
    }
    const compose = eps.find((e) => withShots.has(e.id) && (!e.video || e.status !== 'composed'));
    if (compose) return { stage: 'compose', episode: compose };
    return { stage: 'done' };
  }
  const choiceFor = (ap, capability) => ap.choices?.[capability] || { requested: 'auto', tier: 'standard' };
  async function estimateSpecs(p, ap, specs) {
    let lama = 0;
    for (const spec of specs) {
      const c = choiceFor(ap, spec.capability);
      const e = await engine.estimate({ capability: spec.capability, requested: spec.requestedOverride || c.requested, tier: c.tier, tags: spec.tags, seconds: spec.input.seconds, needImage: !!spec.input.image, input: spec.input, excludeCn: !!Number(p.exclude_cn) });
      lama += e.lama;
    }
    return lama;
  }
  // 시작 전 예상: 지금 비어 있는 곳을 기준으로 단계별 라마를 대략 계산합니다(대본이 없는 회차는 컷 수를 추정).
  async function autopilotEstimate(p, ap) {
    const cast = await charactersOf(p.id);
    const eps = await episodesOf(p.id);
    const shots = await db.all('SELECT s.* FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=?', [p.id]);
    const withShots = new Set(shots.map((x) => x.episode_id));
    const guessShots = Math.max(1, Math.ceil(Number(p.episode_seconds) / 5.5));
    const unscripted = eps.filter((e) => !withShots.has(e.id)).length;
    // 아직 없는 컷·인물은 실제 작업처럼 태그·참조 이미지 조건이 붙을 수 있어, 가능한 조합 중 가장 비싼 값으로 넉넉히 잡습니다.
    const variants = { image: [{}, { tags: ['character', 'consistency'] }, { needImage: true }, { tags: ['character', 'consistency'], needImage: true }], video: [{}, { needImage: true }] };
    const price = async (capability, units) => {
      const c = choiceFor(ap, capability);
      let best = null;
      for (const v of variants[capability] || [{}]) {
        try {
          const e = await engine.estimate({ capability, requested: c.requested, tier: c.tier, units, excludeCn: !!Number(p.exclude_cn), ...v });
          best = Math.max(best ?? 0, e.lama);
        } catch {
          // 이 조건을 받는 모델이 없으면 건너뜁니다.
        }
      }
      return best;
    };
    // 이미 있는 인물·컷은 실제 작업 조건으로 정확히 계산합니다.
    const req = ownerReq(p);
    const fallback = { character_image: ['image', 1], shot_image: ['image', 1], shot_tts: ['tts', 0.03] };
    const exact = async (action, ids) => {
      if (!ids.length) return 0;
      try {
        return await estimateSpecs(p, ap, await Promise.all(ids.map((id) => buildJob(req, p, action, id))));
      } catch {
        return per(fallback[action][0], fallback[action][1], ids.length);
      }
    };
    const add = (a, b) => (a === null || b === null ? null : a + b);
    const castCount = cast.length ? cast.filter((c) => !c.image).length : 4;
    const boardCount = shots.filter((x) => !x.image).length + unscripted * guessShots;
    const voiceCount = shots.filter((x) => String(x.dialogue || '').trim() && !x.audio).length + Math.ceil(unscripted * guessShots * 0.7);
    const videoSeconds = shots.filter((x) => !x.video).reduce((n, x) => n + Number(x.seconds || 5), 0) + unscripted * Number(p.episode_seconds);
    const per = async (capability, units, count) => {
      if (!count) return 0;
      const one = await price(capability, units);
      return one === null ? null : one * count;
    };
    const stages = [
      { stage: 'plan', label: AP_STAGES.plan, count: cast.length ? 0 : 1, lama: cast.length ? 0 : await per('text', 4.5, 1) },
      {
        stage: 'cast',
        label: AP_STAGES.cast,
        count: castCount,
        lama: cast.length ? await exact('character_image', cast.filter((c) => !c.image).map((c) => c.id)) : await per('image', 1, castCount),
      },
      { stage: 'script', label: AP_STAGES.script, count: unscripted, lama: await per('text', 4.5, unscripted) },
      {
        stage: 'board',
        label: AP_STAGES.board,
        count: boardCount,
        lama: add(await exact('shot_image', shots.filter((x) => !x.image).map((x) => x.id)), await per('image', 1, unscripted * guessShots)),
      },
      {
        stage: 'voice',
        label: AP_STAGES.voice,
        count: voiceCount,
        lama: add(
          await exact('shot_tts', shots.filter((x) => String(x.dialogue || '').trim() && !x.audio).map((x) => x.id)),
          await per('tts', 0.03, Math.ceil(unscripted * guessShots * 0.7)),
        ),
      },
      ...(ap.includeVideo
        ? [{ stage: 'video', label: AP_STAGES.video + ` (${videoSeconds}초)`, count: videoSeconds, lama: videoSeconds ? await price('video', videoSeconds) : 0 }]
        : []),
      { stage: 'compose', label: AP_STAGES.compose + ' (무료)', count: eps.length, lama: 0 },
    ];
    const unavailable = stages.filter((x) => x.lama === null).map((x) => x.label);
    return { stages, total: stages.reduce((n, x) => n + (x.lama || 0), 0), unavailable };
  }
  async function saveAutopilot(id, ap) {
    await db.run('UPDATE studio_projects SET autopilot=?,updated_at=? WHERE id=?', [JSON.stringify(ap), now(), id]);
  }
  const advancing = new Set();
  async function advanceAutopilot(projectId) {
    if (advancing.has(projectId)) return;
    advancing.add(projectId);
    try {
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [projectId]);
      const ap = parseAutopilot(p?.autopilot);
      if (!p || !ap || ap.status !== 'running') return;
      const active = await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1", [p.id]);
      if (active) return;
      if (await db.get("SELECT id FROM studio_episodes WHERE project_id=? AND status='composing' LIMIT 1", [p.id])) return;
      const pause = async (message) => saveAutopilot(p.id, { ...ap, status: 'paused', message, updated_at: now() });
      let work;
      try {
        work = await stageWork(p, ap);
      } catch (e) {
        return pause(e.message);
      }
      if (work.stage === 'done') return saveAutopilot(p.id, { ...ap, status: 'done', stage: 'done', message: '초안이 모두 완성됐어요. 확인한 뒤 내보내기에서 검수를 신청하세요.', updated_at: now() });
      // 같은 단계가 두 번 연속 비어 있으면(작업 실패) 멈춥니다.
      const signature = work.stage + ':' + (work.episode ? work.episode.id : work.specs.map((x) => x.target.id).sort().join(','));
      const repeat = signature === ap.signature ? Number(ap.repeat || 0) + 1 : 0;
      if (repeat >= 2) return pause(`${AP_STAGES[work.stage]} 단계가 완료되지 않았어요. 실패한 작업을 확인한 뒤 다시 시작해 주세요.`);
      if (work.stage === 'compose') {
        try {
          await startCompose(p, work.episode);
        } catch (e) {
          return pause(e.message);
        }
        return saveAutopilot(p.id, { ...ap, stage: 'compose', signature, repeat, message: `${work.episode.number}화 합성 중`, updated_at: now() });
      }
      const spent = Number(
        (await db.get("SELECT COALESCE(SUM(charged_lama),0) AS n FROM ai_jobs WHERE project_id=? AND status='succeeded' AND created_at>=?", [p.id, ap.started_at]))?.n || 0,
      );
      let need;
      try {
        need = await estimateSpecs(p, ap, work.specs);
      } catch (e) {
        return pause(e.message);
      }
      if (ap.cap && spent + need > ap.cap)
        return pause(`설정한 최대 ${ap.cap.toLocaleString('ko-KR')}라마를 넘어서 멈췄어요. (지금까지 ${spent.toLocaleString('ko-KR')}라마, 다음 단계 예상 ${need.toLocaleString('ko-KR')}라마)`);
      try {
        for (const spec of work.specs) await engine.screen({ userId: p.owner_id, kind: spec.kind, texts: [spec.input.userText, spec.input.text] });
        await db.transaction(async () => {
          for (const spec of work.specs) {
            const c = choiceFor(ap, spec.capability);
            await engine.enqueue({
              userId: p.owner_id,
              kind: spec.kind,
              capability: spec.capability,
              requested: spec.requestedOverride || c.requested,
              tier: c.tier,
              tags: spec.tags || [],
              input: spec.input,
              target: spec.target,
              projectId: p.id,
              excludeCn: !!Number(p.exclude_cn),
            });
          }
          await db.run("UPDATE studio_projects SET status=CASE WHEN status='draft' THEN 'producing' ELSE status END WHERE id=?", [p.id]);
        });
      } catch (e) {
        return pause(e.message);
      }
      await saveAutopilot(p.id, { ...ap, stage: work.stage, signature, repeat, message: `${AP_STAGES[work.stage]} ${work.specs.length}건 진행 중`, spent, updated_at: now() });
    } catch (e) {
      console.error('autopilot', e.message);
    } finally {
      advancing.delete(projectId);
    }
  }
  const autopilotTimer = setInterval(async () => {
    try {
      const rows = await db.all("SELECT id FROM studio_projects WHERE autopilot LIKE '%\"status\":\"running\"%'");
      for (const r of rows) await advanceAutopilot(r.id);
    } catch {}
  }, 2000);
  autopilotTimer.unref();
  app.post('/api/studio/ai/projects/:id/autopilot/estimate', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const ap = autopilotSchema.parse(req.body);
    res.json({ ...(await autopilotEstimate(p, ap)), wallet: await lamaWalletOf(db, req.user.id) });
  });
  app.post('/api/studio/ai/projects/:id/autopilot', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req);
    const b = autopilotSchema.parse(req.body);
    const current = parseAutopilot(p.autopilot);
    if (current?.status === 'running') fail(409, '자동 제작이 이미 진행 중이에요.');
    const est = await autopilotEstimate(p, b);
    const cap = b.cap ?? Math.ceil(est.total * 1.3) + 10;
    const wallet = await lamaWalletOf(db, req.user.id);
    if (wallet.total < Math.min(cap, est.total))
      fail(400, `라마가 부족해요. 예상 ${est.total.toLocaleString('ko-KR')}라마가 필요하고 사용 가능한 라마는 ${wallet.total.toLocaleString('ko-KR')}라마예요.`);
    const ap = { ...b, cap, status: 'running', stage: '', repeat: 0, started_at: now(), estimate: est.total, message: '자동 제작을 시작했어요.', updated_at: now() };
    await saveAutopilot(p.id, ap);
    void advanceAutopilot(p.id);
    res.status(201).json({ autopilot: ap });
  });
  app.post('/api/studio/ai/projects/:id/autopilot/stop', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const ap = parseAutopilot(p.autopilot);
    if (!ap || ap.status !== 'running') fail(409, '진행 중인 자동 제작이 없어요.');
    // 이미 시작된 AI 작업은 끝까지 처리하고, 대기 중인 작업은 취소해 라마를 돌려줍니다.
    const queued = await db.all("SELECT id FROM ai_jobs WHERE project_id=? AND status='queued'", [p.id]);
    for (const j of queued) await engine.cancel(j.id, req.user).catch(() => {});
    await saveAutopilot(p.id, { ...ap, status: 'stopped', message: `멈췄어요. 대기 중이던 작업 ${queued.length}건은 취소하고 라마를 돌려드렸어요.`, updated_at: now() });
    res.json({ ok: true, canceled: queued.length });
  });
  // PD 스튜디오 상단 표시용: 진행 중인 AI 작업·자동 제작 요약
  app.get('/api/studio/ai/activity', roles('pd', 'admin'), async (req, res) => {
    const active = await db.all(
      "SELECT j.kind, j.status, p.title FROM ai_jobs j LEFT JOIN studio_projects p ON p.id=j.project_id WHERE j.user_id=? AND j.status IN ('queued','running')",
      [req.user.id],
    );
    const failed = await db.get("SELECT COUNT(*) AS n FROM ai_jobs WHERE user_id=? AND status='failed' AND finished_at>=?", [req.user.id, new Date(Date.now() - 3600000).toISOString()]);
    const autopilots = (await db.all("SELECT id,title,autopilot FROM studio_projects WHERE owner_id=? AND autopilot<>''", [req.user.id]))
      .map((r) => ({ id: r.id, title: r.title, ...(parseAutopilot(r.autopilot) || {}) }))
      .filter((r) => ['running', 'paused'].includes(r.status));
    res.json({ active: active.length, running: active.filter((j) => j.status === 'running').length, failedLastHour: Number(failed?.n || 0), autopilots, wallet: await lamaWalletOf(db, req.user.id) });
  });

  // 검수용 제작 이력: 스튜디오에서 만든 회차가 어떤 모델로 몇 번 생성됐는지
  app.get('/api/studio/dramas/:id/provenance', roles('pd', 'admin'), async (req, res) => {
    const d = await db.get('SELECT id,owner_id FROM dramas WHERE id=?', [req.params.id]);
    if (!d || (d.owner_id !== req.user.id && req.user.role !== 'admin')) fail(404, '작품을 찾을 수 없습니다.');
    const projects = await db.all('SELECT id,title,created_at FROM studio_projects WHERE drama_id=?', [d.id]);
    const rows = projects.length
      ? await db.all(
          `SELECT j.kind, j.capability, m.label AS model_label, p.name AS provider_name, p.country, COUNT(*) AS jobs, COALESCE(SUM(j.charged_lama),0) AS lama
           FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref LEFT JOIN ai_providers p ON p.id=j.provider_id
           WHERE j.status='succeeded' AND j.project_id IN (${projects.map(() => '?').join(',')})
           GROUP BY j.kind, j.capability, m.label, p.name, p.country ORDER BY jobs DESC`,
          projects.map((x) => x.id),
        )
      : [];
    res.json({ projects, models: rows });
  });

  // ── 업로드 영상용 AI 도구 ─────────────────────────────────────
  app.post('/api/studio/ai/tools/subtitles', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const b = z.object({ dramaId: z.string().min(1).max(80), number: z.number().int().min(1), requested: z.string().max(80).default('auto') }).parse(req.body);
    const d = await db.get('SELECT * FROM dramas WHERE id=?', [b.dramaId]);
    if (!d || (d.owner_id !== req.user.id && req.user.role !== 'admin')) fail(404, '작품을 찾을 수 없습니다.');
    if (!['draft', 'rejected'].includes(d.status)) fail(409, '임시저장 또는 반려 상태에서 자막을 만들 수 있어요.');
    const e = await db.get('SELECT * FROM episodes WHERE drama_id=? AND number=?', [d.id, b.number]);
    if (!e?.video) fail(404, '회차 영상을 찾을 수 없어요.');
    const src = e.video.startsWith('/demo/') ? path.resolve('public/demo/preview.mp4') : path.join(uploadDir, path.basename(e.video));
    const meta = await db.get('SELECT duration,has_audio FROM media_metadata WHERE url=?', [e.video]);
    const probed = await probeMedia(src);
    if (!probed.hasAudio || (meta && Number(meta.has_audio) === 0)) fail(400, '소리가 없는 영상이라 자막을 만들 수 없어요.');
    const audio = randomUUID() + '.mp3';
    await runFfmpeg(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', path.join(uploadDir, audio)], 240000);
    await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', ['/uploads/' + audio, req.user.id, 'audio/mpeg', now()]);
    const duration = Math.max(1, Math.round(probed.duration || Number(meta?.duration || e.duration || 60)));
    const job = await db.transaction(() =>
      engine.enqueue({
        userId: req.user.id,
        kind: 'tool_subtitles',
        capability: 'stt',
        requested: b.requested,
        tier: 'standard',
        input: { audio: { path: '/uploads/' + audio, mime: 'audio/mpeg' }, duration },
        target: { type: 'drama_episode', id: `${d.id}#${b.number}` },
      }),
    );
    res.status(201).json({ id: job.id, lama: Number(job.estimate_lama) });
  });
  app.post('/api/studio/ai/tools/poster', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const b = z.object({ dramaId: z.string().min(1).max(80), prompt: z.string().trim().max(300).default(''), requested: z.string().max(80).default('auto'), tier: z.enum(['draft', 'standard', 'premium']).default('standard') }).parse(req.body);
    const d = await db.get('SELECT * FROM dramas WHERE id=?', [b.dramaId]);
    if (!d || (d.owner_id !== req.user.id && req.user.role !== 'admin')) fail(404, '작품을 찾을 수 없습니다.');
    await engine.screen({ userId: req.user.id, kind: 'tool_poster', texts: [b.prompt] });
    const job = await db.transaction(() =>
      engine.enqueue({
        userId: req.user.id,
        kind: 'tool_poster',
        capability: 'image',
        requested: b.requested,
        tier: b.tier,
        tags: ['poster'],
        input: {
          prompt: `Korean short drama poster, vertical 9:16, key art for "${d.title}" (${d.genre}). ${d.tagline}. ${b.prompt}. Cinematic lighting, empty space at top for the title, no text.`,
          aspect: '9:16',
          userText: b.prompt,
        },
        target: { type: 'drama', id: d.id },
      }),
    );
    res.status(201).json({ id: job.id, lama: Number(job.estimate_lama) });
  });
  app.get('/api/studio/ai/tools/jobs/:jid', roles('pd', 'admin'), async (req, res) => {
    const j = await db.get('SELECT id,user_id,kind,status,error,output,charged_lama,estimate_lama FROM ai_jobs WHERE id=?', [req.params.jid]);
    if (!j || (j.user_id !== req.user.id && req.user.role !== 'admin')) fail(404, '작업을 찾을 수 없어요.');
    res.json({ ...j, output: JSON.parse(j.output || '{}') });
  });

  // 스튜디오 결과물(영상·음성·이미지) 미리보기: 본인과 관리자만 받습니다.
  app.get('/api/studio/media/:file', roles('pd', 'admin'), async (req, res) => {
    if (!/^[a-f0-9-]+\.(mp4|mp3|wav|jpg|png|webp)$/.test(req.params.file)) fail(404, '파일을 찾을 수 없어요.');
    const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', ['/uploads/' + req.params.file]);
    if (!f || (f.owner_id !== req.user.id && req.user.role !== 'admin')) fail(404, '파일을 찾을 수 없어요.');
    res.sendFile(path.join(uploadDir, req.params.file));
  });
  // 스튜디오 합성 자막(VTT) 미리보기
  app.get('/api/studio/ai/episodes/:eid/subtitles', roles('pd', 'admin'), async (req, res) => {
    const e = await db.get('SELECT e.subtitles, p.owner_id FROM studio_episodes e JOIN studio_projects p ON p.id=e.project_id WHERE e.id=?', [req.params.eid]);
    if (!e || (e.owner_id !== req.user.id && req.user.role !== 'admin') || !/^[a-f0-9-]+\.vtt$/.test(e.subtitles || '')) fail(404, '자막이 없어요.');
    res.type('text/vtt; charset=utf-8').sendFile(path.join(subsDir, e.subtitles));
  });
  return { precheck };
}
