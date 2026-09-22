import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { appendFile, rename, rm, stat, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runFfmpeg, inspectMedia } from './media.mjs';

// 외부 제작 영상 업로드 고도화: 분할(이어) 업로드, 썸네일 후보, 자막, 권리·AI 자가 신고.
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const CHUNK_BYTES = 8 * 1024 * 1024;

// SRT·VTT를 검증해 WebVTT로 바꿉니다. 태그는 모두 제거해 안전한 텍스트만 남깁니다.
export function toVtt(text) {
  const clean = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^WEBVTT[^\n]*\n/, '');
  const time = /(\d{1,2}:)?(\d{1,2}):(\d{2})[,.](\d{3})/;
  const cues = [];
  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->').map((x) => x.trim());
    const ma = a.match(time),
      mb = b.match(time);
    if (!ma || !mb) continue;
    const norm = (m) =>
      `${String(Number((m[1] || '0:').slice(0, -1))).padStart(2, '0')}:${m[2].padStart(2, '0')}:${m[3]}.${m[4]}`;
    const body = lines
      .slice(at + 1)
      .map((l) => l.replace(/<[^>]*>/g, '').replace(/[{}]/g, '').trim())
      .filter(Boolean)
      .join('\n');
    if (!body) continue;
    cues.push(`${norm(ma)} --> ${norm(mb)}\n${body}`);
    if (cues.length > 3000) break;
  }
  if (!cues.length) return null;
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

