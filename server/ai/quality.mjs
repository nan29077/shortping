import { z } from 'zod';
import { blockedTerm } from './prompts.mjs';
import { loadSettings } from '../settings.mjs';

// 공개 전 품질 점검(2026-09-24): 합성·검수 신청 전에 흔한 실수를 찾아 '고칠 거리'로 보여 주고,
// 가능한 것은 버튼 하나로 고칩니다(무료 수정은 바로, AI 작업은 라마 확인 후).
// level: error(합성·공개가 막힘) · warn(보기 불편하거나 품질이 떨어짐) · info(참고)
// 지금 컷 이미지를 검수한 결과만 돌려줍니다(이미지가 바뀌었으면 null).
export function verifyOf(s) {
  if (!s.verify || !s.image) return null;
  try {
    const v = JSON.parse(s.verify);
    return v && v.image === s.image ? v : null;
  } catch {
    return null;
  }
}
// 컷 리듬 진단(무료 규칙): 숏폼은 3초 안에 훅, 같은 크기 샷이 이어지면 지루함, 말 없는 컷이 길게 이어지면 이탈, 마지막 컷은 궁금증.
const SIZE = (camera) => {
  const c = String(camera || '');
  if (/클로즈|close|익스트림|바스트/i.test(c)) return 'close';
  if (/와이드|풀샷|롱|wide|full|establish|전경/i.test(c)) return 'wide';
  if (/미디엄|medium|웨이스트|니샷|오버|over/i.test(c)) return 'medium';
  return '';
};
export function rhythmOf(e, shots, p) {
  const out = [];
  if (!shots.length) return out;
  const ep = `${e.number}화`;
  const at = (i) => `${ep} ${i + 1}번 컷`;
  const first = shots[0];
  if (Number(first.seconds) > 4 && !String(first.dialogue || '').trim())
    out.push({ level: 'warn', code: 'rhythm_hook', text: '첫 컷이 4초가 넘고 대사가 없어요. 숏폼은 3초 안에 갈등이나 궁금증을 보여 줘야 덜 넘겨요.', where: at(0), shotId: first.id });
  let run = 1;
  for (let i = 1; i < shots.length; i++) {
    const a = SIZE(shots[i - 1].camera);
    const b = SIZE(shots[i].camera);
    run = a && a === b ? run + 1 : 1;
    if (run === 3) out.push({ level: 'info', code: 'rhythm_same_size', text: `같은 크기 샷(${{ close: '클로즈업', medium: '미디엄', wide: '와이드' }[b]})이 3컷 넘게 이어져요. 샷 크기를 섞으면 덜 지루해요.`, where: at(i), shotId: shots[i].id });
  }
  let silent = 0;
  for (let i = 0; i < shots.length; i++) {
    silent = String(shots[i].dialogue || '').trim() ? 0 : silent + 1;
    if (silent === 4) out.push({ level: 'info', code: 'rhythm_silent', text: '대사 없는 컷이 4컷 넘게 이어져요. 내레이션이나 효과음으로 긴장을 이어 주세요.', where: at(i), shotId: shots[i].id });
  }
  const avg = shots.reduce((n, s) => n + Number(s.seconds || 0), 0) / shots.length;
  if (avg > 6) out.push({ level: 'info', code: 'rhythm_slow', text: `컷 평균 길이가 ${avg.toFixed(1)}초예요. 숏폼은 컷을 3~5초로 짧게 끊을수록 몰입해요.` });
  const last = shots[shots.length - 1];
  if (!String(e.cliffhanger || '').trim() && !String(last.dialogue || '').trim() && Number(e.number) < Number(p.episode_count || 1))
    out.push({ level: 'info', code: 'rhythm_cliff', text: '마지막 컷에 대사나 반전이 없어요. 다음 화가 궁금해지는 한마디나 장면으로 끝내 보세요.', where: at(shots.length - 1), shotId: last.id });
  return out;
}

