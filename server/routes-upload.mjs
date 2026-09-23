import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { appendFile, rename, rm, stat, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runFfmpeg, inspectMedia } from './media.mjs';
import { loadSettings } from './settings.mjs';

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
  episodeEditable,
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

  // 어디에서도 쓰이지 않는 오래된 업로드 파일 정리(고르지 않은 포스터 후보 장면, 버려진 초안 이미지 등).
  // 보관 기간은 최고 관리자가 '저장 공간 정리'에서 정합니다(media_retention_days, 기본 91일, 0이면 끔).
  // 만든 지 보관 기간이 지났고, 아래 모든 참조 칸에서 쓰이지 않는 파일만 지웁니다.
  const referenced = [
    'SELECT 1 FROM user_profiles WHERE avatar=m.url',
    'SELECT 1 FROM dramas WHERE image=m.url',
    'SELECT 1 FROM episodes WHERE video=m.url',
    'SELECT 1 FROM channels WHERE banner=m.url OR logo=m.url',
    'SELECT 1 FROM studio_projects WHERE poster=m.url',
    'SELECT 1 FROM studio_characters WHERE image=m.url OR voice_sample=m.url',
    'SELECT 1 FROM studio_shots WHERE image=m.url OR audio=m.url OR video=m.url',
    'SELECT 1 FROM studio_episodes WHERE video=m.url',
    'SELECT 1 FROM studio_assets WHERE url=m.url',
    'SELECT 1 FROM upload_sessions WHERE url=m.url',
    "SELECT 1 FROM ai_jobs WHERE status IN ('queued','running') AND input LIKE '%' || m.url || '%'",
    // 숏핑 스튜디오 고도화(2026-09-23)에서 생긴 자리: 오프닝/엔딩 카드·회차 썸네일·배경음악·예고편·장소·참고 이미지·입 모양·효과음
    'SELECT 1 FROM studio_episodes WHERE intro_card=m.url OR outro_card=m.url OR thumbnail=m.url OR bgm=m.url',
    'SELECT 1 FROM studio_projects WHERE bgm=m.url OR trailer=m.url',
    'SELECT 1 FROM studio_locations WHERE image=m.url',
    "SELECT 1 FROM studio_characters WHERE refs LIKE '%' || m.url || '%'",
    'SELECT 1 FROM studio_shots WHERE lipsync=m.url OR sfx=m.url',
    'SELECT 1 FROM dramas WHERE trailer=m.url',
    'SELECT 1 FROM episodes WHERE thumbnail=m.url',
    'SELECT 1 FROM drama_thumbnails WHERE url=m.url',
    'SELECT 1 FROM voice_samples WHERE url=m.url',
    // 메인페이지 여백 배경 사진(지금 설정과 되돌리기용 기록)
    "SELECT 1 FROM platform_settings WHERE key='home_style' AND value LIKE '%' || m.url || '%'",
    "SELECT 1 FROM home_history WHERE data LIKE '%' || m.url || '%'",
  ];
  const orphanWhere = `m.created_at<? AND ${referenced.map((q) => `NOT EXISTS (${q})`).join(' AND ')}`;
  const cutoffFor = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const safeUrl = (url) => /^\/uploads\/[a-f0-9-]+\.[a-z0-9]+$/.test(url);
  let lastSweep = null;
  // 정리 대상 미리보기(삭제하지 않음). 용량은 오래된 순 500개까지만 실제 파일 크기로 셉니다.
  async function previewOrphans(days) {
    if (!days) return { count: 0, bytes: 0, sampled: 0, sample: [] };
    const cutoff = cutoffFor(days);
    const count = Number((await db.get(`SELECT COUNT(*) AS n FROM media_files m WHERE ${orphanWhere}`, [cutoff]))?.n || 0);
    const rows = await db.all(`SELECT m.url, m.mime, m.created_at FROM media_files m WHERE ${orphanWhere} ORDER BY m.created_at LIMIT 500`, [cutoff]);
    let bytes = 0;
    for (const r of rows) {
      try {
        bytes += (await stat(path.join(uploadDir, path.basename(r.url)))).size;
      } catch {
        /* 이미 없는 파일 */
      }
    }
    return { count, bytes, sampled: rows.length, sample: rows.slice(0, 20) };
  }
  async function sweepOrphans({ days, actorId = null } = {}) {
    if (!days) return { deleted: 0, days: 0 };
    const cutoff = cutoffFor(days);
    let deleted = 0;
    // 한 번에 200개씩, 최대 5,000개까지 정리합니다(남으면 다음 날 이어서).
    for (let round = 0; round < 25; round++) {
      const rows = await db.all(`SELECT m.url FROM media_files m WHERE ${orphanWhere} LIMIT 200`, [cutoff]);
      const targets = rows.filter((r) => safeUrl(r.url));
      if (!targets.length) break;
      for (const { url } of targets) {
        await db.run('DELETE FROM media_files WHERE url=?', [url]);
        await rm(path.join(uploadDir, path.basename(url)), { force: true });
        deleted += 1;
      }
      if (rows.length < 200) break;
    }
    lastSweep = { at: now(), deleted, days, by: actorId ? 'manual' : 'auto' };
    const actor = actorId || (await db.get("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1"))?.id;
    if (actor && (deleted || actorId))
      await db
        .run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [
          randomUUID(),
          actor,
          `storage:cleanup:${deleted}`,
          `${days}d`,
          now(),
        ])
        .catch(() => {});
    return { deleted, days };
  }
  const autoSweep = async () => {
    const days = Number((await loadSettings(db)).media_retention_days || 0);
    if (days > 0) await sweepOrphans({ days });
  };
  setInterval(() => void autoSweep().catch((e) => console.error('orphan sweep', e.message)), 24 * 60 * 60 * 1000).unref();

  // 최고 관리자 · 저장 공간 정리: 현황과 정리 대상 미리보기, 지금 정리하기
  app.get('/api/admin/storage', roles('admin'), async (req, res) => {
    const days = Number((await loadSettings(db)).media_retention_days || 0);
    const total = await db.get('SELECT COUNT(*) AS n FROM media_files');
    res.json({
      retention_days: days,
      default_days: 91,
      total_files: Number(total?.n || 0),
      candidates: await previewOrphans(days),
      last_sweep: lastSweep,
      checked_places: referenced.length,
    });
  });
  app.post('/api/admin/storage/cleanup', roles('admin'), async (req, res) => {
    const days = Number((await loadSettings(db)).media_retention_days || 0);
    if (!days) fail(400, '자동 정리가 꺼져 있어요. 보관 기간을 먼저 정해 주세요.');
    res.json(await sweepOrphans({ days, actorId: req.user.id }));
  });

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
    let previous = '';
    await db.transaction(async () => {
      const d = await owned(req, true);
      const e = await db.get('SELECT id,subtitles,review_status FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
      if (!episodeEditable(d, e))
        fail(409, '임시저장 또는 반려 상태에서 자막을 수정해 주세요. 연재 중인 작품은 공개 전 회차만 고칠 수 있어요.');
      if (!e) fail(404, '회차를 찾을 수 없습니다.');
      await writeFile(path.join(subsDir, file), vtt, 'utf8');
      await db.run('UPDATE episodes SET subtitles=? WHERE id=?', [file, e.id]);
      previous = e.subtitles;
    });
    // 교체된 이전 자막 파일은 더 이상 쓰이지 않으므로 지웁니다.
    if (/^[a-f0-9-]+\.vtt$/.test(previous || '')) await rm(path.join(subsDir, previous), { force: true }).catch(() => {});
    res.json({ ok: true, cues: vtt.split('-->').length - 1 });
  });
  app.delete('/api/studio/dramas/:id/episodes/:number/subtitles', roles('pd', 'admin'), async (req, res) => {
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    let previous = '';
    await db.transaction(async () => {
      const d = await owned(req, true);
      const e = await db.get('SELECT subtitles,review_status FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
      if (!episodeEditable(d, e))
        fail(409, '임시저장 또는 반려 상태에서 자막을 수정해 주세요. 연재 중인 작품은 공개 전 회차만 고칠 수 있어요.');
      await db.run("UPDATE episodes SET subtitles='' WHERE drama_id=? AND number=?", [d.id, number]);
      previous = e?.subtitles || '';
    });
    if (/^[a-f0-9-]+\.vtt$/.test(previous)) await rm(path.join(subsDir, previous), { force: true }).catch(() => {});
    res.json({ ok: true });
  });
  // 시청 권한이 있는 사람만 자막을 받습니다(영상과 같은 기준).
  app.get('/api/subtitles/:id/:number', async (req, res) => {
    const d = await db.get('SELECT * FROM dramas WHERE id=?', [req.params.id]);
    if (!d || (d.status !== 'published' && req.user?.role !== 'admin' && d.owner_id !== req.user?.id))
      fail(404, '작품을 찾을 수 없습니다.');
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    if (!(await canWatch(req.user, d, number))) fail(403, '시청 권한이 없습니다.');
    const e = await db.get('SELECT subtitles,review_status FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
    const all = req.user && (req.user.role === 'admin' || req.user.id === d.owner_id);
    if (!e?.subtitles || !/^[a-f0-9-]+\.vtt$/.test(e.subtitles) || (e.review_status !== 'approved' && !all)) fail(404, '자막이 없습니다.');
    res.type('text/vtt; charset=utf-8').send(await readFile(path.join(subsDir, e.subtitles), 'utf8'));
  });
  return { toVtt, sweepOrphans, previewOrphans };
}
