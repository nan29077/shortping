import { z } from 'zod';
import { episodeEditable } from '../routes-serial.mjs';
import { randomUUID } from 'node:crypto';
import { copyFile, writeFile, mkdir, rm } from 'node:fs/promises';
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
  parseScriptPrompt,
  parseScriptSchema,
  propPrompt,
  verifyPrompt,
  lookOf,
  videoVerifyPrompt,
  videoVerifySchema,
  verifySchema,
  bridgePrompt,
  variantsPrompt,
  variantsSchema,
  reverseScriptPrompt,
  reverseScriptSchema,
} from './prompts.mjs';
import { studioPlusRoutes } from './studio-plus.mjs';
import { notify } from '../notify.mjs';
import { familyList } from './model-guide.mjs';
import { assistantRoutes } from './assistant.mjs';
import { shotMediaRoutes } from './shot-media.mjs';
import { qualityRoutes } from './quality.mjs';
import { libraryRoutes } from './library.mjs';
import { can, ROLE_NAME, needText, actionNeed } from './team.mjs';
import { collabRoutes } from './collab.mjs';
import { CAMERA_MOVES, ANGLE_IDS, LENS_IDS, STRENGTH_IDS, SHOT_EFFECTS, LIGHT_IDS, TONE_IDS, HEIGHT_IDS, angleOf, lensOf, lightOf, toneOf, isComplexMove, toneGrade, lightText } from './direction.mjs';

