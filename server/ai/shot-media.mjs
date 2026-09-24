import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
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
      const s = await loadShot(req, req.params.sid);
      const p = await project(req, s.project_id);
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
        if (!meta?.hasVideo || !meta.duration) fail(400, '영상을 읽을 수 없어요. 다른 파일로 올려 주세요.');
        const maxSec = Number(settings.studio_upload_video_seconds);
        if (meta.duration > maxSec + 0.5) fail(400, `영상은 ${maxSec}초까지 올릴 수 있어요. (지금 ${Math.round(meta.duration)}초)`);
        const target = path.join(uploadDir, id + '.mp4');
        made.push(target);
        await runFfmpeg(
          ['-i', f.path, '-map', '0:v:0', ...(meta.hasAudio ? ['-map', '0:a:0'] : []), '-vf', "scale='min(1080,iw)':-2,fps=30", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', ...(meta.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []), '-movflags', '+faststart', target],
          300000,
        );
        meta = await probeMedia(target);
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
      const seconds = q.kind === 'video' ? Math.min(10, Math.max(2, Math.round(meta.duration))) : null;
      await db.transaction(async () => {
        await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [url, p.owner_id, mime, now()]);
        await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [url, Math.ceil(meta.duration || 0), meta.width || 0, meta.height || 0, meta.hasAudio ? 1 : 0]);
        await db.run('INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [randomUUID(), p.owner_id, p.id, 'shot', s.id, q.kind, url, null, label, now()]);
        if (q.kind === 'image') await db.run('UPDATE studio_shots SET image=? WHERE id=?', [url, s.id]);
        // 새 영상을 쓰면 예전 영상에 맞춘 입 모양 결과는 맞지 않으므로 뺍니다(버전 기록에는 남음).
        if (q.kind === 'video') await db.run("UPDATE studio_shots SET video=?,lipsync='',seconds=? WHERE id=?", [url, seconds, s.id]);
        if (q.kind === 'audio') await db.run("UPDATE studio_shots SET audio=?,audio_seconds=?,lipsync='' WHERE id=?", [url, Math.round(meta.duration * 100) / 100, s.id]);
        await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
        await db.run('UPDATE studio_projects SET updated_at=? WHERE id=?', [now(), p.id]);
      });
      made.length = 0;
      res.status(201).json({ url, duration: Math.round((meta.duration || 0) * 10) / 10, seconds });
    } finally {
      if (f) await rm(f.path, { force: true }).catch(() => {});
      for (const m of made) await rm(m, { force: true }).catch(() => {});
    }
  });
  // 컷에서 영상·음성·이미지 빼기(버전 기록에는 남아 언제든 다시 고를 수 있어요). 영상을 빼면 이미지에 카메라 움직임으로 합성해요.
  app.delete('/api/studio/ai/shots/:sid/media/:kind', roles('pd', 'admin'), async (req, res) => {
    const s = await loadShot(req, req.params.sid);
    const kind = z.enum(['image', 'video', 'audio', 'lipsync', 'sfx']).parse(req.params.kind);
    if (kind === 'image' && !s.video && !s.lipsync) fail(400, '영상이 없는 컷은 이미지를 뺄 수 없어요. 다른 이미지로 바꿔 주세요.');
    const sets = { image: "image=''", video: "video='',lipsync=''", audio: "audio='',audio_seconds=0,lipsync=''", lipsync: "lipsync=''", sfx: "sfx=''" }[kind];
    await db.run(`UPDATE studio_shots SET ${sets} WHERE id=?`, [s.id]);
    await db.run("UPDATE studio_episodes SET status=CASE WHEN status='composed' THEN 'scripted' ELSE status END WHERE id=?", [s.episode_id]);
    res.json({ ok: true });
  });
}