export function qualityRoutes({ app, db, fail, now, roles, project, charactersOf, episodesOf, shotsOf }) {
  async function check(p) {
    const settings = await loadSettings(db);
    const cast = await charactersOf(p.id);
    const eps = await episodesOf(p.id);
    const issues = [];
    const add = (level, code, text, where, extra = {}) => issues.push({ level, code, text, where, ...extra });
    const usedCast = new Set();
    for (const e of eps) {
      const shots = await shotsOf(e.id);
      const ep = `${e.number}화`;
      if (!shots.length) {
        add('error', 'no_script', '대본(컷)이 없어요.', ep, { episodeId: e.id, fix: { kind: 'ai', action: 'script', cap: 'text', targetId: e.id, label: `${ep} 대본 쓰기` } });
        continue;
      }
      const missing = shots.filter((s) => !s.image && !s.video && !s.lipsync);
      if (missing.length)
        add('error', 'no_media', `이미지·영상이 없는 컷이 ${missing.length}개 있어요. 합성할 수 없어요.`, ep, {
          episodeId: e.id,
          shotId: missing[0].id,
          fix: { kind: 'ai', action: 'batch_shot_image', cap: 'image', targetId: e.id, label: '빈 컷 이미지 모두 만들기' },
        });
      let total = 0;
      const silent = [];
      const unverified = [];
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i];
        const where = `${ep} ${i + 1}번 컷`;
        total += Number(s.seconds) || 0;
        for (const id of String(s.cast_ids || '').split(',').filter(Boolean)) usedCast.add(id);
        if (s.speaker_id) usedCast.add(s.speaker_id);
        const line = String(s.dialogue || '').trim();
        const caption = s.caption === null || s.caption === undefined ? line : String(s.caption);
        if (line && !s.audio && !s.lipsync) silent.push({ s, where });
        const audio = Number(s.audio_seconds || 0);
        if (s.audio && !s.lipsync && audio > Number(s.seconds) + 0.5)
          add('warn', 'voice_long', `음성(${audio.toFixed(1)}초)이 컷 길이(${s.seconds}초)보다 길어요. 합성할 때 마지막 장면이 멈춘 채로 늘어나요.`, where, {
            episodeId: e.id,
            shotId: s.id,
            fix: audio <= 10 ? { kind: 'edit', code: 'extend_shot', targetId: s.id, label: `컷을 ${Math.ceil(audio)}초로 늘리기` } : { kind: 'ai', action: 'rewrite_shot', cap: 'text', targetId: s.id, instruction: '대사를 절반 길이로 짧게 줄여 주세요', label: '대사 짧게 다시 쓰기' },
          });
        // 한국어 자막은 1초에 7~8자가 편하게 읽혀요.
        const cps = caption.replace(/\s/g, '').length / Math.max(1, Math.max(Number(s.seconds) || 1, audio));
        if (caption && cps > 9)
          add('warn', 'fast_caption', `자막이 빨리 지나가요(1초에 ${cps.toFixed(1)}자).`, where, {
            episodeId: e.id,
            shotId: s.id,
            fix: { kind: 'ai', action: 'rewrite_shot', cap: 'text', targetId: s.id, instruction: '대사를 더 짧고 강하게 줄여 주세요', label: '대사 줄이기' },
          });
        const bad = blockedTerm([line, caption, s.visual], settings.ai_blocked_terms);
        if (bad) add('error', 'blocked', `쓸 수 없는 표현("${bad}")이 들어 있어요. 검수에서 반려될 수 있어요.`, where, { episodeId: e.id, shotId: s.id });
        if (!String(s.visual || '').trim() && !s.image && !s.video) add('info', 'no_visual', '화면 묘사가 비어 있어요.', where, { episodeId: e.id, shotId: s.id });
        // AI 결과 검수: 지금 이미지를 검수한 결과만 봅니다.
        const v = verifyOf(s);
        if (v && !v.ok)
          add('warn', 'verify_fail', `AI 검수에서 문제가 보였어요: ${(v.issues || []).map((x) => x.text).join(' · ') || v.summary || '다시 만드는 것이 좋아요'}`, where, {
            episodeId: e.id,
            shotId: s.id,
            fix: { kind: 'ai', action: 'shot_image', cap: 'image', targetId: s.id, label: '이미지 다시 만들기' },
          });
        else if (s.image && !v) unverified.push(s);
      }
      if (unverified.length)
        add('info', 'not_verified', `AI 검수를 하지 않은 컷이 ${unverified.length}개 있어요. 얼굴 · 글자 · 손 모양 같은 실수를 미리 찾을 수 있어요(라마 소액).`, ep, {
          episodeId: e.id,
          fix: { kind: 'ai', action: 'batch_verify_shot', cap: 'text', targetId: e.id, label: `${unverified.length}컷 AI 검수` },
        });
      for (const r of rhythmOf(e, shots, p)) add(r.level, r.code, r.text, r.where || ep, { episodeId: e.id, shotId: r.shotId });
      // 대사 음성이 빠진 컷: 한 컷이면 그 컷만, 여러 컷이면 회차 단위로 한 번에
      if (silent.length === 1)
        add('warn', 'no_voice', '대사 음성이 없어 자막만 나가요.', silent[0].where, { episodeId: e.id, shotId: silent[0].s.id, fix: { kind: 'ai', action: 'shot_tts', cap: 'tts', targetId: silent[0].s.id, label: '음성 만들기' } });
      else if (silent.length > 1)
        add('warn', 'no_voice', `대사 음성이 없는 컷이 ${silent.length}개 있어요(${silent.map((x) => x.where.slice(ep.length + 1)).join(', ')}). 자막만 나가요.`, ep, {
          episodeId: e.id,
          shotId: silent[0].s.id,
          fix: { kind: 'ai', action: 'batch_shot_tts', cap: 'tts', targetId: e.id, label: `음성 ${silent.length}개 만들기` },
        });
      const target = Number(p.episode_seconds) || 60;
      if (total > target * 1.6) add('info', 'long_episode', `회차 길이(약 ${total}초)가 목표(${target}초)보다 길어요.`, ep, { episodeId: e.id });
      if (!missing.length && e.status !== 'composed' && e.status !== 'composing')
        add('warn', 'not_composed', e.video ? '합성한 뒤 내용이 바뀌었어요. 다시 합성해야 반영돼요.' : '아직 합성하지 않았어요.', ep, { episodeId: e.id, fix: { kind: 'compose', targetId: e.id, label: '합성하기(무료)' } });
      if (e.status === 'compose_failed') add('error', 'compose_failed', `합성에 실패했어요: ${e.compose_error || '원인을 알 수 없어요.'}`, ep, { episodeId: e.id, fix: { kind: 'compose', targetId: e.id, label: '다시 합성' } });
    }
    for (const c of cast) {
      if (!usedCast.has(c.id)) continue;
      if (!c.image)
        add('warn', 'no_face', '인물 기준 이미지가 없어 컷마다 얼굴이 달라질 수 있어요.', c.name, { characterId: c.id, fix: { kind: 'ai', action: 'character_image', cap: 'image', targetId: c.id, label: '기준 이미지 만들기' } });
      if (!c.voice) add('info', 'no_voice_pick', '목소리를 정하지 않아 기본 목소리로 나가요.', c.name, { characterId: c.id, fix: { kind: 'tab', tab: 'plan', label: '목소리 고르기' } });
    }
    if (!p.poster) add('warn', 'no_poster', '작품 포스터가 없어요. 목록에서 눈에 잘 띄지 않아요.', '작품', { fix: { kind: 'ai', action: 'poster', cap: 'image', label: '포스터 만들기' } });
    const order = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => order[a.level] - order[b.level]);
    return {
      checked_at: now(),
      summary: { error: issues.filter((x) => x.level === 'error').length, warn: issues.filter((x) => x.level === 'warn').length, info: issues.filter((x) => x.level === 'info').length },
      issues: issues.slice(0, 200),
    };
  }
  // 회차 리듬 진단(대본 탭에서 무료로 바로 보기)
  app.get('/api/studio/ai/projects/:id/episodes/:eid/rhythm', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [req.params.eid, p.id]);
    if (!e) fail(404, '회차를 찾을 수 없어요.');
    const shots = await shotsOf(e.id);
    const list = rhythmOf(e, shots, p);
    // 점수: 경고 20점, 참고 8점씩 깎아요(100점 만점).
    const score = Math.max(0, 100 - list.reduce((n, x) => n + (x.level === 'warn' ? 20 : 8), 0));
    res.json({ score, items: list, shots: shots.length, seconds: shots.reduce((n, s) => n + Number(s.seconds || 0), 0) });
  });
  app.get('/api/studio/ai/projects/:id/check', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'view');
    res.json(await check(p));
  });
  // 무료로 바로 고칠 수 있는 것(컷 길이 늘리기)
  app.post('/api/studio/ai/projects/:id/check/fix', roles('pd', 'admin'), async (req, res) => {
    const p = await project(req, req.params.id, 'scene');
    const b = z.object({ code: z.enum(['extend_shot']), targetId: z.string().max(80) }).parse(req.body);
    const s = await db.get('SELECT s.*, e.project_id FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE s.id=?', [b.targetId]);
    if (!s || s.project_id !== p.id) fail(404, '컷을 찾을 수 없어요.');
    const seconds = Math.min(10, Math.max(Number(s.seconds), Math.ceil(Number(s.audio_seconds || 0))));
    await db.run('UPDATE studio_shots SET seconds=? WHERE id=?', [seconds, s.id]);
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
    res.json({ ok: true, seconds });
  });
  return { check };
}