// 숏핑 스튜디오(AI 제작) API: 프로젝트 → 기획 → 캐릭터 → 대본(컷) → 스토리보드 → 음성 → 영상 → 합성 → 작품으로 내보내기·검수 신청.
// 비용이 드는 단계는 모두 AI 작업 대기열(engine)을 거치고, 라마 예약·차감·반환은 엔진이 맡습니다.
export { GENRES } from '../genres.mjs';
import { GENRES } from '../genres.mjs';
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
  board: '컷 이미지',
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
  // 프로젝트 접근: 소유자·관리자는 모든 권한, 협업자는 역할에 따라(need: view·script·scene·approve·manage).
  // 협업자가 아닌 사람에게는 프로젝트가 있는지조차 알리지 않아요(404).
  const project = async (req, id = req.params.id, need = 'manage') => {
    const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [id]);
    if (!p) fail(404, '프로젝트를 찾을 수 없어요.');
    if (p.owner_id === req.user.id || req.user.role === 'admin') {
      req.teamRole = 'owner';
      req.teamMember = null;
      return p;
    }
    const m = await memberOf(p.id, req.user);
    if (!m) fail(404, '프로젝트를 찾을 수 없어요.');
    // 소유자가 이용 제한 · 탈퇴 상태면 협업자는 프로젝트를 열 수 없어요(소유자 라마로 계속 작업되지 않도록).
    const owner = await db.get('SELECT status FROM users WHERE id=?', [p.owner_id]);
    if (owner?.status !== 'active') fail(403, '프로젝트 소유자 계정을 지금 이용할 수 없어 함께 작업할 수 없어요.');
    if (!can(m.role, need)) fail(403, `${ROLE_NAME[m.role] || m.role} 역할은 ${needText(need)} 권한이 없어요. 프로젝트 소유자에게 역할 변경을 요청해 주세요.`);
    req.teamRole = m.role;
    req.teamMember = m;
    return p;
  };
  // 협업 멤버(기능이 꺼져 있거나 시청자 계정이면 없음)
  const memberOf = async (projectId, user) => {
    if (!user || !['pd', 'admin'].includes(user.role)) return null;
    if (!Number((await settingsOf()).studio_collab_enabled)) return null;
    return db.get('SELECT * FROM studio_members WHERE project_id=? AND user_id=?', [projectId, user.id]);
  };
  let chatApi = null; // AI 조수(assistant.mjs) — 아래에서 연결
  let shotMedia = null; // 내 소재·마스크(shot-media.mjs) — 아래에서 연결
  const touch = (id) => db.run('UPDATE studio_projects SET updated_at=? WHERE id=?', [now(), id]);
  const charactersOf = (pid) => db.all('SELECT * FROM studio_characters WHERE project_id=? ORDER BY sort_order, name', [pid]);
  const episodesOf = (pid) => db.all('SELECT * FROM studio_episodes WHERE project_id=? ORDER BY number', [pid]);
  const shotsOf = (eid) => db.all('SELECT * FROM studio_shots WHERE episode_id=? ORDER BY sort_order', [eid]);
  const collab = collabRoutes({ app, db, fail, now, roles, project, memberOf, settings: () => loadSettings(db) });
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
  const imageRef = (url) => (url && url.startsWith('/uploads/') ? { path: url, mime: /\.png$/.test(url) ? 'image/png' : /\.webp$/.test(url) ? 'image/webp' : 'image/jpeg' } : undefined);
  const loadShot = async (req, shotId, need = 'manage') => {
    const s = await db.get(
      'SELECT s.*, e.project_id, e.number AS episode_number FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=?',
      [shotId],
    );
    if (!s) fail(404, '컷을 찾을 수 없어요.');
    await project(req, s.project_id, need);
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
  // reuseIds: 대본을 다시 쓸 때 같은 순번의 옛 컷 ID를 그대로 써서, 컷에 매인 버전 기록 · 의견 · 작업 기록이 고아가 되지 않게 해요(2026-09-30).
  async function insertShots(episodeId, projectId, list, startOrder = 0, reuseIds = []) {
    const cast = await charactersOf(projectId);
    const places = await locationsOf(projectId);
    const things = await propsOf(projectId);
    const idOf = (name) => cast.find((c) => c.name === String(name || '').trim())?.id || null;
    const placeOf = (name) => places.find((l) => l.name === String(name || '').trim())?.id || null;
    const propOf = (name) => things.find((x) => x.name === String(name || '').trim())?.id || null;
    let i = startOrder;
    let n = 0;
    for (const s of list) {
      const shotId = reuseIds[n++] || randomUUID();
      const narration = String(s.speaker || '').trim() === '내레이션';
      const speakerId = narration ? null : idOf(s.speaker);
      const castIds = [...new Set([...(s.cast || []).map(idOf), speakerId].filter(Boolean))].join(',');
      const en = s.visual_en || (/[가-힣]/.test(s.visual) ? '' : s.visual);
      // 인물 상태: 이름 → 인물 ID('기본'은 원래 모습으로 돌아감)
      const states = {};
      for (const [name, v] of Object.entries(s.states || {})) {
        const cid = idOf(name);
        if (cid && String(v || '').trim()) states[cid] = String(v).trim().slice(0, 120);
      }
      const propIds = [...new Set((s.props || []).map(propOf).filter(Boolean))].join(',');
      await db.run(
        'INSERT INTO studio_shots (id,episode_id,sort_order,scene,visual,visual_en,visual_en_src,dialogue,speaker_id,cast_ids,camera,camera_move,angle,lens,light,tone,emotion,narration,sfx_prompt,seconds,location_id,prop_ids,states) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [shotId, episodeId, i++, s.scene, s.visual, en, en ? s.visual : '', s.dialogue, s.dialogue ? speakerId : null, castIds, s.camera, s.camera_move || '', angleOf(s.angle), lensOf(s.lens), lightOf(s.light), toneOf(s.tone), s.emotion || '', narration && s.dialogue ? 1 : 0, s.sfx || '', Math.round(Math.min(10, Math.max(2, s.seconds))), placeOf(s.location), propIds, Object.keys(states).length ? JSON.stringify(states) : ''],
      );
    }
    return i;
  }
  // AI가 쓴 컷(이름 기준) → 버전 기록용 컷(ID 기준). 대본 변형처럼 지금 컷을 바꾸지 않고 버전으로만 남길 때 씁니다.
  async function versionRows(projectId, list) {
    const cast = await charactersOf(projectId);
    const places = await locationsOf(projectId);
    const things = await propsOf(projectId);
    const idOf = (name) => cast.find((c) => c.name === String(name || '').trim())?.id || null;
    return list.map((s) => {
      const narration = String(s.speaker || '').trim() === '내레이션';
      const speakerId = narration ? null : idOf(s.speaker);
      const states = {};
      for (const [name, v] of Object.entries(s.states || {})) if (idOf(name) && String(v || '').trim()) states[idOf(name)] = String(v).trim().slice(0, 120);
      return {
        scene: s.scene, visual: s.visual, visual_en: s.visual_en || '', visual_en_src: s.visual_en ? s.visual : '', dialogue: s.dialogue, speaker_id: s.dialogue ? speakerId : null,
        cast_ids: [...new Set([...(s.cast || []).map(idOf), speakerId].filter(Boolean))].join(','),
        location_id: places.find((l) => l.name === String(s.location || '').trim())?.id || null,
        camera: s.camera, camera_move: s.camera_move || '', angle: angleOf(s.angle), lens: lensOf(s.lens), light: lightOf(s.light), tone: toneOf(s.tone), emotion: s.emotion || '', speed: 1, narration: narration && s.dialogue ? 1 : 0,
        seconds: Math.round(Math.min(10, Math.max(2, s.seconds))), sfx_prompt: s.sfx || '', transition: 'cut',
        prop_ids: [...new Set((s.props || []).map((n) => things.find((x) => x.name === String(n).trim())?.id).filter(Boolean))].join(','),
        states: Object.keys(states).length ? JSON.stringify(states) : '',
      };
    });
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
      prop_ids: x.prop_ids, states: x.states,
      angle: x.angle, lens: x.lens, move_strength: x.move_strength, end_image: x.end_image, effect: x.effect,
      // 되돌려도 같은 그림이 이어지도록 시드 · 끝 장면 · 화질 올림 · 검수 결과까지 남겨요.
      seed: x.seed, seed_lock: x.seed_lock, end_frame: x.end_frame, upscaled: x.upscaled, verify: x.verify,
      light: x.light, tone: x.tone, height: x.height, dof: x.dof, focal: x.focal,
    }));
    await db.run('INSERT INTO studio_script_versions (id,project_id,episode_id,version,shots,source,note,created_at) VALUES (?,?,?,?,?,?,?,?)', [
      randomUUID(), projectId, episodeId, version, JSON.stringify(keep), source, note.slice(0, 200), now(),
    ]);
    // 대본이 바뀌면 받은 대본 승인(요청·승인)은 다시 받아야 해요.
    await db.run("UPDATE studio_episodes SET script_version=?,script_review=CASE WHEN script_review IN ('approved','requested') THEN '' ELSE script_review END WHERE id=?", [version, episodeId]);
    // 오래된 버전은 회차당 30개까지만 남깁니다.
    await db.run('DELETE FROM studio_script_versions WHERE episode_id=? AND version<=?', [episodeId, version - 30]);
    return version;
  }
  // 대본 내용(장면·대사·화자·순서·길이)을 직접 고치면 받아 둔 대본 승인(요청·승인)은 다시 받아야 해요.
  const resetScriptReview = (episodeId) => db.run("UPDATE studio_episodes SET script_review=CASE WHEN script_review IN ('approved','requested') THEN '' ELSE script_review END WHERE id=?", [episodeId]);
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
      const oldIds = (await db.all('SELECT id FROM studio_shots WHERE episode_id=? ORDER BY sort_order', [e.id])).map((x) => x.id);
      await db.run('DELETE FROM studio_shots WHERE episode_id=?', [e.id]);
      await insertShots(e.id, e.project_id, script.shots, 0, oldIds);
      // 합성 중이면 상태를 덮지 않고 '내용 바뀜'만 표시해요(합성 완료 확정이 실패하지 않도록).
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composing' THEN status ELSE 'scripted' END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END,video=CASE WHEN status='composing' THEN video ELSE '' END,duration=CASE WHEN status='composing' THEN duration ELSE 0 END WHERE id=?", [e.id]);
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
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status IN ('composed','outline') THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [e.id]);
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
        if (table === 'prop') await db.run('UPDATE studio_props SET look_en=?,look_en_src=? WHERE id=? AND look=?', [item.en, src.ko, id, src.ko]);
      }
      return { items: out.items.length };
    },
  });
  const mediaHandler = (column, table, kind) => ({
    async onSuccess({ job, result, model }) {
      const row = await db.get(`SELECT * FROM ${table} WHERE id=?`, [job.target_id]);
      if (row) {
        // 영상이나 대사 음성이 바뀌면 입 모양 맞춘 영상은 더 이상 맞지 않으므로 지웁니다.
        const resetSync =
          (table === 'studio_shots' && (column === 'audio' || column === 'video') ? ",lipsync=''" : '') +
          // 이미지·영상이 바뀌면 이전 AI 검수 결과는 맞지 않으므로 지웁니다.
          (table === 'studio_shots' && (column === 'image' || column === 'video') ? ",verify=''" : '');
        await db.run(`UPDATE ${table} SET ${column}=?${column === 'audio' ? ',audio_seconds=?' : ''}${resetSync} WHERE id=?`, column === 'audio' ? [result.url, result.duration || 0, row.id] : [result.url, row.id]);
        // 컷이 바뀌면 이미 합성한 회차 영상은 다시 만들어야 합니다.
        if (table === 'studio_shots') await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [row.episode_id]);
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
      const emotion = String(next.emotion || '').trim() || s.emotion || '';
      const audioReset = next.dialogue !== s.dialogue || speakerId !== s.speaker_id || emotion !== (s.emotion || '');
      // 영어 묘사: AI가 함께 준 영어 프롬프트를 쓰고, 없으면 번역을 맡겨요. 카메라 움직임은 AI가 새로 정했을 때만 바꾸고 앵글·렌즈 느낌은 그대로 둬요.
      const en = String(next.visual_en || '').trim();
      const move = CAMERA_MOVES.includes(String(next.camera_move || '')) ? next.camera_move : s.camera_move || '';
      await db.run(
        `UPDATE studio_shots SET scene=?,visual=?,visual_en=?,visual_en_src=?,dialogue=?,speaker_id=?,camera=?,camera_move=?,emotion=?,seconds=?,updated_at=?${audioReset ? ",audio='',audio_seconds=0,lipsync=''" : ''} WHERE id=?`,
        [next.scene, next.visual, en || (next.visual === s.visual ? s.visual_en || '' : ''), en ? next.visual : next.visual === s.visual ? s.visual_en_src || '' : '', next.dialogue, speakerId, next.camera || s.camera, move, emotion, Math.round(Math.min(10, Math.max(2, next.seconds))), now(), s.id],
      );
      if (!en && next.visual !== s.visual) {
        const owner = (await db.get('SELECT owner_id FROM studio_projects WHERE id=?', [s.project_id]))?.owner_id;
        // 작업 확정 트랜잭션 안이라 같은 트랜잭션으로 번역을 걸어요(따로 열면 SQLite에서 서로 기다리며 멈춰요).
        if (owner) await queueTranslate(s.project_id, owner, [{ id: 'shot:' + s.id, ko: next.visual }], { inTx: true }).catch(() => {});
      }
      // 대본 내용이 바뀌었으니 받아 둔 대본 승인은 다시 받아야 해요.
      await resetScriptReview(s.episode_id);
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
      const values = await db.get('SELECT scene,visual,dialogue,camera,seconds,emotion,camera_move,audio,audio_seconds,lipsync FROM studio_shots WHERE id=?', [s.id]);
      return { audioReset, values };
    },
  });
  engine.registerHandler('voice_sample', mediaHandler('voice_sample', 'studio_characters', 'audio'));
  engine.registerHandler('character_image', mediaHandler('image', 'studio_characters', 'image'));
  // 후보 여러 장(2026-09-29): 같은 요청의 후보는 묶음(batch)으로 버전 기록에 남기고, 컷에 아직 결과가 없을 때만
  // 먼저 끝난 후보를 넣어 둡니다. PD가 후보 칸에서 고르면 그 후보로 바꿔요.
  const candidateAware = (base, column) => ({
    async onSuccess(args) {
      const { job, result, model } = args;
      const input = JSON.parse(job.input || '{}');
      if (!input.candidate) return base.onSuccess(args);
      // 두 후보가 동시에 끝나도 한 장만 컷에 들어가게 컷 행을 잠그고 읽어요(PostgreSQL).
      const row = await db.get('SELECT * FROM studio_shots WHERE id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''), [job.target_id]);
      let out;
      if (row && !row[column]) out = await base.onSuccess(args);
      else {
        if (job.project_id) await asset(job, job.project_id, { type: 'shot', id: job.target_id }, column, result.url, model);
        out = { url: result.url, candidate: true };
      }
      await db.run('UPDATE studio_assets SET batch=? WHERE job_id=?', [String(input.candidate).slice(0, 40), job.id]);
      return out;
    },
  });
  engine.registerHandler('shot_image', candidateAware(mediaHandler('image', 'studio_shots', 'image'), 'image'));
  // 후보 AI 검수: 검사한 후보 이미지(버전 기록)에 결과를 남겨 '추천' 표시에 써요.
  engine.registerHandler('verify_asset', {
    async onSuccess({ job, result }) {
      const v = parseJson(result.text, verifySchema);
      const input = JSON.parse(job.input || '{}');
      const a = await db.get('SELECT id,url FROM studio_assets WHERE id=?', [job.target_id]);
      if (!a || a.url !== input.checkedImage) return { skipped: true };
      const record = { ok: v.ok, score: Math.round(v.score), issues: v.issues, faces: v.faces || [], summary: v.summary, at: now(), image: a.url };
      await db.run('UPDATE studio_assets SET verify=? WHERE id=?', [JSON.stringify(record), a.id]);
      await recordQuality(a.url, record.score, record.faces, 'image');
      return { ok: record.ok, score: record.score };
    },
  });
  engine.registerHandler('shot_tts', mediaHandler('audio', 'studio_shots', 'audio'));
  engine.registerHandler('shot_video', candidateAware(mediaHandler('video', 'studio_shots', 'video'), 'video'));
  engine.registerHandler('poster', mediaHandler('poster', 'studio_projects', 'image'));
  engine.registerHandler('shot_image_edit', mediaHandler('image', 'studio_shots', 'image'));
  engine.registerHandler('shot_lipsync', mediaHandler('lipsync', 'studio_shots', 'lipsync'));
  engine.registerHandler('shot_sfx', mediaHandler('sfx', 'studio_shots', 'sfx'));
  engine.registerHandler('prop_image', mediaHandler('image', 'studio_props', 'image'));
  // 화질 올리기(2026-09-29): 올리는 동안 컷 이미지·영상이 바뀌지 않았을 때만 바꿔 끼웁니다(바뀌었으면 버전 기록에만 남김).
  const parseUp = (raw) => {
    try {
      const v = raw ? JSON.parse(raw) : {};
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  const upscaleHandler = (which) => ({
    async onSuccess({ job, result, model }) {
      const input = JSON.parse(job.input || '{}');
      const s = await db.get('SELECT * FROM studio_shots WHERE id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE' : ''), [job.target_id]);
      const column = which === 'image' ? 'image' : input.column === 'lipsync' ? 'lipsync' : 'video';
      let applied = false;
      if (s && s[column] === input.sourceUrl) {
        const up = { ...parseUp(s.upscaled), [which]: result.url };
        // 이미지가 바뀌면 예전 검수 결과는 맞지 않으므로 지웁니다(열 이름은 위에서 정한 세 가지 중 하나).
        await db.run(`UPDATE studio_shots SET ${column}=?,upscaled=?${column === 'image' ? ",verify=''" : ''} WHERE id=?`, [result.url, JSON.stringify(up), s.id]);
        await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
        applied = true;
      }
      if (job.project_id) await asset(job, job.project_id, { type: 'shot', id: job.target_id }, column === 'lipsync' ? 'lipsync' : which, result.url, { label: `${model?.label || 'AI'} · 화질 올림` });
      return { url: result.url, applied, column };
    },
  });
  engine.registerHandler('shot_upscale', upscaleHandler('image'));
  engine.registerHandler('shot_upscale_video', upscaleHandler('video'));
  // 사이 컷: 고른 컷 바로 뒤에 짧은 연결 컷을 끼워 넣습니다(지금 대본은 버전으로 남김).
  engine.registerHandler('bridge_shot', {
    async onSuccess({ job, result }) {
      const next = parseJson(result.text, aiShotSchema);
      const s = await db.get('SELECT s.*, e.project_id FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=?', [job.target_id]);
      if (!s) return { skipped: true };
      await snapshotScript(s.episode_id, s.project_id, 'before_bridge', '사이 컷 넣기 전');
      await db.run('UPDATE studio_shots SET sort_order=sort_order+1 WHERE episode_id=? AND sort_order>?', [s.episode_id, s.sort_order]);
      await insertShots(s.episode_id, s.project_id, [{ ...next, seconds: Math.min(4, Math.max(2, next.seconds)) }], Number(s.sort_order) + 1);
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
      return { inserted: 1 };
    },
  });
  // 대본 변형: 지금 대본은 그대로 두고 변형마다 버전 기록으로 남겨, 마음에 드는 것을 '되돌리기'로 골라 씁니다.
  engine.registerHandler('variants', {
    async onSuccess({ job, result }) {
      const out = parseJson(result.text, variantsSchema);
      const e = await db.get('SELECT * FROM studio_episodes WHERE id=?', [job.target_id]);
      if (!e) return { skipped: true };
      let version = Number(e.script_version || 0);
      for (const v of out.variants) {
        version += 1;
        await db.run('INSERT INTO studio_script_versions (id,project_id,episode_id,version,shots,source,note,created_at) VALUES (?,?,?,?,?,?,?,?)', [
          randomUUID(), e.project_id, e.id, version, JSON.stringify(await versionRows(e.project_id, v.shots)), 'variant', `${v.label}${v.note ? ' · ' + v.note : ''}`.slice(0, 200), now(),
        ]);
      }
      await db.run('UPDATE studio_episodes SET script_version=? WHERE id=?', [version, e.id]);
      return { variants: out.variants.length };
    },
  });
  // AI 결과 검수: 검사한 그 이미지가 아직 컷 이미지일 때만 결과를 남깁니다.
  // 6단계(2026-09-30): AI 검수 점수를 그 결과를 만든 모델의 품질 표본으로 남겨요(자동 선택 품질 가중치 · 관리자 품질 표).
  async function recordQuality(url, score, faces, kind) {
    const j = await db.get('SELECT j.model_ref FROM studio_assets a JOIN ai_jobs j ON j.id=a.job_id WHERE a.url=? AND a.job_id IS NOT NULL LIMIT 1', [url]);
    if (!j?.model_ref) return;
    const face = faces?.length ? Math.round(Math.min(...faces.map((f) => Number(f.match)))) : null;
    await db.run('INSERT INTO ai_quality_samples (id,model_ref,kind,source,score,face,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), j.model_ref, kind, 'real', Math.round(Number(score) || 0), face, now()]);
  }
  engine.registerHandler('verify_shot', {
    async onSuccess({ job, result }) {
      const v = parseJson(result.text, verifySchema);
      const input = JSON.parse(job.input || '{}');
      const s = await db.get('SELECT id,image FROM studio_shots WHERE id=?', [job.target_id]);
      if (!s || s.image !== input.checkedImage) return { skipped: true };
      const record = { ok: v.ok, score: Math.round(v.score), issues: v.issues, faces: v.faces || [], summary: v.summary, at: now(), image: s.image };
      await db.run('UPDATE studio_shots SET verify=? WHERE id=?', [JSON.stringify(record), s.id]);
      await recordQuality(s.image, record.score, record.faces, 'image');
      return { ok: record.ok, issues: v.issues.length };
    },
  });
  // 완성 대본 → 회차·컷·인물·장소·소품·관계(원래 대본은 버전으로 남김)
  engine.registerHandler('parse_script', {
    async onSuccess({ job, result }) {
      const out = parseJson(result.text, parseScriptSchema);
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [job.project_id]);
      if (!p) return { skipped: true };
      if (out.synopsis && !String(p.synopsis || '').trim()) await db.run('UPDATE studio_projects SET synopsis=? WHERE id=?', [out.synopsis, p.id]);
      // 인물: 이미 있는 이름은 그대로 두고(비어 있는 외모만 채움) 새 인물만 추가
      const old = await charactersOf(p.id);
      let order = old.length;
      for (const c of out.characters) {
        const same = old.find((o) => o.name.trim() === c.name.trim());
        const lookEn = c.look_en || (/[가-힣]/.test(c.look) ? '' : c.look);
        if (same) {
          if (!String(same.look || '').trim() && c.look) await db.run('UPDATE studio_characters SET look=?,look_en=?,look_en_src=? WHERE id=?', [c.look, lookEn, lookEn ? c.look : '', same.id]);
          if (!String(same.description || '').trim() && c.description) await db.run('UPDATE studio_characters SET description=? WHERE id=?', [c.description, same.id]);
        } else if (order < 12)
          await db.run('INSERT INTO studio_characters (id,project_id,name,role,description,look,look_en,look_en_src,sort_order) VALUES (?,?,?,?,?,?,?,?,?)', [
            randomUUID(), p.id, c.name.trim(), c.role, c.description, c.look, lookEn, lookEn ? c.look : '', order++,
          ]);
      }
      const places = await locationsOf(p.id);
      let lo = places.length;
      for (const l of out.locations)
        if (!places.some((x) => x.name === l.name.trim()) && lo < 12)
          await db.run('INSERT INTO studio_locations (id,project_id,name,look,sort_order) VALUES (?,?,?,?,?)', [randomUUID(), p.id, l.name.trim(), l.look, lo++]);
      const things = await propsOf(p.id);
      let po = things.length;
      for (const x of out.props)
        if (!things.some((y) => y.name === x.name.trim()) && po < 30)
          await db.run('INSERT INTO studio_props (id,project_id,name,look,sort_order) VALUES (?,?,?,?,?)', [randomUUID(), p.id, x.name.trim(), x.look, po++]);
      // 관계: 이름 → ID, 이미 있는 쌍은 덮어쓰지 않음
      const cast = await charactersOf(p.id);
      let rel = [];
      try {
        rel = JSON.parse(p.relations || '[]');
      } catch {}
      for (const r of out.relations) {
        const a = cast.find((c) => c.name === r.a.trim())?.id;
        const b = cast.find((c) => c.name === r.b.trim())?.id;
        if (a && b && a !== b && !rel.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a)) && rel.length < 40) rel.push({ a, b, kind: r.kind.slice(0, 20), note: r.note });
      }
      await db.run('UPDATE studio_projects SET relations=? WHERE id=?', [JSON.stringify(rel), p.id]);
      // 회차: 필요하면 회차 수를 늘리고, 대본이 있던 회차는 버전으로 남긴 뒤 바꿉니다.
      let made = 0;
      const maxNumber = Math.max(...out.episodes.map((e) => e.number));
      if (maxNumber > Number(p.episode_count)) await db.run('UPDATE studio_projects SET episode_count=? WHERE id=?', [Math.min(60, maxNumber), p.id]);
      for (const e of out.episodes) {
        let row = await db.get('SELECT * FROM studio_episodes WHERE project_id=? AND number=?', [p.id, e.number]);
        let oldIds = [];
        if (!row) {
          const id = randomUUID();
          await db.run("INSERT INTO studio_episodes (id,project_id,number,title,summary,status) VALUES (?,?,?,?,?,'outline')", [id, p.id, e.number, e.title || `${e.number}화`, e.summary]);
          row = { id };
        } else {
          await snapshotScript(row.id, p.id, 'before_import', '대본 붙여 넣기 전');
          oldIds = (await db.all('SELECT id FROM studio_shots WHERE episode_id=? ORDER BY sort_order', [row.id])).map((x) => x.id);
          await db.run('DELETE FROM studio_shots WHERE episode_id=?', [row.id]);
          if (e.title || e.summary) await db.run("UPDATE studio_episodes SET title=CASE WHEN ?<>'' THEN ? ELSE title END, summary=CASE WHEN ?<>'' THEN ? ELSE summary END WHERE id=?", [e.title, e.title, e.summary, e.summary, row.id]);
        }
        await insertShots(row.id, p.id, e.shots, 0, oldIds);
        await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composing' THEN status ELSE 'scripted' END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END,video=CASE WHEN status='composing' THEN video ELSE '' END,duration=CASE WHEN status='composing' THEN duration ELSE 0 END WHERE id=?", [row.id]);
        made += e.shots.length;
      }
      // 한국어로만 적힌 외모·장소·소품 묘사는 영어로 옮겨 둡니다(플랫폼 부담).
      const items = [
        ...(await charactersOf(p.id)).filter((c) => c.look && !c.look_en).map((c) => ({ id: 'character:' + c.id, ko: c.look })),
        ...(await locationsOf(p.id)).filter((l) => l.look && !l.look_en).map((l) => ({ id: 'location:' + l.id, ko: l.look })),
        ...(await propsOf(p.id)).filter((x) => x.look && !x.look_en).map((x) => ({ id: 'prop:' + x.id, ko: x.look })),
      ];
      if (items.length) await queueTranslate(p.id, p.owner_id, items, { inTx: true }).catch(() => {});
      await touch(p.id);
      return { episodes: out.episodes.length, shots: made };
    },
  });
  // 영상 → 대본 복원: 결과 대본을 '완성 대본 붙여 넣기' 칸에 넣어 PD가 확인·수정한 뒤 컷으로 나눕니다.
  engine.registerHandler('reverse_script', {
    async onSuccess({ job, result }) {
      const out = parseJson(result.text, reverseScriptSchema);
      const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [job.project_id]);
      if (!p) return { skipped: true };
      await db.run('UPDATE studio_projects SET script_text=?,synopsis=CASE WHEN synopsis=\'\' THEN ? ELSE synopsis END,updated_at=? WHERE id=?', [out.script.slice(0, 30000), out.synopsis || '', now(), p.id]);
      return { chars: out.script.length };
    },
  });
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
      if (type === 'episode') await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [id]);
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
  // 영상에서 장면 몇 장을 잠깐 뽑아(비율 0~1 위치) 검수 모델에 보여 줘요. 작업이 끝나면 지웁니다.
  async function grabFrames(clip, spots, ownerId, projectId) {
    const src = path.join(uploadDir, path.basename(clip));
    const info = await probeMedia(src).catch(() => null);
    const dur = Math.max(0.1, Number(info?.duration || 1));
    const out = [];
    try {
      for (const r of spots) {
        const id = randomUUID();
        const file = path.join(uploadDir, id + '.jpg');
        await runFfmpeg(['-ss', Math.max(0, Math.min(dur - 0.05, dur * r)).toFixed(3), '-i', src, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', '-y', file], 60000);
        const url = '/uploads/' + id + '.jpg';
        await db.run('INSERT INTO media_files (url,owner_id,mime,created_at,project_id) VALUES (?,?,?,?,?)', [url, ownerId, 'image/jpeg', now(), projectId]);
        out.push(url);
      }
    } catch (e) {
      await removeFrames(out);
      throw Object.assign(new Error('영상에서 검수할 장면을 뽑지 못했어요. 영상을 다시 만든 뒤 검수해 주세요.'), { status: 400 });
    }
    return out;
  }
  const removeFrames = async (list) => {
    for (const url of list || []) {
      if (!/^\/uploads\/[a-f0-9-]+\.jpg$/.test(url)) continue;
      await db.run('DELETE FROM media_files WHERE url=?', [url]).catch(() => {});
      await rm(path.join(uploadDir, path.basename(url)), { force: true }).catch(() => {});
    }
  };
  // 확정(커밋)된 뒤에만 임시 장면을 지워요. 확정이 실패해 다시 시도하게 되면 파일이 남아 있어야 하니까요.
  const afterCommit = (jobId, frames) => {
    if (!frames?.length) return;
    const later = () =>
      setTimeout(async () => {
        const j = await db.get('SELECT status FROM ai_jobs WHERE id=?', [jobId]).catch(() => null);
        if (!j || ['succeeded', 'failed', 'canceled'].includes(j.status)) await removeFrames(frames);
      }, 1500);
    if (db.detach) db.detach(later);
    else later();
  };
  const tempFramesOf = (job) => {
    try {
      return JSON.parse(job.input || '{}').tempFrames || [];
    } catch {
      return [];
    }
  };
  engine.registerHandler('verify_video', {
    async onSuccess({ job, result }) {
      const v = parseJson(result.text, videoVerifySchema);
      const input = JSON.parse(job.input || '{}');
      afterCommit(job.id, input.tempFrames);
      const s = await db.get('SELECT id,video,lipsync FROM studio_shots WHERE id=?', [job.target_id]);
      if (!s || (s.lipsync || s.video) !== input.checkedClip) return { skipped: true };
      const record = { ok: v.ok, score: Math.round(v.score), issues: v.issues, faces: v.faces || [], summary: v.summary, at: now(), video: input.checkedClip };
      await db.run('UPDATE studio_shots SET video_verify=? WHERE id=?', [JSON.stringify(record), s.id]);
      await recordQuality(input.checkedClip, record.score, record.faces, 'video');
      return { ok: record.ok, issues: v.issues.length };
    },
    onFail: async ({ job }) => removeFrames(tempFramesOf(job)),
  });
  const tempAudioOf = (job) => {
    try {
      return JSON.parse(job.input || '{}').audio?.path || '';
    } catch {
      return '';
    }
  };
  // 업로드 영상용 AI 도구: 포스터 후보(작품에 바로 적용하지 않고 후보로만 남김), 자동 자막
  engine.registerHandler('tool_poster', { onSuccess: async ({ result }) => ({ url: result.url }) });
  engine.registerHandler('tool_first_shot', { onSuccess: async ({ result }) => ({ url: result.url }) });
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
      const row = await db.get('SELECT e.id, e.subtitles AS old_subtitles, e.review_status, d.status AS drama_status FROM episodes e JOIN dramas d ON d.id=e.drama_id WHERE e.drama_id=? AND e.number=?', [dramaId, Number(number)]);
      // 작품이 임시저장·반려 상태이거나, 연재 중 작품의 아직 공개 전(초안·반려) 회차만 자막을 바꿉니다.
      const e = row && episodeEditable({ status: row.drama_status }, row) ? row : null;
      if (!e || !vtt) {
        await removeTemp(tempAudioOf(job));
        return { skipped: true };
      }
      const file = randomUUID() + '.vtt';
      await mkdir(subsDir, { recursive: true });
      await writeFile(path.join(subsDir, file), vtt, 'utf8');
      await db.run('UPDATE episodes SET subtitles=? WHERE id=?', [file, e.id]);
      // 이전 자막 파일은 더 이상 쓰이지 않으므로 지웁니다.
      if (e.old_subtitles && e.old_subtitles !== file) await rm(path.join(subsDir, path.basename(e.old_subtitles)), { force: true }).catch(() => {});
      // 임시 음성 파일은 자막을 다 저장한 뒤에 지워요(중간에 실패하면 다시 시도할 때 그대로 써요).
      await removeTemp(tempAudioOf(job));
      return { cues: segments.length };
    },
    onFail: async ({ job }) => removeTemp(tempAudioOf(job)),
  });

  // 실행할 작업을 만듭니다. 예상 라마 조회와 실제 실행이 같은 정의를 씁니다.
  const locationsOf = (pid) => db.all('SELECT * FROM studio_locations WHERE project_id=? ORDER BY sort_order, name', [pid]);
  const propsOf = (pid) => db.all('SELECT * FROM studio_props WHERE project_id=? ORDER BY sort_order, name', [pid]);
  const refsOf = (c) => {
    try {
      return JSON.parse(c.refs || '[]');
    } catch {
      return [];
    }
  };
  // 인물 카드(2026-09-29): 컷에 맞는 참고 자세를 고릅니다. 전신 샷엔 전신, 옆·어깨 너머엔 옆모습, 감정엔 표정 참고.
  const posesFor = (shot) => {
    if (!shot) return ['front'];
    const cam = `${shot.camera || ''} ${shot.angle || ''}`;
    const out = [];
    if (/풀샷|와이드|전신/.test(cam)) out.push('full');
    if (/어깨|오버숄더/.test(cam) || /옆모습|옆얼굴|측면/.test(shot.visual || '')) out.push('side');
    const face = { 기쁨: 'smile', 설렘: 'smile', 분노: 'angry', 슬픔: 'sad' }[shot.emotion || ''];
    if (face && !/풀샷|와이드/.test(cam)) out.push(face);
    out.push('front');
    return out;
  };
  const personRefs = (c, shot, max) => {
    const refs = refsOf(c);
    const picked = posesFor(shot).map((pose) => refs.find((r) => r.pose === pose)?.url).filter(Boolean);
    return [c.image, ...picked].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, max);
  };
  // 컷 이미지에 넘길 참고 이미지: 등장 인물의 기준 이미지(+컷에 맞는 자세 참고) → 장소 이미지, 최대 4장
  // 소품 이미지(최대 1장)와 스타일 잠금 참고 이미지(1장)는 자리를 남겨 두고 넣습니다(최대 5장).
  const shotRefs = (people, place, props = [], style = [], shot = null) => {
    const per = people.length <= 1 ? 3 : 2;
    const base = [...people.flatMap((c) => personRefs(c, shot, per)), place?.image].filter(Boolean);
    const extra = [props.find((x) => x.image)?.image, style[0]].filter(Boolean);
    const keep = Math.max(1, 5 - extra.length);
    return [...base.filter((v, i, a) => a.indexOf(v) === i).slice(0, Math.min(4, keep)), ...extra]
      .filter((v, i, a) => a.indexOf(v) === i)
      .map(imageRef)
      .filter(Boolean);
  };
  const styleRefsOf = (p) => {
    try {
      const list = JSON.parse(p.style_refs || '[]');
      return Array.isArray(list) ? list.filter((u) => typeof u === 'string' && /^\/uploads\//.test(u)).slice(0, 3) : [];
    } catch {
      return [];
    }
  };
  // 인물 상태: 이 컷에 적힌 상태, 없으면 같은 회차 앞 컷에서 마지막으로 바뀐 상태를 이어 씁니다('기본'이면 원래 모습).
  async function effectiveStates(shot) {
    const list = await shotsOf(shot.episode_id);
    const out = {};
    for (const s of list) {
      let st = {};
      try {
        st = s.states ? JSON.parse(s.states) : {};
      } catch {}
      for (const [cid, v] of Object.entries(st)) out[cid] = /^(기본|원래대로|normal)$/i.test(String(v).trim()) ? '' : String(v).trim();
      if (s.id === shot.id) break;
    }
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
  }
  const propsOfShot = async (shot, pid) => {
    const ids = String(shot.prop_ids || '').split(',').filter(Boolean);
    if (!ids.length) return [];
    return (await propsOf(pid)).filter((x) => ids.includes(x.id));
  };
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
    if (action === 'parse_script') {
      const text = String(p.script_text || '').trim();
      if (text.length < 20) fail(400, '나눌 대본을 20자 이상 먼저 붙여 넣어 주세요.');
      return {
        kind: 'parse_script',
        capability: 'text',
        tags: ['story', 'korean'],
        target: { type: 'project', id: p.id },
        input: { ...parseScriptPrompt({ project: p, text, characters: cast, locations: await locationsOf(p.id), props: await propsOf(p.id) }), userText: text.slice(0, 3000) },
      };
    }
    if (action === 'reverse_script') {
      const text = String(p.source_text || '').trim();
      if (!/\d+화 자막/.test(text) || text.length < 20) fail(400, '영상 자막이 없어요. 스튜디오 첫 화면의 ‘영상에서 대본 뽑기’로 다시 시작해 주세요.');
      return { kind: 'reverse_script', capability: 'text', tags: ['story', 'korean'], target: { type: 'project', id: p.id }, input: { ...reverseScriptPrompt({ project: p, transcript: text }), userText: text.slice(0, 3000) } };
    }
    if (action === 'prop_image') {
      const x = await db.get('SELECT * FROM studio_props WHERE id=? AND project_id=?', [targetId, p.id]);
      if (!x) fail(404, '소품을 찾을 수 없어요.');
      return { kind: 'prop_image', capability: 'image', tags: ['poster'], target: { type: 'prop', id: x.id }, input: { prompt: propPrompt(p, x), aspect: '9:16', userText: x.look } };
    }
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
    if (action === 'script' || action === 'diagnose' || action === 'rewrite_range' || action === 'variants') {
      const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [targetId, p.id]);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      if (action === 'variants') {
        const shots = await shotsOf(e.id);
        if (!shots.length) fail(400, '변형할 대본이 없어요. 대본을 먼저 만들어 주세요.');
        const angles = (opt.angles || []).map((a) => String(a).trim()).filter(Boolean).slice(0, 3);
        if (!angles.length) fail(400, '어떤 방향으로 바꿀지 골라 주세요.');
        return {
          kind: 'variants',
          capability: 'text',
          tags: ['story', 'korean'],
          target: { type: 'episode', id: e.id },
          input: { ...variantsPrompt({ project: p, characters: cast, episode: e, shots, angles }), userText: angles.join(' ') },
        };
      }
      if (action === 'diagnose') {
        const shots = await shotsOf(e.id);
        if (!shots.length) fail(400, '진단할 대본이 없어요. 대본을 먼저 만들어 주세요.');
        return { kind: 'diagnose', capability: 'text', tags: ['story'], target: { type: 'episode', id: e.id }, input: { ...diagnosePrompt({ project: p, characters: cast, episode: e, shots }), userText: '' } };
      }
      if (action === 'rewrite_range') {
        const instruction = String(extra.instruction || '').trim();
        if (instruction.length < 2) fail(400, '어떻게 고칠지 적어 주세요.');
        const ids = Array.isArray(opt.shotIds) ? opt.shotIds.map(String) : [];
        const all = await shotsOf(e.id);
        const picked = all.filter((x) => ids.includes(x.id));
        if (!picked.length) fail(400, '다시 쓸 컷을 골라 주세요.');
        // 떨어진 컷(예: 1·4번)만 다시 쓰면 사이 컷 순서가 뒤바뀌어요. 화면과 같이 고른 컷 사이를 모두 포함한 구간으로 다시 씁니다.
        const shots = all.slice(all.indexOf(picked[0]), all.indexOf(picked[picked.length - 1]) + 1);
        if (shots.length > 20) fail(400, '한 번에 20컷까지 고칠 수 있어요.');
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
          ...scriptPrompt({ project: p, characters: cast, episode: e, history, maxShotSeconds: 8, locations: await locationsOf(p.id), props: await propsOf(p.id), instruction }),
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
      return { kind: 'location_image', capability: 'image', tags: ['landscape'], target: { type: 'location', id: l.id }, input: { prompt: locationPrompt(p, l), aspect: '9:16', refImages: styleRefsOf(p).slice(0, 1).map(imageRef).filter(Boolean), userText: l.look } };
    }
    if (action === 'verify_asset') {
      const a = await db.get("SELECT * FROM studio_assets WHERE id=? AND project_id=? AND target_type='shot' AND kind='image'", [targetId, p.id]);
      if (!a) fail(404, '후보를 찾을 수 없어요.');
      const s = await loadShot(req, a.target_id, 'view');
      const faces = castOf(s, cast).filter((c) => c.image).slice(0, 3);
      return {
        kind: 'verify_asset',
        capability: 'text',
        tags: ['vision'],
        requestedOverride: 'auto',
        target: { type: 'asset', id: a.id },
        input: {
          ...verifyPrompt({
            shot: s,
            people: faces.length ? faces : castOf(s, cast),
            props: await propsOfShot(s, p.id),
            states: await effectiveStates(s),
            styleLock: styleRefsOf(p).length > 0,
            place: s.location_id ? await db.get('SELECT * FROM studio_locations WHERE id=? AND project_id=?', [s.location_id, p.id]) : null,
          }),
          refImages: [a.url, ...faces.map((c) => c.image)].map(imageRef).filter(Boolean),
          checkedImage: a.url,
          _requireImage: true,
          userText: '',
        },
      };
    }
    const shot = await loadShot(req, targetId, 'view');
    if (shot.project_id !== p.id) fail(404, '컷을 찾을 수 없어요.');
    const speaker = cast.find((c) => c.id === shot.speaker_id);
    const people = castOf(shot, cast);
    const place = shot.location_id ? await db.get('SELECT * FROM studio_locations WHERE id=? AND project_id=?', [shot.location_id, p.id]) : null;
    if (action === 'bridge_shot') {
      const list = await shotsOf(shot.episode_id);
      if (list.length >= 40) fail(400, '한 회차에는 컷을 40개까지 넣을 수 있어요.');
      const i = list.findIndex((x) => x.id === shot.id);
      const instruction = String(extra.instruction || '').trim().slice(0, 300);
      return {
        kind: 'bridge_shot',
        capability: 'text',
        tags: ['story'],
        target: { type: 'shot', id: shot.id },
        input: { ...bridgePrompt({ project: p, characters: cast, prev: list[i], next: list[i + 1], instruction }), userText: instruction },
      };
    }
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
    if (action === 'shot_image') {
      const things = await propsOfShot(shot, p.id);
      const style = styleRefsOf(p);
      return {
        kind: 'shot_image',
        capability: 'image',
        tags: ['character', 'consistency'],
        target: { type: 'shot', id: shot.id },
        input: {
          prompt: shotImagePrompt(p, shot, people.length ? people : cast.slice(0, 2), place, { states: await effectiveStates(shot), props: things, styleLock: style.length > 0 }),
          aspect: '9:16',
          refImages: shotRefs(people, place, things, style, shot),
          seed: seedOf(shot),
          userText: shot.visual,
        },
      };
    }
    if (action === 'shot_image_edit') {
      let instruction = String(extra.instruction || '').trim();
      // 인물 바꾸기 · 배경 바꾸기(4단계): 고른 인물 · 장소의 기준 이미지를 참고로 붙이고, 지시문은 서버가 만들어요.
      let swapRef = null;
      if (opt.swap === 'character') {
        const who = cast.find((c) => c.id === opt.swapId);
        if (!who) fail(400, '바꿔 넣을 인물을 골라 주세요.');
        if (!who.image) fail(400, `${who.name}의 기준 이미지를 먼저 만들어 주세요.`);
        swapRef = who.image;
        instruction = `Replace the person${opt.mask ? ' inside the painted area' : ''} with ${who.name} from the character reference image (${lookOf(who)}${who.hair ? `, hair: ${who.hair}` : ''}${who.outfit ? `, wearing ${who.outfit}` : ''}). Keep the same pose, position, expression intent, lighting and camera angle.${instruction ? ' ' + instruction : ''}`;
      } else if (opt.swap === 'background') {
        const where = opt.swapId ? await db.get('SELECT * FROM studio_locations WHERE id=? AND project_id=?', [opt.swapId, p.id]) : null;
        if (opt.swapId && !where) fail(400, '이 프로젝트의 장소만 고를 수 있어요.');
        if (!where && instruction.length < 2) fail(400, '어떤 배경으로 바꿀지 장소를 고르거나 적어 주세요.');
        swapRef = where?.image || null;
        instruction = `Replace only the background${where ? ` with ${where.name}: ${lookOf(where)}${where.image ? ' (match the location reference image)' : ''}` : ''}. Keep every person exactly the same (faces, hair, outfits, pose, position) and keep the lighting direction consistent.${instruction ? ' ' + instruction : ''}`;
      }
      if (instruction.length < 2) fail(400, '어떻게 바꿀지 적어 주세요.');
      if (!shot.image) fail(400, '고칠 컷 이미지가 없어요. 이미지를 먼저 만들어 주세요.');
      // 붓으로 칠한 부분만 고치기(2026-09-29): 흰색 = 고칠 곳. 이 프로젝트에서 올린 마스크만 써요.
      const mask = opt.mask ? String(opt.mask) : '';
      if (mask) {
        const file = shotMedia?.maskFile(mask, shot.id);
        if (!file || !existsSync(file)) fail(400, '칠한 영역이 없어졌어요. 다시 칠해 주세요.');
      }
      return {
        kind: 'shot_image_edit',
        capability: 'image',
        tags: mask ? ['consistency', 'inpaint'] : ['consistency'],
        target: { type: 'shot', id: shot.id },
        input: {
          prompt: mask
            ? `Edit the first image only inside the white area of the black-and-white mask (the last image). Change only this: ${instruction}. Keep everything outside the mask exactly the same (faces, outfits, composition, lighting). Vertical 9:16, no text.`
            : `Edit the first image. Change only this: ${instruction}. Keep everything else (faces, outfits, composition, lighting) the same. Vertical 9:16, no text.`,
          aspect: '9:16',
          editImage: imageRef(shot.image),
          refImages: swapRef ? [imageRef(swapRef), ...shotRefs(people, null)].filter(Boolean).slice(0, 3) : shotRefs(people, null).slice(0, 2),
          ...(mask ? { maskImage: { path: mask, mime: 'image/png' } } : {}),
          needImage: true,
          // 다시 시도할 때 같은 요청을 만들 수 있게 PD가 적은 글과 바꾸기 설정을 남겨요.
          userText: opt.swap ? String(extra.instruction || '').trim() : instruction,
          ...(opt.swap ? { swap: opt.swap, swapId: opt.swapId || '' } : {}),
        },
      };
    }
    if (action === 'shot_upscale') {
      if (!shot.image) fail(400, '화질을 올릴 컷 이미지가 없어요.');
      if (parseUp(shot.upscaled).image === shot.image) fail(400, '이 이미지는 이미 화질을 올렸어요.');
      return { kind: 'shot_upscale', capability: 'upscale', tags: ['poster'], target: { type: 'shot', id: shot.id }, input: { image: imageRef(shot.image), sourceUrl: shot.image, factor: 2, userText: '' } };
    }
    if (action === 'shot_upscale_video') {
      const column = shot.lipsync ? 'lipsync' : 'video';
      const clip = shot[column];
      if (!clip) fail(400, '화질을 올릴 컷 영상이 없어요. 영상을 먼저 만들어 주세요.');
      if (parseUp(shot.upscaled).video === clip) fail(400, '이 영상은 이미 화질을 올렸어요.');
      const meta = await db.get('SELECT duration FROM media_metadata WHERE url=?', [clip]);
      return {
        kind: 'shot_upscale_video',
        capability: 'upscale_video',
        tags: ['cinematic'],
        target: { type: 'shot', id: shot.id },
        input: { video: { path: clip, mime: 'video/mp4' }, sourceUrl: clip, column, seconds: Math.max(1, Math.ceil(Number(meta?.duration) || Number(shot.seconds) || 5)), factor: 2, userText: '' },
      };
    }
    if (action === 'verify_shot') {
      if (!shot.image) fail(400, '검수할 컷 이미지가 없어요. 이미지를 먼저 만들어 주세요.');
      const faces = people.filter((c) => c.image).slice(0, 3);
      return {
        kind: 'verify_shot',
        capability: 'text',
        tags: ['vision'],
        // 검수는 이미지를 읽을 수 있는 모델만 써야 하므로, 글 모델 직접 선택과 상관없이 자동으로 고릅니다.
        requestedOverride: 'auto',
        target: { type: 'shot', id: shot.id },
        input: {
          ...verifyPrompt({ shot, people: faces.length ? faces : people, props: await propsOfShot(shot, p.id), states: await effectiveStates(shot), styleLock: styleRefsOf(p).length > 0, place }),
          refImages: [shot.image, ...faces.map((c) => c.image)].map(imageRef).filter(Boolean),
          checkedImage: shot.image,
          _requireImage: true,
          userText: '',
        },
      };
    }
    if (action === 'verify_video') {
      const clip = shot.lipsync || shot.video;
      if (!clip) fail(400, '검수할 컷 영상이 없어요. 영상을 먼저 만들어 주세요.');
      const faces = people.filter((c) => c.image).slice(0, 2);
      const prev = await db.get('SELECT lipsync,video FROM studio_shots WHERE episode_id=? AND sort_order<? ORDER BY sort_order DESC LIMIT 1', [shot.episode_id, shot.sort_order]);
      const prevClip = prev?.lipsync || prev?.video || '';
      // 기준 얼굴 이미지가 있는 인물만 넘겨요(이미지 없이 이름만 넘기면 모델이 다른 이미지를 얼굴로 읽어요).
      const base = videoVerifyPrompt({ shot, people: faces, hasPrevFrame: !!prevClip });
      return {
        kind: 'verify_video',
        capability: 'text',
        tags: ['vision'],
        requestedOverride: 'auto',
        target: { type: 'shot', id: shot.id },
        input: {
          ...base,
          refImages: faces.map((c) => imageRef(c.image)).filter(Boolean),
          // 장면 3장(+ 앞 컷 마지막 장면)은 실제로 실행할 때만 뽑아요. 예상 라마에는 그만큼 미리 셉니다.
          _extraImages: 3 + (prevClip ? 1 : 0),
          checkedClip: clip,
          _requireImage: true,
          userText: '',
        },
        prepare: async (input) => {
          const frames = await grabFrames(clip, [0.08, 0.5, 0.92], p.owner_id, p.id);
          let tail = [];
          try {
            tail = prevClip ? await grabFrames(prevClip, [0.97], p.owner_id, p.id) : [];
          } catch {
            tail = []; // 앞 컷 장면을 못 뽑으면 이어짐 검사만 빼고 진행해요.
          }
          const { _extraImages, ...rest } = input;
          return { ...rest, refImages: [...frames.map(imageRef), ...rest.refImages, ...tail.map(imageRef)], tempFrames: [...frames, ...tail] };
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
      // 움직임만 입히기(4단계): 지금 컷 이미지를 그대로 두고 숨 · 눈 깜빡임 · 머리카락 · 옷자락만 살짝 움직여요.
      if (opt.motionOnly) {
        if (!shot.image) fail(400, '움직임을 입힐 컷 이미지가 없어요. 이미지를 먼저 만들어 주세요.');
        return {
          kind: 'shot_video',
          capability: 'video',
          tags: ['consistency', ...(shot.dialogue ? ['lipsync'] : [])],
          target: { type: 'shot', id: shot.id },
          input: {
            prompt: `Animate this exact image with only subtle natural motion: breathing, blinking, slight hair and cloth movement${lightText(shot) ? `, ${lightText(shot)} kept the same` : ''}. Do not change the composition, faces, outfits or background. Locked static camera. Vertical 9:16, no text overlay.${
              shot.dialogue && speaker ? ` ${speaker.name} speaks in Korean${shot.emotion ? ` (${shot.emotion})` : ''}: "${shot.dialogue}"` : ''
            }`,
            seconds: Number(shot.seconds) || 5,
            aspect: '9:16',
            image: imageRef(shot.image),
            seed: seedOf(shot),
            motionOnly: true,
            userText: shot.visual,
          },
        };
      }
      // 끝 장면 지정: PD가 고른 이미지 > 다음 컷의 스토리보드로 자연스럽게 이어지게(지원하는 모델만)
      let endImage;
      if (shot.end_image) endImage = imageRef(shot.end_image);
      else if (Number(shot.end_frame)) {
        const next = await db.get('SELECT image FROM studio_shots WHERE episode_id=? AND sort_order>? ORDER BY sort_order LIMIT 1', [shot.episode_id, shot.sort_order]);
        endImage = imageRef(next?.image);
      }
      return {
        kind: 'shot_video',
        capability: 'video',
        tags: [...shotTags(shot), ...(shot.dialogue ? ['lipsync'] : [])],
        target: { type: 'shot', id: shot.id },
        input: {
          prompt: shotVideoPrompt(p, shot, speaker, { locked: people.filter((c) => Number(c.locked)) }),
          // 복잡한 카메라 움직임: 잘 따르는 모델을 먼저 고르고, 약한 모델에는 비슷한 쉬운 움직임으로 보냅니다.
          ...(isComplexMove(shot.camera_move) ? { needCamera: true, promptBasic: shotVideoPrompt(p, shot, speaker, { basic: true, locked: people.filter((c) => Number(c.locked)) }) } : {}),
          seconds: Number(shot.seconds) || 5,
          aspect: '9:16',
          image: imageRef(shot.image),
          endImage,
          seed: seedOf(shot),
          userText: shot.visual,
        },
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
      // 효과음 설명은 실제로 실행할 때만 저장합니다(예상 라마 조회·AI 조수 계획 세우기에서는 저장하지 않음).
      return {
        persist: opt.prompt && opt.prompt !== shot.sfx_prompt ? { sql: 'UPDATE studio_shots SET sfx_prompt=? WHERE id=?', params: [prompt, shot.id] } : null,
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
    const col = { shot_image: 'image', shot_tts: 'audio', shot_video: 'video', shot_lipsync: 'lipsync', shot_sfx: 'sfx', verify_shot: 'verify', shot_upscale: 'upscaled', shot_upscale_video: 'upscaled' }[action];
    // 화질 올리기: 이미지·영상이 있고 아직 올리지 않은 컷만(고른 컷이어도 이미 올린 파일은 건너뜀)
    if (action === 'shot_upscale') return shots.filter((s) => s.image && parseUp(s.upscaled).image !== s.image && !busy.has(s.id));
    // 영상 검수(5단계): 영상이 있고, 지금 영상을 아직 검수하지 않은 컷만(고른 컷은 다시 검수)
    if (action === 'verify_video') return shots.filter((s) => (s.lipsync || s.video) && !busy.has(s.id) && (chosen || !String(s.video_verify || '').includes(`"video":"${s.lipsync || s.video}"`)));
    if (action === 'shot_upscale_video') return shots.filter((s) => (s.lipsync || s.video) && parseUp(s.upscaled).video !== (s.lipsync || s.video) && !busy.has(s.id));
    return shots.filter(
      (s) =>
        (chosen || action === 'verify_shot' || !s[col]) &&
        !busy.has(s.id) &&
        // 화면 묘사가 빈 컷은 이미지·영상 일괄 작업에서 빼서 라마가 헛되이 쓰이지 않게 합니다.
        (!['shot_image', 'shot_video'].includes(action) || String(s.visual || '').trim()) &&
        (action !== 'shot_tts' || String(s.dialogue || '').trim()) &&
        (action !== 'shot_lipsync' || (s.video && s.audio)) &&
        (action !== 'shot_sfx' || String(s.sfx_prompt || '').trim()) &&
        // 검수: 이미지가 있는 컷만, 이미 검수한 이미지면 건너뜀(고른 컷은 다시 검수)
        (action !== 'verify_shot' || (s.image && (chosen || !String(s.verify || '').includes(`"image":"${s.image}"`)))),
    );
  }
  const PROJECT_ACTIONS = ['plan', 'poster', 'adapt', 'bible', 'season', 'metadata', 'thumb_bg', 'music', 'parse_script', 'reverse_script'];
  const runSchema = z.object({
    action: z.enum([
      'plan', 'poster', 'adapt', 'bible', 'season', 'metadata', 'thumb_bg', 'music', 'parse_script', 'reverse_script',
      'script', 'diagnose', 'rewrite_range', 'variants',
      'prop_image', 'verify_shot', 'batch_verify_shot', 'bridge_shot',
      'character_image', 'character_ref', 'character_sheet', 'location_image', 'voice_sample',
      'shot_image', 'shot_image_edit', 'shot_tts', 'shot_video', 'shot_lipsync', 'shot_sfx', 'rewrite_shot',
      'batch_shot_image', 'batch_shot_tts', 'batch_shot_video', 'batch_shot_lipsync', 'batch_shot_sfx',
      // 힉스필드 벤치마킹 고도화(2026-09-29): 화질 올리기
      'shot_upscale', 'shot_upscale_video', 'batch_shot_upscale', 'batch_shot_upscale_video',
      'verify_candidates', 'verify_asset',
      // 5단계(2026-09-30): 컷 영상 AI 검수
      'verify_video', 'batch_verify_video',
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
        angles: z.array(z.string().trim().max(60)).max(3).optional(), // 대본 변형 방향
        mask: z.string().regex(/^\/masks\/[a-f0-9-]+\.[a-f0-9-]+\.png$/).optional(), // 부분 수정 붓(흰색 = 고칠 곳, 비공개 폴더)
        // 4단계(2026-09-30): 인물 바꾸기 · 배경 바꾸기(칠한 곳 + 인물 · 장소 참고 이미지), 움직임만 입히기
        swap: z.enum(['character', 'background']).optional(),
        swapId: z.string().max(80).optional(),
        motionOnly: z.boolean().optional(),
      })
      .default({}),
    targetId: z.string().max(80).optional(),
    requested: z.string().max(80).default('auto'),
    tier: z.enum(['draft', 'standard', 'premium']).default('standard'),
    idempotencyKey: z.string().uuid().optional(),
    budgetOk: z.boolean().optional(), // 프로젝트 예산을 넘어도 진행(PD가 확인함)
    payOwn: z.boolean().optional(), // 협업: 소유자 지원 한도를 넘으면 내 라마로 진행
  });
  async function plan(req, p, b) {
    // 협업자는 역할에 맞는 AI 작업만(글 작업은 script, 그림·소리·영상은 scene 권한)
    if (req.teamRole && req.teamRole !== 'owner' && !can(req.teamRole, actionNeed(b.action)))
      fail(403, `${ROLE_NAME[req.teamRole] || req.teamRole} 역할은 이 AI 작업(${needText(actionNeed(b.action))})을 실행할 수 없어요.`);
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
    // 후보 여러 장: 이미지 2~4장, 영상 2개. 같은 묶음 번호로 버전 기록에 남아요.
    if ((b.action === 'shot_image' || b.action === 'shot_video') && Number(b.options.count) > 1) {
      const max = b.action === 'shot_video' ? 2 : 4;
      if (Number(b.options.count) > max) fail(400, b.action === 'shot_video' ? '영상 후보는 2개까지 만들 수 있어요.' : '이미지 후보는 4장까지 만들 수 있어요.');
      const family = b.action === 'shot_video' ? ['shot_video', 'shot_upscale_video'] : ['shot_image', 'shot_image_edit', 'shot_upscale'];
      if (await db.get(`SELECT id FROM ai_jobs WHERE target_id=? AND kind IN (${family.map(() => '?').join(',')}) AND status IN ('queued','running') LIMIT 1`, [b.targetId, ...family]))
        fail(409, '이 컷을 만드는 작업이 진행 중이에요. 끝난 뒤 후보를 만들어 주세요.');
      const batch = randomUUID().slice(0, 8);
      const specs = [];
      for (let i = 0; i < Number(b.options.count); i++) {
        const spec = await buildJob(req, p, b.action, b.targetId, { options: b.options });
        const seed = (Number.isInteger(spec.input.seed) ? spec.input.seed : 1000 + Math.floor(Math.random() * 1e8)) + i * 7919;
        specs.push({ ...spec, keySuffix: `c${i + 1}`, input: { ...spec.input, seed, candidate: batch } });
      }
      return specs;
    }
    // 후보 이미지 AI 검수(추천 표시용): 가장 최근 후보 묶음 중 아직 검수하지 않은 이미지
    if (b.action === 'verify_candidates') {
      const s = await loadShot(req, b.targetId, 'view');
      if (s.project_id !== p.id) fail(404, '컷을 찾을 수 없어요.');
      const last = await db.get("SELECT batch FROM studio_assets WHERE target_id=? AND kind='image' AND batch<>'' ORDER BY created_at DESC LIMIT 1", [s.id]);
      // 검수 중인 후보는 빼서 두 번 누르거나 다시 보내도 두 번 결제되지 않게 합니다.
      const list = last
        ? await db.all(
            "SELECT a.id FROM studio_assets a WHERE a.target_id=? AND a.kind='image' AND a.batch=? AND a.verify='' AND NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.kind='verify_asset' AND j.target_id=a.id AND j.status IN ('queued','running'))",
            [s.id, last.batch],
          )
        : [];
      if (!list.length) fail(400, '검수할 후보 이미지가 없어요(이미 검수했거나 검수 중이에요).');
      const specs = [];
      for (const a of list) specs.push(await buildJob(req, p, 'verify_asset', a.id));
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
      // 협업: 초대받아 함께 만드는 프로젝트(기능이 꺼져 있으면 비어 있어요)
      shared: Number(settings.studio_collab_enabled)
        ? await db.all(
            "SELECT p.id,p.title,p.genre,p.status,p.poster,p.updated_at,m.role,u.name AS owner_name,(SELECT COUNT(*) FROM studio_episodes e WHERE e.project_id=p.id) AS episode_total,(SELECT COUNT(*) FROM studio_episodes e WHERE e.project_id=p.id AND e.video<>'') AS composed FROM studio_members m JOIN studio_projects p ON p.id=m.project_id JOIN users u ON u.id=p.owner_id WHERE m.user_id=? ORDER BY p.updated_at DESC",
            [req.user.id],
          )
        : [],
      collab: { enabled: !!Number(settings.studio_collab_enabled), max_members: Number(settings.studio_collab_max_members || 10) },
      invites: await collab.myInvites(req.user),
    });
  });
  // 모델 센터: 작업별로 '지금 자동이면 어떤 모델을 왜 고르는지' 알려 줍니다(라마 들지 않음).
  const DEFAULT_TAGS = { text: ['story', 'korean'], image: ['character', 'consistency'], video: ['cinematic'], tts: ['korean'], music: ['emotion'], sfx: ['scene'], lipsync: ['lipsync'], upscale: ['poster'], upscale_video: ['cinematic'] };
  const DEFAULT_INPUT = { text: { prompt: 'x'.repeat(2000), maxTokens: 4000 }, image: { count: 1 }, video: { seconds: 5 }, tts: { text: 'x'.repeat(100) }, music: { seconds: 30 }, sfx: { seconds: 4 }, lipsync: { seconds: 5 }, upscale: { count: 1 }, upscale_video: { seconds: 5 } };
  app.post('/api/studio/ai/models/explain', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({
        items: z.array(z.object({ capability: z.enum(['text', 'image', 'video', 'tts', 'music', 'sfx', 'lipsync', 'upscale', 'upscale_video']), tier: z.enum(['draft', 'standard', 'premium']).default('standard') })).max(10),
        projectId: z.string().max(80).optional(),
      })
      .parse(req.body);
    const p = b.projectId ? await project(req, b.projectId, 'view') : null;
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
    const p = await project(req, req.params.id, 'view');
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
        "SELECT j.id,j.kind,j.target_type,j.target_id,j.status,j.estimate_lama,j.charged_lama,j.error,j.created_at,j.finished_at,j.attempts,j.requested_model,j.model_ref,j.tier,j.flags,m.label AS model_label,j.user_id,j.actor_id,u.name AS actor_name FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref LEFT JOIN users u ON u.id=j.actor_id WHERE j.project_id=? AND (j.status IN ('queued','running') OR j.created_at>=?) ORDER BY j.created_at DESC LIMIT 300",
        [p.id, new Date(Date.now() - 3 * 86400000).toISOString()],
      ),
      // 결과 버전: 대상(인물·컷·포스터)마다 최근 12개씩(큰 프로젝트에서도 예전 버전이 목록에서 사라지지 않게)
      assets: await db.all(
        `SELECT id,target_type,target_id,kind,url,model_label,created_at,batch,verify FROM (
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
      props: await propsOf(p.id),
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
      team: await collab.summary(req, p),
    });
  });
  app.patch('/api/studio/ai/projects/:id', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'script');
    // zod의 partial()은 .default()가 있는 칸(톤·스타일·시놉시스·중국 모델 제외)을 보내지 않아도 기본값으로 채워요.
    // 바뀐 칸만 보내는 화면(2026-10-01)에서 다른 칸이 지워지지 않도록, 실제로 보낸 칸만 반영합니다.
    const parsed = projectSchema.partial().parse(req.body);
    const b = Object.fromEntries(Object.entries(parsed).filter(([k]) => Object.hasOwn(req.body || {}, k)));
    // 모델 정책(중국 모델 제외) · 회차 수는 관리 항목이에요(2026-09-30 점검).
    if (req.teamRole && req.teamRole !== 'owner' && !can(req.teamRole, 'manage') && ((b.exclude_cn !== undefined && (b.exclude_cn ? 1 : 0) !== Number(p.exclude_cn)) || (b.episode_count !== undefined && Number(b.episode_count) !== Number(p.episode_count))))
      fail(403, `${ROLE_NAME[req.teamRole] || req.teamRole} 역할은 회차 수 · 모델 정책을 바꿀 수 없어요.`);
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
    const p = await project(req, req.params.id, 'scene');
    const b = z.object({ image: z.string().regex(/^\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/) }).parse(req.body);
    const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [b.image]);
    if (!f || (f.owner_id !== p.owner_id && req.user.role !== 'admin')) fail(403, '이 프로젝트에서 만든 이미지만 포스터로 쓸 수 있어요.');
    await db.run('UPDATE studio_projects SET poster=?,updated_at=? WHERE id=?', [b.image, now(), p.id]);
    res.json({ ok: true });
  });
  // ── 인물 · 회차 · 컷 편집 ──────────────────────────────────
  // 한국어로 쓴 묘사(컷 화면·인물 외모·장소)는 저장할 때 영상·이미지 모델용 영어로 번역해 둡니다.
  // 번역은 플랫폼이 부담하므로(라마 차감 없음) 텍스트 모델이 없거나 실패해도 저장에는 영향이 없습니다.
  // inTx: 이미 트랜잭션 안(작업 결과 반영 중 등)이면 새 트랜잭션을 열지 않습니다(SQLite 대기열 교착 방지).
  async function queueTranslate(projectId, userId, items, { inTx = false } = {}) {
    const list = items.filter((x) => /[가-힣]/.test(x.ko || '') && String(x.ko).trim().length >= 2);
    if (!list.length) return;
    const wrap = (fn) => (inTx ? fn() : db.transaction(fn));
    try {
      await wrap(() =>
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
    // 3단계(2026-09-30): 모든 컷에서 지킬 외형(헤어 · 체형 · 금지 요소)과 외형 고정
    hair: z.string().trim().max(120).default(''),
    body: z.string().trim().max(120).default(''),
    forbid: z.string().trim().max(200).default(''),
    locked: z.boolean().optional(),
  });
  // 고치기(PATCH)는 보낸 칸만 바꿔요(다른 칸은 지금 값을 그대로 둠).
  const characterPatchSchema = z.object(Object.fromEntries(Object.entries(characterSchema.shape).map(([k, v]) => [k, v instanceof z.ZodDefault ? v.unwrap().optional() : v.optional()])));
  app.post('/api/studio/ai/projects/:id/characters', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'script');
    const b = characterSchema.parse(req.body);
    const count = (await charactersOf(p.id)).length;
    if (count >= 8) fail(400, '인물은 8명까지 만들 수 있어요.');
    const id = randomUUID();
    await db.run('INSERT INTO studio_characters (id,project_id,name,role,description,look,outfit,voice_model,voice,voice_style,hair,body,forbid,locked,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      id, p.id, b.name, b.role, b.description, b.look, b.outfit, b.voice_model, b.voice, b.voice_style, b.hair, b.body, b.forbid, b.locked ? 1 : 0, count,
    ]);
    await touch(p.id);
    await queueTranslate(p.id, p.owner_id, [{ id: 'character:' + id, ko: b.look }]);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/projects/:id/characters/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, ['script', 'scene']);
    const raw = characterPatchSchema.parse(req.body);
    const c = await db.get('SELECT * FROM studio_characters WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    if (!c) fail(404, '인물을 찾을 수 없어요.');
    const b = { ...c, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) };
    b.locked = raw.locked === undefined ? Number(c.locked || 0) : raw.locked ? 1 : 0;
    await db.run('UPDATE studio_characters SET name=?,role=?,description=?,look=?,outfit=?,voice_model=?,voice=?,voice_style=?,hair=?,body=?,forbid=?,locked=? WHERE id=?', [
      b.name, b.role, b.description, b.look, b.outfit, b.voice_model, b.voice, b.voice_style, b.hair || '', b.body || '', b.forbid || '', b.locked, c.id,
    ]);
    await touch(p.id);
    if (b.look !== c.look && b.look !== c.look_en_src) await queueTranslate(p.id, p.owner_id, [{ id: 'character:' + c.id, ko: b.look }]);
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/projects/:id/characters/:cid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'script');
    const c = await db.get('SELECT id FROM studio_characters WHERE id=? AND project_id=?', [req.params.cid, p.id]);
    if (!c) fail(404, '인물을 찾을 수 없어요.');
    // 진행 중인 AI 작업(이미지 · 목소리 등)이 있으면 지우지 않아요(결과 갈 곳 없이 라마만 차감되지 않게).
    if (await db.get("SELECT id FROM ai_jobs WHERE target_id=? AND status IN ('queued','running') AND kind<>'translate' LIMIT 1", [c.id]))
      fail(409, '이 인물의 AI 작업이 진행 중이에요. 끝나거나 작업 센터에서 멈춘 뒤 지워 주세요.');
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
  // 이 프로젝트의 파일인지: 주인 + (프로젝트 표시 또는 이 프로젝트의 버전 기록·인물·장소·소품에서 쓰임)
  const projectMedia = async (projectId, url) => {
    const pr = await db.get('SELECT owner_id FROM studio_projects WHERE id=?', [projectId]);
    const hit = await db.get(
      `SELECT 1 AS ok FROM media_files f WHERE f.url=? AND f.owner_id=? AND (f.project_id=?
        OR EXISTS (SELECT 1 FROM studio_assets a WHERE a.url=f.url AND a.project_id=?)
        OR EXISTS (SELECT 1 FROM studio_characters c WHERE c.project_id=? AND c.image=f.url)
        OR EXISTS (SELECT 1 FROM studio_locations l WHERE l.project_id=? AND l.image=f.url)
        OR EXISTS (SELECT 1 FROM studio_props x WHERE x.project_id=? AND x.image=f.url)
        OR EXISTS (SELECT 1 FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=? AND (s.image=f.url OR s.end_image=f.url)))`,
      [url, pr?.owner_id || '', projectId, projectId, projectId, projectId, projectId, projectId],
    );
    if (!hit) fail(403, '이 프로젝트에서 만든 이미지만 고를 수 있어요.');
  };
  const ownedMedia = async (p, url) => {
    if (!url) return;
    const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [url]);
    if (!f || f.owner_id !== p.owner_id) fail(403, '이 프로젝트에서 만든 파일만 쓸 수 있어요.');
  };
  app.patch('/api/studio/ai/projects/:id/episodes/:eid', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, ['script', 'scene']);
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
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [e.id]);
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
    prop_ids: z.array(z.string().max(80)).max(6).optional(),
    states: z.record(z.string().max(80), z.string().trim().max(120)).optional(), // {인물ID: '젖은 머리'}
    // 컷 연출(2026-09-29): 앵글·렌즈 느낌·움직임 강도 · 끝 장면 이미지 · 합성 효과
    angle: z.string().trim().max(20).refine((v) => v === '' || ANGLE_IDS.includes(v), '앵글을 목록에서 골라 주세요.').optional(),
    lens: z.string().trim().max(20).refine((v) => v === '' || LENS_IDS.includes(v), '화면 느낌을 목록에서 골라 주세요.').optional(),
    move_strength: z.enum(STRENGTH_IDS).optional(),
    end_image: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).optional(),
    effect: z.enum(SHOT_EFFECTS).optional(),
    // 2단계(2026-09-30): 조명 · 시간과 색감 · 카메라 높이 · 조리개(f값) · 초점 거리(mm, 0 = 자동)
    light: z.string().trim().max(20).refine((v) => v === '' || LIGHT_IDS.includes(v), '조명을 목록에서 골라 주세요.').optional(),
    tone: z.string().trim().max(20).refine((v) => v === '' || TONE_IDS.includes(v), '시간 · 색감을 목록에서 골라 주세요.').optional(),
    height: z.string().trim().max(20).refine((v) => v === '' || HEIGHT_IDS.includes(v), '카메라 높이를 목록에서 골라 주세요.').optional(),
    dof: z.union([z.literal(''), z.string().regex(/^\d{1,2}(\.\d)?$/).refine((v) => Number(v) >= 1.2 && Number(v) <= 22, '조리개는 f/1.2~f/22 사이로 적어 주세요.')]).optional(),
    focal: z.number().int().refine((v) => v === 0 || (v >= 12 && v <= 300), '초점 거리는 12~300mm 사이로 적어 주세요.').optional(),
    base_updated_at: z.string().max(40).nullable().optional(), // 협업: 불러올 때의 수정 시각(다른 사람이 먼저 고쳤는지 확인)
  });
  // 컷 고치기(PATCH)는 바꾼 칸만 보내도 돼요. 보내지 않은 칸은 지금 값을 그대로 둡니다(다른 탭에서 고친 내용을 덮어쓰지 않도록).
  const shotPatchSchema = shotSchema.extend({
    scene: z.string().trim().max(200).optional(),
    visual: z.string().trim().max(800).optional(),
    dialogue: z.string().trim().max(300).optional(),
    speaker_id: z.string().max(80).nullable().optional(),
    camera: z.string().trim().max(80).optional(),
    seconds: z.number().int().min(2).max(10).optional(),
  });
  const checkProps = async (projectId, ids) => {
    for (const id of ids) if (!(await db.get('SELECT id FROM studio_props WHERE id=? AND project_id=?', [id, projectId]))) fail(400, '이 프로젝트의 소품만 고를 수 있어요.');
  };
  app.post('/api/studio/ai/projects/:id/episodes/:eid/shots', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'script');
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
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status IN ('outline','composed') THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [e.id]);
    await resetScriptReview(e.id);
    await queueTranslate(p.id, p.owner_id, [{ id: 'shot:' + id, ko: b.visual }]);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/shots/:sid', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid, ['script', 'scene']);
    const raw = shotPatchSchema.parse(req.body);
    const b = {
      ...raw,
      scene: raw.scene ?? s.scene,
      visual: raw.visual ?? s.visual,
      dialogue: raw.dialogue ?? s.dialogue,
      speaker_id: raw.speaker_id === undefined ? s.speaker_id : raw.speaker_id,
      camera: raw.camera ?? s.camera,
      seconds: raw.seconds ?? Number(s.seconds),
    };
    // 편집·연출(대본 권한 없음)은 장면·대사·화자·내레이션 같은 대본 내용은 바꿀 수 없어요.
    if (req.teamRole && !can(req.teamRole, 'script') && (b.scene !== s.scene || b.dialogue !== s.dialogue || b.speaker_id !== s.speaker_id || (b.narration !== undefined && (b.narration ? 1 : 0) !== Number(s.narration))))
      fail(403, `${ROLE_NAME[req.teamRole]} 역할은 장면 이름·대사·화자를 바꿀 수 없어요. 작가에게 요청해 주세요.`);
    await checkSpeaker(s.project_id, b.speaker_id);
    if (b.cast_ids) await checkCast(s.project_id, b.cast_ids);
    if (b.location_id !== undefined) await checkLocation(s.project_id, b.location_id);
    if (b.prop_ids) await checkProps(s.project_id, b.prop_ids);
    if (b.states) for (const cid of Object.keys(b.states)) await checkSpeaker(s.project_id, cid);
    // 같은 컷을 다른 사람이 먼저 고쳤으면 덮어쓰지 않고 알려 줍니다(혼자 작업할 때는 해당 없음).
    // 같은 사람이라도 다른 기기 · 탭(세션)에서 먼저 고쳤으면 알려요(2026-09-30). 같은 탭의 연속 저장은 그대로 통과.
    const otherSession = s.updated_by === req.user.id && !!s.updated_session && !!req.sessionKey && s.updated_session !== req.sessionKey;
    if (b.base_updated_at !== undefined && s.updated_at && s.updated_by && (s.updated_by !== req.user.id || otherSession) && s.updated_at !== b.base_updated_at) {
      if (otherSession) throw Object.assign(new Error('다른 기기나 탭에서 이 컷을 먼저 고쳤어요. 새로 불러온 뒤 다시 고쳐 주세요.'), { status: 409, code: 'edit_conflict' });
      const who = await db.get('SELECT name FROM users WHERE id=?', [s.updated_by]);
      throw Object.assign(new Error(`${who?.name || '다른 사람'}님이 이 컷을 먼저 고쳤어요. 새로 불러온 뒤 다시 고쳐 주세요.`), { status: 409, code: 'edit_conflict' });
    }
    const states = b.states ? Object.fromEntries(Object.entries(b.states).filter(([, v]) => v)) : null;
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
      angle: b.angle ?? s.angle ?? '',
      lens: b.lens ?? s.lens ?? '',
      move_strength: b.move_strength ?? s.move_strength ?? '',
      end_image: b.end_image ?? s.end_image ?? '',
      effect: b.effect ?? s.effect ?? '',
      light: b.light ?? s.light ?? '',
      tone: b.tone ?? s.tone ?? '',
      height: b.height ?? s.height ?? '',
      dof: b.dof ?? s.dof ?? '',
      focal: b.focal ?? Number(s.focal || 0),
    };
    // 끝 장면은 이 프로젝트에서 만든 이미지만 쓸 수 있어요(같은 주인의 다른 프로젝트 파일도 안 됨).
    if (b.end_image && b.end_image !== s.end_image) await projectMedia(s.project_id, b.end_image);
    // 대사·화자·감정·속도·내레이션이 바뀌면 이전 음성(과 입 모양 영상)은 맞지 않으므로 지웁니다(버전 기록에는 남음).
    const audioReset =
      b.dialogue !== s.dialogue || b.speaker_id !== s.speaker_id || next.emotion !== s.emotion || Number(next.speed) !== Number(s.speed) || next.narration !== Number(s.narration);
    // 시드 고정을 켜면 지금 시드를 정해 두고, 같은 컷을 다시 만들 때 비슷한 그림이 나오게 합니다.
    const seed = next.seed_lock && (s.seed === null || s.seed === undefined) ? Math.floor(Math.random() * 2147483647) : s.seed;
    await db.run(
      `UPDATE studio_shots SET scene=?,visual=?,dialogue=?,speaker_id=?,cast_ids=?,location_id=?,camera=?,camera_move=?,emotion=?,speed=?,narration=?,seed_lock=?,seed=?,end_frame=?,transition=?,sfx_prompt=?,sfx_volume=?,caption=?,seconds=?,prop_ids=?,states=?,angle=?,lens=?,move_strength=?,end_image=?,effect=?,light=?,tone=?,height=?,dof=?,focal=?,updated_at=?,updated_by=?,updated_session=?${
        audioReset ? ",audio='',audio_seconds=0,lipsync=''" : ''
      } WHERE id=?`,
      [
        b.scene, b.visual, b.dialogue, b.speaker_id, next.cast_ids, next.location_id, b.camera, next.camera_move, next.emotion, next.speed, next.narration, next.seed_lock, seed, next.end_frame, next.transition, next.sfx_prompt, next.sfx_volume, next.caption, b.seconds,
        b.prop_ids ? b.prop_ids.join(',') : s.prop_ids || '',
        states ? (Object.keys(states).length ? JSON.stringify(states) : '') : s.states || '',
        next.angle, next.lens, next.move_strength, next.end_image, next.effect,
        next.light, next.tone, next.height, next.dof, next.focal,
        now(), req.user.id, req.sessionKey || '',
        s.id,
      ],
    );
    // 합성본에 들어가는 값(이미지만 있는 컷의 카메라 움직임·강도, 효과 포함)이 바뀌면 다시 합성해야 해요.
    const changed =
      ['scene', 'visual', 'dialogue', 'speaker_id', 'camera'].some((k) => b[k] !== s[k]) || Number(b.seconds) !== Number(s.seconds) || audioReset || next.transition !== s.transition || next.caption !== s.caption || Number(next.sfx_volume) !== Number(s.sfx_volume) ||
      next.effect !== (s.effect || '') || toneGrade(next.tone) !== toneGrade(s.tone) || (!s.video && !s.lipsync && (next.camera_move !== s.camera_move || next.move_strength !== (s.move_strength || '')));
    const stamp = (await db.get('SELECT updated_at FROM studio_shots WHERE id=?', [s.id]))?.updated_at;
    if (changed) await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
    if (['scene', 'visual', 'dialogue', 'speaker_id'].some((k) => b[k] !== s[k]) || Number(b.seconds) !== Number(s.seconds) || next.narration !== Number(s.narration)) await resetScriptReview(s.episode_id);
    if (b.visual !== s.visual && b.visual !== s.visual_en_src) await queueTranslate(s.project_id, (await db.get('SELECT owner_id FROM studio_projects WHERE id=?', [s.project_id])).owner_id, [{ id: 'shot:' + s.id, ko: b.visual }]);
    res.json({ ok: true, audioReset, updated_at: stamp });
  });
  app.delete('/api/studio/ai/shots/:sid', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid, 'script');
    // 진행 중인 AI 작업이 있는 컷을 지우면 결과가 갈 곳 없이 라마만 차감돼요. 끝나거나 멈춘 뒤 지우게 합니다.
    if (await db.get("SELECT id FROM ai_jobs WHERE target_type='shot' AND target_id=? AND status IN ('queued','running') AND kind<>'translate' LIMIT 1", [s.id]))
      fail(409, '이 컷을 만드는 AI 작업이 진행 중이에요. 작업이 끝나거나 작업 센터에서 멈춘 뒤 지워 주세요.');
    await db.transaction(async () => {
      // 지우기 전 대본을 버전으로 남겨, 버전 기록에서 되돌릴 수 있게 합니다.
      const order = (await shotsOf(s.episode_id)).findIndex((x) => x.id === s.id);
      await snapshotScript(s.episode_id, s.project_id, 'before_delete', `${order + 1}번 컷 지우기 전`);
      await db.run('DELETE FROM studio_shots WHERE id=?', [s.id]);
    });
    // 합성한 뒤 컷이 바뀌면 완성본을 다시 만들어야 합니다.
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
    await resetScriptReview(s.episode_id);
    res.json({ ok: true });
  });
  app.post('/api/studio/ai/shots/:sid/move', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid, ['script', 'scene']);
    const b = z.object({ direction: z.enum(['up', 'down']) }).parse(req.body);
    await db.transaction(async () => {
      const shots = await shotsOf(s.episode_id);
      const i = shots.findIndex((x) => x.id === s.id);
      const j = b.direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= shots.length) return;
      [shots[i], shots[j]] = [shots[j], shots[i]];
      for (let k = 0; k < shots.length; k++) await db.run('UPDATE studio_shots SET sort_order=? WHERE id=?', [k, shots[k].id]);
      await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
      await resetScriptReview(s.episode_id);
    });
    res.json({ ok: true });
  });
  // 컷 순서 한 번에 바꾸기(스토리보드 끌어 놓기)
  app.post('/api/studio/ai/projects/:id/episodes/:eid/shots/order', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, ['script', 'scene']);
    const b = z.object({ ids: z.array(z.string().max(80)).min(1).max(200) }).parse(req.body);
    await db.transaction(async () => {
      const e = await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      const shots = await shotsOf(e.id);
      if (b.ids.length !== shots.length || new Set(b.ids).size !== b.ids.length || !b.ids.every((id) => shots.some((s) => s.id === id)))
        fail(409, '컷 목록이 바뀌었어요. 새로고침한 뒤 다시 옮겨 주세요.');
      for (let k = 0; k < b.ids.length; k++) await db.run('UPDATE studio_shots SET sort_order=? WHERE id=?', [k, b.ids[k]]);
      if (b.ids.some((id, k) => shots[k].id !== id)) {
        await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [e.id]);
        await resetScriptReview(e.id);
      }
    });
    res.json({ ok: true });
  });
  // 여러 컷 한 번에 고치기(감정·말 빠르기·카메라 움직임·전환·말하는 인물·길이)
  app.patch('/api/studio/ai/projects/:id/episodes/:eid/shots/bulk', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'scene');
    const b = z
      .object({
        ids: z.array(z.string().max(80)).min(1).max(200),
        emotion: z.string().trim().max(20).optional(),
        speed: z.number().min(0.5).max(2).optional(),
        camera_move: z.string().trim().max(30).optional(),
        transition: z.enum(['cut', 'fade', 'dip', 'flash']).optional(),
        speaker_id: z.string().max(80).nullable().optional(),
        seconds: z.number().int().min(2).max(10).optional(),
        // 연출 세트 한 번에(샷 크기·앵글·렌즈 느낌·움직임 강도) · 효과
        camera: z.string().trim().max(80).optional(),
        angle: z.string().trim().max(20).refine((v) => v === '' || ANGLE_IDS.includes(v), '앵글을 목록에서 골라 주세요.').optional(),
        lens: z.string().trim().max(20).refine((v) => v === '' || LENS_IDS.includes(v), '화면 느낌을 목록에서 골라 주세요.').optional(),
        move_strength: z.enum(STRENGTH_IDS).optional(),
        effect: z.enum(SHOT_EFFECTS).optional(),
        light: z.string().trim().max(20).refine((v) => v === '' || LIGHT_IDS.includes(v), '조명을 목록에서 골라 주세요.').optional(),
        tone: z.string().trim().max(20).refine((v) => v === '' || TONE_IDS.includes(v), '시간 · 색감을 목록에서 골라 주세요.').optional(),
        height: z.string().trim().max(20).refine((v) => v === '' || HEIGHT_IDS.includes(v), '카메라 높이를 목록에서 골라 주세요.').optional(),
      })
      .parse(req.body);
    const e = await db.get('SELECT id FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    // 말하는 인물 · 길이는 대본 항목이라 단일 컷 수정과 같은 권한(작가)을 요구해요(2026-09-30 점검).
    if (req.teamRole && req.teamRole !== 'owner' && !can(req.teamRole, 'script') && (b.speaker_id !== undefined || b.seconds !== undefined))
      fail(403, `${ROLE_NAME[req.teamRole] || req.teamRole} 역할은 말하는 인물 · 길이를 바꿀 수 없어요(작가 권한 필요).`);
    if (b.speaker_id !== undefined) await checkSpeaker(p.id, b.speaker_id);
    const fields = ['emotion', 'speed', 'camera_move', 'transition', 'speaker_id', 'seconds', 'camera', 'angle', 'lens', 'move_strength', 'effect', 'light', 'tone', 'height'].filter((k) => b[k] !== undefined);
    if (!fields.length) fail(400, '바꿀 내용을 골라 주세요.');
    let changed = 0;
    let reset = 0;
    let scriptTouched = false;
    await db.transaction(async () => {
      for (const s of (await shotsOf(e.id)).filter((x) => b.ids.includes(x.id))) {
        const diff = fields.filter((k) => String(b[k] ?? '') !== String(s[k] ?? ''));
        if (!diff.length) continue;
        // 대사 목소리에 영향을 주는 값이 바뀌면 이전 음성(과 입 모양)은 맞지 않으므로 뺍니다(버전 기록에는 남음).
        const audioReset = diff.some((k) => ['emotion', 'speed', 'speaker_id'].includes(k)) && (s.audio || s.lipsync);
        await db.run(`UPDATE studio_shots SET ${diff.map((k) => `${k}=?`).join(',')}${audioReset ? ",audio='',audio_seconds=0,lipsync=''" : ''}${b.speaker_id !== undefined && diff.includes('speaker_id') ? ',narration=0' : ''} WHERE id=?`, [...diff.map((k) => b[k]), s.id]);
        changed++;
        if (audioReset) reset++;
        if (diff.some((k) => ['speaker_id', 'seconds'].includes(k))) scriptTouched = true;
      }
      if (scriptTouched) await resetScriptReview(e.id);
      if (changed) await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [e.id]);
    });
    res.json({ changed, audioReset: reset });
  });
  // 결과 버전 고르기: 예전에 만든 이미지·음성·영상으로 되돌립니다.
  app.post('/api/studio/ai/assets/:aid/use', roles('pd', 'admin'), async (req, res) => {
    const a = await db.get('SELECT * FROM studio_assets WHERE id=?', [req.params.aid]);
    if (!a) fail(404, '결과를 찾을 수 없어요.');
    await project(req, a.project_id, 'scene');
    const map = {
      character: ['studio_characters', { image: 'image', audio: 'voice_sample' }[a.kind]],
      shot: ['studio_shots', { image: 'image', audio: 'audio', video: 'video', lipsync: 'lipsync', sfx: 'sfx' }[a.kind]],
      project: ['studio_projects', 'poster'],
    }[a.target_type];
    if (!map || !map[1]) fail(400, '적용할 수 없는 결과예요.');
    if (a.target_type === 'shot' && a.kind === 'audio') {
      const meta = await db.get('SELECT duration FROM media_metadata WHERE url=?', [a.url]);
      // 음성이 바뀌면 예전 음성에 맞춘 입 모양 영상은 맞지 않아요.
      await db.run("UPDATE studio_shots SET audio=?,audio_seconds=?,lipsync='' WHERE id=?", [a.url, Number(meta?.duration || 0), a.target_id]);
    } else if (a.target_type === 'shot' && map[1] === 'image' && a.verify) {
      // 후보를 검수해 두었으면 그 결과를 컷 검수로 그대로 이어 써요(같은 이미지).
      await db.run('UPDATE studio_shots SET image=?,verify=? WHERE id=?', [a.url, a.verify, a.target_id]);
    } else
      await db.run(
        `UPDATE ${map[0]} SET ${map[1]}=?${a.target_type === 'shot' && (map[1] === 'image' || map[1] === 'video') ? ",verify=''" : ''}${a.target_type === 'shot' && map[1] === 'video' ? ",lipsync=''" : ''} WHERE id=?`,
        [a.url, a.target_id],
      );
    if (a.target_type === 'shot') {
      const shot = await db.get('SELECT episode_id FROM studio_shots WHERE id=?', [a.target_id]);
      if (shot) await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [shot.episode_id]);
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
  // 협업 결제: 기본은 실행한 사람이 자기 라마로(젠스파크 방식). 소유자가 '지원'으로 정한 멤버는
  // 한도(0 = 제한 없음) 안에서 소유자 라마로 실행해요(러버블 방식).
  async function sponsorUsed(projectId, actorId, ownerId) {
    return Number(
      (
        await db.get(
          "SELECT COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_lama WHEN status IN ('queued','running') THEN estimate_lama ELSE 0 END),0) AS n FROM ai_jobs WHERE project_id=? AND actor_id=? AND user_id=? AND billed=1",
          [projectId, actorId, ownerId],
        )
      )?.n || 0,
    );
  }
  async function payerInfo(req, p) {
    const m = req.teamRole && req.teamRole !== 'owner' ? req.teamMember : null;
    if (!m || m.pay_mode !== 'sponsor') return { mode: 'self', payer_id: req.user.id, limit: 0, used: 0 };
    return { mode: 'sponsor', payer_id: p.owner_id, limit: Number(m.sponsor_limit || 0), used: await sponsorUsed(p.id, req.user.id, p.owner_id) };
  }
  async function payerFor(req, p, b, lama) {
    const info = await payerInfo(req, p);
    if (info.mode !== 'sponsor' || b.payOwn) return req.user.id;
    if (info.limit > 0 && info.used + lama > info.limit)
      throw Object.assign(new Error(`소유자가 지원하는 라마 한도(${info.limit.toLocaleString('ko-KR')}라마)를 넘어요. 지금까지 ${info.used.toLocaleString('ko-KR')}라마를 썼어요. 내 라마로 진행할 수 있어요.`), { status: 409, code: 'sponsor_limit' });
    return p.owner_id;
  }
  async function priceSpecs(p, b, specs, exclude = []) {
    let lama = 0;
    let label = '';
    for (const spec of specs) {
      const e = await engine.estimate({ capability: spec.capability, requested: spec.requestedOverride || b.requested, tier: b.tier, tags: spec.tags, seconds: spec.input.seconds, needImage: needsImage(spec.input), needCamera: !!spec.input.needCamera, needEnd: !!spec.input.endImage, needMask: !!spec.input.maskImage, input: spec.input, excludeCn: !!Number(p.exclude_cn), exclude, requireImage: !!spec.input._requireImage });
      lama += e.lama;
      label = e.model.label;
    }
    return { lama, label };
  }
  app.post('/api/studio/ai/projects/:id/estimate', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const b = runSchema.parse(req.body);
    const specs = await plan(req, p, b);
    const settings = await settingsOf();
    const { lama, label } = await priceSpecs(p, b, specs);
    // 자동 선택이면 '왜 이 모델?' 이유와 다른 후보를 함께 보여 줍니다(목소리를 정해 둔 음성 작업 제외).
    let why = [];
    const first = specs[0];
    if (b.requested === 'auto' && first && !first.requestedOverride) {
      try {
        why = await engine.explain({ capability: first.capability, tier: b.tier, tags: first.tags, seconds: first.input.seconds, needImage: needsImage(first.input), needCamera: !!first.input.needCamera, needEnd: !!first.input.endImage, needMask: !!first.input.maskImage, input: first.input, excludeCn: !!Number(p.exclude_cn), requireImage: !!first.input._requireImage });
      } catch {}
    }
    const budget = await budgetOf(p);
    const pay = await payerInfo(req, p);
    res.json({
      payer: { mode: pay.mode, limit: pay.limit, used: pay.used, over: pay.mode === 'sponsor' && pay.limit > 0 && pay.used + lama > pay.limit },
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
    const needPrice = (Number(p.budget_lama) > 0 && !b.budgetOk) || (!!req.teamMember && req.teamRole !== 'owner');
    const price = needPrice ? (await priceSpecs(p, b, specs, exclude)).lama : 0;
    // 실제로 실행할 때만 하는 준비(예: 영상 검수용 장면 뽑기). 작업이 만들어지지 않으면 뽑은 파일을 지워요.
    const prepared = [];
    const cleanup = async (keep = new Set()) => {
      for (const spec of prepared) if (!keep.has(spec)) await removeFrames(spec.input.tempFrames);
    };
    let made;
    try {
      for (const spec of specs)
        if (spec.prepare) {
          spec.input = await spec.prepare(spec.input);
          prepared.push(spec);
        }
      made = await runSpecsTx(req, p, b, specs, exclude, price);
    } catch (e) {
      await cleanup();
      throw e;
    }
    // 이미 있던 작업(같은 요청 · 진행 중)을 돌려받은 경우 새로 뽑은 파일은 쓰이지 않아요.
    await cleanup(new Set(specs.filter((spec, i) => made.created[i])));
    return made.jobs;
  }
  // 대본을 새로 쓰는 작업(대본 쓰기·구간 다시 쓰기·대본 나누기)과 컷 작업(이미지·영상·음성 등)이 같은 회차에서 겹치면,
  // 컷 ID를 다시 쓰는 대본 반영 뒤에 끝난 옛 컷 결과가 내용이 바뀐 새 컷에 붙고 라마도 차감됩니다(2026-10-01 점검).
  // 그래서 둘 중 하나가 진행 중이면 다른 쪽은 시작하지 않아요. 번역(무료)은 막지 않습니다.
  const SCRIPT_REWRITE_KINDS = ['script', 'rewrite_range', 'parse_script'];
  async function guardScriptVsShots(p, spec) {
    if (SCRIPT_REWRITE_KINDS.includes(spec.kind)) {
      const shotJob =
        spec.kind === 'parse_script'
          ? await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') AND target_type='shot' AND kind<>'translate' LIMIT 1", [p.id])
          : await db.get(
              "SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') AND target_type='shot' AND kind<>'translate' AND target_id IN (SELECT id FROM studio_shots WHERE episode_id=?) LIMIT 1",
              [p.id, spec.target.id],
            );
      if (shotJob) fail(409, '이 회차의 컷을 만드는 AI 작업이 진행 중이에요. 끝난 뒤 대본을 다시 써 주세요.');
      return;
    }
    if (spec.target?.type !== 'shot' || spec.kind === 'translate') return;
    const shot = await db.get('SELECT episode_id FROM studio_shots WHERE id=?', [spec.target.id]);
    if (!shot) return;
    const scriptJob = await db.get(
      "SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') AND (kind='parse_script' OR (kind IN ('script','rewrite_range') AND target_type='episode' AND target_id=?)) LIMIT 1",
      [p.id, shot.episode_id],
    );
    if (scriptJob) fail(409, '이 회차의 대본을 AI가 다시 쓰는 중이에요. 대본이 바뀐 뒤 컷을 만들어 주세요.');
  }
  async function runSpecsTx(req, p, b, specs, exclude, price) {
    const createdFlags = [];
    const jobs = await db.transaction(async () => {
      if (db.engine === 'postgresql') await db.get('SELECT id FROM studio_projects WHERE id=? FOR UPDATE', [p.id]);
      // 결제자 · 지원 한도 · 프로젝트 예산은 프로젝트 잠금 안에서 확인해요(동시에 누른 두 작업이 함께 한도를 넘지 않도록).
      if (req.teamMember && req.teamRole !== 'owner') {
        const fresh = await db.get('SELECT pay_mode,sponsor_limit FROM studio_members WHERE project_id=? AND user_id=?', [p.id, req.user.id]);
        if (fresh) req.teamMember = { ...req.teamMember, pay_mode: fresh.pay_mode, sponsor_limit: fresh.sponsor_limit };
      }
      const payer = await payerFor(req, p, b, price);
      if (Number(p.budget_lama) > 0 && !b.budgetOk) {
        const budget = await budgetOf(p);
        if (budget.spent + price > budget.limit)
          throw Object.assign(new Error(`프로젝트 예산(${budget.limit.toLocaleString('ko-KR')}라마)을 넘어요. 지금까지 ${budget.spent.toLocaleString('ko-KR')}라마를 썼고, 이번 작업은 약 ${price.toLocaleString('ko-KR')}라마예요.`), {
            status: 409,
            code: 'project_budget',
          });
      }
      const out = [];
      for (const spec of specs) {
        const multi = specs.length > 1 || b.action.startsWith('batch_');
        const requestKey = b.idempotencyKey ? (multi ? `${b.idempotencyKey}:${spec.kind}:${spec.target.id}${spec.keySuffix ? ':' + spec.keySuffix : ''}` : b.idempotencyKey) : undefined;
        const previous = requestKey ? await db.get('SELECT * FROM ai_jobs WHERE idempotency_key=?', [requestKey]) : null;
        if (previous) {
          if (previous.user_id !== payer || previous.project_id !== p.id || previous.kind !== spec.kind || previous.target_id !== spec.target.id)
            fail(409, '다른 AI 작업에 사용된 요청입니다. 다시 시작해 주세요.');
          out.push(previous);
          createdFlags.push(false);
          continue;
        }
        await guardScriptVsShots(p, spec);
        // 후보 여러 장: 잠금 안에서 한 번 더 확인해요(두 번 빨리 눌러 후보가 두 배로 생기지 않도록).
        if (spec.input?.candidate && /^c1$/.test(spec.keySuffix || '')) {
          const family = spec.kind === 'shot_video' ? ['shot_video', 'shot_upscale_video'] : ['shot_image', 'shot_image_edit', 'shot_upscale'];
          if (await db.get(`SELECT id FROM ai_jobs WHERE target_id=? AND kind IN (${family.map(() => '?').join(',')}) AND status IN ('queued','running') LIMIT 1`, [spec.target.id, ...family]))
            fail(409, '이 컷을 만드는 작업이 진행 중이에요. 끝난 뒤 후보를 만들어 주세요.');
        }
        // 같은 대상의 같은 작업이 진행 중이면 새로 만들지 않습니다(인물 참고 이미지는 자세별로 따로).
        // 자세별 참고 이미지(keySuffix=pose)는 같은 자세가 진행 중일 때만 막아요(2026-09-30 점검: 세트 이중 실행 방지).
        const active = spec.keySuffix
          ? spec.input?.candidate
            ? null
            : await db.get("SELECT * FROM ai_jobs WHERE project_id=? AND kind=? AND target_id=? AND status IN ('queued','running') AND input LIKE ?", [p.id, spec.kind, spec.target.id, `%"pose":"${String(spec.input?.pose || spec.keySuffix).replace(/[%_"\\]/g, '')}"%`])
          : await db.get("SELECT * FROM ai_jobs WHERE project_id=? AND kind=? AND target_id=? AND status IN ('queued','running')", [p.id, spec.kind, spec.target.id]);
        if (active) {
          if (!multi) fail(409, '같은 작업이 이미 진행 중이에요.');
          out.push(active);
          createdFlags.push(false);
          continue;
        }
        createdFlags.push(true);
        out.push(
          await engine.enqueue({
            userId: payer,
            actorId: req.user.id,
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
      for (const spec of specs) if (spec.persist) await db.run(spec.persist.sql, spec.persist.params);
      await db.run("UPDATE studio_projects SET status=CASE WHEN status='draft' THEN 'producing' ELSE status END,updated_at=? WHERE id=?", [now(), p.id]);
      return out;
    }).catch((e) => {
      // 소유자 지원으로 결제하는 팀원에게는 소유자 잔액을 보여 주지 않고, 내 라마로 진행할 수 있다고 알려요(2026-09-30 점검).
      if (e?.code === 'insufficient_lama' && req.teamMember && req.teamRole !== 'owner' && req.teamMember.pay_mode === 'sponsor' && !b.payOwn)
        throw Object.assign(new Error('프로젝트 소유자의 라마가 부족해요. 소유자에게 충전을 요청하거나, 내 라마로 진행할 수 있어요.'), { status: 409, code: 'sponsor_insufficient' });
      throw e;
    });
    return { jobs, created: createdFlags };
  }
  const jobsView = async (req, jobs) => ({
    jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, estimate_lama: Number(j.estimate_lama), status: j.status })),
    lama: jobs.reduce((n, j) => n + Number(j.estimate_lama), 0),
    wallet: await lamaWalletOf(db, req.user.id),
  });
  app.post('/api/studio/ai/projects/:id/run', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const p = await project(req, req.params.id, 'view');
    const b = runSchema.parse(req.body);
    const specs = await plan(req, p, b);
    const jobs = await runSpecs(req, p, b, specs);
    if (req.teamRole !== 'owner' || (await collab.approvalsActive(p))) await collab.log(p.id, req.user.id, 'ai_run', `${b.action.replace(/^batch_/, '일괄 ')} ${jobs.length}건`);
    res.status(201).json(await jobsView(req, jobs));
  });
  // 실패한 작업 다시 시도: 같은 작업을 다시 만들되, 자동 선택이면 실패한 모델은 빼고 다음 후보로(직접 고르면 그 모델로).
  const RETRYABLE = new Set(['plan', 'poster', 'adapt', 'bible', 'season', 'metadata', 'music', 'script', 'diagnose', 'rewrite_range', 'character_image', 'character_ref', 'location_image', 'voice_sample', 'shot_image', 'shot_image_edit', 'shot_tts', 'shot_video', 'shot_lipsync', 'shot_sfx', 'rewrite_shot', 'parse_script', 'reverse_script', 'prop_image', 'verify_shot', 'bridge_shot', 'variants', 'shot_upscale', 'shot_upscale_video', 'verify_asset', 'verify_video']);
  app.post('/api/studio/ai/jobs/:jid/retry', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const job = await db.get('SELECT * FROM ai_jobs WHERE id=?', [req.params.jid]);
    if (!job || !job.project_id) fail(404, '작업을 찾을 수 없어요.');
    const p = await project(req, job.project_id, 'view');
    if (!['failed', 'canceled'].includes(job.status)) fail(400, '실패하거나 취소한 작업만 다시 시도할 수 있어요.');
    if (!RETRYABLE.has(job.kind)) fail(400, '이 작업은 원래 화면에서 다시 시작해 주세요.');
    const body = z
      .object({
        requested: z.string().max(80).default('auto'),
        tier: z.enum(['draft', 'standard', 'premium']).optional(),
        budgetOk: z.boolean().optional(),
        payOwn: z.boolean().optional(),
        idempotencyKey: z.string().uuid().optional(),
        // estimate: true면 실행하지 않고 예상 라마 · 모델만 돌려줘요(다시 시도 전에 확인).
        estimate: z.boolean().optional(),
      })
      .parse(req.body || {});
    let input = {};
    try {
      input = JSON.parse(job.input || '{}');
    } catch {}
    const options = {};
    if (job.kind === 'character_ref') options.pose = input.pose;
    if (job.kind === 'rewrite_range') options.shotIds = input.shotIds;
    if (job.kind === 'variants') options.angles = input.context?.angles || [];
    if (job.kind === 'shot_image_edit' && input.maskImage?.path) {
      // 예전 방식(컷에 묶이지 않은) 마스크는 더 쓸 수 없어요.
      if (!/^\/masks\/[a-f0-9-]+\.[a-f0-9-]+\.png$/.test(input.maskImage.path)) fail(400, '칠한 영역이 만료됐어요. 장면 편집에서 다시 칠해 주세요.');
      options.mask = input.maskImage.path;
    }
    if (job.kind === 'shot_image_edit' && input.swap) Object.assign(options, { swap: input.swap, ...(input.swapId ? { swapId: input.swapId } : {}) });
    if (job.kind === 'shot_video' && input.motionOnly) options.motionOnly = true;
    if (job.kind === 'music') {
      options.seconds = input.seconds;
      if (input.userText) options.mood = String(input.userText).slice(0, 200);
    }
    const instruction = ['rewrite_range', 'script'].includes(job.kind) ? input.userInstruction : ['rewrite_shot', 'shot_image_edit', 'bridge_shot'].includes(job.kind) ? input.userText : undefined;
    const b = runSchema.parse({
      action: job.kind,
      targetId: job.target_type === 'project' || job.target_type === 'music' ? p.id : job.target_id,
      ...(instruction ? { instruction: String(instruction).slice(0, 300) } : {}),
      options,
      requested: body.requested,
      tier: body.tier || job.tier,
      budgetOk: body.budgetOk,
      payOwn: body.payOwn,
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    let specs = await plan(req, p, b);
    // 후보 묶음의 한 장을 다시 시도하면 후보로 다시 만들어요(이미 고른 컷 이미지·영상을 덮어쓰지 않게).
    if (input.candidate && ['shot_image', 'shot_video'].includes(job.kind))
      specs = specs.map((x) => ({ ...x, keySuffix: 'r' + job.id.slice(0, 8), input: { ...x.input, candidate: input.candidate, seed: Number.isInteger(input.seed) ? input.seed + 1 : x.input.seed } }));
    const exclude = body.requested === 'auto' && job.model_ref ? [job.model_ref] : [];
    if (body.estimate) {
      const { lama: price, label } = await priceSpecs(p, b, specs, exclude);
      return res.json({ lama: price, model: body.requested === 'auto' ? `자동 선택 (예: ${label})` : label, jobs: specs.length, wallet: await lamaWalletOf(db, req.user.id) });
    }
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
    const busy = await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') AND ((target_type='shot' AND target_id IN (SELECT id FROM studio_shots WHERE episode_id=?)) OR (target_type='episode' AND target_id=?)) LIMIT 1", [p.id, e.id, e.id]);
    if (busy) fail(409, '이 회차의 AI 작업이 끝난 뒤 합성해 주세요.');
    if (!shots.length) fail(400, '대본(컷)이 없어요. 대본을 먼저 만들어 주세요.');
    const missing = shots.findIndex((s) => !s.video && !s.image && !s.lipsync);
    if (missing >= 0) fail(400, `${missing + 1}번째 컷에 영상이나 컷 이미지가 없어요.`);
    try {
      // 대기열에 넣고 바로 돌려줍니다(같은 회차를 동시에 눌러도 한 번만 들어감).
      await renderer.queueEpisode(p, e);
    } catch (err) {
      fail(err.status || 500, err.message);
    }
  }
  app.post('/api/studio/ai/projects/:id/episodes/:eid/compose', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'scene');
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    await startCompose(p, e);
    if (req.teamRole !== 'owner' || (await collab.approvalsActive(p))) await collab.log(p.id, req.user.id, 'compose', `${e.number}화`);
    res.status(202).json({ ok: true });
  });
  app.get('/api/studio/ai/projects/:id/episodes/:eid/compose', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const e = await db.get('SELECT id,status,video,duration,compose_progress,compose_error FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    const r = await db.get("SELECT status,created_at FROM studio_renders WHERE kind='episode' AND target_id=? ORDER BY created_at DESC LIMIT 1", [e.id]);
    // 대기 순서: 나보다 먼저 들어온 대기 중 합성 수
    const ahead = r?.status === 'queued' ? Number((await db.get("SELECT COUNT(*) AS n FROM studio_renders WHERE status IN ('queued','running') AND created_at<?", [r.created_at]))?.n || 0) : 0;
    res.json({ ...e, progress: Math.round(Number(e.compose_progress || 0) * 100), queue: ahead, error: e.status === 'compose_failed' ? e.compose_error || '합성에 실패했어요.' : '' });
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
        forceApproval: z.boolean().default(false), // 협업 승인이 안 끝났어도 소유자가 내보내기
      })
      .parse(req.body);
    const all = await episodesOf(p.id);
    const approvals = await collab.approvalsActive(p);
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
      // 협업 승인: 회차 합성본 승인을 받지 않은 회차는 내보내지 않아요(소유자가 강행하면 예외).
      const unapproved = approvals && !b.forceApproval ? targets.filter((e) => e.final_review !== 'approved') : [];
      if (unapproved.length)
        throw Object.assign(new Error(`${unapproved.map((e) => e.number + '화').join(', ')}는 아직 합성본 승인을 받지 않았어요. 승인을 받거나, 소유자 권한으로 그대로 내보낼 수 있어요.`), { status: 409, code: 'approval_required' });
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
        // 자막 파일은 공개 회차용으로 따로 복사해요. 같은 파일을 함께 쓰면 스튜디오에서 자막을 다시 만들거나
        // 공개 회차를 지울 때 다른 쪽 자막까지 사라져요(2026-10-01 점검).
        let subtitles = '';
        if (/^[a-f0-9-]+\.vtt$/.test(e.subtitles || '') && existsSync(path.join(subsDir, e.subtitles))) {
          subtitles = randomUUID() + '.vtt';
          await copyFile(path.join(subsDir, e.subtitles), path.join(subsDir, subtitles));
        }
        const previous = (await db.get('SELECT subtitles FROM episodes WHERE drama_id=? AND number=?', [drama.id, e.number]))?.subtitles || '';
        await db.run(
          "INSERT INTO episodes (id,drama_id,number,title,video,duration,source,subtitles,studio_episode_id,thumbnail,review_status) VALUES (?,?,?,?,?,?,'studio',?,?,?,?) ON CONFLICT(drama_id,number) DO UPDATE SET title=excluded.title,video=excluded.video,duration=excluded.duration,source='studio',subtitles=excluded.subtitles,studio_episode_id=excluded.studio_episode_id,thumbnail=excluded.thumbnail",
          [randomUUID(), drama.id, e.number, e.title.slice(0, 100), e.video, Math.max(1, Number(e.duration)), subtitles, e.id, e.thumbnail || '', serial ? 'draft' : 'approved'],
        );
        // 예전에 내보낸 자막 복사본은 정리해요(스튜디오 회차가 아직 쓰는 파일이면 그대로 둬요).
        if (/^[a-f0-9-]+\.vtt$/.test(previous) && previous !== subtitles && !(await db.get('SELECT id FROM studio_episodes WHERE subtitles=?', [previous])) && !(await db.get('SELECT id FROM episodes WHERE subtitles=?', [previous])))
          await rm(path.join(subsDir, previous), { force: true }).catch(() => {});
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
    if (approvals) await collab.log(p.id, req.user.id, 'export', `${result.numbers.map((n) => n + '화').join(', ')}${b.forceApproval ? ' · 승인 없이 강행' : ''}`);
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
    // 대량 제작(2026-09-25): 회차 범위만 만들기 · 실패하면 다른 모델로 자동 재시도(횟수)
    from: z.number().int().min(1).max(500).optional(),
    to: z.number().int().min(1).max(500).optional(),
    retries: z.number().int().min(0).max(3).default(1),
  });
  const inRange = (ap, n) => (!ap.from || Number(n) >= ap.from) && (!ap.to || Number(n) <= ap.to);
  const ownerReq = (p) => ({ user: { id: p.owner_id, role: 'pd' }, params: {} });
  async function stageWork(p, ap) {
    const req = ownerReq(p);
    const cast = await charactersOf(p.id);
    const allEps = await episodesOf(p.id);
    const eps = allEps.filter((e) => inRange(ap, e.number));
    const inEps = new Set(eps.map((e) => e.id));
    const shots = (await db.all('SELECT s.* FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=? ORDER BY e.number, s.sort_order', [p.id])).filter((x) => inEps.has(x.episode_id));
    const specs = async (action, ids) => Promise.all(ids.map((id) => buildJob(req, p, action, id)));
    if (!cast.length) return { stage: 'plan', specs: [await buildJob(req, p, 'plan')] };
    // 빠른 제작: 설정집과 회차별 훅·반전을 먼저 잡아 두면 대본이 회차끼리 잘 이어집니다.
    if (ap.includeBible && !p.bible) return { stage: 'bible', specs: [await buildJob(req, p, 'bible')] };
    if (ap.includeBible && allEps.length > 1 && !p.season) return { stage: 'season', specs: [await buildJob(req, p, 'season')] };
    const noImage = cast.filter((c) => !c.image);
    if (noImage.length) return { stage: 'cast', specs: await specs('character_image', noImage.map((c) => c.id)) };
    const withShots = new Set(shots.map((x) => x.episode_id));
    const unscripted = eps.filter((e) => !withShots.has(e.id));
    if (unscripted.length) return { stage: 'script', specs: await specs('script', unscripted.map((e) => e.id)) };
    // 화면 묘사가 빈 컷은 이미지를 만들 수 없어 건너뜁니다(같은 컷을 계속 다시 시도하지 않도록).
    const board = shots.filter((x) => !x.image && String(x.visual || '').trim());
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
      const e = await engine.estimate({ capability: spec.capability, requested: spec.requestedOverride || c.requested, tier: c.tier, tags: spec.tags, seconds: spec.input.seconds, needImage: needsImage(spec.input), needCamera: !!spec.input.needCamera, needEnd: !!spec.input.endImage, needMask: !!spec.input.maskImage, requireImage: !!spec.input._requireImage, input: spec.input, excludeCn: !!Number(p.exclude_cn) });
      lama += e.lama;
    }
    return lama;
  }
  // 시작 전 예상: 지금 비어 있는 곳을 기준으로 단계별 라마를 대략 계산합니다(대본이 없는 회차는 컷 수를 추정).
  async function autopilotEstimate(p, ap) {
    const cast = await charactersOf(p.id);
    const eps = (await episodesOf(p.id)).filter((e) => inRange(ap, e.number));
    const inEps = new Set(eps.map((e) => e.id));
    const shots = (await db.all('SELECT s.* FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=?', [p.id])).filter((x) => inEps.has(x.episode_id));
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
    const boardCount = shots.filter((x) => !x.image && String(x.visual || '').trim()).length + unscripted * guessShots;
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
      const retries = ap.retries ?? 1;
      if (repeat > retries)
        return pause(`${AP_STAGES[work.stage]} 단계가 ${retries ? `${retries}번 다시 시도해도 ` : ''}완료되지 않았어요. 실패한 작업을 확인한 뒤 다시 시작해 주세요.`);
      // 다시 시도할 때는 이번 빠른 제작에서 그 대상에 실패한 모델을 빼고 다음 후보로(자동 선택일 때)
      const failedModels = new Map();
      if (repeat > 0 && work.specs)
        for (const r of await db.all("SELECT kind,target_id,model_ref FROM ai_jobs WHERE project_id=? AND status='failed' AND created_at>=?", [p.id, ap.started_at]))
          failedModels.set(`${r.kind}:${r.target_id}`, [...(failedModels.get(`${r.kind}:${r.target_id}`) || []), r.model_ref].filter(Boolean));
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
      // 프로젝트 예산도 지켜요(2026-09-30 점검): 빠른 제작은 확인 창을 거치지 않으므로 넘기 전에 멈춥니다.
      const budget = await budgetOf(p);
      if (budget.limit > 0 && budget.spent + need > budget.limit)
        return pause(`프로젝트 예산 ${budget.limit.toLocaleString('ko-KR')}라마를 넘어서 멈췄어요. (사용 ${budget.spent.toLocaleString('ko-KR')}라마, 다음 단계 예상 ${need.toLocaleString('ko-KR')}라마) 기획 · 설정에서 예산을 올리거나 직접 이어 만들 수 있어요.`);
      try {
        for (const spec of work.specs) await engine.screen({ userId: p.owner_id, kind: spec.kind, texts: [spec.input.userText, spec.input.text] });
        const queuedOk = await db.transaction(async () => {
          // 프로젝트 행을 잠근 뒤 진행 중 작업을 다시 확인해요(다른 서버 · PD의 직접 실행과 겹쳐 같은 작업이 두 번 등록되지 않게).
          if (db.engine === 'postgresql') await db.get('SELECT id FROM studio_projects WHERE id=? FOR UPDATE', [p.id]);
          if (await db.get("SELECT id FROM ai_jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1", [p.id])) return false;
          // 등록 직전에 다시 확인: 멈췄으면 아무것도 등록하지 않습니다(같은 트랜잭션에서 상태도 갱신).
          if (!(await saveIfRunning(p.id, ap.run, { ...ap, stage: work.stage, signature, repeat, message: `${AP_STAGES[work.stage]} ${work.specs.length}건 진행 중`, spent, updated_at: now() })))
            return false;
          for (const spec of work.specs) {
            const c = choiceFor(ap, spec.capability);
            const requested = spec.requestedOverride || c.requested;
            const tryExclude = requested === 'auto' ? [...new Set(failedModels.get(`${spec.kind}:${spec.target.id}`) || [])] : [];
            const enqueue = (exclude) =>
              engine.enqueue({
                userId: p.owner_id,
                kind: spec.kind,
                capability: spec.capability,
                requested,
                tier: c.tier,
                tags: spec.tags || [],
                // 이번 빠른 제작이 만든 작업 표시: 멈추기를 누르면 이 작업만 취소해요(팀원이 직접 건 작업은 그대로).
                input: { ...spec.input, _autopilot: ap.run },
                target: spec.target,
                projectId: p.id,
                excludeCn: !!Number(p.exclude_cn),
                exclude,
              });
            // 다른 후보가 없으면(모두 실패) 원래 후보로 한 번 더
            await (tryExclude.length ? enqueue(tryExclude).catch((e) => (e.code === 'no_model' ? enqueue([]) : Promise.reject(e))) : enqueue([]));
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
    // 이번 빠른 제작이 만든 대기 작업만 취소해요(팀원이 자기 라마로 직접 건 작업은 그대로 둬요).
    const queued = await db.all("SELECT id FROM ai_jobs WHERE project_id=? AND status='queued' AND input LIKE ?", [p.id, `%"_autopilot":"${String(ap.run || '').replace(/[^a-f0-9-]/gi, '')}"%`]);
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
  // 힉스필드 · 폴로 벤치마킹 2단계(2026-09-30): 첫 컷 미리 보기.
  // 프로젝트를 만들기 전에 아이디어 한 줄로 대표 컷 하나를 뽑아 봐요(이미지 1장 라마). 마음에 들면 그 이미지를
  // 새 프로젝트의 포스터 · 스타일 참고로 넣고 이어 가요.
  const firstShotSchema = z.object({
    logline: z.string().trim().min(5).max(300),
    genre: z.enum(GENRES).default('로맨스'),
    tone: z.string().trim().max(100).default(''),
    style: z.string().trim().max(500).default(''),
    requested: z.string().max(80).default('auto'),
    tier: z.enum(['draft', 'standard', 'premium']).default('standard'),
    seed: z.number().int().min(0).max(1000000).optional(),
  });
  const firstShotPrompt = (b) =>
    `Korean short-form drama key frame, vertical 9:16, genre: ${b.genre}. ${b.logline}. ${b.tone ? `Mood: ${b.tone}. ` : ''}${b.style || 'Cinematic realistic look.'} One striking moment that sells the story, cinematic lighting and composition, no text, no captions, no watermark.`;
  const firstShotInput = (b) => ({ prompt: firstShotPrompt(b), aspect: '9:16', userText: [b.logline, b.tone].filter(Boolean).join(' '), ...(b.seed !== undefined ? { seed: b.seed } : {}) });
  app.post('/api/studio/ai/tools/first-shot/estimate', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const b = firstShotSchema.parse(req.body);
    const e = await engine.estimate({ capability: 'image', requested: b.requested, tier: b.tier, tags: ['cinematic'], input: firstShotInput(b) });
    res.json({ lama: e.lama, won: e.lama * 10, model: b.requested === 'auto' ? `자동 선택 (예: ${e.model.label})` : e.model.label, wallet: await lamaWalletOf(db, req.user.id) });
  });
  app.post('/api/studio/ai/tools/first-shot', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const b = firstShotSchema.parse(req.body);
    await engine.screen({ userId: req.user.id, kind: 'tool_first_shot', texts: [b.logline, b.tone] });
    const job = await db.transaction(() =>
      engine.enqueue({
        userId: req.user.id,
        kind: 'tool_first_shot',
        capability: 'image',
        requested: b.requested,
        tier: b.tier,
        tags: ['cinematic'],
        input: firstShotInput(b),
        target: { type: 'first_shot', id: req.user.id },
      }),
    );
    res.status(201).json({ id: job.id, lama: Number(job.estimate_lama) });
  });
  app.get('/api/studio/ai/tools/jobs/:jid', roles('pd', 'admin'), async (req, res) => {
    const j = await db.get('SELECT id,user_id,kind,status,error,output,charged_lama,estimate_lama FROM ai_jobs WHERE id=?', [req.params.jid]);
    if (!j || (j.user_id !== req.user.id && req.user.role !== 'admin')) fail(404, '작업을 찾을 수 없어요.');
    res.json({ ...j, output: JSON.parse(j.output || '{}') });
  });

  // ── 영상 → 대본(2026-09-25): 내가 올린 완성 영상(자막)으로 새 AI 프로젝트를 시작합니다 ──
  // 자막이 있는 회차만 쓸 수 있어요(자막이 없으면 '내 작품'의 AI 자막 만들기를 먼저).
  const vttText = async (file) => {
    if (!/^[a-f0-9-]+\.vtt$/.test(file || '')) return '';
    try {
      const raw = await (await import('node:fs/promises')).readFile(path.join(subsDir, file), 'utf8');
      return raw
        .split(/\r?\n/)
        .filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/-->/.test(l) && !/^\d+$/.test(l.trim()) && !/^NOTE\b/.test(l))
        .map((l) => l.replace(/<[^>]+>/g, '').trim())
        .filter((l, i, a) => l && l !== a[i - 1])
        .join('\n');
    } catch {
      return '';
    }
  };
  app.get('/api/studio/ai/reverse/sources', roles('pd', 'admin'), async (req, res) => {
    const dramas = await db.all('SELECT id,title,genre,image,status FROM dramas WHERE owner_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    const out = [];
    for (const d of dramas) {
      const eps = await db.all("SELECT number,title,duration,subtitles,video FROM episodes WHERE drama_id=? AND video<>'' ORDER BY number LIMIT 60", [d.id]);
      if (eps.length) out.push({ ...d, episodes: eps.map((e) => ({ number: e.number, title: e.title, duration: Number(e.duration || 0), has_subtitles: /\.vtt$/.test(e.subtitles || '') })) });
    }
    res.json(out);
  });
  app.post('/api/studio/ai/reverse', roles('pd', 'admin'), async (req, res) => {
    await requireTerms(req);
    const b = z.object({ dramaId: z.string().max(80), numbers: z.array(z.number().int().min(1).max(500)).min(1).max(12), title: z.string().trim().min(1).max(70).optional() }).parse(req.body);
    const d = await db.get('SELECT * FROM dramas WHERE id=?', [b.dramaId]);
    if (!d || d.owner_id !== req.user.id) fail(404, '작품을 찾을 수 없어요.');
    const numbers = [...new Set(b.numbers)].sort((x, y) => x - y);
    const parts = [];
    const missing = [];
    for (const n of numbers) {
      const e = await db.get('SELECT number,subtitles FROM episodes WHERE drama_id=? AND number=?', [d.id, n]);
      const text = e ? await vttText(e.subtitles) : '';
      if (!text) missing.push(n);
      else parts.push(`${parts.length + 1}화 자막 (원래 ${n}화)\n${text}`);
    }
    if (missing.length) fail(400, `${missing.map((n) => n + '화').join(', ')}에 자막이 없어요. ‘내 작품’에서 AI 자막을 먼저 만들어 주세요.`);
    const source = parts.join('\n\n').slice(0, 30000);
    const id = randomUUID();
    const genre = GENRES.includes(d.genre) ? d.genre : '로맨스';
    const avg = Math.round(
      Number((await db.get(`SELECT AVG(duration) AS n FROM episodes WHERE drama_id=? AND number IN (${numbers.map(() => '?').join(',')})`, [d.id, ...numbers]))?.n || 60),
    );
    await db.transaction(async () => {
      await db.run(
        "INSERT INTO studio_projects (id,owner_id,title,logline,genre,tone,style,synopsis,episode_count,episode_seconds,exclude_cn,status,source_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,'draft',?,?,?)",
        [id, req.user.id, (b.title || `${d.title} 다시 만들기`).slice(0, 70), String(d.tagline || d.title).slice(0, 200), genre, '', '', String(d.synopsis || '').slice(0, 3000), numbers.length, Math.max(20, Math.min(180, avg)), source, now(), now()],
      );
      for (let n = 1; n <= numbers.length; n++) await db.run("INSERT INTO studio_episodes (id,project_id,number,title,summary,status) VALUES (?,?,?,?,?,'outline')", [randomUUID(), id, n, `${n}화`, '']);
    });
    res.status(201).json({ id, chars: source.length });
  });
  // 스튜디오 결과물(영상·음성·이미지) 미리보기: 본인과 관리자만 받습니다.
  app.get('/api/studio/media/:file', roles('pd', 'admin'), async (req, res) => {
    if (!/^[a-f0-9-]+\.(mp4|mp3|wav|jpg|png|webp)$/.test(req.params.file)) fail(404, '파일을 찾을 수 없어요.');
    const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', ['/uploads/' + req.params.file]);
    // 협업자는 함께 만드는 프로젝트 소유자의 결과물을 볼 수 있어요.
    const url = '/uploads/' + req.params.file;
    if (!f || (f.owner_id !== req.user.id && req.user.role !== 'admin' && !(await collab.sharesWith(req.user, f.owner_id, url)))) fail(404, '파일을 찾을 수 없어요.');
    res.sendFile(path.join(uploadDir, req.params.file));
  });
  // 스튜디오 합성 자막(VTT) 미리보기
  app.get('/api/studio/ai/episodes/:eid/subtitles', roles('pd', 'admin'), async (req, res) => {
    const e = await db.get('SELECT e.subtitles, e.project_id, p.owner_id FROM studio_episodes e JOIN studio_projects p ON p.id=e.project_id WHERE e.id=?', [req.params.eid]);
    if (!e || (e.owner_id !== req.user.id && req.user.role !== 'admin' && !(await memberOf(e.project_id, req.user))) || !/^[a-f0-9-]+\.vtt$/.test(e.subtitles || '')) fail(404, '자막이 없어요.');
    res.type('text/vtt; charset=utf-8').sendFile(path.join(subsDir, e.subtitles));
  });
  studioPlusRoutes({ app, db, fail, now, roles, engine, renderer, uploadDir, project, touch, queueTranslate, shotsOf, charactersOf, episodesOf });
  shotMedia = shotMediaRoutes({ app, db, fail, now, roles, uploadDir, loadShot, project });
  qualityRoutes({ app, db, fail, now, roles, project, charactersOf, episodesOf, shotsOf, hasModel: async (cap) => (await engine.listForPicker(cap, await settingsOf())).length > 0 });
  libraryRoutes({ app, db, fail, now, roles, project, charactersOf, locationsOf, propsOf, queueTranslate });
  chatApi = assistantRoutes({ app, db, fail, now, roles, engine, project, requireTerms, plan, runSpecs, runSchema, estimateSpecs: priceSpecs, charactersOf, episodesOf, shotsOf, locationsOf, queueTranslate, settingsOf });
  // 목소리 라이브러리 샘플은 모든 PD가 함께 들을 수 있습니다.
  app.get('/api/studio/ai/voices/sample/:file', roles('pd', 'admin'), async (req, res) => {
    if (!/^[a-f0-9-]+\.(mp3|wav)$/.test(req.params.file)) fail(404, '파일을 찾을 수 없어요.');
    if (!(await db.get('SELECT voice FROM voice_samples WHERE url=?', ['/uploads/' + req.params.file]))) fail(404, '파일을 찾을 수 없어요.');
    res.sendFile(path.join(uploadDir, req.params.file));
  });
  // /uploads 비공개 결과물: 협업자가 함께 만드는 프로젝트 소유자의 파일인지
  const sharesUpload = (user, ownerId, url) => collab.sharesWith(user, ownerId, url);
  return { precheck, sharesUpload };
}
