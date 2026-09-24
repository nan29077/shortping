import { z } from 'zod';
import { episodeEditable } from '../routes-serial.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadSettings } from '../settings.mjs';
import { lamaWalletOf } from '../lama.mjs';
import { runFfmpeg, precheck, probeMedia } from '../media.mjs';
import { toVtt } from '../routes-upload.mjs';
import { composeEpisode } from './compose.mjs';
import {
  adaptPrompt,
  biblePrompt,
  bibleSchema,
  characterImagePrompt,
  characterRefPrompt,
  diagnosePrompt,
  diagnoseSchema,
  locationPrompt,
  metaPrompt,
  metaSchema,
  musicPrompt,
  parseJson,
  planPrompt,
  planSchema,
  posterPrompt,
  rangePrompt,
  rangeSchema,
  rewriteShotPrompt,
  scriptPrompt,
  seasonPrompt,
  seasonSchema,
  shotSchema as aiShotSchema,
  scriptSchema,
  shotImagePrompt,
  shotVideoPrompt,
  translatePrompt,
  translateSchema,
} from './prompts.mjs';
import { studioPlusRoutes } from './studio-plus.mjs';
import { notify } from '../notify.mjs';
import { familyList } from './model-guide.mjs';
import { assistantRoutes } from './assistant.mjs';
import { shotMediaRoutes } from './shot-media.mjs';
import { qualityRoutes } from './quality.mjs';

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
  bible: '작품 설정집',
  season: '회차별 훅·반전 설계',
  cast: '인물 이미지',
  script: '대본',
  board: '스토리보드',
  voice: '대사 음성',
  video: '컷 영상',
  lipsync: '입 모양 맞추기',
  sfx: '효과음',
  music: '배경음악',
  compose: '회차 합성',
};
const TERMS_VERSION = '2026-09';
// 참고·원본 이미지를 받는 모델을 우선하도록 알려 줍니다.
const needsImage = (input) => !!(input.image || input.editImage || input.refImage || input.refImages?.length);

