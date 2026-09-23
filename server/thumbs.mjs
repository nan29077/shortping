import { createHash } from 'node:crypto';
import { notify } from './notify.mjs';

// 썸네일 A/B 비교: 한 작품에 후보 이미지가 2장 이상 있으면 시청자마다(같은 사람은 늘 같은 후보) 나눠 보여 주고,
// 목록에 보인 횟수(노출)와 눌러 들어온 횟수(클릭)를 셉니다. 후보마다 노출이 충분히 쌓이면 클릭률이 가장 높은
// 이미지를 대표 포스터로 바꾸고 비교를 끝냅니다.
export const AB_MIN_IMPRESSIONS = Number(process.env.AB_MIN_IMPRESSIONS || 300);
const bucket = (key, n) => parseInt(createHash('md5').update(String(key)).digest('hex').slice(0, 8), 16) % n;

export async function applyThumbs(db, dramas, viewerKey) {
  if (!dramas.length) return dramas;
  const ids = dramas.map((d) => d.id);
  const rows = await db.all(`SELECT id,drama_id,url FROM drama_thumbnails WHERE active=1 AND drama_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, ids);
  if (!rows.length) return dramas;
  const byDrama = new Map();
  for (const r of rows) byDrama.set(r.drama_id, [...(byDrama.get(r.drama_id) || []), r]);
  const shown = [];
  const out = dramas.map((d) => {
    const list = byDrama.get(d.id);
    if (!list || list.length < 2) return d;
    const pick = list[bucket(`${viewerKey}:${d.id}`, list.length)];
    shown.push(pick.id);
    return { ...d, image: pick.url, thumb_id: pick.id };
  });
  // 노출 수는 한 번에 올립니다(실패해도 목록 응답에는 영향 없음).
  if (shown.length)
    await db.run(`UPDATE drama_thumbnails SET impressions=impressions+1 WHERE id IN (${shown.map(() => '?').join(',')})`, shown).catch(() => {});
  return out;
}
export async function thumbClick(db, dramaId, thumbId) {
  if (!thumbId || !/^[a-f0-9-]{36}$/.test(thumbId)) return;
  await db.run('UPDATE drama_thumbnails SET clicks=clicks+1 WHERE id=? AND drama_id=? AND active=1', [thumbId, dramaId]).catch(() => {});
}
// 비교가 끝날 만큼 노출이 쌓였는지 보고, 끝났으면 가장 잘 눌린 이미지를 대표 포스터로 바꿉니다.
export async function settleThumbs(db) {
  const rows = await db.all('SELECT * FROM drama_thumbnails WHERE active=1 ORDER BY drama_id');
  const byDrama = new Map();
  for (const r of rows) byDrama.set(r.drama_id, [...(byDrama.get(r.drama_id) || []), r]);
  let settled = 0;
  for (const [dramaId, list] of byDrama) {
    if (list.length < 2 || list.some((r) => Number(r.impressions) < AB_MIN_IMPRESSIONS)) continue;
    const rate = (r) => Number(r.clicks) / Math.max(1, Number(r.impressions));
    const winner = [...list].sort((a, b) => rate(b) - rate(a))[0];
    await db.transaction(async () => {
      await db.run('UPDATE drama_thumbnails SET active=0, winner=CASE WHEN id=? THEN 1 ELSE 0 END WHERE drama_id=? AND active=1', [winner.id, dramaId]);
      await db.run('UPDATE dramas SET image=? WHERE id=?', [winner.url, dramaId]);
    });
    const d = await db.get('SELECT title,owner_id FROM dramas WHERE id=?', [dramaId]);
    if (d)
      await notify(db, d.owner_id, {
        kind: 'thumb_ab',
        title: `${d.title} 썸네일 비교가 끝났어요`,
        body: `클릭률 ${(rate(winner) * 100).toFixed(1)}%로 가장 잘 눌린 이미지를 대표 포스터로 바꿨어요.`,
        link: 'studio/contents',
      });
    settled++;
  }
  return settled;
}