export function uploadRoutes({
  app,
  db,
  fail,
  now,
  roles,
  checkMedia,
  uploadDir,
  mediaPath,
  owned,
  canWatch,
  registerMediaFile,
}) {
  const partsDir = path.join(uploadDir, '.parts');
  const subsDir = path.join(uploadDir, 'subtitles');
  void mkdir(partsDir, { recursive: true });
  void mkdir(subsDir, { recursive: true });
  const partPath = (id) => path.join(partsDir, id + '.part');
  const writing = new Set();
  const session = async (req) => {
    const s = await db.get('SELECT * FROM upload_sessions WHERE id=?', [req.params.id]);
    if (!s || s.owner_id !== req.user.id) fail(404, '업로드를 찾을 수 없습니다.');
    return s;
  };

  // 1) 업로드 시작: 파일 크기를 먼저 알리고 세션을 받습니다.
  app.post('/api/studio/uploads', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({
        size: z.number().int().min(1),
        mime: z.literal('video/mp4'),
        filename: z.string().trim().max(200).default(''),
      })
      .parse(req.body);
    if (b.size > MAX_VIDEO_BYTES) fail(400, '영상은 회차당 최대 500MB까지 올릴 수 있어요.');
    const id = randomUUID();
    await writeFile(partPath(id), '');
    await db.run(
      'INSERT INTO upload_sessions (id,owner_id,mime,size,received,filename,status,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?,?)',
      [id, req.user.id, b.mime, b.size, b.filename, 'open', now(), now()],
    );
    res.status(201).json({ id, chunkSize: CHUNK_BYTES, received: 0 });
  });
  // 2) 이어 올리기: 끊긴 경우 서버가 받은 위치부터 다시 보냅니다.
  app.get('/api/studio/uploads/:id', roles('pd', 'admin'), async (req, res) => {
    const s = await session(req);
    res.json({ id: s.id, size: Number(s.size), received: Number(s.received), status: s.status, url: s.url });
  });
  app.put(
    '/api/studio/uploads/:id',
    roles('pd', 'admin'),
    express.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES + 1024 }),
    async (req, res) => {
      const s = await session(req);
      if (s.status !== 'open') fail(409, '이미 완료되었거나 취소된 업로드입니다.');
      const offset = z.coerce.number().int().min(0).parse(req.query.offset);
      const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!chunk.length) fail(400, '빈 조각입니다.');
      if (writing.has(s.id)) fail(409, '같은 업로드가 진행 중입니다.');
      writing.add(s.id);
      try {
        // 파일 크기가 진실입니다. DB 값과 어긋나면 파일 기준으로 맞춥니다.
        const actual = existsSync(partPath(s.id)) ? statSync(partPath(s.id)).size : -1;
        if (actual < 0) fail(410, '업로드가 만료되었습니다. 처음부터 다시 올려 주세요.');
        if (offset !== actual)
          return res.status(409).json({ error: '업로드 위치가 맞지 않아요.', received: actual });
        if (actual + chunk.length > Number(s.size)) fail(400, '파일 크기를 넘는 조각입니다.');
        await appendFile(partPath(s.id), chunk);
        const received = actual + chunk.length;
        await db.run('UPDATE upload_sessions SET received=?,updated_at=? WHERE id=?', [
          received,
          now(),
          s.id,
        ]);
        res.json({ received });
      } finally {
        writing.delete(s.id);
      }
    },
  );
  // 3) 완료: 다 받았으면 일반 업로드와 같은 검사(파일 서명·디코딩·H.264)를 거쳐 등록합니다.
  app.post('/api/studio/uploads/:id/complete', roles('pd', 'admin'), async (req, res) => {
    const s = await session(req);
    if (s.status === 'done') {
      const meta = await db.get('SELECT * FROM media_metadata WHERE url=?', [s.url]);
      return res.json({ url: s.url, duration: Number(meta?.duration || 0), warnings: [] });
    }
    if (s.status !== 'open' || writing.has(s.id)) fail(409, '업로드를 완료할 수 없는 상태입니다.');
    const size = existsSync(partPath(s.id)) ? statSync(partPath(s.id)).size : -1;
    if (size !== Number(s.size))
      return res.status(409).json({ error: '아직 모든 조각이 도착하지 않았어요.', received: Math.max(0, size) });
    writing.add(s.id);
    try {
      const filename = randomUUID() + '.mp4';
      const target = path.join(uploadDir, filename);
      await rename(partPath(s.id), target);
      let result;
      try {
        result = await registerMediaFile(
          { path: target, filename, mimetype: 'video/mp4', size },
          req.user.id,
        );
      } catch (error) {
        await db.run("UPDATE upload_sessions SET status='failed',updated_at=? WHERE id=?", [now(), s.id]);
        throw error;
      }
      await db.run("UPDATE upload_sessions SET status='done',url=?,updated_at=? WHERE id=?", [
        result.url,
        now(),
        s.id,
      ]);
      res.json(result);
    } finally {
      writing.delete(s.id);
    }
  });
  app.delete('/api/studio/uploads/:id', roles('pd', 'admin'), async (req, res) => {
    const s = await session(req);
    if (s.status === 'open') {
      await rm(partPath(s.id), { force: true });
      await db.run("UPDATE upload_sessions SET status='canceled',updated_at=? WHERE id=?", [now(), s.id]);
    }
    res.json({ ok: true });
  });
  // 하루 넘게 멈춘 업로드 조각은 정리합니다.
  const sweep = async () => {
    const stale = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = await db.all("SELECT id FROM upload_sessions WHERE status='open' AND updated_at<?", [stale]);
    for (const r of rows) {
      await rm(partPath(r.id), { force: true });
      await db.run("UPDATE upload_sessions SET status='expired' WHERE id=?", [r.id]);
    }
    for (const f of existsSync(partsDir) ? readdirSync(partsDir) : []) {
      const full = path.join(partsDir, f);
      if (Date.now() - statSync(full).mtimeMs > 48 * 3600 * 1000) await rm(full, { force: true });
    }
  };
  setInterval(() => void sweep().catch(() => {}), 60 * 60 * 1000).unref();

  // 영상에서 포스터 후보 장면 3장을 뽑습니다.
  app.post('/api/studio/media/frames', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({ video: z.string().regex(/^\/(uploads\/[a-f0-9-]+\.mp4|demo\/preview\.mp4)$/) })
      .parse(req.body);
    await checkMedia(req, b.video);
    const meta = await db.get('SELECT duration FROM media_metadata WHERE url=?', [b.video]);
    const duration = b.video.startsWith('/demo/') ? 12 : Number(meta?.duration || 10);
    const frames = [];
    for (const ratio of [0.15, 0.45, 0.75]) {
      const filename = randomUUID() + '.jpg';
      const target = path.join(uploadDir, filename);
      await runFfmpeg([
        '-ss',
        String(Math.max(0, duration * ratio).toFixed(2)),
        '-i',
        mediaPath(b.video),
        '-frames:v',
        '1',
        '-vf',
        "scale='min(1080,iw)':-2",
        '-q:v',
        '3',
        target,
      ]);
      const info = await stat(target);
      frames.push(await registerMediaFile({ path: target, filename, mimetype: 'image/jpeg', size: info.size }, req.user.id));
    }
    res.json({ frames: frames.map((f) => f.url) });
  });
  app.put('/api/studio/dramas/:id/poster', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({
        image: z.string().regex(/^\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/),
      })
      .parse(req.body);
    await db.transaction(async () => {
      const d = await owned(req, true);
      if (!['draft', 'rejected'].includes(d.status))
        fail(409, '임시저장 또는 반려된 작품만 수정할 수 있어요.');
      await checkMedia(req, b.image);
      await db.run('UPDATE dramas SET image=? WHERE id=?', [b.image, d.id]);
    });
    res.json({ ok: true });
  });
  // 권리·초상권·AI 사용 자가 신고(외부 제작 영상)
  app.put('/api/studio/dramas/:id/declaration', roles('pd', 'admin'), async (req, res) => {
    const b = z
      .object({
        rights_confirmed: z.boolean(),
        likeness_confirmed: z.boolean(),
        ai_usage: z.enum(['none', 'partial', 'full']),
      })
      .parse(req.body);
    await db.transaction(async () => {
      const d = await owned(req, true);
      if (!['draft', 'rejected'].includes(d.status))
        fail(409, '임시저장 또는 반려된 작품만 수정할 수 있어요.');
      await db.run(
        'UPDATE dramas SET rights_confirmed=?,likeness_confirmed=?,ai_usage=?,declared_at=? WHERE id=?',
        [b.rights_confirmed ? 1 : 0, b.likeness_confirmed ? 1 : 0, b.ai_usage, now(), d.id],
      );
    });
    res.json({ ok: true });
  });
  // 자막: SRT/VTT 텍스트를 받아 WebVTT로 저장합니다.
  app.post('/api/studio/dramas/:id/episodes/:number/subtitles', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ text: z.string().min(10).max(200000) }).parse(req.body);
    const vtt = toVtt(b.text);
    if (!vtt) fail(400, '자막 형식을 읽을 수 없어요. SRT 또는 VTT 파일을 올려 주세요.');
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    const file = randomUUID() + '.vtt';
    await db.transaction(async () => {
      const d = await owned(req, true);
      if (!['draft', 'rejected'].includes(d.status))
        fail(409, '임시저장 또는 반려 상태에서 자막을 수정해 주세요.');
      const e = await db.get('SELECT id FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
      if (!e) fail(404, '회차를 찾을 수 없습니다.');
      await writeFile(path.join(subsDir, file), vtt, 'utf8');
      await db.run('UPDATE episodes SET subtitles=? WHERE id=?', [file, e.id]);
    });
    res.json({ ok: true, cues: vtt.split('-->').length - 1 });
  });
  app.delete('/api/studio/dramas/:id/episodes/:number/subtitles', roles('pd', 'admin'), async (req, res) => {
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    await db.transaction(async () => {
      const d = await owned(req, true);
      if (!['draft', 'rejected'].includes(d.status))
        fail(409, '임시저장 또는 반려 상태에서 자막을 수정해 주세요.');
      await db.run("UPDATE episodes SET subtitles='' WHERE drama_id=? AND number=?", [d.id, number]);
    });
    res.json({ ok: true });
  });
  // 시청 권한이 있는 사람만 자막을 받습니다(영상과 같은 기준).
  app.get('/api/subtitles/:id/:number', async (req, res) => {
    const d = await db.get('SELECT * FROM dramas WHERE id=?', [req.params.id]);
    if (!d || (d.status !== 'published' && req.user?.role !== 'admin' && d.owner_id !== req.user?.id))
      fail(404, '작품을 찾을 수 없습니다.');
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    if (!(await canWatch(req.user, d, number))) fail(403, '시청 권한이 없습니다.');
    const e = await db.get('SELECT subtitles FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
    if (!e?.subtitles || !/^[a-f0-9-]+\.vtt$/.test(e.subtitles)) fail(404, '자막이 없습니다.');
    res.type('text/vtt; charset=utf-8').send(await readFile(path.join(subsDir, e.subtitles), 'utf8'));
  });
  return { toVtt };
}
