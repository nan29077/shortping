// 2026-11-05 전체 점검 수정 검증:
// 탈퇴 · 제한 PD의 심사 대기 작품 공개 차단과 탈퇴 시 내림 · 방송국 재공개 차단
// · 정산 건이 아주 많은 PD의 출금 · 파일 사용 여부 확인 SQL(정리 목록과 같은 기준) · 썸네일 후보 동시 추가
// SQLite(기본)와 PostgreSQL(TEST_PG_ADMIN_URL 지정) 모두에서 같은 결과가 나와야 합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';
import { GENRES } from '../server/genres.mjs';
import { MEDIA_IN_USE_SQL } from '../server/media-refs.mjs';

const port = 5361,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb,
  admin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
async function newUser(tag, role = 'viewer') {
  const email = `${tag}-${runId}@audit1105.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'Audit1105!pw', name: '점검 ' + tag } });
  assert.ok([200, 201].includes(reg.status), JSON.stringify(reg.data));
  if (role !== 'viewer') await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role, status: 'active', name: '점검 ' + tag, phone: '' } });
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'Audit1105!pw' } })).cookie;
  return { id: reg.data.user.id, email, cookie };
}
async function newDrama(owner, title) {
  const r = await request('/studio/dramas', {
    method: 'POST',
    cookie: owner.cookie,
    body: { title, tagline: '점검용 작품', synopsis: '11월 점검 수정이 잘 동작하는지 확인하는 작품이에요.', genre: GENRES[0], free_episodes: 1, image: '/images/hero.webp', rights_confirmed: true },
  });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  return r.data.id;
}

before(async () => {
  testDb = await prepareTestDb(runId, dataDir);
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: testDb.url, PORT: String(port), APP_ORIGIN: base, ENABLE_DEMO: 'true', DATA_DIR: dataDir, UPLOAD_DIR: path.join(dataDir, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {}
    if (Date.now() - start > 30000) throw new Error(output);
    await sleep(200);
  }
  admin = await login('admin');
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

const PASSWORD = 'Audit1105!pw';

test('탈퇴 · 이용 제한된 PD의 심사 대기 작품은 공개할 수 없고, 탈퇴하면 대기 작품도 내려간다', async () => {
  const pd = await newUser('susp', 'pd');
  const id = await newDrama(pd, '제한 PD 작품 ' + runId.slice(0, 6));
  await testDb.run("UPDATE dramas SET status='pending' WHERE id=?", [id]);
  await testDb.run("UPDATE users SET status='suspended' WHERE id=?", [pd.id]);
  const r = await request(`/admin/dramas/${id}/review`, { method: 'POST', cookie: admin, body: { status: 'published', note: '' } });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /탈퇴 · 이용 제한/);
  assert.equal((await testDb.all('SELECT status FROM dramas WHERE id=?', [id]))[0].status, 'pending');
  // 반려는 그대로 할 수 있어요.
  assert.equal((await request(`/admin/dramas/${id}/review`, { method: 'POST', cookie: admin, body: { status: 'rejected', note: '계정 제한' } })).status, 200);

  const leaving = await newUser('leave', 'pd');
  const pending = await newDrama(leaving, '탈퇴 PD 작품 ' + runId.slice(0, 6));
  await testDb.run("UPDATE dramas SET status='pending' WHERE id=?", [pending]);
  const w = await request('/account/withdraw', { method: 'POST', cookie: leaving.cookie, body: { password: PASSWORD, confirm: true } });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal((await testDb.all('SELECT status FROM dramas WHERE id=?', [pending]))[0].status, 'hidden');
  const [profile] = await testDb.all('SELECT avatar FROM user_profiles WHERE user_id=?', [leaving.id]);
  assert.ok(!profile || profile.avatar.startsWith('/avatars/'), '탈퇴 회원의 프로필 사진은 기본 아바타로 바뀌어야 해요');
});

test('탈퇴 · 이용 제한 회원의 방송국은 다시 공개하거나 추천할 수 없다', async () => {
  const pd = await newUser('chan', 'pd');
  const channelId = randomUUID();
  await testDb.run("INSERT INTO channels (id,owner_id,name,slug,status,created_at) VALUES (?,?,?,?,'hidden',?)", [channelId, pd.id, '제한 방송국', 'audit-' + runId.slice(0, 8), new Date().toISOString()]);
  await testDb.run("UPDATE users SET status='suspended' WHERE id=?", [pd.id]);
  assert.equal((await request('/admin/channels/' + channelId, { method: 'PATCH', cookie: admin, body: { status: 'active', featured: false } })).status, 409);
  assert.equal((await request('/admin/channels/' + channelId, { method: 'PATCH', cookie: admin, body: { status: 'hidden', featured: true } })).status, 409);
  // 숨김 유지는 할 수 있어요.
  assert.equal((await request('/admin/channels/' + channelId, { method: 'PATCH', cookie: admin, body: { status: 'hidden', featured: false } })).status, 200);
  // 이미 추천돼 있던 방송국을 그대로 저장하는 것(새로 켜지 않음)은 막지 않아요.
  await testDb.run('UPDATE channels SET featured=1 WHERE id=?', [channelId]);
  assert.equal((await request('/admin/channels/' + channelId, { method: 'PATCH', cookie: admin, body: { status: 'hidden', featured: true } })).status, 200);
  await testDb.run('UPDATE channels SET featured=0 WHERE id=?', [channelId]);
  await testDb.run("UPDATE users SET status='active' WHERE id=?", [pd.id]);
  assert.equal((await request('/admin/channels/' + channelId, { method: 'PATCH', cookie: admin, body: { status: 'active', featured: false } })).status, 200);
});

test('정산 건이 DB 변수 한도보다 많아도 출금 신청이 한 번에 처리된다', async () => {
  const pd = await newUser('many', 'pd');
  const put = await request('/studio/tax', {
    method: 'PUT',
    cookie: pd.cookie,
    body: { business_type: 'individual', bank_name: '국민은행', account_number: '110-555-000001', account_holder: '점검 PD' },
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const stamp = new Date(Date.now() - 30 * 86400000).toISOString();
  const total = 34000; // SQLite 변수 한도(32,766)를 넘는 건수
  for (let i = 0; i < total; i += 1000) {
    const n = Math.min(1000, total - i);
    const rows = Array.from({ length: n }, () => "(?,?,NULL,NULL,'ping',?,1,0,0,1,30,'available',?,?)").join(',');
    const params = [];
    for (let k = 0; k < n; k++) params.push(randomUUID(), pd.id, stamp.slice(0, 7), stamp, stamp);
    await testDb.run(
      'INSERT INTO settlement_entries (id,pd_id,order_id,drama_id,kind,period,gross,platform_fee,pg_fee,net,fee_rate,status,confirm_at,created_at) VALUES ' + rows,
      params,
    );
  }
  const payout = await request('/studio/payouts', { method: 'POST', cookie: pd.cookie, body: {} });
  assert.equal(payout.status, 201, JSON.stringify(payout.data));
  assert.equal(Number(payout.data.amount), total);
  const [left] = await testDb.all("SELECT COUNT(*) AS n FROM settlement_entries WHERE pd_id=? AND status='available'", [pd.id]);
  assert.equal(Number(left.n), 0);
  const [moved] = await testDb.all('SELECT COUNT(*) AS n FROM settlement_entries WHERE payout_id=?', [payout.data.id]);
  assert.equal(Number(moved.n), total);
});

test('파일 사용 여부 확인 SQL은 정리 목록 전체를 보고 SQLite · PostgreSQL 모두에서 동작한다', async () => {
  const url = '/uploads/' + randomUUID() + '.jpg';
  assert.equal((await testDb.all(MEDIA_IN_USE_SQL, [url])).length, 0);
  // 프로필 사진 교체가 예전에는 보지 않던 자리(메인페이지 배경 기록)에 쓰인 파일도 '사용 중'으로 봐요.
  await testDb.run('INSERT INTO home_history (id,kind,actor_id,data,created_at) VALUES (?,?,?,?,?)', [randomUUID(), 'style', 'demo-admin', JSON.stringify({ background: url }), new Date().toISOString()]);
  assert.equal((await testDb.all(MEDIA_IN_USE_SQL, [url])).length, 1);
});

test('썸네일 후보를 동시에 두 번 추가해도 대표 포스터가 한 번만 들어간다', async () => {
  const pd = await newUser('thumb', 'pd');
  const id = await newDrama(pd, '썸네일 작품 ' + runId.slice(0, 6));
  const add = () => request(`/studio/dramas/${id}/thumbnails`, { method: 'POST', cookie: pd.cookie, body: { url: '/images/channel-noir.webp' } });
  const results = await Promise.all([add(), add()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], JSON.stringify(results.map((r) => r.data)));
  const rows = await testDb.all('SELECT url FROM drama_thumbnails WHERE drama_id=? AND active=1', [id]);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.equal(new Set(rows.map((r) => r.url)).size, 2);
});

test('AI 작업이 진행 중인 회차는 회차 수를 줄여도 지워지지 않는다', async () => {
  const pd = await newUser('eps', 'pd');
  await request('/studio/ai/terms', { method: 'POST', cookie: pd.cookie, body: { agree: true, version: '2026-09' } });
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: pd.cookie, body: { title: '회차 줄이기', logline: '비 오는 밤 오래된 약속이 두 사람을 다시 부른다', genre: '로맨스', episode_count: 2, episode_seconds: 20 } });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.data));
  const pid = created.data.id;
  const detail = await request('/studio/ai/projects/' + pid, { cookie: pd.cookie });
  const second = detail.data.episodes.find((e) => e.number === 2);
  // 처리기가 집어 가지 않도록 다음 확인 시각을 먼 미래로 둔 대기 작업
  const jobId = randomUUID();
  await testDb.run(
    "INSERT INTO ai_jobs (id,user_id,project_id,target_type,target_id,kind,capability,status,next_poll_at,created_at) VALUES (?,?,?,'episode',?,'script','text','queued',?,?)",
    [jobId, pd.id, pid, second.id, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString()],
  );
  const shrink = await request('/studio/ai/projects/' + pid, { method: 'PATCH', cookie: pd.cookie, body: { episode_count: 1 } });
  assert.equal(shrink.status, 409, JSON.stringify(shrink.data));
  assert.match(shrink.data.error, /AI 작업이 끝난 뒤/);
  assert.equal((await testDb.all('SELECT id FROM studio_episodes WHERE id=?', [second.id])).length, 1);
  await testDb.run("UPDATE ai_jobs SET status='failed' WHERE id=?", [jobId]);
  assert.equal((await request('/studio/ai/projects/' + pid, { method: 'PATCH', cookie: pd.cookie, body: { episode_count: 1 } })).status, 200);
  assert.equal((await testDb.all('SELECT id FROM studio_episodes WHERE id=?', [second.id])).length, 0);
});
