import { randomUUID } from 'node:crypto';

// 인앱 알림: 빠른 제작 완료·멈춤, 합성 완료·실패, 회차 검수 결과 등을 회원에게 남깁니다.
// 같은 링크의 읽지 않은 알림이 1분 안에 또 생기면 새로 쌓지 않고 내용만 바꿉니다(알림 폭주 방지).
export async function notify(db, userId, { kind, title, body = '', link = '' }) {
  if (!userId) return;
  try {
    const recent = await db.get(
      'SELECT id FROM notifications WHERE user_id=? AND kind=? AND link=? AND read_at IS NULL AND created_at>=? ORDER BY created_at DESC LIMIT 1',
      [userId, kind, link, new Date(Date.now() - 60000).toISOString()],
    );
    if (recent) await db.run('UPDATE notifications SET title=?,body=?,created_at=? WHERE id=?', [title, body, new Date().toISOString(), recent.id]);
    else
      await db.run('INSERT INTO notifications (id,user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?,?)', [
        randomUUID(),
        userId,
        kind,
        title.slice(0, 120),
        body.slice(0, 500),
        link.slice(0, 200),
        new Date().toISOString(),
      ]);
  } catch (e) {
    console.error('notify', e.message);
  }
}
