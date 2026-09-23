import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { notify } from './notify.mjs';
import { settleThumbs } from './thumbs.mjs';

// 연재형 공개: 이미 공개된 작품에 새 회차를 올리면 그 회차만 검수를 받고, 승인되면(또는 예약한 시각에) 공개됩니다.
// 회차 상태(review_status)
//   approved  공개 중(시청자에게 보임)
//   draft     공개 작품에 새로 올렸지만 아직 검수 신청 전
//   pending   회차 검수 대기
//   rejected  회차 반려(고쳐서 다시 신청)
//   scheduled 승인됐고 예약한 시각을 기다리는 중
export const EDITABLE_EPISODE = ['draft', 'rejected'];
// 작품 상태와 회차 상태를 함께 보고 회차를 고칠 수 있는지 판단합니다.
export function episodeEditable(d, e) {
  if (['draft', 'rejected'].includes(d.status)) return true;
  return d.status === 'published' && !!e && EDITABLE_EPISODE.includes(e.review_status);
}
export function serialRoutes({ app, db, fail, now, roles, owned, mediaPath, demo }) {
  const epOf = async (d, number) => db.get('SELECT * FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
  const audit = (actorId, action, targetId) =>
    db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), actorId, action, targetId, now()]);
  const future = (iso) => !!iso && new Date(iso).getTime() > Date.now();

  // PD: 공개 작품의 새 회차 검수 신청(원하면 공개 예약 시각도 함께)
  app.post('/api/studio/dramas/:id/episodes/:number/submit', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ publish_at: z.string().datetime().nullable().optional() }).parse(req.body || {});
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    await db.transaction(async () => {
      const d = await owned(req, true);
      if (d.status !== 'published') fail(409, '공개 중인 작품의 새 회차만 따로 검수를 신청할 수 있어요. 작품 전체는 작품 검수로 신청해 주세요.');
      const e = await epOf(d, number);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      if (!EDITABLE_EPISODE.includes(e.review_status)) fail(409, '이미 검수 중이거나 공개된 회차예요.');
      if (!e.video || !existsSync(mediaPath(e.video)) || (!demo && e.video.startsWith('/demo/'))) fail(400, `${number}화 영상 파일을 확인해 주세요.`);
      const before = await db.get('SELECT COUNT(*) AS n FROM episodes WHERE drama_id=? AND number<?', [d.id, number]);
      if (Number(before?.n || 0) !== number - 1) fail(400, '앞 회차가 빠져 있어요. 1화부터 순서대로 올려 주세요.');
      if (b.publish_at && !future(b.publish_at)) fail(400, '공개 예약 시각은 지금보다 뒤여야 해요.');
      await db.run("UPDATE episodes SET review_status='pending',review_note='',submitted_at=?,publish_at=? WHERE id=?", [now(), b.publish_at || null, e.id]);
      await audit(req.user.id, 'episode:pending', e.id);
    });
    res.json({ ok: true });
  });
  // PD: 공개 예약 시각 바꾸기(검수 중·예약 중 회차)
  app.patch('/api/studio/dramas/:id/episodes/:number/schedule', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ publish_at: z.string().datetime().nullable() }).parse(req.body);
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    await db.transaction(async () => {
      const d = await owned(req, true);
      const e = await epOf(d, number);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      if (!['draft', 'pending', 'scheduled', 'rejected'].includes(e.review_status)) fail(409, '이미 공개된 회차는 예약을 바꿀 수 없어요.');
      if (b.publish_at && !future(b.publish_at)) fail(400, '공개 예약 시각은 지금보다 뒤여야 해요.');
      // 승인되어 예약 대기 중인데 예약을 지우면 바로 공개합니다.
      const next = e.review_status === 'scheduled' && !b.publish_at ? 'approved' : e.review_status;
      await db.run('UPDATE episodes SET publish_at=?,review_status=? WHERE id=?', [b.publish_at, next, e.id]);
    });
    res.json({ ok: true });
  });
  // 관리자: 회차 검수 대기 목록
  app.get('/api/admin/episodes/review', roles('admin'), async (req, res) => {
    res.json(
      await db.all(
        `SELECT e.id,e.drama_id,e.number,e.title,e.video,e.duration,e.source,e.review_status,e.review_note,e.submitted_at,e.publish_at,
                CASE WHEN e.subtitles<>'' THEN 1 ELSE 0 END AS has_subtitles,
                d.title AS drama_title,d.image AS drama_image,d.ai_usage,u.name AS owner_name,u.id AS owner_id
         FROM episodes e JOIN dramas d ON d.id=e.drama_id JOIN users u ON u.id=d.owner_id
         WHERE e.review_status='pending' ORDER BY e.submitted_at`,
      ),
    );
  });
  app.post('/api/admin/episodes/:eid/review', roles('admin'), async (req, res) => {
    const b = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(1000).default('') }).parse(req.body);
    const result = await db.transaction(async () => {
      const e = await db.get('SELECT e.*, d.owner_id, d.title AS drama_title, d.status AS drama_status FROM episodes e JOIN dramas d ON d.id=e.drama_id WHERE e.id=?' + (db.engine === 'postgresql' ? ' FOR UPDATE OF e' : ''), [req.params.eid]);
      if (!e) fail(404, '회차를 찾을 수 없어요.');
      if (e.review_status !== 'pending') fail(409, '검수 대기 중인 회차만 처리할 수 있어요.');
      if (b.status === 'rejected' && !b.note.trim()) fail(400, '반려 사유를 입력해 주세요.');
      const status = b.status === 'rejected' ? 'rejected' : future(e.publish_at) ? 'scheduled' : 'approved';
      await db.run('UPDATE episodes SET review_status=?,review_note=? WHERE id=?', [status, b.note.trim(), e.id]);
      await audit(req.user.id, `episode:${status}`, e.id);
      return { ...e, status };
    });
    const title = `${result.drama_title} ${result.number}화`;
    await notify(db, result.owner_id, {
      kind: 'episode_review',
      title:
        result.status === 'rejected'
          ? `${title} 검수가 반려됐어요`
          : result.status === 'scheduled'
            ? `${title}이 승인됐어요 · ${new Date(result.publish_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 공개 예정`
            : `${title}이 공개됐어요`,
      body: result.status === 'rejected' ? b.note.trim() : '시청자가 지금 볼 수 있어요.',
      link: 'studio/contents',
    });
    res.json({ ok: true, status: result.status });
  });
  // 예약 공개 처리기: 예약 시각이 된 회차를 공개합니다(30초마다).
  async function publishDue() {
    const due = await db.all(
      "SELECT e.id,e.number,d.title,d.owner_id FROM episodes e JOIN dramas d ON d.id=e.drama_id WHERE e.review_status='scheduled' AND e.publish_at<=?",
      [now()],
    );
    for (const e of due) {
      const r = await db.run("UPDATE episodes SET review_status='approved' WHERE id=? AND review_status='scheduled'", [e.id]);
      if (Number(r?.rowCount ?? r?.changes ?? 0) > 0)
        await notify(db, e.owner_id, { kind: 'episode_review', title: `${e.title} ${e.number}화가 예약대로 공개됐어요`, body: '시청자가 지금 볼 수 있어요.', link: 'studio/contents' });
    }
    return due.length;
  }
  const timer = setInterval(() => void publishDue().catch((e) => console.error('publish', e.message)), 30000);
  timer.unref();
  void publishDue().catch(() => {});
  app.locals.publishDue = publishDue;

  // ── 썸네일 A/B: PD가 결과를 보고, 후보를 더하거나 비교를 끝냅니다 ─────────
  app.get('/api/studio/dramas/:id/thumbnails', roles('pd', 'admin'), async (req, res) => {
    const d = await owned(req);
    res.json(await db.all('SELECT id,url,impressions,clicks,active,winner,created_at FROM drama_thumbnails WHERE drama_id=? ORDER BY created_at', [d.id]));
  });
  app.post('/api/studio/dramas/:id/thumbnails', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ url: z.string().regex(/^\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/) }).parse(req.body);
    const d = await owned(req);
    if (b.url.startsWith('/uploads/')) {
      const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [b.url]);
      if (!f || (f.owner_id !== d.owner_id && req.user.role !== 'admin')) fail(403, '본인이 올리거나 만든 이미지만 쓸 수 있어요.');
    }
    const active = await db.all('SELECT url FROM drama_thumbnails WHERE drama_id=? AND active=1', [d.id]);
    if (active.length >= 4) fail(400, '썸네일 후보는 4장까지 비교할 수 있어요.');
    if (active.some((r) => r.url === b.url)) fail(409, '이미 비교 중인 이미지예요.');
    // 비교를 처음 시작하면 지금 대표 포스터도 후보로 넣습니다.
    if (!active.length && d.image !== b.url)
      await db.run('INSERT INTO drama_thumbnails (id,drama_id,url,created_at) VALUES (?,?,?,?)', [randomUUID(), d.id, d.image, now()]);
    await db.run('INSERT INTO drama_thumbnails (id,drama_id,url,created_at) VALUES (?,?,?,?)', [randomUUID(), d.id, b.url, now()]);
    res.status(201).json({ ok: true });
  });
  // 비교 끝내기: 고른 이미지를 대표 포스터로(고르지 않으면 지금까지 클릭률이 가장 높은 이미지)
  app.post('/api/studio/dramas/:id/thumbnails/finish', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ id: z.string().max(80).optional() }).parse(req.body || {});
    const d = await owned(req);
    const list = await db.all('SELECT * FROM drama_thumbnails WHERE drama_id=? AND active=1', [d.id]);
    if (!list.length) fail(409, '진행 중인 썸네일 비교가 없어요.');
    const rate = (r) => Number(r.clicks) / Math.max(1, Number(r.impressions));
    const winner = b.id ? list.find((r) => r.id === b.id) : [...list].sort((x, y) => rate(y) - rate(x))[0];
    if (!winner) fail(404, '후보를 찾을 수 없어요.');
    await db.transaction(async () => {
      await db.run('UPDATE drama_thumbnails SET active=0, winner=CASE WHEN id=? THEN 1 ELSE 0 END WHERE drama_id=? AND active=1', [winner.id, d.id]);
      await db.run('UPDATE dramas SET image=? WHERE id=?', [winner.url, d.id]);
    });
    res.json({ ok: true, url: winner.url });
  });
  const abTimer = setInterval(() => void settleThumbs(db).catch((e) => console.error('thumbs', e.message)), 10 * 60 * 1000);
  abTimer.unref();
  app.locals.settleThumbs = () => settleThumbs(db);
}
