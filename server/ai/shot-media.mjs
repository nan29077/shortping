import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs';
import { rm, rename } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { probeMedia, runFfmpeg } from '../media.mjs';
import { loadSettings } from '../settings.mjs';

// 내 소재 올리기(2026-09-24): 컷마다 AI 대신 내 사진·영상·목소리(녹음 포함)를 쓸 수 있어요.
// 크기·길이 제한과 사용 여부는 최고관리자가 정합니다(설정: studio_upload_*).
// 영상은 MP4(H.264)로, 음성은 MP3로 바꿔 저장해 합성·미리보기가 어떤 기기에서도 되게 합니다.
const IMAGE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const VIDEO = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/3gpp'];
const AUDIO = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'video/webm'];
const HARD_LIMIT = 500 * 1024 * 1024;
const SHOT_MAX_SECONDS = 10;

export function shotMediaRoutes({ app, db, fail, now, roles, uploadDir, loadShot, project }) {
  const incoming = path.join(uploadDir, '.incoming');
  mkdirSync(incoming, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({ destination: incoming, filename: (req, file, cb) => cb(null, randomUUID() + '.part') }),
    limits: { fileSize: HARD_LIMIT, files: 1 },
    fileFilter: (req, file, cb) => cb(null, !!IMAGE[file.mimetype] || VIDEO.includes(file.mimetype) || AUDIO.includes(file.mimetype)),
  });
  const head = (file) => {
    const buf = Buffer.alloc(16);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    return buf;
  };
  const imageOk = (mime, h) =>
    (mime === 'image/png' && h.toString('hex', 0, 8) === '89504e470d0a1a0a') ||
    (mime === 'image/jpeg' && h[0] === 255 && h[1] === 216) ||
    (mime === 'image/webp' && h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP');
  const mb = (n) => `${n}MB`;
  app.post('/api/studio/ai/shots/:sid/media', roles('pd', 'admin'), upload.single('file'), async (req, res) => {
    const f = req.file;
    const made = [];
    try {
      const s = await loadShot(req, req.params.sid, 'scene');
      const p = await project(req, s.project_id, 'scene');
      const q = z.object({ kind: z.enum(['image', 'video', 'audio']), source: z.enum(['upload', 'record']).default('upload') }).parse({ ...req.query, ...req.body });
      const settings = await loadSettings(db);
      if (!Number(settings.studio_upload_enabled)) fail(403, '지금은 내 파일을 올릴 수 없어요. 관리자에게 문의해 주세요.');
      if (!f) fail(400, q.kind === 'image' ? 'JPG · PNG · WEBP 사진만 올릴 수 있어요.' : q.kind === 'video' ? 'MP4 · MOV · WEBM 영상만 올릴 수 있어요.' : 'MP3 · M4A · WAV · WEBM 음성만 올릴 수 있어요.');
      const size = statSync(f.path).size;
      const limitMb = Number({ image: settings.studio_upload_image_mb, video: settings.studio_upload_video_mb, audio: settings.studio_upload_audio_mb }[q.kind]);
      if (size > limitMb * 1024 * 1024) fail(413, `${{ image: '사진', video: '영상', audio: '음성' }[q.kind]} 파일은 ${mb(limitMb)}까지 올릴 수 있어요.`);
      const id = randomUUID();
      let url;
      let mime;
      let meta;
      let trimmed = false;
      if (q.kind === 'image') {
        if (!IMAGE[f.mimetype] || !imageOk(f.mimetype, head(f.path))) fail(400, 'JPG · PNG · WEBP 사진만 올릴 수 있어요.');
        const target = path.join(uploadDir, id + IMAGE[f.mimetype]);
        meta = await probeMedia(f.path).catch(() => null);
        if (!meta?.width) fail(400, '사진을 읽을 수 없어요. 다른 파일로 올려 주세요.');
        await rm(target, { force: true });
        await rename(f.path, target);
        made.push(target);
        url = '/uploads/' + path.basename(target);
        mime = f.mimetype;
      } else if (q.kind === 'video') {
        if (!VIDEO.includes(f.mimetype)) fail(400, 'MP4 · MOV · WEBM 영상만 올릴 수 있어요.');
        meta = await probeMedia(f.path).catch(() => null);
        if (!meta?.hasVideo) fail(400, '영상을 읽을 수 없어요. 다른 파일로 올려 주세요.');
        const maxSec = Number(settings.studio_upload_video_seconds);
        // 길이 정보가 없는 파일(브라우저 녹화 WEBM 등)은 변환한 뒤에 길이를 확인합니다.
        if (meta.duration && meta.duration > maxSec + 0.5) fail(400, `영상은 ${maxSec}초까지 올릴 수 있어요. (지금 ${Math.round(meta.duration)}초)`);
        const target = path.join(uploadDir, id + '.mp4');
        made.push(target);
        // 컷 하나는 최대 10초라서 앞부분 10초만 저장합니다(화면에서 미리 안내).
        await runFfmpeg(
          ['-i', f.path, '-t', String(SHOT_MAX_SECONDS), '-map', '0:v:0', ...(meta.hasAudio ? ['-map', '0:a:0'] : []), '-vf', "scale='min(1080,iw)':-2,fps=30", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', ...(meta.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []), '-movflags', '+faststart', target],
          300000,
        );
        const original = meta.duration || 0;
        meta = await probeMedia(target);
        if (!meta.duration || meta.duration < 0.5) fail(400, '영상이 너무 짧거나 읽을 수 없어요.');
        trimmed = original > SHOT_MAX_SECONDS + 0.5;
        url = '/uploads/' + path.basename(target);
        mime = 'video/mp4';
      } else {
        if (!AUDIO.includes(f.mimetype)) fail(400, 'MP3 · M4A · WAV · WEBM 음성만 올릴 수 있어요.');
        meta = await probeMedia(f.path).catch(() => null);
        if (!meta?.hasAudio) fail(400, '음성을 읽을 수 없어요. 다른 파일로 올려 주세요.');
        const maxSec = Number(settings.studio_upload_audio_seconds);
        if (meta.duration && meta.duration > maxSec + 0.5) fail(400, `음성은 ${maxSec}초까지 올릴 수 있어요. (지금 ${Math.round(meta.duration)}초)`);
        const target = path.join(uploadDir, id + '.mp3');
        made.push(target);
        await runFfmpeg(['-i', f.path, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', target], 180000);
        meta = await probeMedia(target);
        if (!meta.duration || meta.duration < 0.3) fail(400, '소리가 너무 짧아요. 다시 녹음해 주세요.');
        url = '/uploads/' + path.basename(target);
        mime = 'audio/mpeg';
      }
      const label = { image: '직접 올린 사진', video: '직접 올린 영상', audio: q.source === 'record' ? '직접 녹음' : '직접 올린 음성' }[q.kind];
      const seconds = q.kind === 'video' ? Math.min(SHOT_MAX_SECONDS, Math.max(2, Math.round(meta.duration))) : null;
      await db.transaction(async () => {
        await db.run('INSERT INTO media_files (url,owner_id,mime,created_at,project_id) VALUES (?,?,?,?,?)', [url, p.owner_id, mime, now(), p.id]);
        await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [url, Math.ceil(meta.duration || 0), meta.width || 0, meta.height || 0, meta.hasAudio ? 1 : 0]);
        await db.run('INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [randomUUID(), p.owner_id, p.id, 'shot', s.id, q.kind, url, null, label, now()]);
        if (q.kind === 'image') await db.run("UPDATE studio_shots SET image=?,verify='' WHERE id=?", [url, s.id]);
        // 새 영상을 쓰면 예전 영상에 맞춘 입 모양 결과는 맞지 않으므로 뺍니다(버전 기록에는 남음).
        if (q.kind === 'video') await db.run("UPDATE studio_shots SET video=?,lipsync='',seconds=? WHERE id=?", [url, seconds, s.id]);
        if (q.kind === 'audio') await db.run("UPDATE studio_shots SET audio=?,audio_seconds=?,lipsync='' WHERE id=?", [url, Math.round(meta.duration * 100) / 100, s.id]);
        await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
        await db.run('UPDATE studio_projects SET updated_at=? WHERE id=?', [now(), p.id]);
      });
      made.length = 0;
      res.status(201).json({ url, duration: Math.round((meta.duration || 0) * 10) / 10, seconds, trimmed });
    } finally {
      if (f) await rm(f.path, { force: true }).catch(() => {});
      for (const m of made) await rm(m, { force: true }).catch(() => {});
    }
  });
  // 등록(파일 → media_files · media_metadata · 버전 기록) 공통
  async function register(p, s, url, mime, meta, label, kind = 'image') {
    await db.run('INSERT INTO media_files (url,owner_id,mime,created_at,project_id) VALUES (?,?,?,?,?)', [url, p.owner_id, mime, now(), p.id]);
    await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [url, Math.ceil(meta?.duration || 0), meta?.width || 0, meta?.height || 0, meta?.hasAudio ? 1 : 0]);
    if (label) await db.run('INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [randomUUID(), p.owner_id, p.id, 'shot', s.id, kind, url, null, label, now()]);
  }
  // 앞 컷에서 이어받기(무료, 2026-09-29): 앞 컷 영상의 마지막 장면을 이 컷의 시작 이미지로 씁니다.
  // 컷과 컷 사이가 튀지 않고 한 호흡으로 이어져요. 지금 이미지는 버전 기록에 남아 언제든 되돌릴 수 있어요.
  app.post('/api/studio/ai/shots/:sid/continue', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid, 'scene');
    const p = await project(req, s.project_id, 'scene');
    const prev = await db.get('SELECT * FROM studio_shots WHERE episode_id=? AND sort_order<? ORDER BY sort_order DESC LIMIT 1', [s.episode_id, s.sort_order]);
    if (!prev) fail(400, '첫 컷은 이어받을 앞 컷이 없어요.');
    const clip = prev.lipsync || prev.video;
    if (!clip) fail(400, '앞 컷에 영상이 있어야 마지막 장면을 이어받을 수 있어요. 앞 컷 영상을 먼저 만들어 주세요.');
    if (await db.get("SELECT id FROM ai_jobs WHERE target_id=? AND kind IN ('shot_image','shot_image_edit','shot_upscale') AND status IN ('queued','running')", [s.id]))
      fail(409, '이 컷 이미지를 만드는 중이에요. 끝난 뒤 이어받아 주세요.');
    const src = path.join(uploadDir, path.basename(clip));
    const id = randomUUID();
    const target = path.join(uploadDir, id + '.jpg');
    try {
      // 끝에서 0.1초 앞 프레임(마지막 프레임이 검게 끝나는 파일도 있어 살짝 앞)을 고화질 JPG로 뽑습니다.
      await runFfmpeg(['-sseof', '-0.15', '-i', src, '-frames:v', '1', '-q:v', '2', '-y', target], 60000);
      const meta = await probeMedia(target).catch(() => null);
      if (!meta?.width) fail(500, '앞 컷의 마지막 장면을 읽지 못했어요.');
      const url = '/uploads/' + id + '.jpg';
      await db.transaction(async () => {
        await register(p, s, url, 'image/jpeg', meta, `앞 컷(${Number(prev.sort_order) + 1}번) 마지막 장면`);
        await db.run("UPDATE studio_shots SET image=?,verify='' WHERE id=?", [url, s.id]);
        await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
      });
      res.status(201).json({ url });
    } catch (e) {
      await rm(target, { force: true }).catch(() => {});
      // ffmpeg 같은 내부 오류는 알아볼 수 있는 문구로 바꿔 알려요.
      if (!e?.status) throw Object.assign(new Error('앞 컷 영상에서 마지막 장면을 뽑지 못했어요. 앞 컷 영상을 다시 만든 뒤 시도해 주세요.'), { status: 500 });
      throw e;
    }
  });
  // 영상에서 장면 뽑기(무료, 4단계 2026-09-30): 이 컷 영상의 원하는 순간을 이미지로 뽑아
  // 이 컷의 이미지(to=self) 또는 다음 컷의 시작 이미지(to=next)로 써요. 이전 이미지는 버전 기록에 남아요.
  app.post('/api/studio/ai/shots/:sid/frame', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ at: z.number().min(0).max(60), to: z.enum(['self', 'next']).default('self') }).parse(req.body);
    const s = await loadShot(req, req.params.sid, 'scene');
    const p = await project(req, s.project_id, 'scene');
    const clip = s.lipsync || s.video;
    if (!clip) fail(400, '이 컷에 영상이 있어야 장면을 뽑을 수 있어요.');
    const dest = b.to === 'next' ? await db.get('SELECT * FROM studio_shots WHERE episode_id=? AND sort_order>? ORDER BY sort_order LIMIT 1', [s.episode_id, s.sort_order]) : s;
    if (!dest) fail(400, '다음 컷이 없어요.');
    if (await db.get("SELECT id FROM ai_jobs WHERE target_id=? AND kind IN ('shot_image','shot_image_edit','shot_upscale') AND status IN ('queued','running')", [dest.id]))
      fail(409, '그 컷 이미지를 만드는 중이에요. 끝난 뒤 다시 해 주세요.');
    const src = path.join(uploadDir, path.basename(clip));
    const info = await probeMedia(src).catch(() => null);
    const at = Math.max(0, Math.min(b.at, Math.max(0, Number(info?.duration || 0) - 0.05)));
    const id = randomUUID();
    const target = path.join(uploadDir, id + '.jpg');
    try {
      await runFfmpeg(['-ss', at.toFixed(3), '-i', src, '-frames:v', '1', '-q:v', '2', '-y', target], 60000);
      const meta = await probeMedia(target).catch(() => null);
      if (!meta?.width) fail(500, '그 순간의 장면을 읽지 못했어요. 다른 순간을 골라 주세요.');
      const url = '/uploads/' + id + '.jpg';
      await db.transaction(async () => {
        await register(p, dest, url, 'image/jpeg', meta, `${b.to === 'next' ? '앞 컷' : '이 컷'} 영상 ${at.toFixed(1)}초 장면`);
        await db.run("UPDATE studio_shots SET image=?,verify='',updated_at=? WHERE id=?", [url, now(), dest.id]);
        await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [dest.episode_id]);
      });
      res.status(201).json({ url, at, shotId: dest.id });
    } catch (e) {
      await rm(target, { force: true }).catch(() => {});
      if (!e?.status) throw Object.assign(new Error('영상에서 장면을 뽑지 못했어요. 영상을 다시 만든 뒤 시도해 주세요.'), { status: 500 });
      throw e;
    }
  });
  // 부분 수정용 붓 칠(마스크) 올리기: 흰색 = 고칠 곳, 검은색 = 그대로. PNG만, 5MB까지.
  // 마스크는 작업 입력으로만 쓰므로 공개 업로드 폴더가 아닌 uploads/masks에 두고(주소로 열리지 않음),
  // media_files에도 넣지 않아 포스터·썸네일 같은 다른 자리에 쓸 수 없어요. 7일이 지나면 지워요(다시 시도 여유).
  const maskDir = path.join(uploadDir, 'masks');
  mkdirSync(maskDir, { recursive: true });
  const sweepMasks = async () => {
    for (const f of readdirSync(maskDir)) {
      const full = path.join(maskDir, f);
      try {
        if (Date.now() - statSync(full).mtimeMs > 7 * 86400000) await rm(full, { force: true });
      } catch {
        /* 이미 지워짐 */
      }
    }
  };
  setInterval(() => void sweepMasks().catch(() => {}), 6 * 3600 * 1000).unref();
  const maskUpload = multer({
    storage: multer.diskStorage({ destination: incoming, filename: (req, file, cb) => cb(null, randomUUID() + '.part') }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, file.mimetype === 'image/png'),
  });
  app.post('/api/studio/ai/shots/:sid/mask', roles('pd', 'admin'), maskUpload.single('file'), async (req, res) => {
    const f = req.file;
    try {
      const s = await loadShot(req, req.params.sid, 'scene');
      await project(req, s.project_id, 'scene');
      if (!s.image) fail(400, '고칠 컷 이미지가 없어요.');
      if (!f || !imageOk('image/png', head(f.path))) fail(400, '칠한 영역을 읽지 못했어요. 다시 칠해 주세요.');
      const meta = await probeMedia(f.path).catch(() => null);
      if (!meta?.width || meta.width > 4096 || meta.height > 4096) fail(400, '칠한 영역 크기가 올바르지 않아요.');
      // 컷 이미지와 가로세로 비율이 같아야 칠한 위치가 맞아요.
      const img = await probeMedia(path.join(uploadDir, path.basename(s.image))).catch(() => null);
      if (img?.width && Math.abs(meta.width / meta.height - img.width / img.height) > 0.02) fail(400, '칠한 영역이 지금 컷 이미지와 맞지 않아요. 창을 닫고 다시 칠해 주세요.');
      // 파일 이름에 컷 ID를 넣어 이 컷에서만 쓸 수 있게 묶어요(다른 컷 · 프로젝트에 가져다 쓸 수 없음).
      const id = `${s.id}.${randomUUID()}`;
      await rename(f.path, path.join(maskDir, id + '.png'));
      res.status(201).json({ url: '/masks/' + id + '.png' });
    } finally {
      if (f) await rm(f.path, { force: true }).catch(() => {});
    }
  });
  // 컷에서 영상·음성·이미지 빼기(버전 기록에는 남아 언제든 다시 고를 수 있어요). 영상을 빼면 이미지에 카메라 움직임으로 합성해요.
  app.delete('/api/studio/ai/shots/:sid/media/:kind', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid, 'scene');
    const kind = z.enum(['image', 'video', 'audio', 'lipsync', 'sfx']).parse(req.params.kind);
    if (kind === 'image' && !s.video && !s.lipsync) fail(400, '영상이 없는 컷은 이미지를 뺄 수 없어요. 다른 이미지로 바꿔 주세요.');
    const sets = { image: "image=''", video: "video='',lipsync=''", audio: "audio='',audio_seconds=0,lipsync=''", lipsync: "lipsync=''", sfx: "sfx=''" }[kind];
    await db.run(`UPDATE studio_shots SET ${sets} WHERE id=?`, [s.id]);
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END,compose_dirty=CASE WHEN status='composing' THEN 1 ELSE compose_dirty END WHERE id=?", [s.episode_id]);
    res.json({ ok: true });
  });
  // 마스크 파일 경로(형식이 맞지 않거나 다른 컷의 마스크면 null)
  const MASK = /^\/masks\/([a-f0-9-]+)\.[a-f0-9-]+\.png$/;
  return { maskFile: (url, shotId) => (MASK.exec(url || '')?.[1] === shotId ? path.join(maskDir, path.basename(url)) : null) };
}