export function studioAiRoutes({ app, db, fail, now, roles, engine, renderer, uploadDir, owned: _owned, contentIssues }) {
  const subsDir = path.join(uploadDir, 'subtitles');
  const project = async (req, id = req.params.id) => {
    const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [id]);
    if (!p || (p.owner_id !== req.user.id && req.user.role !== 'admin')) fail(404, '프로젝트를 찾을 수 없어요.');
    return p;
  };
  let chatApi = null; // AI 조수(assistant.mjs) — 아래에서 연결
  const touch = (id) => db.run('UPDATE studio_projects SET updated_at=? WHERE id=?', [now(), id]);
  const charactersOf = (pid) => db.all('SELECT * FROM studio_characters WHERE project_id=? ORDER BY sort_order, name', [pid]);
  const episodesOf = (pid) => db.all('SELECT * FROM studio_episodes WHERE project_id=? ORDER BY number', [pid]);
  const shotsOf = (eid) => db.all('SELECT * FROM studio_shots WHERE episode_id=? ORDER BY sort_order', [eid]);
  // 결과 버전 기록의 주인은 프로젝트 주인(PD)입니다. 관리자가 대신 실행해도 PD의 기록으로 남깁니다.
  const asset = async (job, projectId, target, kind, url, model) => {
    const owner = (await db.get('SELECT owner_id FROM studio_projects WHERE id=?', [projectId]))?.owner_id || job.user_id;
    return db.run(
      'INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [randomUUID(), owner, projectId, target.type, target.id, kind, url, job.id, model?.label || '', now()],
    );
  };
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
  const planHandler = {
    async onSuccess({ job, result }) {
      const plan = parseJson(result.text, planSchema);
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [job.project_id]);
      if (!p) return { skipped: true };
      await db.run('UPDATE studio_projects SET title=?,logline=?,synopsis=?,style=?,updated_at=? WHERE id=?', [
        plan.title, plan.logline, plan.synopsis, plan.style || p.style, now(), p.id,
      ]);
      // 인물: 같은 이름의 인물은 그대로 두고 정보만 바꿔 컷의 화자 연결을 지킵니다.
      // 새 기획에서 빠진 인물은 기준 이미지가 없을 때만 지우고, 그 인물이 말하던 컷은 화자 없음으로 정리합니다.
      const old = await charactersOf(p.id);
      const names = new Set(plan.characters.map((c) => c.name.trim()));
      for (const c of old)
        if (!c.image && !names.has(c.name.trim())) {
          await db.run('UPDATE studio_shots SET speaker_id=NULL WHERE speaker_id=? AND episode_id IN (SELECT id FROM studio_episodes WHERE project_id=?)', [c.id, p.id]);
          await db.run('DELETE FROM studio_characters WHERE id=?', [c.id]);
        }
      let order = old.length;
      for (const c of plan.characters) {
        const same = old.find((o) => o.name.trim() === c.name.trim());
        const lookEn = c.look_en || (/[가-힣]/.test(c.look) ? '' : c.look);
        if (same)
          await db.run('UPDATE studio_characters SET role=?,description=?,look=?,look_en=?,look_en_src=? WHERE id=?', [c.role, c.description, c.look, lookEn, lookEn ? c.look : '', same.id]);
        else
          await db.run('INSERT INTO studio_characters (id,project_id,name,role,description,look,look_en,look_en_src,sort_order) VALUES (?,?,?,?,?,?,?,?,?)', [
            randomUUID(), p.id, c.name, c.role, c.description, c.look, lookEn, lookEn ? c.look : '', order++,
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
  };
  engine.registerHandler('plan', planHandler);
  // 대본 컷 저장: 인물 이름→ID, 등장 인물 여러 명, 영어 묘사(번역 캐시), 카메라 움직임·감정·효과음까지 함께 넣습니다.
  async function insertShots(episodeId, projectId, list, startOrder = 0) {
    const cast = await charactersOf(projectId);
    const idOf = (name) => cast.find((c) => c.name === String(name || '').trim())?.id || null;
    let i = startOrder;
    for (const s of list) {
      const narration = String(s.speaker || '').trim() === '내레이션';
      const speakerId = narration ? null : idOf(s.speaker);
      const castIds = [...new Set([...(s.cast || []).map(idOf), speakerId].filter(Boolean))].join(',');
      const en = s.visual_en || (/[가-힣]/.test(s.visual) ? '' : s.visual);
      await db.run(
        'INSERT INTO studio_shots (id,episode_id,sort_order,scene,visual,visual_en,visual_en_src,dialogue,speaker_id,cast_ids,camera,camera_move,emotion,narration,sfx_prompt,seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [randomUUID(), episodeId, i++, s.scene, s.visual, en, en ? s.visual : '', s.dialogue, s.dialogue ? speakerId : null, castIds, s.camera, s.camera_move || '', s.emotion || '', narration && s.dialogue ? 1 : 0, s.sfx || '', Math.round(Math.min(10, Math.max(2, s.seconds)))],
      );
    }
    return i;
  }
  // 대본을 바꾸기 전 지금 컷을 버전으로 남겨, 다시 써도 되돌릴 수 있게 합니다.
  async function snapshotScript(episodeId, projectId, source, note = '') {
    const shots = await shotsOf(episodeId);
    if (!shots.length) return null;
    const e = await db.get('SELECT script_version FROM studio_episodes WHERE id=?', [episodeId]);
    const version = Number(e?.script_version || 0) + 1;
    const keep = shots.map((x) => ({
      scene: x.scene, visual: x.visual, visual_en: x.visual_en, visual_en_src: x.visual_en_src, dialogue: x.dialogue, speaker_id: x.speaker_id, cast_ids: x.cast_ids,
      location_id: x.location_id, camera: x.camera, camera_move: x.camera_move, emotion: x.emotion, speed: x.speed, narration: x.narration, seconds: x.seconds,
      image: x.image, audio: x.audio, audio_seconds: x.audio_seconds, video: x.video, lipsync: x.lipsync, sfx: x.sfx, sfx_prompt: x.sfx_prompt, sfx_volume: x.sfx_volume, transition: x.transition, caption: x.caption,
    }));
    await db.run('INSERT INTO studio_script_versions (id,project_id,episode_id,version,shots,source,note,created_at) VALUES (?,?,?,?,?,?,?,?)', [
      randomUUID(), projectId, episodeId, version, JSON.stringify(keep), source, note.slice(0, 200), now(),
    ]);
    await db.run('UPDATE studio_episodes SET script_version=? WHERE id=?', [version, episodeId]);
    // 오래된 버전은 회차당 30개까지만 남깁니다.
    await db.run('DELETE FROM studio_script_versions WHERE episode_id=? AND version<=?', [episodeId, version - 30]);
    return version;
  }
  engine.registerHandler('script', {
    async onSuccess({ job, result }) {
      const script = parseJson(result.text, scriptSchema);
      const e = await db.get('SELECT * FROM studio_episodes WHERE id=?', [job.target_id]);
      if (!e) return { skipped: true };
      const instruction = (() => {
        try {
          return JSON.parse(job.input || '{}').userInstruction || '';
        } catch {
          return '';
        }
      })();
      await snapshotScript(e.id, e.project_id, 'before_ai', instruction ? `AI 다시 쓰기 전 · ${instruction}` : 'AI 대본 쓰기 전');
      await db.run('DELETE FROM studio_shots WHERE episode_id=?', [e.id]);
      await insertShots(e.id, e.project_id, script.shots);
      await db.run("UPDATE studio_episodes SET status='scripted',video='',duration=0 WHERE id=?", [e.id]);
      await touch(e.project_id);
      return { shots: script.shots.length };
    },
  });
  // 연속된 컷 몇 개만 다시 쓰기
  engine.registerHandler('rewrite_range', {
    async onSuccess({ job, result }) {
      const next = parseJson(result.text, rangeSchema);
      const input = JSON.parse(job.input || '{}');
      const e = await db.get('SELECT * FROM studio_episodes WHERE id=?', [job.target_id]);
      if (!e) return { skipped: true };
      const shots = await shotsOf(e.id);
      const ids = new Set(input.shotIds || []);
      const first = shots.findIndex((x) => ids.has(x.id));
      if (first < 0) return { skipped: true };
      await snapshotScript(e.id, e.project_id, 'before_ai', `구간 다시 쓰기 전 · ${String(input.userInstruction || '').slice(0, 80)}`);
      for (const x of shots.filter((x) => ids.has(x.id))) await db.run('DELETE FROM studio_shots WHERE id=?', [x.id]);
      const after = shots.filter((x, i) => i > first && !ids.has(x.id));
      const end = await insertShots(e.id, e.project_id, next.shots, first);
      let k = end;
      for (const x of after) await db.run('UPDATE studio_shots SET sort_order=? WHERE id=?', [k++, x.id]);
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status IN ('composed','outline') THEN 'scripted' ELSE status END WHERE id=?", [e.id]);
      await touch(e.project_id);
      return { shots: next.shots.length };
    },
  });
  engine.registerHandler('bible', {
    async onSuccess({ job, result }) {
      const bible = parseJson(result.text, bibleSchema);
      await db.run('UPDATE studio_projects SET bible=?,updated_at=? WHERE id=?', [JSON.stringify(bible), now(), job.project_id]);
      return { ok: true };
    },
  });
  engine.registerHandler('season', {
    async onSuccess({ job, result }) {
      const season = parseJson(result.text, seasonSchema);
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [job.project_id]);
      if (!p) return { skipped: true };
      await db.run('UPDATE studio_projects SET season=?,updated_at=? WHERE id=?', [JSON.stringify({ arc: season.arc, paywall_from: season.paywall_from, paywall_reason: season.paywall_reason }), now(), p.id]);
      for (const e of season.episodes.slice(0, Number(p.episode_count))) {
        const ex = await db.get('SELECT id FROM studio_episodes WHERE project_id=? AND number=?', [p.id, e.number]);
        if (ex)
          await db.run("UPDATE studio_episodes SET title=CASE WHEN ?<>'' THEN ? ELSE title END, summary=CASE WHEN ?<>'' THEN ? ELSE summary END, hook=?, cliffhanger=? WHERE id=?", [
            e.title, e.title, e.summary, e.summary, e.hook, [e.cliffhanger, e.twist].filter(Boolean).join(' · 반전: '), ex.id,
          ]);
        else
          await db.run("INSERT INTO studio_episodes (id,project_id,number,title,summary,hook,cliffhanger,status) VALUES (?,?,?,?,?,?,?,'outline')", [
            randomUUID(), p.id, e.number, e.title || `${e.number}화`, e.summary, e.hook, e.cliffhanger,
          ]);
      }
      return { episodes: season.episodes.length };
    },
  });
  engine.registerHandler('diagnose', {
    async onSuccess({ job, result }) {
      const d = parseJson(result.text, diagnoseSchema);
      await db.run('UPDATE studio_episodes SET diagnosis=? WHERE id=?', [JSON.stringify({ ...d, at: now() }), job.target_id]);
      return d;
    },
  });
  engine.registerHandler('metadata', {
    async onSuccess({ job, result }) {
      const meta = parseJson(result.text, metaSchema);
      await db.run('UPDATE studio_projects SET meta=?,updated_at=? WHERE id=?', [JSON.stringify({ ...meta, at: now() }), now(), job.project_id]);
      return { titles: meta.titles.length };
    },
  });
  // 한국어 묘사 → 영상·이미지 모델용 영어(번역은 플랫폼 부담, 라마 차감 없음)
  engine.registerHandler('translate', {
    async onSuccess({ job, result }) {
      const out = parseJson(result.text, translateSchema);
      const input = JSON.parse(job.input || '{}');
      for (const item of out.items) {
        const src = (input.items || []).find((x) => x.id === item.id);
        if (!src || !item.en.trim()) continue;
        const [table, id] = src.id.split(':');
        if (table === 'shot') await db.run('UPDATE studio_shots SET visual_en=?,visual_en_src=? WHERE id=? AND visual=?', [item.en, src.ko, id, src.ko]);
        if (table === 'character') await db.run('UPDATE studio_characters SET look_en=?,look_en_src=? WHERE id=? AND look=?', [item.en, src.ko, id, src.ko]);
        if (table === 'location') await db.run('UPDATE studio_locations SET look_en=?,look_en_src=? WHERE id=? AND look=?', [item.en, src.ko, id, src.ko]);
      }
      return { items: out.items.length };
    },
  });
  const mediaHandler = (column, table, kind) => ({
    async onSuccess({ job, result, model }) {
      const row = await db.get(`SELECT * FROM ${table} WHERE id=?`, [job.target_id]);
      if (row) {
        // 영상이나 대사 음성이 바뀌면 입 모양 맞춘 영상은 더 이상 맞지 않으므로 지웁니다.
        const resetSync = table === 'studio_shots' && (column === 'audio' || column === 'video') ? ",lipsync=''" : '';
        await db.run(`UPDATE ${table} SET ${column}=?${column === 'audio' ? ',audio_seconds=?' : ''}${resetSync} WHERE id=?`, column === 'audio' ? [result.url, result.duration || 0, row.id] : [result.url, row.id]);
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
  engine.registerHandler('shot_image_edit', mediaHandler('image', 'studio_shots', 'image'));
  engine.registerHandler('shot_lipsync', mediaHandler('lipsync', 'studio_shots', 'lipsync'));
  engine.registerHandler('shot_sfx', mediaHandler('sfx', 'studio_shots', 'sfx'));
  engine.registerHandler('location_image', mediaHandler('image', 'studio_locations', 'image'));
  // 인물 참고 이미지(정면·옆·전신·표정): 같은 자세는 새 이미지로 바꿉니다.
  engine.registerHandler('character_ref', {
    async onSuccess({ job, result, model }) {
      const input = JSON.parse(job.input || '{}');
      // 자세별 참고 이미지가 동시에 끝나도 서로 덮어쓰지 않게 인물 행을 잠그고 읽습니다.
      const c = await db.get('SELECT * FROM studio_characters WHERE id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''), [job.target_id]);
      if (c) {
        let refs = [];
        try {
          refs = JSON.parse(c.refs || '[]');
        } catch {}
        refs = [...refs.filter((r) => r.pose !== input.pose), { pose: input.pose, url: result.url }];
        await db.run('UPDATE studio_characters SET refs=?' + (c.image ? '' : ',image=?') + ' WHERE id=?', c.image ? [JSON.stringify(refs), c.id] : [JSON.stringify(refs), result.url, c.id]);
      }
      if (job.project_id) await asset(job, job.project_id, { type: 'character', id: job.target_id }, 'image', result.url, model);
      return { url: result.url };
    },
  });
  // 배경음악: 프로젝트 음악 목록에 쌓고, 회차 대상이면 그 회차 음악으로, 프로젝트에 기본 음악이 없으면 기본으로 씁니다.
  engine.registerHandler('music', {
    async onSuccess({ job, result, model }) {
      const [type, id] = [job.target_type, job.target_id];
      if (type === 'episode') await db.run('UPDATE studio_episodes SET bgm=? WHERE id=?', [result.url, id]);
      await db.run("UPDATE studio_projects SET bgm=CASE WHEN bgm='' THEN ? ELSE bgm END WHERE id=?", [result.url, job.project_id]);
      if (type === 'episode') await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [id]);
      await asset(job, job.project_id, { type: 'music', id: job.project_id }, 'music', result.url, model);
      return { url: result.url, duration: result.duration || 0 };
    },
  });
  // 썸네일 배경 후보(작품에 바로 적용하지 않고 후보로만 남김)
  engine.registerHandler('thumb_bg', {
    async onSuccess({ job, result, model }) {
      await asset(job, job.project_id, { type: 'thumb', id: job.project_id }, 'thumb_bg', result.url, model);
      return { url: result.url };
    },
  });
  // 원작 각색은 기획안과 같은 형태로 반영합니다.
  engine.registerHandler('adapt', { onSuccess: (args) => planHandler.onSuccess(args) });
  // 자막 인식용으로 잠깐 뽑은 음성 파일처럼, 작업이 끝나면 필요 없는 임시 파일을 지웁니다.
  const removeTemp = async (url) => {
    if (!url || !/^\/uploads\/[a-f0-9-]+\.(mp3|wav)$/.test(url)) return;
    await db.run('DELETE FROM media_files WHERE url=?', [url]).catch(() => {});
    await rm(path.join(uploadDir, path.basename(url)), { force: true }).catch(() => {});
  };
  const tempAudioOf = (job) => {
    try {
      return JSON.parse(job.input || '{}').audio?.path || '';
    } catch {
      return '';
    }
  };
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
      await removeTemp(tempAudioOf(job));
      const [dramaId, number] = String(job.target_id).split('#');
      const row = await db.get('SELECT e.id, e.subtitles AS old_subtitles, e.review_status, d.status AS drama_status FROM episodes e JOIN dramas d ON d.id=e.drama_id WHERE e.drama_id=? AND e.number=?', [dramaId, Number(number)]);
      // 작품이 임시저장·반려 상태이거나, 연재 중 작품의 아직 공개 전(초안·반려) 회차만 자막을 바꿉니다.
      const e = row && episodeEditable({ status: row.drama_status }, row) ? row : null;
      if (!e || !vtt) return { skipped: true };
      const file = randomUUID() + '.vtt';
      await mkdir(subsDir, { recursive: true });
      await writeFile(path.join(subsDir, file), vtt, 'utf8');
      await db.run('UPDATE episodes SET subtitles=? WHERE id=?', [file, e.id]);
      // 이전 자막 파일은 더 이상 쓰이지 않으므로 지웁니다.
      if (e.old_subtitles && e.old_subtitles !== file) await rm(path.join(subsDir, path.basename(e.old_subtitles)), { force: true }).catch(() => {});
      return { cues: segments.length };
    },
    onFail: async ({ job }) => removeTemp(tempAudioOf(job)),
  });

  // 실행할 작업을 만듭니다. 예상 라마 조회와 실제 실행이 같은 정의를 씁니다.
  const locationsOf = (pid) => db.all('SELECT * FROM studio_locations WHERE project_id=? ORDER BY sort_order, name', [pid]);
  const refsOf = (c) => {
    try {
      return JSON.parse(c.refs || '[]');
    } catch {
      return [];
    }
  };
  // 컷 이미지에 넘길 참고 이미지: 등장 인물의 기준 이미지(+정면 참고) → 장소 이미지, 최대 4장
  const shotRefs = (people, place) =>
    [...people.flatMap((c) => [c.image, refsOf(c).find((r) => r.pose === 'front')?.url]), place?.image].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4).map(imageRef).filter(Boolean);
  const castOf = (shot, cast) => {
    const ids = String(shot.cast_ids || '').split(',').filter(Boolean);
    const people = ids.map((id) => cast.find((c) => c.id === id)).filter(Boolean);
    const speaker = cast.find((c) => c.id === shot.speaker_id);
    if (speaker && !people.includes(speaker)) people.unshift(speaker);
    return people;
  };
  const seedOf = (shot) => (Number(shot.seed_lock) && Number.isInteger(Number(shot.seed)) && shot.seed !== null ? Number(shot.seed) : undefined);
  async function buildJob(req, p, action, targetId, extra = {}) {
    const cast = await charactersOf(p.id);
    const opt = extra.options || {};
    if (action === 'voice_sample') {
      const c = cast.find((x) => x.id === targetId);
      if (!c) fail(404, '인물을 찾을 수 없어요.');
      return {
        kind: 'voice_sample',
        capability: 'tts',
        tags: ['korean'],
        requestedOverride: c.voice_model && c.voice_model !== 'auto' ? c.voice_model : null,
        target: { type: 'character', id: c.id },
        input: { text: `안녕하세요, 저는 ${c.name}이에요. ${String(c.description || '').slice(0, 40) || '오늘 이야기, 기대해 주세요.'}`, voice: c.voice || '', style: c.voice_style || '' },
      };
    }
    const episodesBrief = async () => (await episodesOf(p.id)).map((e) => ({ number: e.number, title: e.title, summary: e.summary }));
    if (action === 'plan')
      return { kind: 'plan', capability: 'text', target: { type: 'project', id: p.id }, input: { ...planPrompt(p), userText: `${p.title} ${p.logline} ${p.tone}` } };
    if (action === 'adapt') {
      if (String(p.source_text || '').trim().length < 50) fail(400, '각색할 원작(시놉시스·원고)을 50자 이상 먼저 붙여 넣어 주세요.');
      return { kind: 'adapt', capability: 'text', target: { type: 'project', id: p.id }, input: { ...adaptPrompt({ project: p, source: p.source_text }), maxTokens: 8000, userText: p.source_text.slice(0, 3000) } };
    }
    if (action === 'bible') {
      if (!cast.length) fail(400, '기획안(등장인물)을 먼저 만들어 주세요.');
      return { kind: 'bible', capability: 'text', tags: ['story'], target: { type: 'project', id: p.id }, input: { ...biblePrompt({ project: p, characters: cast, episodes: await episodesBrief() }), userText: p.synopsis } };
    }
    if (action === 'season')
      return { kind: 'season', capability: 'text', tags: ['story'], target: { type: 'project', id: p.id }, input: { ...seasonPrompt({ project: p, characters: cast, episodes: await episodesBrief() }), userText: p.synopsis } };
    if (action === 'metadata')
      return { kind: 'metadata', capability: 'text', tags: ['korean'], target: { type: 'project', id: p.id }, input: { ...metaPrompt({ project: p, episodes: await episodesBrief() }), userText: p.synopsis } };
    if (action === 'poster')
      return { kind: 'poster', capability: 'image', tags: ['poster'], target: { type: 'project', id: p.id }, input: { prompt: posterPrompt(p, cast), aspect: '9:16', refImages: shotRefs(cast.slice(0, 2)), userText: p.logline } };
    if (action === 'thumb_bg') {
      const variant = Number(extra.index || 0);
      const moods = ['dramatic close-up of the leads', 'two leads facing each other with tension', 'mysterious silhouette with strong rim light', 'emotional moment in the rain'];
      return {
        kind: 'thumb_bg',
        capability: 'image',
        tags: ['poster'],
        target: { type: 'thumb', id: `${p.id}#${variant}` },
        input: { prompt: posterPrompt(p, cast) + ` Variation: ${moods[variant % moods.length]}.`, aspect: opt.aspect || '9:16', refImages: shotRefs(cast.slice(0, 2)), seed: 1000 + variant, userText: p.logline },
      };
    }
    if (action === 'music') {
      const seconds = Math.max(10, Math.min(180, Math.round(Number(opt.seconds) || Number(p.episode_seconds) || 60)));
      const mood = String(opt.mood || '').slice(0, 200);
      const e = targetId && targetId !== p.id ? await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [targetId, p.id]) : null;
      if (targetId && targetId !== p.id && !e) fail(404, '회차를 찾을 수 없어요.');
      return {
        kind: 'music',
        capability: 'music',
        tags: ['emotion'],
        target: e ? { type: 'episode', id: e.id } : { type: 'project', id: p.id },
        input: { prompt: musicPrompt(p, mood, seconds), seconds, userText: mood },
      };
    }
    if (action === 'script' || action === 'diagnose' || action === 'rewrite_range') {
      const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [targetId, p.id]);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      if (action === 'diagnose') {
        const shots = await shotsOf(e.id);
        if (!shots.length) fail(400, '진단할 대본이 없어요. 대본을 먼저 만들어 주세요.');
        return { kind: 'diagnose', capability: 'text', tags: ['story'], target: { type: 'episode', id: e.id }, input: { ...diagnosePrompt({ project: p, characters: cast, episode: e, shots }), userText: '' } };
      }
      if (action === 'rewrite_range') {
        const instruction = String(extra.instruction || '').trim();
        if (instruction.length < 2) fail(400, '어떻게 고칠지 적어 주세요.');
        const ids = Array.isArray(opt.shotIds) ? opt.shotIds.map(String) : [];
        const shots = (await shotsOf(e.id)).filter((x) => ids.includes(x.id));
        if (!shots.length) fail(400, '다시 쓸 컷을 골라 주세요.');
        return {
          kind: 'rewrite_range',
          capability: 'text',
          target: { type: 'episode', id: e.id },
          input: { ...rangePrompt({ project: p, characters: cast, shots, instruction }), shotIds: shots.map((x) => x.id), userInstruction: instruction, userText: instruction },
        };
      }
      if (!cast.length) fail(400, '기획안(등장인물)을 먼저 만들어 주세요.');
      const history = (await episodesOf(p.id)).filter((x) => x.number < e.number).slice(-6).map((x) => ({ number: x.number, title: x.title, summary: x.summary }));
      const instruction = String(extra.instruction || '').trim().slice(0, 300);
      return {
        kind: 'script',
        capability: 'text',
        tags: ['story', 'korean'],
        target: { type: 'episode', id: e.id },
        input: {
          ...scriptPrompt({ project: p, characters: cast, episode: e, history, maxShotSeconds: 8, locations: await locationsOf(p.id), instruction }),
          userInstruction: instruction,
          userText: `${e.title} ${e.summary} ${instruction}`,
        },
      };
    }
    if (action === 'character_image' || action === 'character_ref') {
      const c = cast.find((x) => x.id === targetId);
      if (!c) fail(404, '인물을 찾을 수 없어요.');
      if (action === 'character_image')
        return { kind: 'character_image', capability: 'image', tags: ['character', 'consistency'], target: { type: 'character', id: c.id }, input: { prompt: characterImagePrompt(p, c), aspect: '9:16', userText: c.look } };
      const pose = ['front', 'side', 'full', 'smile', 'angry', 'sad'].includes(opt.pose) ? opt.pose : 'front';
      if (!c.image) fail(400, '기준 이미지를 먼저 만들어 주세요. 참고 이미지는 기준 이미지와 같은 얼굴로 만들어요.');
      return {
        kind: 'character_ref',
        capability: 'image',
        tags: ['character', 'consistency'],
        target: { type: 'character', id: c.id },
        input: { prompt: characterRefPrompt(p, c, pose), aspect: '9:16', refImage: imageRef(c.image), pose, userText: c.look },
      };
    }
    if (action === 'location_image') {
      const l = await db.get('SELECT * FROM studio_locations WHERE id=? AND project_id=?', [targetId, p.id]);
      if (!l) fail(404, '장소를 찾을 수 없어요.');
      return { kind: 'location_image', capability: 'image', tags: ['landscape'], target: { type: 'location', id: l.id }, input: { prompt: locationPrompt(p, l), aspect: '9:16', userText: l.look } };
    }
    const shot = await loadShot(req, targetId);
    if (shot.project_id !== p.id) fail(404, '컷을 찾을 수 없어요.');
    const speaker = cast.find((c) => c.id === shot.speaker_id);
    const people = castOf(shot, cast);
    const place = shot.location_id ? await db.get('SELECT * FROM studio_locations WHERE id=? AND project_id=?', [shot.location_id, p.id]) : null;
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
        input: {
          prompt: shotImagePrompt(p, shot, people.length ? people : cast.slice(0, 2), place),
          aspect: '9:16',
          refImages: shotRefs(people, place),
          seed: seedOf(shot),
          userText: shot.visual,
        },
      };
    if (action === 'shot_image_edit') {
      const instruction = String(extra.instruction || '').trim();
      if (instruction.length < 2) fail(400, '어떻게 바꿀지 적어 주세요.');
      if (!shot.image) fail(400, '고칠 스토리보드 이미지가 없어요. 이미지를 먼저 만들어 주세요.');
      return {
        kind: 'shot_image_edit',
        capability: 'image',
        tags: ['consistency'],
        target: { type: 'shot', id: shot.id },
        input: {
          prompt: `Edit the first image. Change only this: ${instruction}. Keep everything else (faces, outfits, composition, lighting) the same. Vertical 9:16, no text.`,
          aspect: '9:16',
          editImage: imageRef(shot.image),
          refImages: shotRefs(people, null).slice(0, 2),
          needImage: true,
          userText: instruction,
        },
      };
    }
    if (action === 'shot_tts') {
      if (!String(shot.dialogue || '').trim()) fail(400, '대사가 없는 컷이에요.');
      const narrator = Number(shot.narration) === 1;
      const model = narrator ? p.narrator_model : speaker?.voice_model;
      return {
        kind: 'shot_tts',
        capability: 'tts',
        tags: ['korean', ...(shot.emotion ? ['emotion'] : [])],
        requestedOverride: model && model !== 'auto' ? model : null,
        target: { type: 'shot', id: shot.id },
        input: { text: shot.dialogue, voice: (narrator ? p.narrator_voice : speaker?.voice) || '', style: shot.emotion || speaker?.voice_style || '', speed: Number(shot.speed) || 1, userText: shot.dialogue },
      };
    }
    if (action === 'shot_video') {
      // 끝 장면 지정: 다음 컷의 스토리보드로 자연스럽게 이어지게(지원하는 모델만)
      let endImage;
      if (Number(shot.end_frame)) {
        const next = await db.get('SELECT image FROM studio_shots WHERE episode_id=? AND sort_order>? ORDER BY sort_order LIMIT 1', [shot.episode_id, shot.sort_order]);
        endImage = imageRef(next?.image);
      }
      return {
        kind: 'shot_video',
        capability: 'video',
        tags: [...shotTags(shot), ...(shot.dialogue ? ['lipsync'] : [])],
        target: { type: 'shot', id: shot.id },
        input: { prompt: shotVideoPrompt(p, shot, speaker), seconds: Number(shot.seconds) || 5, aspect: '9:16', image: imageRef(shot.image), endImage, seed: seedOf(shot), userText: shot.visual },
      };
    }
    if (action === 'shot_lipsync') {
      if (!shot.video) fail(400, '입 모양을 맞추려면 이 컷의 영상이 먼저 있어야 해요.');
      if (!shot.audio) fail(400, '입 모양을 맞추려면 대사 음성이 먼저 있어야 해요.');
      const meta = await db.get('SELECT duration FROM media_metadata WHERE url=?', [shot.video]);
      return {
        kind: 'shot_lipsync',
        capability: 'lipsync',
        tags: ['lipsync', 'dialogue'],
        target: { type: 'shot', id: shot.id },
        input: {
          video: { path: shot.video, mime: 'video/mp4' },
          audio: { path: shot.audio, mime: /\.wav$/.test(shot.audio) ? 'audio/wav' : 'audio/mpeg' },
          seconds: Math.max(1, Math.ceil(Number(meta?.duration) || Number(shot.seconds) || 5)),
          userText: shot.dialogue,
        },
      };
    }
    if (action === 'shot_sfx') {
      const prompt = String(opt.prompt || shot.sfx_prompt || '').trim().slice(0, 200);
      if (!prompt) fail(400, '어떤 효과음이 필요한지 적어 주세요. 예: 문이 쾅 닫히는 소리');
      if (opt.prompt && opt.prompt !== shot.sfx_prompt) await db.run('UPDATE studio_shots SET sfx_prompt=? WHERE id=?', [prompt, shot.id]);
      return {
        kind: 'shot_sfx',
        capability: 'sfx',
        tags: ['scene'],
        target: { type: 'shot', id: shot.id },
        input: {
          prompt: `${prompt}. Sound effect only, no music, no speech.`,
          seconds: Math.max(1, Math.min(10, Number(shot.seconds) || 4)),
          ...(shot.video ? { video: { path: shot.video, mime: 'video/mp4' } } : {}),
          userText: prompt,
        },
      };
    }
    fail(400, '알 수 없는 작업이에요.');
  }
  // 회차 단위 일괄 작업: 아직 결과가 없는 컷만 대상으로 합니다.
  // chosen: 고른 컷만(이미 결과가 있어도 다시 만듦 — 여러 컷 골라 한 번에 다시 만들기)
  async function batchTargets(p, action, episodeId, chosen = null) {
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [episodeId, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    const all = await shotsOf(e.id);
    const shots = chosen ? all.filter((s) => chosen.includes(s.id)) : all;
    const busy = new Set(
      (await db.all("SELECT target_id FROM ai_jobs WHERE project_id=? AND target_type='shot' AND kind=? AND status IN ('queued','running')", [p.id, action])).map((r) => r.target_id),
    );
    const col = { shot_image: 'image', shot_tts: 'audio', shot_video: 'video', shot_lipsync: 'lipsync', shot_sfx: 'sfx' }[action];
    return shots.filter(
      (s) =>
        (chosen || !s[col]) &&
        !busy.has(s.id) &&
        // 화면 묘사가 빈 컷은 이미지·영상 일괄 작업에서 빼서 라마가 헛되이 쓰이지 않게 합니다.
        (!['shot_image', 'shot_video'].includes(action) || String(s.visual || '').trim()) &&
        (action !== 'shot_tts' || String(s.dialogue || '').trim()) &&
        (action !== 'shot_lipsync' || (s.video && s.audio)) &&
        (action !== 'shot_sfx' || String(s.sfx_prompt || '').trim()),
    );
  }
  const PROJECT_ACTIONS = ['plan', 'poster', 'adapt', 'bible', 'season', 'metadata', 'thumb_bg', 'music'];
  const runSchema = z.object({
    action: z.enum([
      'plan', 'poster', 'adapt', 'bible', 'season', 'metadata', 'thumb_bg', 'music',
      'script', 'diagnose', 'rewrite_range',
      'character_image', 'character_ref', 'character_sheet', 'location_image', 'voice_sample',
      'shot_image', 'shot_image_edit', 'shot_tts', 'shot_video', 'shot_lipsync', 'shot_sfx', 'rewrite_shot',
      'batch_shot_image', 'batch_shot_tts', 'batch_shot_video', 'batch_shot_lipsync', 'batch_shot_sfx',
    ]),
    instruction: z.string().trim().max(300).optional(),
    options: z
      .object({
        pose: z.string().max(20).optional(),
        poses: z.array(z.enum(['front', 'side', 'full', 'smile', 'angry', 'sad'])).max(6).optional(),
        count: z.number().int().min(1).max(4).optional(),
        aspect: z.enum(['9:16', '1:1', '16:9']).optional(),
        mood: z.string().max(200).optional(),
        seconds: z.number().int().min(5).max(180).optional(),
        prompt: z.string().max(200).optional(),
        shotIds: z.array(z.string().max(80)).max(20).optional(),
      })
      .default({}),
    targetId: z.string().max(80).optional(),
    requested: z.string().max(80).default('auto'),
    tier: z.enum(['draft', 'standard', 'premium']).default('standard'),
    idempotencyKey: z.string().uuid().optional(),
    budgetOk: z.boolean().optional(), // 프로젝트 예산을 넘어도 진행(PD가 확인함)
  });
  async function plan(req, p, b) {
    if (!PROJECT_ACTIONS.includes(b.action) && !b.targetId) fail(400, '작업 대상을 선택해 주세요.');
    // 인물 참고 이미지 여러 장(정면·옆·전신·표정)을 한 번에
    if (b.action === 'character_sheet') {
      const poses = b.options.poses?.length ? b.options.poses : ['front', 'side', 'full', 'smile'];
      const specs = [];
      for (const pose of poses) specs.push({ ...(await buildJob(req, p, 'character_ref', b.targetId, { options: { pose } })), keySuffix: pose });
      return specs.map((x) => ({ ...x, target: { ...x.target, id: x.target.id } }));
    }
    // 썸네일 배경 후보 여러 장
    if (b.action === 'thumb_bg') {
      const specs = [];
      for (let i = 0; i < (b.options.count || 4); i++) specs.push(await buildJob(req, p, 'thumb_bg', p.id, { index: i, options: b.options }));
      return specs;
    }
    if (b.action.startsWith('batch_')) {
      const action = b.action.slice(6);
      const chosen = b.options.shotIds?.length ? b.options.shotIds : null;
      const targets = await batchTargets(p, action, b.targetId, chosen);
      if (!targets.length) fail(400, chosen ? '고른 컷 중에 만들 수 있는 컷이 없어요(진행 중이거나 필요한 내용이 비어 있어요).' : '새로 만들 컷이 없어요. 이미 결과가 있거나 진행 중이에요.');
      const specs = [];
      for (const t of targets) specs.push(await buildJob(req, p, action, t.id));
      return specs;
    }
    return [await buildJob(req, p, b.action, b.targetId || p.id, { instruction: b.instruction, options: b.options })];
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
      families: familyList(),
      features: featuresOf(settings),
      genres: GENRES,
      projects: await db.all(
        "SELECT p.*, (SELECT COUNT(*) FROM studio_episodes e WHERE e.project_id=p.id) AS episode_total, (SELECT COUNT(*) FROM studio_episodes e WHERE e.project_id=p.id AND e.video<>'') AS composed, (SELECT COALESCE(SUM(j.charged_lama),0) FROM ai_jobs j WHERE j.project_id=p.id AND j.status='succeeded') AS spent FROM studio_projects p WHERE p.owner_id=? ORDER BY p.updated_at DESC",
        [req.user.id],
      ),
    });
  });
  // 모델 센터: 작업별로 '지금 자동이면 어떤 모델을 왜 고르는지' 알려 줍니다(라마 들지 않음).
  const DEFAULT_TAGS = { text: ['story', 'korean'], image: ['character', 'consistency'], video: ['cinematic'], tts: ['korean'], music: ['emotion'], sfx: ['scene'], lipsync: ['lipsync'] };
  const DEFAULT_INPUT = { text: { prompt: 'x'.repeat(2000), maxTokens: 4000 }, image: { count: 1 }, video: { seconds: 5 }, tts: { text: 'x'.repeat(100) }, music: { seconds: 30 }, sfx: { seconds: 4 }, lipsync: { seconds: 5 } };
  app.post('/api/studio/ai/models/explain', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({
        items: z.array(z.object({ capability: z.enum(['text', 'image', 'video', 'tts', 'music', 'sfx', 'lipsync']), tier: z.enum(['draft', 'standard', 'premium']).default('standard') })).max(10),
        projectId: z.string().max(80).optional(),
      })
      .parse(req.body);
    const p = b.projectId ? await project(req, b.projectId) : null;
    const out = {};
    for (const it of b.items) {
      try {
        out[it.capability] = await engine.explain({ capability: it.capability, tier: it.tier, tags: DEFAULT_TAGS[it.capability], seconds: DEFAULT_INPUT[it.capability].seconds, input: DEFAULT_INPUT[it.capability], excludeCn: !!Number(p?.exclude_cn) });
      } catch {
        out[it.capability] = [];
      }
    }
    res.json(out);
  });
  app.post('/api/studio/ai/terms', roles('pd', 'admin'), async (req, res) => {
    z.object({ agree: z.literal(true), version: z.literal(TERMS_VERSION) }).parse(req.body);
    await db.run('UPDATE user_profiles SET studio_terms_at=? WHERE user_id=?', [now(), req.user.id]);
    res.json({ ok: true });
  });
  // PD 화면에 알려 줄 기능 설정(AI 조수·내 소재 올리기 제한)
  const featuresOf = (settings) => ({
    assistant: !!Number(settings.ai_assistant_enabled),
    assistant_daily_limit: Number(settings.ai_assistant_daily_limit || 0),
    upload: {
      enabled: !!Number(settings.studio_upload_enabled),
      image_mb: Number(settings.studio_upload_image_mb),
      video_mb: Number(settings.studio_upload_video_mb),
      video_seconds: Number(settings.studio_upload_video_seconds),
      audio_mb: Number(settings.studio_upload_audio_mb),
      audio_seconds: Number(settings.studio_upload_audio_seconds),
    },
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
        "SELECT j.id,j.kind,j.target_type,j.target_id,j.status,j.estimate_lama,j.charged_lama,j.error,j.created_at,j.finished_at,j.attempts,j.requested_model,j.model_ref,j.tier,m.label AS model_label FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref WHERE j.project_id=? AND (j.status IN ('queued','running') OR j.created_at>=?) ORDER BY j.created_at DESC LIMIT 300",
        [p.id, new Date(Date.now() - 3 * 86400000).toISOString()],
      ),
      // 결과 버전: 대상(인물·컷·포스터)마다 최근 12개씩(큰 프로젝트에서도 예전 버전이 목록에서 사라지지 않게)
      assets: await db.all(
        `SELECT id,target_type,target_id,kind,url,model_label,created_at FROM (
           SELECT a.*, ROW_NUMBER() OVER (PARTITION BY a.target_id, a.kind ORDER BY a.created_at DESC) AS rn FROM studio_assets a WHERE a.project_id=?
         ) x WHERE rn<=12 ORDER BY created_at DESC`,
        [p.id],
      ),
      spent: Number((await db.get("SELECT COALESCE(SUM(charged_lama),0) AS n FROM ai_jobs WHERE project_id=? AND status='succeeded'", [p.id]))?.n || 0),
      costs: await db.all(
        "SELECT kind, COUNT(*) AS jobs, COALESCE(SUM(charged_lama),0) AS lama, COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed FROM ai_jobs WHERE project_id=? AND status IN ('succeeded','failed') GROUP BY kind",
        [p.id],
      ),
      autopilot: parseAutopilot(p.autopilot),
      locations: await locationsOf(p.id),
      renders: await db.all("SELECT id,kind,target_id,status,progress,error,created_at FROM studio_renders WHERE project_id=? AND (status IN ('queued','running') OR created_at>=?) ORDER BY created_at DESC LIMIT 30", [
        p.id,
        new Date(Date.now() - 86400000).toISOString(),
      ]),
      // 반려 후 다시 내보낼 때 입력칸을 기존 작품 값으로 채울 수 있게 가격·소개도 함께 보냅니다.
      drama: p.drama_id
        ? await db.get('SELECT id,title,status,review_note,tagline,free,episode_pings,free_episodes,image FROM dramas WHERE id=?', [p.drama_id])
        : null,
      wallet: await lamaWalletOf(db, req.user.id),
      chat: chatApi ? await chatApi.chatOf(p.id) : [],
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
    const composingNow = await db.get("SELECT id FROM studio_episodes WHERE project_id=? AND status='composing' LIMIT 1", [p.id]);
    if (composingNow) fail(409, '회차 합성이 끝난 뒤 삭제해 주세요.');
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
  // 한국어로 쓴 묘사(컷 화면·인물 외모·장소)는 저장할 때 영상·이미지 모델용 영어로 번역해 둡니다.
  // 번역은 플랫폼이 부담하므로(라마 차감 없음) 텍스트 모델이 없거나 실패해도 저장에는 영향이 없습니다.
  async function queueTranslate(projectId, userId, items) {
    const list = items.filter((x) => /[가-힣]/.test(x.ko || '') && String(x.ko).trim().length >= 2);
    if (!list.length) return;
    try {
      await db.transaction(() =>
        engine.enqueue({
          userId,
          kind: 'translate',
          capability: 'text',
          requested: 'auto',
          tier: 'draft',
          tags: ['fast'],
          input: { ...translatePrompt(list), items: list, userText: '' },
          target: { type: 'translate', id: list[0].id },
          projectId,
          bill: false,
        }),
      );
    } catch (e) {
      if (e.status >= 500 && e.status !== 503) console.error('translate', e.message);
    }
  }
  const characterSchema = z.object({
    name: z.string().trim().min(1).max(30),
    role: z.string().trim().max(60).default(''),
    description: z.string().trim().max(500).default(''),
    look: z.string().trim().max(500).default(''),
    outfit: z.string().trim().max(200).default(''),
    voice_model: z.string().max(80).default('auto'),
    voice: z.string().trim().max(80).default(''),
    voice_style: z.string().trim().max(40).default(''),
  });
  app.post('/api/studio/ai/projects/:id/characters', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = characterSchema.parse(req.body);
    const count = (await charactersOf(p.id)).length;
    if (count >= 8) fail(400, '인물은 8명까지 만들 수 있어요.');
    const id = randomUUID();
    await db.run('INSERT INTO studio_characters (id,project_id,name,role,description,look,outfit,voice_model,voice,voice_style,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      id, p.id, b.name, b.role, b.description, b.look, b.outfit, b.voice_model, b.voice, b.voice_style, count,
    ]);
    await touch(p.id);
    await queueTranslate(p.id, p.owner_id, [{ id: 'character:' + id, ko: b.look }]);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/projects/:id/characters/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = characterSchema.parse(req.body);
    const c = await db.get('SELECT * FROM studio_characters WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    if (!c) fail(404, '인물을 찾을 수 없어요.');
    await db.run('UPDATE studio_characters SET name=?,role=?,description=?,look=?,outfit=?,voice_model=?,voice=?,voice_style=? WHERE id=?', [
      b.name, b.role, b.description, b.look, b.outfit, b.voice_model, b.voice, b.voice_style, c.id,
    ]);
    await touch(p.id);
    if (b.look !== c.look && b.look !== c.look_en_src) await queueTranslate(p.id, p.owner_id, [{ id: 'character:' + c.id, ko: b.look }]);
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id/characters/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const c = await db.get('SELECT id FROM studio_characters WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    if (!c) fail(404, '인물을 찾을 수 없어요.');
    await db.run('UPDATE studio_shots SET speaker_id=NULL WHERE speaker_id=?', [c.id]);
    // 컷의 등장 인물 목록에서도 뺍니다.
    for (const s of await db.all("SELECT s.id, s.cast_ids FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=? AND s.cast_ids LIKE ?", [p.id, `%${c.id}%`]))
      await db.run('UPDATE studio_shots SET cast_ids=? WHERE id=?', [String(s.cast_ids).split(',').filter((x) => x && x !== c.id).join(','), s.id]);
    await db.run('DELETE FROM studio_characters WHERE id=? AND project_id=?', [c.id, p.id]);
    await touch(p.id);
    res.json({ ok: true });
  });
  // 부분 수정: 보낸 칸만 바꿉니다(음악·카드만 바꿀 때 제목·줄거리를 함께 보내지 않아도 됨).
  const episodeSchema = z.object({
    title: z.string().trim().min(1).max(100).optional(),
    summary: z.string().trim().max(800).optional(),
    hook: z.string().trim().max(200).optional(),
    cliffhanger: z.string().trim().max(300).optional(),
    intro_card: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).optional(),
    outro_card: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).optional(),
    thumbnail: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).optional(),
    bgm: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(mp3|wav))$/).optional(),
    bgm_volume: z.number().min(-1).max(1).optional(),
  });
  const ownedMedia = async (p, url) => {
    if (!url) return;
    const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [url]);
    if (!f || f.owner_id !== p.owner_id) fail(403, '이 프로젝트에서 만든 파일만 쓸 수 있어요.');
  };
  app.patch('/api/studio/ai/projects/:id/episodes/:eid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = episodeSchema.parse(req.body);
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    for (const k of ['intro_card', 'outro_card', 'thumbnail', 'bgm']) if (b[k]) await ownedMedia(p, b[k]);
    const next = { ...e, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    await db.run('UPDATE studio_episodes SET title=?,summary=?,hook=?,cliffhanger=?,intro_card=?,outro_card=?,thumbnail=?,bgm=?,bgm_volume=? WHERE id=?', [
      next.title, next.summary, next.hook, next.cliffhanger, next.intro_card, next.outro_card, next.thumbnail, next.bgm, next.bgm_volume, e.id,
    ]);
    // 완성본에 들어가는 요소(카드·음악)가 바뀌면 다시 합성해야 합니다.
    if (['intro_card', 'outro_card', 'bgm', 'bgm_volume'].some((k) => b[k] !== undefined && b[k] !== e[k]))
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [e.id]);
    await touch(p.id);
    res.json({ ok: true });
  });
  const checkSpeaker = async (projectId, speakerId) => {
    if (!speakerId) return;
    if (!(await db.get('SELECT id FROM studio_characters WHERE id=? AND project_id=?', [speakerId, projectId])))
      fail(400, '이 프로젝트의 인물만 화자로 고를 수 있어요.');
  };
  const checkCast = async (projectId, ids) => {
    for (const id of ids) await checkSpeaker(projectId, id);
  };
  const checkLocation = async (projectId, id) => {
    if (id && !(await db.get('SELECT id FROM studio_locations WHERE id=? AND project_id=?', [id, projectId]))) fail(400, '이 프로젝트의 장소만 고를 수 있어요.');
  };
  const shotSchema = z.object({
    scene: z.string().trim().max(200).default(''),
    visual: z.string().trim().max(800).default(''),
    dialogue: z.string().trim().max(300).default(''),
    speaker_id: z.string().max(80).nullable().default(null),
    cast_ids: z.array(z.string().max(80)).max(8).optional(),
    location_id: z.string().max(80).nullable().optional(),
    camera: z.string().trim().max(80).default(''),
    camera_move: z.string().trim().max(30).optional(),
    emotion: z.string().trim().max(20).optional(),
    speed: z.number().min(0.5).max(2).optional(),
    narration: z.boolean().optional(),
    seed_lock: z.boolean().optional(),
    end_frame: z.boolean().optional(),
    transition: z.enum(['cut', 'fade', 'dip', 'flash']).optional(),
    sfx_prompt: z.string().trim().max(200).optional(),
    sfx_volume: z.number().min(0).max(1.5).optional(),
    caption: z.string().trim().max(300).nullable().optional(),
    seconds: z.number().int().min(2).max(10),
  });
  app.post('/api/studio/ai/projects/:id/episodes/:eid/shots', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = shotSchema.parse(req.body);
    const e = await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    await checkSpeaker(p.id, b.speaker_id);
    await checkCast(p.id, b.cast_ids || []);
    await checkLocation(p.id, b.location_id);
    const last = await db.get('SELECT MAX(sort_order) AS n FROM studio_shots WHERE episode_id=?', [e.id]);
    const id = randomUUID();
    await db.run(
      'INSERT INTO studio_shots (id,episode_id,sort_order,scene,visual,dialogue,speaker_id,cast_ids,location_id,camera,camera_move,emotion,seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, e.id, Number(last?.n ?? -1) + 1, b.scene, b.visual, b.dialogue, b.speaker_id, (b.cast_ids || []).join(','), b.location_id || null, b.camera, b.camera_move || '', b.emotion || '', b.seconds],
    );
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status IN ('outline','composed') THEN 'scripted' ELSE status END WHERE id=?", [e.id]);
    await queueTranslate(p.id, p.owner_id, [{ id: 'shot:' + id, ko: b.visual }]);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/shots/:sid', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid);
    const b = shotSchema.parse(req.body);
    await checkSpeaker(s.project_id, b.speaker_id);
    if (b.cast_ids) await checkCast(s.project_id, b.cast_ids);
    if (b.location_id !== undefined) await checkLocation(s.project_id, b.location_id);
    const next = {
      cast_ids: b.cast_ids ? b.cast_ids.join(',') : s.cast_ids,
      location_id: b.location_id !== undefined ? b.location_id : s.location_id,
      camera_move: b.camera_move ?? s.camera_move,
      emotion: b.emotion ?? s.emotion,
      speed: b.speed ?? s.speed,
      narration: b.narration === undefined ? Number(s.narration) : b.narration ? 1 : 0,
      seed_lock: b.seed_lock === undefined ? Number(s.seed_lock) : b.seed_lock ? 1 : 0,
      end_frame: b.end_frame === undefined ? Number(s.end_frame) : b.end_frame ? 1 : 0,
      transition: b.transition ?? s.transition,
      sfx_prompt: b.sfx_prompt ?? s.sfx_prompt,
      sfx_volume: b.sfx_volume ?? s.sfx_volume,
      caption: b.caption === undefined ? s.caption : b.caption,
    };
    // 대사·화자·감정·속도·내레이션이 바뀌면 이전 음성(과 입 모양 영상)은 맞지 않으므로 지웁니다(버전 기록에는 남음).
    const audioReset =
      b.dialogue !== s.dialogue || b.speaker_id !== s.speaker_id || next.emotion !== s.emotion || Number(next.speed) !== Number(s.speed) || next.narration !== Number(s.narration);
    // 시드 고정을 켜면 지금 시드를 정해 두고, 같은 컷을 다시 만들 때 비슷한 그림이 나오게 합니다.
    const seed = next.seed_lock && (s.seed === null || s.seed === undefined) ? Math.floor(Math.random() * 2147483647) : s.seed;
    await db.run(
      `UPDATE studio_shots SET scene=?,visual=?,dialogue=?,speaker_id=?,cast_ids=?,location_id=?,camera=?,camera_move=?,emotion=?,speed=?,narration=?,seed_lock=?,seed=?,end_frame=?,transition=?,sfx_prompt=?,sfx_volume=?,caption=?,seconds=?${
        audioReset ? ",audio='',audio_seconds=0,lipsync=''" : ''
      } WHERE id=?`,
      [b.scene, b.visual, b.dialogue, b.speaker_id, next.cast_ids, next.location_id, b.camera, next.camera_move, next.emotion, next.speed, next.narration, next.seed_lock, seed, next.end_frame, next.transition, next.sfx_prompt, next.sfx_volume, next.caption, b.seconds, s.id],
    );
    const changed = ['scene', 'visual', 'dialogue', 'speaker_id', 'camera', 'seconds'].some((k) => b[k] !== s[k]) || audioReset || next.transition !== s.transition || next.caption !== s.caption || Number(next.sfx_volume) !== Number(s.sfx_volume);
    if (changed) await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
    if (b.visual !== s.visual && b.visual !== s.visual_en_src) await queueTranslate(s.project_id, (await db.get('SELECT owner_id FROM studio_projects WHERE id=?', [s.project_id])).owner_id, [{ id: 'shot:' + s.id, ko: b.visual }]);
    res.json({ ok: true, audioReset });
  });
  app.delete('/api/studio/ai/shots/:sid', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid);
    await db.run('DELETE FROM studio_shots WHERE id=?', [s.id]);
    // 합성한 뒤 컷이 바뀌면 완성본을 다시 만들어야 합니다.
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
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
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
    });
    res.json({ ok: true });
  });
  // 컷 순서 한 번에 바꾸기(스토리보드 끌어 놓기)
  app.post('/api/studio/ai/projects/:id/episodes/:eid/shots/order', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = z.object({ ids: z.array(z.string().max(80)).min(1).max(200) }).parse(req.body);
    await db.transaction(async () => {
      const e = await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      const shots = await shotsOf(e.id);
      if (b.ids.length !== shots.length || new Set(b.ids).size !== b.ids.length || !b.ids.every((id) => shots.some((s) => s.id === id)))
        fail(409, '컷 목록이 바뀌었어요. 새로고침한 뒤 다시 옮겨 주세요.');
      for (let k = 0; k < b.ids.length; k++) await db.run('UPDATE studio_shots SET sort_order=? WHERE id=?', [k, b.ids[k]]);
      if (b.ids.some((id, k) => shots[k].id !== id)) await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [e.id]);
    });
    res.json({ ok: true });
  });
  // 여러 컷 한 번에 고치기(감정·말 빠르기·카메라 움직임·전환·말하는 인물·길이)
  app.patch('/api/studio/ai/projects/:id/episodes/:eid/shots/bulk', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = z
      .object({
        ids: z.array(z.string().max(80)).min(1).max(200),
        emotion: z.string().trim().max(20).optional(),
        speed: z.number().min(0.5).max(2).optional(),
        camera_move: z.string().trim().max(30).optional(),
        transition: z.enum(['cut', 'fade', 'dip', 'flash']).optional(),
        speaker_id: z.string().max(80).nullable().optional(),
        seconds: z.number().int().min(2).max(10).optional(),
      })
      .parse(req.body);
    const e = await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    if (b.speaker_id !== undefined) await checkSpeaker(p.id, b.speaker_id);
    const fields = ['emotion', 'speed', 'camera_move', 'transition', 'speaker_id', 'seconds'].filter((k) => b[k] !== undefined);
    if (!fields.length) fail(400, '바꿀 내용을 골라 주세요.');
    let changed = 0;
    let reset = 0;
    await db.transaction(async () => {
      for (const s of (await shotsOf(e.id)).filter((x) => b.ids.includes(x.id))) {
        const diff = fields.filter((k) => String(b[k] ?? '') !== String(s[k] ?? ''));
        if (!diff.length) continue;
        // 대사 목소리에 영향을 주는 값이 바뀌면 이전 음성(과 입 모양)은 맞지 않으므로 뺍니다(버전 기록에는 남음).
        const audioReset = diff.some((k) => ['emotion', 'speed', 'speaker_id'].includes(k)) && (s.audio || s.lipsync);
        await db.run(`UPDATE studio_shots SET ${diff.map((k) => `${k}=?`).join(',')}${audioReset ? ",audio='',audio_seconds=0,lipsync=''" : ''}${b.speaker_id !== undefined && diff.includes('speaker_id') ? ',narration=0' : ''} WHERE id=?`, [...diff.map((k) => b[k]), s.id]);
        changed++;
        if (audioReset) reset++;
      }
      if (changed) await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [e.id]);
    });
    res.json({ changed, audioReset: reset });
  });
  // 결과 버전 고르기: 예전에 만든 이미지·음성·영상으로 되돌립니다.
  app.post('/api/studio/ai/assets/:aid/use', roles('pd', 'admin'), async (req, res) => {
    const a = await db.get('SELECT * FROM studio_assets WHERE id=?', [req.params.aid]);
    if (!a) fail(404, '결과를 찾을 수 없어요.');
    await project(req, a.project_id);
    const map = {
      character: ['studio_characters', { image: 'image', audio: 'voice_sample' }[a.kind]],
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
  // 프로젝트 예산(라마): 쓴 라마 + 진행 중 예약 라마
  async function budgetOf(p) {
    const limit = Number(p.budget_lama || 0);
    const spent = Number(
      (
        await db.get(
          "SELECT COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_lama WHEN status IN ('queued','running') THEN estimate_lama ELSE 0 END),0) AS n FROM ai_jobs WHERE project_id=? AND billed=1",
          [p.id],
        )
      )?.n || 0,
    );
    return { limit, spent, left: limit > 0 ? Math.max(0, limit - spent) : null };
  }
  async function priceSpecs(p, b, specs, exclude = []) {
    let lama = 0;
    let label = '';
    for (const spec of specs) {
      const e = await engine.estimate({ capability: spec.capability, requested: spec.requestedOverride || b.requested, tier: b.tier, tags: spec.tags, seconds: spec.input.seconds, needImage: needsImage(spec.input), input: spec.input, excludeCn: !!Number(p.exclude_cn), exclude });
      lama += e.lama;
      label = e.model.label;
    }
    return { lama, label };
  }
  app.post('/api/studio/ai/projects/:id/estimate', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = runSchema.parse(req.body);
    const specs = await plan(req, p, b);
    const settings = await settingsOf();
    const { lama, label } = await priceSpecs(p, b, specs);
    // 자동 선택이면 '왜 이 모델?' 이유와 다른 후보를 함께 보여 줍니다(목소리를 정해 둔 음성 작업 제외).
    let why = [];
    const first = specs[0];
    if (b.requested === 'auto' && first && !first.requestedOverride) {
      try {
        why = await engine.explain({ capability: first.capability, tier: b.tier, tags: first.tags, seconds: first.input.seconds, needImage: needsImage(first.input), input: first.input, excludeCn: !!Number(p.exclude_cn) });
      } catch {}
    }
    const budget = await budgetOf(p);
    res.json({
      lama,
      jobs: specs.length,
      model: b.requested === 'auto' ? `자동 선택 (예: ${label})` : label,
      won: lama * 10,
      wallet: await lamaWalletOf(db, req.user.id),
      daily_limit: settings.ai_daily_limit_lama,
      capability: first?.capability || '',
      why,
      budget: { ...budget, over: budget.limit > 0 && budget.spent + lama > budget.limit },
    });
  });
  // 실행: 입력 검사 → (프로젝트 예산 확인) → 중복 검사·라마 예약(한 트랜잭션). AI 조수·다시 시도에서도 씁니다.
  async function runSpecs(req, p, b, specs, { exclude = [] } = {}) {
    for (const spec of specs) {
      await engine.screen({ userId: req.user.id, kind: spec.kind, texts: [spec.input.userText, spec.input.text] });
    }
    if (Number(p.budget_lama) > 0 && !b.budgetOk) {
      const budget = await budgetOf(p);
      const { lama } = await priceSpecs(p, b, specs, exclude);
      if (budget.spent + lama > budget.limit)
        throw Object.assign(new Error(`프로젝트 예산(${budget.limit.toLocaleString('ko-KR')}라마)을 넘어요. 지금까지 ${budget.spent.toLocaleString('ko-KR')}라마를 썼고, 이번 작업은 약 ${lama.toLocaleString('ko-KR')}라마예요.`), {
          status: 409,
          code: 'project_budget',
        });
    }
    return db.transaction(async () => {
      if (db.engine === 'postgresql') await db.get('SELECT id FROM studio_projects WHERE id=? FOR UPDATE', [p.id]);
      const out = [];
      for (const spec of specs) {
        const multi = specs.length > 1 || b.action.startsWith('batch_');
        const requestKey = b.idempotencyKey ? (multi ? `${b.idempotencyKey}:${spec.kind}:${spec.target.id}${spec.keySuffix ? ':' + spec.keySuffix : ''}` : b.idempotencyKey) : undefined;
        const previous = requestKey ? await db.get('SELECT * FROM ai_jobs WHERE idempotency_key=?', [requestKey]) : null;
        if (previous) {
          if (previous.user_id !== req.user.id || previous.project_id !== p.id || previous.kind !== spec.kind || previous.target_id !== spec.target.id)
            fail(409, '다른 AI 작업에 사용된 요청입니다. 다시 시작해 주세요.');
          out.push(previous);
          continue;
        }
        // 같은 대상의 같은 작업이 진행 중이면 새로 만들지 않습니다(인물 참고 이미지는 자세별로 따로).
        const active = spec.keySuffix
          ? null
          : await db.get("SELECT * FROM ai_jobs WHERE project_id=? AND kind=? AND target_id=? AND status IN ('queued','running')", [p.id, spec.kind, spec.target.id]);
        if (active) {
          if (!multi) fail(409, '같은 작업이 이미 진행 중이에요.');
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
            exclude,
          }),
        );
      }
      await db.run("UPDATE studio_projects SET status=CASE WHEN status='draft' THEN 'producing' ELSE status END,updated_at=? WHERE id=?", [now(), p.id]);
      return out;
    });
  }
  const jobsView = async (req, jobs) => ({
    jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, estimate_lama: Number(j.estimate_lama), status: j.status })),
    lama: jobs.reduce((n, j) => n + Number(j.estimate_lama), 0),
    wallet: await lamaWalletOf(db, req.user.id),
  });
  app.post('/api/studio/ai/projects/:id/run', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req);
    const b = runSchema.parse(req.body);
    const specs = await plan(req, p, b);
    res.status(201).json(await jobsView(req, await runSpecs(req, p, b, specs)));
  });
  // 실패한 작업 다시 시도: 같은 작업을 다시 만들되, 자동 선택이면 실패한 모델은 빼고 다음 후보로(직접 고르면 그 모델로).
  const RETRYABLE = new Set(['plan', 'poster', 'adapt', 'bible', 'season', 'metadata', 'music', 'script', 'diagnose', 'rewrite_range', 'character_image', 'character_ref', 'location_image', 'voice_sample', 'shot_image', 'shot_image_edit', 'shot_tts', 'shot_video', 'shot_lipsync', 'shot_sfx', 'rewrite_shot']);
  app.post('/api/studio/ai/jobs/:jid/retry', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const job = await db.get('SELECT * FROM ai_jobs WHERE id=?', [req.params.jid]);
    if (!job || !job.project_id) fail(404, '작업을 찾을 수 없어요.');
    const p = await project(req, job.project_id);
    if (!['failed', 'canceled'].includes(job.status)) fail(400, '실패하거나 취소한 작업만 다시 시도할 수 있어요.');
    if (!RETRYABLE.has(job.kind)) fail(400, '이 작업은 원래 화면에서 다시 시작해 주세요.');
    const body = z.object({ requested: z.string().max(80).default('auto'), tier: z.enum(['draft', 'standard', 'premium']).optional(), budgetOk: z.boolean().optional() }).parse(req.body || {});
    let input = {};
    try {
      input = JSON.parse(job.input || '{}');
    } catch {}
    const options = {};
    if (job.kind === 'character_ref') options.pose = input.pose;
    if (job.kind === 'rewrite_range') options.shotIds = input.shotIds;
    if (job.kind === 'music') {
      options.seconds = input.seconds;
      if (input.userText) options.mood = String(input.userText).slice(0, 200);
    }
    const instruction = ['rewrite_range', 'script'].includes(job.kind) ? input.userInstruction : ['rewrite_shot', 'shot_image_edit'].includes(job.kind) ? input.userText : undefined;
    const b = runSchema.parse({
      action: job.kind,
      targetId: job.target_type === 'project' || job.target_type === 'music' ? p.id : job.target_id,
      ...(instruction ? { instruction: String(instruction).slice(0, 300) } : {}),
      options,
      requested: body.requested,
      tier: body.tier || job.tier,
      budgetOk: body.budgetOk,
    });
    const specs = await plan(req, p, b);
    const exclude = body.requested === 'auto' && job.model_ref ? [job.model_ref] : [];
    res.status(201).json(await jobsView(req, await runSpecs(req, p, b, specs, { exclude })));
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
  // 회차 합성 시작(검사 후 합성 대기열에 넣음). 빠른 제작에서도 같은 함수를 씁니다.
  async function startCompose(p, e) {
    const shots = await shotsOf(e.id);
    const busy = await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND target_type='shot' AND status IN ('queued','running') AND target_id IN (SELECT id FROM studio_shots WHERE episode_id=?) LIMIT 1", [p.id, e.id]);
    if (busy) fail(409, '이 회차의 AI 작업이 끝난 뒤 합성해 주세요.');
    if (!shots.length) fail(400, '대본(컷)이 없어요. 대본을 먼저 만들어 주세요.');
    const missing = shots.findIndex((s) => !s.video && !s.image && !s.lipsync);
    if (missing >= 0) fail(400, `${missing + 1}번째 컷에 영상이나 스토리보드 이미지가 없어요.`);
    try {
      // 대기열에 넣고 바로 돌려줍니다(같은 회차를 동시에 눌러도 한 번만 들어감).
      await renderer.queueEpisode(p, e);
    } catch (err) {
      fail(err.status || 500, err.message);
    }
  }
  app.post('/api/studio/ai/projects/:id/episodes/:eid/compose', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    await startCompose(p, e);
    res.status(202).json({ ok: true });
  });
  app.get('/api/studio/ai/projects/:id/episodes/:eid/compose', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const e = await db.get('SELECT id,status,video,duration,compose_progress,compose_error FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    const r = await db.get("SELECT status,created_at FROM studio_renders WHERE kind='episode' AND target_id=? ORDER BY created_at DESC LIMIT 1", [e.id]);
    // 대기 순서: 나보다 먼저 들어온 대기 중 합성 수
    const ahead = r?.status === 'queued' ? Number((await db.get("SELECT COUNT(*) AS n FROM studio_renders WHERE status IN ('queued','running') AND created_at<?", [r.created_at]))?.n || 0) : 0;
    res.json({ ...e, progress: Number(e.compose_progress || 0), queue: ahead, error: e.status === 'compose_failed' ? e.compose_error || '합성에 실패했어요.' : '' });
  });

  // 작품으로 내보내기: 합성된 회차를 작품(드라마)의 회차로 등록하고, 원하면 바로 검수를 신청합니다.
  app.post('/api/studio/ai/projects/:id/export', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req);
    const img = z.string().regex(/^\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/);
    const b = z
      .object({
        title: z.string().trim().min(1).max(70).optional(),
        tagline: z.string().trim().min(2).max(120),
        synopsis: z.string().trim().min(10).max(3000).optional(),
        hashtags: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
        free: z.boolean().default(false),
        episode_pings: z.number().int().min(0).max(1000).default(0),
        free_episodes: z.number().int().min(1).max(50).default(1),
        image: img.optional(),
        // 썸네일 A/B 비교 후보(대표 포스터 외 1~3장)
        variants: z.array(img).max(3).default([]),
        attachTrailer: z.boolean().default(true),
        // 연재 중인 작품에 회차 추가: 공개 예약 시각(선택)
        publish_at: z.string().datetime().nullable().optional(),
        submit: z.boolean().default(false),
      })
      .parse(req.body);
    const all = await episodesOf(p.id);
    const composed = all.filter((e) => e.video);
    if (!composed.length) fail(400, '합성이 끝난 회차가 없어요. 회차를 먼저 합성해 주세요.');
    const image = b.image || p.poster || (await db.get("SELECT image FROM studio_characters WHERE project_id=? AND image<>'' LIMIT 1", [p.id]))?.image;
    if (!image) fail(400, '포스터를 먼저 만들거나 골라 주세요.');
    if (!existsSync(path.join(uploadDir, path.basename(image))) && image.startsWith('/uploads/')) fail(400, '포스터 파일을 찾을 수 없어요.');
    // 직접 고른 포스터·썸네일 후보는 본인(또는 프로젝트 소유자)이 올린·만든 파일이어야 합니다.
    for (const url of [b.image, ...b.variants].filter((u) => u && u.startsWith('/uploads/'))) {
      const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [url]);
      if (!f || (f.owner_id !== p.owner_id && f.owner_id !== req.user.id && req.user.role !== 'admin'))
        fail(403, '본인이 올리거나 만든 이미지만 포스터로 쓸 수 있어요.');
    }
    if (b.publish_at && new Date(b.publish_at).getTime() <= Date.now()) fail(400, '공개 예약 시각은 지금보다 뒤여야 해요.');
    const result = await db.transaction(async () => {
      let drama = p.drama_id ? await db.get('SELECT * FROM dramas WHERE id=?', [p.drama_id]) : null;
      if (drama && ['pending', 'hidden'].includes(drama.status))
        fail(409, drama.status === 'pending' ? '작품 검수 중이에요. 검수가 끝난 뒤 다시 내보내 주세요.' : '관리자가 노출을 멈춘 작품이에요. 고객센터로 문의해 주세요.');
      const serial = drama?.status === 'published';
      const existing = drama ? await db.all('SELECT number,review_status FROM episodes WHERE drama_id=? ORDER BY number', [drama.id]) : [];
      // 내보낼 회차: 연재 중이면 아직 공개 전인 회차(새 번호 포함)만, 아니면 1화부터 전부
      const locked = new Set(existing.filter((x) => !['draft', 'rejected'].includes(x.review_status) && serial).map((x) => Number(x.number)));
      const targets = composed.filter((e) => !locked.has(Number(e.number)));
      if (!targets.length) fail(400, serial ? '새로 공개할 회차가 없어요. 다음 회차를 합성한 뒤 내보내 주세요.' : '내보낼 회차가 없어요.');
      const maxExisting = existing.length ? Math.max(...existing.map((x) => Number(x.number))) : 0;
      const numbers = [...new Set([...existing.map((x) => Number(x.number)), ...targets.map((e) => Number(e.number))])].sort((x, y) => x - y);
      if (numbers.some((n, i) => n !== i + 1)) fail(400, '1화부터 빠짐없이 합성한 회차만 내보낼 수 있어요.');
      if (serial && targets.some((e) => e.number > maxExisting + targets.length)) fail(400, '회차 번호가 이어지지 않아요.');
      // 합성한 뒤 컷·이미지·음성이 바뀌었거나 합성 중·실패한 회차는 옛 영상이 나가지 않도록 막습니다.
      const stale = targets.filter((e) => e.status !== 'composed');
      if (stale.length)
        fail(409, `${stale.map((e) => e.number + '화').join(', ')}는 합성한 뒤 내용이 바뀌었거나 합성이 끝나지 않았어요. 다시 합성한 뒤 내보내 주세요.`);
      const synopsis = (b.synopsis || p.synopsis || p.logline).padEnd(10, ' ').slice(0, 3000);
      const title = (b.title || p.title).slice(0, 70);
      const hashtags = b.hashtags.map((h) => h.replace(/^#/, '')).filter(Boolean).join(',');
      const channel = await db.get('SELECT id FROM channels WHERE owner_id=?', [p.owner_id]);
      const trailer = b.attachTrailer && p.trailer ? p.trailer : drama?.trailer || '';
      if (!drama) {
        const id = randomUUID();
        await db.run(
          "INSERT INTO dramas (id,owner_id,title,tagline,synopsis,genre,image,free,episode_pings,free_episodes,created_at,channel_id,rights_confirmed,likeness_confirmed,ai_usage,declared_at,hashtags,trailer,subtitle_style) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,'full',?,?,?,?)",
          [id, p.owner_id, title, b.tagline, synopsis, p.genre, image, b.free ? 1 : 0, b.episode_pings, b.free_episodes, now(), channel?.id || null, now(), hashtags, trailer, p.subtitle_style || ''],
        );
        drama = await db.get('SELECT * FROM dramas WHERE id=?', [id]);
        await db.run('UPDATE studio_projects SET drama_id=? WHERE id=?', [id, p.id]);
      } else if (!serial) {
        await db.run(
          "UPDATE dramas SET title=?,tagline=?,synopsis=?,genre=?,image=?,free=?,episode_pings=?,free_episodes=?,rights_confirmed=1,likeness_confirmed=1,ai_usage=CASE WHEN ai_usage='none' THEN 'partial' ELSE ai_usage END,declared_at=?,hashtags=?,trailer=?,subtitle_style=? WHERE id=?",
          [title, b.tagline, synopsis, p.genre, image, b.free ? 1 : 0, b.episode_pings, b.free_episodes, now(), hashtags, trailer, p.subtitle_style || '', drama.id],
        );
      } else {
        // 연재 중: 작품 정보(가격·포스터)는 그대로 두고, 예고편·해시태그만 보탭니다.
        await db.run('UPDATE dramas SET trailer=CASE WHEN ?<>\'\' THEN ? ELSE trailer END, hashtags=CASE WHEN ?<>\'\' THEN ? ELSE hashtags END WHERE id=?', [trailer, trailer, hashtags, hashtags, drama.id]);
      }
      for (const e of targets) {
        await db.run(
          "INSERT INTO episodes (id,drama_id,number,title,video,duration,source,subtitles,studio_episode_id,thumbnail,review_status) VALUES (?,?,?,?,?,?,'studio',?,?,?,?) ON CONFLICT(drama_id,number) DO UPDATE SET title=excluded.title,video=excluded.video,duration=excluded.duration,source='studio',subtitles=excluded.subtitles,studio_episode_id=excluded.studio_episode_id,thumbnail=excluded.thumbnail",
          [randomUUID(), drama.id, e.number, e.title.slice(0, 100), e.video, Math.max(1, Number(e.duration)), e.subtitles || '', e.id, e.thumbnail || '', serial ? 'draft' : 'approved'],
        );
        await db.run('UPDATE studio_episodes SET exported_at=? WHERE id=?', [now(), e.id]);
      }
      // 썸네일 A/B: 대표 포스터 + 후보를 비교 목록으로 등록(이미 있는 이미지는 건너뜀)
      if (b.variants.length) {
        const have = new Set((await db.all('SELECT url FROM drama_thumbnails WHERE drama_id=?', [drama.id])).map((r) => r.url));
        for (const url of [image, ...b.variants]) {
          if (have.has(url)) continue;
          have.add(url);
          await db.run('INSERT INTO drama_thumbnails (id,drama_id,url,created_at) VALUES (?,?,?,?)', [randomUUID(), drama.id, url, now()]);
        }
      }
      await db.run("UPDATE studio_projects SET status='exported',updated_at=? WHERE id=?", [now(), p.id]);
      let submitted = false;
      const stamp = now();
      if (b.submit && serial) {
        // 연재: 새 회차만 회차 단위 검수로(예약 공개 시각 포함)
        for (const e of targets)
          await db.run("UPDATE episodes SET review_status='pending',review_note='',submitted_at=?,publish_at=? WHERE drama_id=? AND number=?", [stamp, b.publish_at || null, drama.id, e.number]);
        await db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), req.user.id, 'episode:pending', drama.id, stamp]);
        submitted = true;
      } else if (b.submit) {
        const fresh = await db.get('SELECT * FROM dramas WHERE id=?', [drama.id]);
        const { issues } = await contentIssues(fresh);
        if (issues.length) fail(400, issues.join(' '));
        await db.run("UPDATE dramas SET status='pending',review_note='' WHERE id=?", [drama.id]);
        if (b.publish_at) await db.run('UPDATE episodes SET publish_at=? WHERE drama_id=?', [b.publish_at, drama.id]);
        await db.run('INSERT INTO content_reviews (id,drama_id,actor_id,status,note,created_at) VALUES (?,?,?,?,?,?)', [randomUUID(), drama.id, req.user.id, 'pending', '숏핑 스튜디오에서 검수 신청', stamp]);
        await db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), req.user.id, 'pending', drama.id, stamp]);
        submitted = true;
      }
      return { dramaId: drama.id, episodes: targets.length, numbers: targets.map((e) => e.number), submitted, serial };
    });
    res.json(result);
  });
  // 제목·소개·해시태그 AI 제안 중 고른 값을 프로젝트에 반영(작품 내보내기 입력칸 기본값으로 씀)
  app.post('/api/studio/ai/projects/:id/metadata/apply', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    const b = z
      .object({ title: z.string().trim().min(1).max(70).optional(), synopsis: z.string().trim().max(3000).optional(), episodeTitles: z.boolean().default(false) })
      .parse(req.body);
    let meta = {};
    try {
      meta = JSON.parse(p.meta || '{}');
    } catch {}
    if (b.title) await db.run('UPDATE studio_projects SET title=? WHERE id=?', [b.title, p.id]);
    if (b.synopsis) await db.run('UPDATE studio_projects SET synopsis=? WHERE id=?', [b.synopsis, p.id]);
    if (b.episodeTitles)
      for (const et of meta.episode_titles || [])
        await db.run('UPDATE studio_episodes SET title=? WHERE project_id=? AND number=?', [String(et.title).slice(0, 100), p.id, Number(et.number)]);
    await touch(p.id);
    res.json({ ok: true });
  });

  // ── 빠른 제작(오토파일럿) ─────────────────────────────────────
  // 기획 → 인물 이미지 → 대본 → 스토리보드 → 대사 음성 → (선택) 컷 영상 → 회차 합성까지 빈 곳만 차례로 채웁니다.
  // PD가 정한 최대 라마를 넘으면 멈추고, 같은 단계가 두 번 연속 채워지지 않으면(실패) 멈춰서 알려 줍니다.
  const choiceSchema = z.object({ requested: z.string().max(80).default('auto'), tier: z.enum(['draft', 'standard', 'premium']).default('standard') });
  const autopilotSchema = z.object({
    choices: z
      .object({
        text: choiceSchema.default({}),
        image: choiceSchema.default({}),
        tts: choiceSchema.default({}),
        video: choiceSchema.default({ requested: 'auto', tier: 'draft' }),
        music: choiceSchema.default({}),
        sfx: choiceSchema.default({}),
        lipsync: choiceSchema.default({}),
      })
      .default({}),
    includeVideo: z.boolean().default(false),
    includeBible: z.boolean().default(false),
    includeLipsync: z.boolean().default(false),
    includeSfx: z.boolean().default(false),
    includeMusic: z.boolean().default(false),
    musicMood: z.string().max(200).default(''),
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
    // 빠른 제작: 설정집과 회차별 훅·반전을 먼저 잡아 두면 대본이 회차끼리 잘 이어집니다.
    if (ap.includeBible && !p.bible) return { stage: 'bible', specs: [await buildJob(req, p, 'bible')] };
    if (ap.includeBible && eps.length > 1 && !p.season) return { stage: 'season', specs: [await buildJob(req, p, 'season')] };
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
      const video = shots.filter((x) => !x.video && String(x.visual || '').trim());
      if (video.length) return { stage: 'video', specs: await specs('shot_video', video.map((x) => x.id)) };
      if (ap.includeLipsync) {
        const sync = shots.filter((x) => x.video && x.audio && !x.lipsync);
        if (sync.length) return { stage: 'lipsync', specs: await specs('shot_lipsync', sync.map((x) => x.id)) };
      }
    }
    if (ap.includeSfx) {
      const sfx = shots.filter((x) => String(x.sfx_prompt || '').trim() && !x.sfx);
      if (sfx.length) return { stage: 'sfx', specs: await specs('shot_sfx', sfx.map((x) => x.id)) };
    }
    if (ap.includeMusic && !p.bgm) return { stage: 'music', specs: [await buildJob(req, p, 'music', p.id, { options: { mood: ap.musicMood || p.tone } })] };
    const compose = eps.find((e) => withShots.has(e.id) && (!e.video || e.status !== 'composed'));
    if (compose) return { stage: 'compose', episode: compose };
    return { stage: 'done' };
  }
  const choiceFor = (ap, capability) => ap.choices?.[capability] || { requested: 'auto', tier: 'standard' };
  async function estimateSpecs(p, ap, specs) {
    let lama = 0;
    for (const spec of specs) {
      const c = choiceFor(ap, spec.capability);
      const e = await engine.estimate({ capability: spec.capability, requested: spec.requestedOverride || c.requested, tier: c.tier, tags: spec.tags, seconds: spec.input.seconds, needImage: needsImage(spec.input), input: spec.input, excludeCn: !!Number(p.exclude_cn) });
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
    const sfxCount = shots.filter((x) => String(x.sfx_prompt || '').trim() && !x.sfx).length + Math.ceil(unscripted * guessShots * 0.4);
    const per = async (capability, units, count) => {
      if (!count) return 0;
      const one = await price(capability, units);
      return one === null ? null : one * count;
    };
    const stages = [
      { stage: 'plan', label: AP_STAGES.plan, count: cast.length ? 0 : 1, lama: cast.length ? 0 : await per('text', 4.5, 1) },
      ...(ap.includeBible
        ? [
            { stage: 'bible', label: AP_STAGES.bible, count: p.bible ? 0 : 1, lama: p.bible ? 0 : await per('text', 3.5, 1) },
            { stage: 'season', label: AP_STAGES.season, count: p.season || eps.length < 2 ? 0 : 1, lama: p.season || eps.length < 2 ? 0 : await per('text', 7, 1) },
          ]
        : []),
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
      ...(ap.includeVideo && ap.includeLipsync
        ? [{ stage: 'lipsync', label: AP_STAGES.lipsync + ` (대사 컷 약 ${Math.round(videoSeconds * 0.6)}초)`, count: voiceCount, lama: voiceCount ? await price('lipsync', Math.round(videoSeconds * 0.6)) : 0 }]
        : []),
      ...(ap.includeSfx
        ? [{ stage: 'sfx', label: AP_STAGES.sfx, count: sfxCount, lama: sfxCount ? await per('sfx', 4, sfxCount) : 0 }]
        : []),
      ...(ap.includeMusic ? [{ stage: 'music', label: AP_STAGES.music, count: p.bgm ? 0 : 1, lama: p.bgm ? 0 : await price('music', Number(p.episode_seconds) || 60) }] : []),
      { stage: 'compose', label: AP_STAGES.compose + ' (무료)', count: eps.length, lama: 0 },
    ];
    const unavailable = stages.filter((x) => x.lama === null).map((x) => x.label);
    return { stages, total: stages.reduce((n, x) => n + (x.lama || 0), 0), unavailable };
  }
  async function saveAutopilot(id, ap) {
    await db.run('UPDATE studio_projects SET autopilot=?,updated_at=? WHERE id=?', [JSON.stringify(ap), now(), id]);
  }
  // 진행 로직이 저장할 때는 "그 회차의 빠른 제작이 아직 진행 중일 때만" 저장합니다.
  // 그사이 PD가 멈추기를 눌렀다면 멈춘 상태를 덮어쓰지 않습니다.
  async function saveIfRunning(id, run, ap) {
    const cur = parseAutopilot((await db.get('SELECT autopilot FROM studio_projects WHERE id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''), [id]))?.autopilot);
    if (!cur || cur.status !== 'running' || (cur.run || '') !== (run || '')) return false;
    await saveAutopilot(id, ap);
    return true;
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
      const save = async (next) => {
        const saved = await db.transaction(() => saveIfRunning(p.id, ap.run, next));
        // 빠른 제작이 끝나거나 멈추면 PD에게 알림을 남깁니다(스튜디오 밖에 있어도 알 수 있게).
        if (saved && next.status === 'done') await notify(db, p.owner_id, { kind: 'autopilot', title: `${p.title} 빠른 제작이 끝났어요`, body: next.message, link: `studio/ai/${p.id}/finish` });
        if (saved && next.status === 'paused') await notify(db, p.owner_id, { kind: 'autopilot_paused', title: `${p.title} 빠른 제작이 멈췄어요`, body: next.message, link: `studio/ai/${p.id}` });
        return saved;
      };
      const pause = async (message) => save({ ...ap, status: 'paused', message, updated_at: now() });
      let work;
      try {
        work = await stageWork(p, ap);
      } catch (e) {
        return pause(e.message);
      }
      if (work.stage === 'done') return save({ ...ap, status: 'done', stage: 'done', message: '초안이 모두 완성됐어요. 확인한 뒤 내보내기에서 검수를 신청하세요.', updated_at: now() });
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
        return save({ ...ap, stage: 'compose', signature, repeat, message: `${work.episode.number}화 합성 중`, updated_at: now() });
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
        const queuedOk = await db.transaction(async () => {
          // 등록 직전에 다시 확인: 멈췄으면 아무것도 등록하지 않습니다(같은 트랜잭션에서 상태도 갱신).
          if (!(await saveIfRunning(p.id, ap.run, { ...ap, stage: work.stage, signature, repeat, message: `${AP_STAGES[work.stage]} ${work.specs.length}건 진행 중`, spent, updated_at: now() })))
            return false;
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
          return true;
        });
        if (!queuedOk) return;
      } catch (e) {
        return pause(e.message);
      }
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
    // 빠른 제작은 PD 본인 라마를 쓰므로 PD 본인만 시작할 수 있습니다(관리자는 멈추기만 가능).
    if (p.owner_id !== req.user.id) fail(403, '빠른 제작은 프로젝트를 만든 PD 본인만 시작할 수 있어요.');
    const b = autopilotSchema.parse(req.body);
    const current = parseAutopilot(p.autopilot);
    if (current?.status === 'running') fail(409, '빠른 제작이 이미 진행 중이에요.');
    const est = await autopilotEstimate(p, b);
    const cap = b.cap ?? Math.ceil(est.total * 1.3) + 10;
    const wallet = await lamaWalletOf(db, req.user.id);
    if (wallet.total < Math.min(cap, est.total))
      fail(400, `라마가 부족해요. 예상 ${est.total.toLocaleString('ko-KR')}라마가 필요하고 사용 가능한 라마는 ${wallet.total.toLocaleString('ko-KR')}라마예요.`);
    const ap = { ...b, cap, run: randomUUID(), status: 'running', stage: '', repeat: 0, started_at: now(), estimate: est.total, message: '빠른 제작을 시작했어요.', updated_at: now() };
    await saveAutopilot(p.id, ap);
    void advanceAutopilot(p.id);
    res.status(201).json({ autopilot: ap });
  });
  app.post('/api/studio/ai/projects/:id/autopilot/stop', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req);
    // 먼저 멈춤 상태를 저장(행 잠금)한 뒤 대기 작업을 취소합니다. 진행 로직은 등록 직전에 상태를 다시
    // 확인하므로, 멈춘 뒤에는 새 작업이 등록되지 않습니다.
    const ap = await db.transaction(async () => {
      const cur = parseAutopilot((await db.get('SELECT autopilot FROM studio_projects WHERE id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''), [p.id]))?.autopilot);
      if (!cur || cur.status !== 'running') fail(409, '진행 중인 빠른 제작이 없어요.');
      await saveAutopilot(p.id, { ...cur, status: 'stopped', message: '멈췄어요.', updated_at: now() });
      return cur;
    });
    // 이미 시작된 AI 작업은 끝까지 처리하고, 대기 중인 작업은 취소해 라마를 돌려줍니다.
    const queued = await db.all("SELECT id FROM ai_jobs WHERE project_id=? AND status='queued'", [p.id]);
    let canceled = 0;
    for (const j of queued) if (await engine.cancel(j.id, req.user).then(() => true, () => false)) canceled++;
    await saveAutopilot(p.id, { ...ap, status: 'stopped', message: `멈췄어요. 대기 중이던 작업 ${canceled}건은 취소하고 라마를 돌려드렸어요.`, updated_at: now() });
    res.json({ ok: true, canceled });
  });
  // PD 스튜디오 상단 표시용: 진행 중인 AI 작업·빠른 제작 요약
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
    const e = await db.get('SELECT * FROM episodes WHERE drama_id=? AND number=?', [d.id, b.number]);
    if (!e?.video) fail(404, '회차 영상을 찾을 수 없어요.');
    if (!episodeEditable(d, e)) fail(409, '임시저장 · 반려 작품이나 공개 전 새 회차에서만 자막을 만들 수 있어요.');
    const src = e.video.startsWith('/demo/') ? path.resolve('public/demo/preview.mp4') : path.join(uploadDir, path.basename(e.video));
    const meta = await db.get('SELECT duration,has_audio FROM media_metadata WHERE url=?', [e.video]);
    const probed = await probeMedia(src);
    if (!probed.hasAudio || (meta && Number(meta.has_audio) === 0)) fail(400, '소리가 없는 영상이라 자막을 만들 수 없어요.');
    const audio = randomUUID() + '.mp3';
    await runFfmpeg(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', path.join(uploadDir, audio)], 240000);
    await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', ['/uploads/' + audio, req.user.id, 'audio/mpeg', now()]);
    const duration = Math.max(1, Math.round(probed.duration || Number(meta?.duration || e.duration || 60)));
    let job;
    try {
      job = await db.transaction(() =>
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
    } catch (error) {
      // 한도 초과 등으로 작업을 못 만들면 방금 뽑은 음성 파일도 지웁니다.
      await removeTemp('/uploads/' + audio);
      throw error;
    }
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
  studioPlusRoutes({ app, db, fail, now, roles, engine, renderer, uploadDir, project, touch, queueTranslate, shotsOf, charactersOf, episodesOf });
  shotMediaRoutes({ app, db, fail, now, roles, uploadDir, loadShot, project });
  qualityRoutes({ app, db, fail, now, roles, project, charactersOf, episodesOf, shotsOf });
  chatApi = assistantRoutes({ app, db, fail, now, roles, engine, project, requireTerms, plan, runSpecs, runSchema, estimateSpecs: priceSpecs, charactersOf, episodesOf, shotsOf, locationsOf, queueTranslate, settingsOf });
  // 목소리 라이브러리 샘플은 모든 PD가 함께 들을 수 있습니다.
  app.get('/api/studio/ai/voices/sample/:file', roles('pd', 'admin'), async (req, res) => {
    if (!/^[a-f0-9-]+\.(mp3|wav)$/.test(req.params.file)) fail(404, '파일을 찾을 수 없어요.');
    if (!(await db.get('SELECT voice FROM voice_samples WHERE url=?', ['/uploads/' + req.params.file]))) fail(404, '파일을 찾을 수 없어요.');
    res.sendFile(path.join(uploadDir, req.params.file));
  });
  return { precheck };
}
