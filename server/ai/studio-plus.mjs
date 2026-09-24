import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { probeMedia } from '../media.mjs';
import { bibleSchema } from './prompts.mjs';

// 숏핑 스튜디오 고도화 API(2026-09-23): 작품 설정집, 장소, 대본 버전, 목소리 라이브러리, 배경음악 올리기,
// 예고편, 알림. routes-studio-ai.mjs의 공통 도우미(project, queueTranslate 등)를 받아 씁니다.

// 목소리 라이브러리: 공급사별 대표 목소리(성별·나이대·느낌). 목록에 없어도 공급사 목소리 ID를 직접 넣을 수 있어요.
export const VOICE_LIBRARY = {
  openai: [
    ['nova', '여', '20~30대', '밝고 또렷함'],
    ['shimmer', '여', '20~30대', '부드럽고 차분함'],
    ['coral', '여', '20대', '따뜻하고 친근함'],
    ['sage', '여', '30~40대', '차분하고 지적임'],
    ['alloy', '중성', '20~30대', '담백함'],
    ['fable', '중성', '20대', '이야기꾼 같은'],
    ['echo', '남', '20~30대', '부드러운 저음'],
    ['ash', '남', '20~30대', '또렷하고 힘 있음'],
    ['ballad', '남', '30대', '감성적'],
    ['verse', '남', '30대', '생동감'],
    ['onyx', '남', '40대 이상', '깊고 낮음'],
  ],
  gemini: [
    ['Kore', '여', '20~30대', '단단하고 또렷함'],
    ['Aoede', '여', '20대', '산뜻함'],
    ['Leda', '여', '10~20대', '어리고 맑음'],
    ['Zephyr', '여', '20대', '밝음'],
    ['Despina', '여', '20~30대', '부드러움'],
    ['Sulafat', '여', '30대', '따뜻함'],
    ['Gacrux', '여', '40대 이상', '성숙함'],
    ['Puck', '남', '20대', '경쾌함'],
    ['Charon', '남', '30~40대', '차분한 해설'],
    ['Fenrir', '남', '20~30대', '열정적'],
    ['Orus', '남', '30대', '단단함'],
    ['Algieba', '남', '30대', '부드러움'],
    ['Iapetus', '남', '40대 이상', '명료함'],
  ],
  elevenlabs: [
    ['21m00Tcm4TlvDq8ikWAM', '여', '20~30대', '차분한 내레이션(Rachel)'],
    ['EXAVITQu4vr4xnSDxMaL', '여', '20대', '부드러움(Sarah)'],
    ['XB0fDUnXU5powFXDhCwa', '여', '30대', '또렷함(Charlotte)'],
    ['Xb7hH8MSUJpSbSDYk0k2', '여', '30~40대', '자신감(Alice)'],
    ['TX3LPaxmHKxFdv7VOQHJ', '남', '20대', '젊고 또렷함(Liam)'],
    ['pNInz6obpgDQGcFmaJgB', '남', '30대', '깊은 목소리(Adam)'],
    ['onwK4e9ZLuTAKqWW03F9', '남', '40대 이상', '뉴스 앵커(Daniel)'],
    ['JBFqnCBsd6RMkjVDRZzb', '남', '40대 이상', '따뜻한 이야기꾼(George)'],
  ],
  minimax: [
    ['Korean_SweetGirl', '여', '20대', '사랑스러움'],
    ['Korean_CalmLady', '여', '30대', '차분함'],
    ['Korean_ElegantPrincess', '여', '20대', '우아함'],
    ['Korean_CheerfulBoyfriend', '남', '20대', '명랑함'],
    ['Korean_IntellectualSenior', '남', '40대 이상', '지적임'],
    ['Korean_ReliableYouth', '남', '20대', '믿음직함'],
  ],
  mock: [
    ['mock-female', '여', '20대', '개발용 목소리 A'],
    ['mock-male', '남', '30대', '개발용 목소리 B'],
    ['mock-narrator', '중성', '40대 이상', '개발용 내레이터'],
  ],
};
const PREVIEW_TEXT = '안녕하세요. 오늘 밤, 모든 비밀이 밝혀질 거예요. 끝까지 함께해 주세요.';

export function studioPlusRoutes({ app, db, fail, now, roles, engine, renderer, uploadDir, project, touch, queueTranslate, shotsOf, charactersOf, episodesOf }) {
  // ── 작품 설정집 ─────────────────────────────────────────────
  app.put('/api/studio/ai/projects/:id/bible', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = bibleSchema.parse(req.body);
    await db.run('UPDATE studio_projects SET bible=?,updated_at=? WHERE id=?', [JSON.stringify(b), now(), p.id]);
    res.json({ ok: true });
  });
  // ── 프로젝트 부가 설정(원작, 자막 모양, 내레이터, 배경음악, 화질, 유료 시작 회차) ──────────
  const settingsSchema = z.object({
    source_text: z.string().max(30000).optional(),
    subtitle_style: z
      .object({ position: z.enum(['bottom', 'middle', 'top']), size: z.enum(['s', 'm', 'l', 'xl']), background: z.enum(['none', 'box', 'shadow']), names: z.boolean() })
      .partial()
      .optional(),
    narrator_model: z.string().max(80).optional(),
    narrator_voice: z.string().trim().max(80).optional(),
    bgm: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(mp3|wav))$/).optional(),
    bgm_volume: z.number().min(0).max(1).optional(),
    resolution: z.enum(['720p', '1080p']).optional(),
    paywall_from: z.number().int().min(1).max(60).optional(),
    budget_lama: z.number().int().min(0).max(100000000).optional(), // 프로젝트 예산(0 = 제한 없음)
  });
  app.patch('/api/studio/ai/projects/:id/settings', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = settingsSchema.parse(req.body);
    if (b.bgm) {
      const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [b.bgm]);
      if (!f || f.owner_id !== p.owner_id) fail(403, '이 프로젝트에서 만들거나 올린 음악만 쓸 수 있어요.');
    }
    const parse = (raw) => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    };
    const sets = [];
    const vals = [];
    const put = (col, v) => {
      sets.push(`${col}=?`);
      vals.push(v);
    };
    if (b.source_text !== undefined) put('source_text', b.source_text);
    if (b.subtitle_style) put('subtitle_style', JSON.stringify({ ...parse(p.subtitle_style), ...b.subtitle_style }));
    if (b.narrator_model !== undefined) put('narrator_model', b.narrator_model || 'auto');
    if (b.narrator_voice !== undefined) put('narrator_voice', b.narrator_voice);
    if (b.bgm !== undefined) put('bgm', b.bgm);
    if (b.bgm_volume !== undefined) put('bgm_volume', b.bgm_volume);
    if (b.resolution) put('resolution', b.resolution);
    if (b.budget_lama !== undefined) put('budget_lama', b.budget_lama);
    if (b.paywall_from) put('season', JSON.stringify({ ...parse(p.season), paywall_from: b.paywall_from }));
    if (!sets.length) return res.json({ ok: true });
    put('updated_at', now());
    await db.run(`UPDATE studio_projects SET ${sets.join(',')} WHERE id=?`, [...vals, p.id]);
    // 완성본 모양(배경음악·화질·자막 위치)이 바뀌면 합성한 회차를 다시 합성해야 합니다.
    if (b.bgm !== undefined || b.bgm_volume !== undefined || b.resolution || b.subtitle_style)
      await db.run("UPDATE studio_episodes SET status='scripted' WHERE project_id=? AND status='composed'", [p.id]);
    res.json({ ok: true });
  });

  // ── 장소(로케이션): 장면 배경을 고정해 컷마다 같은 장소로 보이게 합니다 ─────────
  const locationSchema = z.object({ name: z.string().trim().min(1).max(40), look: z.string().trim().max(500).default('') });
  app.post('/api/studio/ai/projects/:id/locations', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = locationSchema.parse(req.body);
    const count = Number((await db.get('SELECT COUNT(*) AS n FROM studio_locations WHERE project_id=?', [p.id]))?.n || 0);
    if (count >= 12) fail(400, '장소는 12곳까지 만들 수 있어요.');
    const id = randomUUID();
    await db.run('INSERT INTO studio_locations (id,project_id,name,look,sort_order) VALUES (?,?,?,?,?)', [id, p.id, b.name, b.look, count]);
    await touch(p.id);
    await queueTranslate(p.id, p.owner_id, [{ id: 'location:' + id, ko: b.look }]);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/projects/:id/locations/:lid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = locationSchema.parse(req.body);
    const l = await db.get('SELECT * FROM studio_locations WHERE id=? AND project_id=?', [req.params.lid, p.id]);
    if (!l) fail(404, '장소를 찾을 수 없어요.');
    await db.run('UPDATE studio_locations SET name=?,look=? WHERE id=?', [b.name, b.look, l.id]);
    if (b.look !== l.look && b.look !== l.look_en_src) await queueTranslate(p.id, p.owner_id, [{ id: 'location:' + l.id, ko: b.look }]);
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id/locations/:lid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const l = await db.get('SELECT id FROM studio_locations WHERE id=? AND project_id=?', [req.params.lid, p.id]);
    if (!l) fail(404, '장소를 찾을 수 없어요.');
    await db.run('UPDATE studio_shots SET location_id=NULL WHERE location_id=?', [l.id]);
    await db.run('DELETE FROM studio_locations WHERE id=?', [l.id]);
    res.json({ ok: true });
  });

  // ── 대본 버전: 목록 · 보기 · 되돌리기 ───────────────────────────
  const episodeOf = async (p, eid) => {
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    return e;
  };
  app.get('/api/studio/ai/projects/:id/episodes/:eid/versions', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const e = await episodeOf(p, req.params.eid);
    const rows = await db.all('SELECT id,version,source,note,created_at,shots FROM studio_script_versions WHERE episode_id=? ORDER BY version DESC', [e.id]);
    res.json(rows.map((r) => ({ id: r.id, version: r.version, source: r.source, note: r.note, created_at: r.created_at, shots: JSON.parse(r.shots) })));
  });
  app.post('/api/studio/ai/projects/:id/episodes/:eid/versions/:vid/restore', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const e = await episodeOf(p, req.params.eid);
    const v = await db.get('SELECT * FROM studio_script_versions WHERE id=? AND episode_id=?', [req.params.vid, e.id]);
    if (!v) fail(404, '버전을 찾을 수 없어요.');
    if (await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') AND (target_id=? OR target_id IN (SELECT id FROM studio_shots WHERE episode_id=?)) LIMIT 1", [p.id, e.id, e.id]))
      fail(409, '이 회차의 AI 작업이 끝난 뒤 되돌려 주세요.');
    const cast = new Set((await charactersOf(p.id)).map((c) => c.id));
    const places = new Set((await db.all('SELECT id FROM studio_locations WHERE project_id=?', [p.id])).map((l) => l.id));
    const shots = JSON.parse(v.shots);
    await db.transaction(async () => {
      // 지금 상태도 버전으로 남긴 뒤 되돌립니다.
      const current = await shotsOf(e.id);
      if (current.length) {
        const version = Number(e.script_version || 0) + 1;
        await db.run('INSERT INTO studio_script_versions (id,project_id,episode_id,version,shots,source,note,created_at) VALUES (?,?,?,?,?,?,?,?)', [
          randomUUID(), p.id, e.id, version, JSON.stringify(current.map(({ id: _id, episode_id: _e, sort_order: _s, ...rest }) => rest)), 'before_restore', `v${v.version}로 되돌리기 전`, now(),
        ]);
        await db.run('UPDATE studio_episodes SET script_version=? WHERE id=?', [version, e.id]);
      }
      await db.run('DELETE FROM studio_shots WHERE episode_id=?', [e.id]);
      let i = 0;
      for (const s of shots) {
        const speaker = s.speaker_id && cast.has(s.speaker_id) ? s.speaker_id : null;
        const castIds = String(s.cast_ids || '').split(',').filter((x) => cast.has(x)).join(',');
        await db.run(
          `INSERT INTO studio_shots (id,episode_id,sort_order,scene,visual,visual_en,visual_en_src,dialogue,speaker_id,cast_ids,location_id,camera,camera_move,emotion,speed,narration,seconds,image,audio,audio_seconds,video,lipsync,sfx,sfx_prompt,sfx_volume,transition,caption)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            randomUUID(), e.id, i++, s.scene || '', s.visual || '', s.visual_en || '', s.visual_en_src || '', s.dialogue || '', speaker, castIds,
            s.location_id && places.has(s.location_id) ? s.location_id : null, s.camera || '', s.camera_move || '', s.emotion || '', Number(s.speed) || 1, Number(s.narration) ? 1 : 0,
            Math.round(Math.min(10, Math.max(2, Number(s.seconds) || 5))), s.image || '', s.audio || '', Number(s.audio_seconds) || 0, s.video || '', s.lipsync || '', s.sfx || '', s.sfx_prompt || '',
            s.sfx_volume ?? 0.6, s.transition || 'cut', s.caption ?? null,
          ],
        );
      }
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='outline' THEN 'scripted' WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [e.id]);
    });
    await touch(p.id);
    res.json({ ok: true, shots: shots.length });
  });

  // ── 목소리 라이브러리 · 미리듣기(한 번 만든 샘플은 모든 PD가 같이 씀, 플랫폼 부담) ─────
  const voicePreviews = new Map();
  engine.registerHandler('voice_preview', {
    async onSuccess({ job, result }) {
      const input = JSON.parse(job.input || '{}');
      await db.run(
        'INSERT INTO voice_samples (model_ref,voice,url,created_at) VALUES (?,?,?,?) ON CONFLICT(model_ref,voice) DO UPDATE SET url=excluded.url,created_at=excluded.created_at',
        [input.modelRef, input.voice || '', result.url, now()],
      );
      return { url: result.url };
    },
  });
  app.get('/api/studio/ai/voices', roles('pd', 'admin'), async (req, res) => {
    const models = await engine.listForPicker('tts', await (await import('../settings.mjs')).loadSettings(db));
    const kinds = await db.all('SELECT m.id, p.kind FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id');
    const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
    const samples = await db.all('SELECT model_ref,voice,url FROM voice_samples');
    res.json(
      models.map((m) => ({
        model: m.id,
        label: m.label,
        provider: m.provider,
        voices: (VOICE_LIBRARY[kindOf.get(m.id)] || []).map(([id, gender, age, tone]) => ({
          id,
          gender,
          age,
          tone,
          sample: samples.find((s) => s.model_ref === m.id && s.voice === id)?.url || '',
        })),
      })),
    );
  });
  app.post('/api/studio/ai/voices/preview', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ model: z.string().min(1).max(80), voice: z.string().trim().max(80) }).parse(req.body);
    const cached = await db.get('SELECT url FROM voice_samples WHERE model_ref=? AND voice=?', [b.model, b.voice]);
    if (cached) return res.json({ url: cached.url, ready: true });
    const key = `${b.model}|${b.voice}`;
    const pending = voicePreviews.get(key);
    if (pending) {
      const j = await db.get('SELECT status,error FROM ai_jobs WHERE id=?', [pending]);
      if (j && ['queued', 'running'].includes(j.status)) return res.json({ ready: false });
      voicePreviews.delete(key);
      if (j?.status === 'failed') fail(502, '미리듣기를 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
    const model = (await db.get('SELECT id FROM ai_models WHERE id=? AND capability=?', [b.model, 'tts']))?.id;
    if (!model) fail(404, '목소리 모델을 찾을 수 없어요.');
    const job = await db.transaction(() =>
      engine.enqueue({
        userId: req.user.id,
        kind: 'voice_preview',
        capability: 'tts',
        requested: model,
        tier: 'standard',
        input: { text: PREVIEW_TEXT, voice: b.voice, modelRef: model, userText: '' },
        target: { type: 'voice', id: key },
        bill: false,
      }),
    );
    voicePreviews.set(key, job.id);
    res.status(202).json({ ready: false });
  });

  // ── 배경음악 올리기(PD가 가진 음원) ─────────────────────────────
  const musicDir = uploadDir;
  mkdirSync(musicDir, { recursive: true });
  const musicUpload = multer({
    storage: multer.diskStorage({
      destination: musicDir,
      filename: (req, file, cb) => cb(null, randomUUID() + (file.mimetype === 'audio/wav' || file.mimetype === 'audio/x-wav' ? '.wav' : '.mp3')),
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'].includes(file.mimetype)),
  });
  app.post('/api/studio/ai/projects/:id/music', roles('pd', 'admin'), musicUpload.single('file'), async (req, res) => {
    const f = req.file;
    let p;
    try {
      p = await project(req);
      if (!f) fail(400, 'MP3 또는 WAV 파일만 올릴 수 있어요(25MB 이하).');
      const meta = await probeMedia(f.path).catch(() => null);
      if (!meta || !meta.hasAudio || meta.hasVideo || meta.duration < 3 || meta.duration > 900) fail(400, '3초~15분 길이의 음악 파일만 올릴 수 있어요.');
      const url = '/uploads/' + f.filename;
      await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [url, p.owner_id, /\.wav$/.test(url) ? 'audio/wav' : 'audio/mpeg', now()]);
      await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,0,0,1)', [url, Math.ceil(meta.duration)]);
      await db.run(
        'INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [randomUUID(), p.owner_id, p.id, 'music', p.id, 'music', url, null, '직접 올린 음악', now()],
      );
      await db.run("UPDATE studio_projects SET bgm=CASE WHEN bgm='' THEN ? ELSE bgm END WHERE id=?", [url, p.id]);
      res.status(201).json({ url, duration: Math.round(meta.duration) });
    } catch (e) {
      if (f) {
        try {
          unlinkSync(f.path);
        } catch {}
      }
      throw e;
    }
  });

  // ── 예고편: 고른 컷(없으면 회차마다 첫·마지막 컷)을 짧게 이어 붙여 15~30초로 ────────
  app.post('/api/studio/ai/projects/:id/trailer', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = z
      .object({
        shotIds: z.array(z.string().max(80)).max(12).default([]),
        titleCard: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).default(''),
        endCard: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).default(''),
      })
      .parse(req.body);
    const shots = await db.all('SELECT s.id,s.episode_id,s.video,s.image,s.lipsync,s.dialogue FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=? ORDER BY e.number, s.sort_order', [p.id]);
    const usable = (s) => s.video || s.image || s.lipsync;
    let ids = b.shotIds.filter((id) => shots.some((s) => s.id === id && usable(s)));
    if (!ids.length) {
      // 자동 선택: 회차마다 대사가 있는 첫 컷과 마지막 컷(클리프행어), 최대 8컷
      const byEp = new Map();
      for (const s of shots.filter(usable)) byEp.set(s.episode_id, [...(byEp.get(s.episode_id) || []), s]);
      for (const list of byEp.values()) {
        const first = list.find((s) => s.dialogue) || list[0];
        const last = list[list.length - 1];
        ids.push(first.id);
        if (last.id !== first.id) ids.push(last.id);
      }
      ids = ids.slice(0, 8);
    }
    if (!ids.length) fail(400, '예고편에 넣을 컷이 없어요. 스토리보드 이미지나 영상을 먼저 만들어 주세요.');
    for (const url of [b.titleCard, b.endCard].filter(Boolean)) {
      const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [url]);
      if (!f || f.owner_id !== p.owner_id) fail(403, '이 프로젝트에서 만든 이미지만 쓸 수 있어요.');
    }
    try {
      await renderer.queueTrailer(p, { shotIds: ids, titleCard: b.titleCard, endCard: b.endCard });
    } catch (e) {
      fail(e.status || 500, e.message);
    }
    res.status(202).json({ ok: true, shots: ids.length });
  });

  // ── 알림 ───────────────────────────────────────────────────
  app.get('/api/notifications', roles('pd', 'admin', 'viewer'), async (req, res) => {
    const list = await db.all('SELECT id,kind,title,body,link,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    const unread = Number((await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', [req.user.id]))?.n || 0);
    res.json({ list, unread });
  });
  app.post('/api/notifications/read', roles('pd', 'admin', 'viewer'), async (req, res) => {
    const b = z.object({ ids: z.array(z.string().max(80)).max(100).optional() }).parse(req.body || {});
    if (b.ids?.length)
      await db.run(`UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND id IN (${b.ids.map(() => '?').join(',')})`, [now(), req.user.id, ...b.ids]);
    else await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [now(), req.user.id]);
    res.json({ ok: true });
  });

  return { VOICE_LIBRARY, episodesOf };
}
