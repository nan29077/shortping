// 2026-10-01 저녁 재점검 수정 검증:
// 예전 관리자 API의 탈퇴 계정 복구 차단 · 탈퇴 PD 작품 재공개 차단 · 분할 업로드 취소/한도 · 세무 확인 유지
// · 탈퇴 회원 지급 차단 · 회원 이름 변경 운영 기록 · 운영 기록 더 보기 · 품질 시험 기본 문제 한 번만
// · 숨김 작품 찜 해제 · 심사 중 대표 포스터 · SRT 태그 · 자막 404 순서 · 이미지 20MB · 승인 알림 문구
// · 빈 달 마감 목록 · 정산 원장 전체 받기 · 오류 문구 · 결과 파일 받기(인증 머리글 출처 제한)
// SQLite(기본)와 PostgreSQL(TEST_PG_ADMIN_URL 지정) 모두에서 같은 결과가 나와야 합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';
import { GENRES } from '../server/genres.mjs';
import { zodMessage } from '../server/errors.mjs';
import { toVtt } from '../server/routes-upload.mjs';
import { kstShort } from '../server/routes-serial.mjs';
import { download } from '../server/ai/http.mjs';

const port = 5341,
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
  const email = `${tag}-${runId}@recheck.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'Recheck!2026', name: '재점검 ' + tag } });
  assert.ok([200, 201].includes(reg.status), JSON.stringify(reg.data));
  if (role !== 'viewer') await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role, status: 'active', name: '재점검 ' + tag, phone: '' } });
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'Recheck!2026' } })).cookie;
  return { id: reg.data.user.id, email, cookie };
}
async function newDrama(owner, title) {
  const r = await request('/studio/dramas', {
    method: 'POST',
    cookie: owner.cookie,
    body: { title, tagline: '재점검용 작품', synopsis: '재점검 수정이 잘 동작하는지 확인하는 작품이에요.', genre: GENRES[0], free_episodes: 1, image: '/images/hero.webp', rights_confirmed: true },
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

test('탈퇴한 계정은 예전 관리자 API로도 되살릴 수 없고, 핑 · 라마를 지급할 수 없다', async () => {
  const v = await newUser('gone');
  await testDb.run("UPDATE users SET status='withdrawn' WHERE id=?", [v.id]);
  const r = await request('/admin/users/' + v.id, { method: 'PATCH', cookie: admin, body: { role: 'viewer', status: 'active' } });
  assert.equal(r.status, 400);
  assert.equal((await testDb.all('SELECT status FROM users WHERE id=?', [v.id]))[0].status, 'withdrawn');
  assert.equal((await request('/admin/pings/adjust', { method: 'POST', cookie: admin, body: { userId: v.id, action: 'grant', pings: 10, memo: '지급 시험' } })).status, 400);
  assert.equal((await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: v.id, action: 'grant', lama: 10, memo: '지급 시험' } })).status, 400);
  // 탈퇴하지 않은 회원에게는 그대로 지급돼요.
  const ok = await newUser('alive');
  assert.equal((await request('/admin/pings/adjust', { method: 'POST', cookie: admin, body: { userId: ok.id, action: 'grant', pings: 10, memo: '지급 시험' } })).status, 200);
});

test('회원 이름 · 연락처 변경은 운영 기록에 남고, 운영 기록은 이어서 더 받을 수 있다', async () => {
  const v = await newUser('rename');
  const r = await request('/admin/members/' + v.id, { method: 'PATCH', cookie: admin, body: { role: 'viewer', status: 'active', name: '새 이름', phone: '010-1234-5678' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const logs = await testDb.all('SELECT action FROM audit_logs WHERE target_id=? ORDER BY created_at DESC', [v.id]);
  assert.equal(logs[0].action, 'user:viewer:active:name+phone');
  await request('/admin/members/' + v.id + '/notes', { method: 'POST', cookie: admin, body: { note: '메모 시험' } });
  assert.ok((await testDb.all("SELECT 1 AS x FROM audit_logs WHERE action='user:note-added' AND target_id=?", [v.id])).length);
  const first = await request('/admin/audit', { cookie: admin });
  assert.equal(first.status, 200);
  assert.ok(first.data.logs.length > 0);
  const tail = first.data.logs.at(-1);
  const last = tail.created_at;
  const older = await request('/admin/audit?before=' + encodeURIComponent(last) + '&beforeId=' + encodeURIComponent(tail.id), { cookie: admin });
  assert.ok(older.data.logs.every((l) => l.created_at < last || (l.created_at === last && l.id < tail.id)));
  // 같은 순간에 남은 기록도 빠지거나 겹치지 않아요.
  const stamp = new Date().toISOString();
  const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
  for (const id of ids) await testDb.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [id, 'demo-admin', 'test:tie', v.id, stamp]);
  const page = await request('/admin/audit?before=' + encodeURIComponent(stamp) + '&beforeId=' + ids[2], { cookie: admin });
  assert.deepEqual(page.data.logs.filter((l) => l.action === 'test:tie').map((l) => l.id), [ids[1], ids[0]]);
  assert.equal((await request('/admin/audit', { cookie: v.cookie })).status, 403);
});

test('탈퇴 · 이용 제한된 PD의 숨김 작품은 다시 공개할 수 없다', async () => {
  const p = await newUser('owner', 'pd');
  const id = await newDrama(p, '재공개 차단 시험');
  await testDb.run("UPDATE dramas SET status='hidden' WHERE id=?", [id]);
  await testDb.run("UPDATE users SET status='suspended' WHERE id=?", [p.id]);
  const body = { free: false, episode_pings: 3, free_episodes: 1, badge: 'NEW', status: 'published' };
  assert.equal((await request(`/admin/dramas/${id}/pricing`, { method: 'PATCH', cookie: admin, body })).status, 409);
  // 숨김 상태로 판매 설정만 바꾸는 건 돼요.
  assert.equal((await request(`/admin/dramas/${id}/pricing`, { method: 'PATCH', cookie: admin, body: { ...body, status: 'hidden' } })).status, 200);
  await testDb.run("UPDATE users SET status='active' WHERE id=?", [p.id]);
  assert.equal((await request(`/admin/dramas/${id}/pricing`, { method: 'PATCH', cookie: admin, body })).status, 200);
});

test('분할 업로드: 한도에 닿으면 upload_limit 코드로 알리고, 취소하면 자리가 난다', async () => {
  const p = await newUser('uploader', 'pd');
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await request('/studio/uploads', { method: 'POST', cookie: p.cookie, body: { size: 1000, mime: 'video/mp4', filename: `${i}.mp4` } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ids.push(r.data.id);
  }
  const blocked = await request('/studio/uploads', { method: 'POST', cookie: p.cookie, body: { size: 1000, mime: 'video/mp4' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, 'upload_limit');
  assert.equal((await request('/studio/uploads/' + ids[0], { method: 'DELETE', cookie: p.cookie })).status, 200);
  assert.equal((await request('/studio/uploads', { method: 'POST', cookie: p.cookie, body: { size: 1000, mime: 'video/mp4' } })).status, 201);
});

test('세무 정보: 연락처만 고치면 관리자 확인이 유지되고, 상호를 바꾸면 다시 확인받는다', async () => {
  const p = await newUser('tax', 'pd');
  const profile = { business_type: 'business', business_no: '123-45-67890', business_name: '재점검상회', rep_name: '김재점', bank_name: '국민은행', account_number: '123-456-7890', account_holder: '김재점', contact: '010-0000-0000' };
  assert.equal((await request('/studio/tax', { method: 'PUT', cookie: p.cookie, body: profile })).status, 200);
  assert.equal((await request('/admin/tax/' + p.id, { method: 'PATCH', cookie: admin, body: { business_type: 'business', verified: true } })).status, 200);
  const verified = async () => Number((await testDb.all('SELECT verified FROM pd_tax_profiles WHERE user_id=?', [p.id]))[0].verified);
  assert.equal(await verified(), 1);
  assert.equal((await request('/studio/tax', { method: 'PUT', cookie: p.cookie, body: { ...profile, contact: '010-1111-2222', address: '서울' } })).status, 200);
  assert.equal(await verified(), 1, '연락처 · 주소만 바꾸면 확인 유지');
  assert.equal((await request('/studio/tax', { method: 'PUT', cookie: p.cookie, body: { ...profile, account_number: '1234567890' } })).status, 200);
  assert.equal(await verified(), 1, '하이픈만 다른 같은 계좌번호는 유지');
  assert.equal((await request('/studio/tax', { method: 'PUT', cookie: p.cookie, body: { ...profile, business_name: '새상호' } })).status, 200);
  assert.equal(await verified(), 0, '상호가 바뀌면 다시 확인');
});

test('숨김 작품도 찜 해제는 되고, 새로 찜하기는 안 된다', async () => {
  const p = await newUser('favowner', 'pd');
  const id = await newDrama(p, '찜 해제 시험');
  await testDb.run("UPDATE dramas SET status='published' WHERE id=?", [id]);
  const v = await newUser('fan');
  assert.equal((await request('/favorites/' + id, { method: 'POST', cookie: v.cookie, body: { active: true } })).status, 200);
  await testDb.run("UPDATE dramas SET status='hidden' WHERE id=?", [id]);
  assert.equal((await request('/favorites/' + id, { method: 'POST', cookie: v.cookie, body: { active: false } })).status, 200);
  assert.equal((await testDb.all('SELECT 1 AS x FROM favorites WHERE user_id=? AND drama_id=?', [v.id, id])).length, 0);
  assert.equal((await request('/favorites/' + id, { method: 'POST', cookie: v.cookie, body: { active: true } })).status, 404);
});

test('심사 중인 작품의 대표 포스터는 PD가 바꿀 수 없다', async () => {
  const p = await newUser('poster', 'pd');
  const id = await newDrama(p, '포스터 시험');
  await testDb.run("UPDATE dramas SET status='pending' WHERE id=?", [id]);
  for (const url of ['/images/hero.webp', '/images/channel-neon.webp'])
    await testDb.run('INSERT INTO drama_thumbnails (id,drama_id,url,reviewed,created_at) VALUES (?,?,?,?,?)', [randomUUID(), id, url, 1, new Date().toISOString()]);
  const r = await request(`/studio/dramas/${id}/thumbnails/finish`, { method: 'POST', cookie: p.cookie, body: {} });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /심사 중/);
  assert.equal((await testDb.all('SELECT image FROM dramas WHERE id=?', [id]))[0].image, '/images/hero.webp');
});

test('자막: SRT 위치 태그를 지우고, 없는 회차는 404를 먼저 알린다', async () => {
  const p = await newUser('subs', 'pd');
  const id = await newDrama(p, '자막 시험');
  assert.equal((await request(`/studio/dramas/${id}/episodes`, { method: 'POST', cookie: p.cookie, body: { number: 1, title: '1화', duration: 12, video: '/demo/preview.mp4' } })).status, 200);
  const srt = '1\n00:00:01,000 --> 00:00:02,500\n{\\an8}<i>위에 뜨는 자막</i>\n\n2\n00:00:03,000 --> 00:00:04,000\n두 번째 {중괄호 메모} 줄\n';
  const r = await request(`/studio/dramas/${id}/episodes/1/subtitles`, { method: 'POST', cookie: p.cookie, body: { text: srt } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const vtt = await (await fetch(`${base}/api/subtitles/${id}/1`, { headers: { cookie: p.cookie } })).text();
  assert.ok(vtt.includes('위에 뜨는 자막'), vtt);
  assert.ok(!vtt.includes('an8') && !vtt.includes('{') && !vtt.includes('<i>'), vtt);
  assert.equal((await request(`/studio/dramas/${id}/episodes/99/subtitles`, { method: 'POST', cookie: p.cookie, body: { text: srt } })).status, 404);
  assert.equal((await request(`/studio/dramas/${id}/episodes/99/subtitles`, { method: 'DELETE', cookie: p.cookie })).status, 404);
  // 한글 20만 자 가까운 자막도 본문 한도(전역 256KB)에 막히지 않아요.
  const long = Array.from({ length: 1600 }, (_, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, '0')},000 --> 00:00:${String(i % 60).padStart(2, '0')},900\n${'가나다라마바사아자차'.repeat(7)}\n`).join('\n');
  assert.ok(Buffer.byteLength(JSON.stringify({ text: long })) > 300 * 1024 && long.length < 200000);
  assert.equal((await request(`/studio/dramas/${id}/episodes/1/subtitles`, { method: 'POST', cookie: p.cookie, body: { text: long } })).status, 200);
});

test('이미지 업로드는 20MB까지만 받는다(영상은 따로 500MB)', async () => {
  const p = await newUser('bigimg', 'pd');
  const png = Buffer.alloc(21 * 1024 * 1024);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'big.png');
  const r = await fetch(base + '/api/studio/upload', { method: 'POST', headers: { cookie: p.cookie }, body: form });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /20MB/);
});

test('예약 승인 알림은 자연스러운 한국어와 한국 시간으로 나간다', async () => {
  const p = await newUser('notice', 'pd');
  const id = await newDrama(p, '알림 문구 시험');
  await testDb.run("UPDATE dramas SET status='published' WHERE id=?", [id]);
  assert.equal((await request(`/studio/dramas/${id}/episodes`, { method: 'POST', cookie: p.cookie, body: { number: 1, title: '1화', duration: 12, video: '/demo/preview.mp4' } })).status, 200);
  const at = new Date(Date.now() + 3 * 3600_000).toISOString();
  assert.equal((await request(`/studio/dramas/${id}/episodes/1/submit`, { method: 'POST', cookie: p.cookie, body: { publish_at: at } })).status, 200);
  const ep = (await request('/admin/episodes/review', { cookie: admin })).data.find((e) => e.drama_id === id && e.number === 1);
  assert.equal((await request('/admin/episodes/' + ep.id + '/review', { method: 'POST', cookie: admin, body: { status: 'approved' } })).data.status, 'scheduled');
  const n = (await request('/notifications', { cookie: p.cookie })).data.list.find((x) => x.kind === 'episode_review');
  assert.equal(n.title, `알림 문구 시험 1화가 승인됐어요 · ${kstShort(at)} 공개 예정`);
  assert.match(n.title, /(오전|오후) \d{1,2}:\d{2} 공개 예정$/);
  assert.ok(!/PM|AM|이 승인/.test(n.title));
  assert.match(n.body, /예약한 시각/);
});

test('배분이 없던 달도 마감하면 마감 목록에 나오고, 정산 원장은 전체를 받을 수 있다', async () => {
  const r = await request('/admin/settlements/close', { method: 'POST', cookie: admin, body: { period: '2019-01' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const overview = (await request('/admin/settlements', { cookie: admin })).data;
  assert.ok(overview.closed.some((c) => c.period === '2019-01'));
  assert.equal(typeof overview.entry_count, 'number');
  const all = await request('/admin/settlements/entries', { cookie: admin });
  assert.equal(all.status, 200);
  assert.equal(all.data.length, overview.entry_count);
});

test('AI 품질 시험 기본 문제는 처음 한 번만 만들어진다(다 지워도 다시 생기지 않음)', async () => {
  const first = (await request('/admin/ai/bench', { cookie: admin })).data.benchmarks;
  assert.ok(first.length > 0);
  for (const b of first) assert.equal((await request('/admin/ai/bench/' + b.id, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await request('/admin/ai/bench', { cookie: admin })).data.benchmarks.length, 0);
});

test('오류 문구 · 자막 변환 · 알림 시각 도우미', () => {
  assert.equal(zodMessage({ code: 'invalid_type', message: 'Invalid input: expected number, received string', path: ['unknown_field'] }), '입력한 값을 확인해 주세요.');
  assert.equal(zodMessage({ code: 'too_big', origin: 'number', maximum: 10, message: 'Too big', path: ['progress'] }), '시청 위치는 10 이하여야 해요.');
  assert.ok(!/progress|값 값/.test(zodMessage({ code: 'too_small', origin: 'number', minimum: 0, message: 'x', path: ['progress'] })));
  assert.equal(toVtt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}안녕\n'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n안녕\n');
  assert.equal(kstShort('2026-10-01T12:16:00Z'), '10월 1일 오후 9:16');
  assert.equal(kstShort('2026-09-30T15:05:00Z'), '10월 1일 오전 12:05');
});

test('결과 파일 받기: 공급사 주소(base_url)와 같은 출처만 허용하고, 다른 출처로는 API 키를 보내지 않는다', async () => {
  const seen = [];
  const other = createServer((req, res) => {
    seen.push({ who: 'other', key: req.headers['x-goog-api-key'] || '' });
    res.end('OTHER');
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherBase = `http://127.0.0.1:${other.address().port}`;
  const vendor = createServer((req, res) => {
    seen.push({ who: 'vendor', path: req.url, key: req.headers['x-goog-api-key'] || '' });
    if (req.url === '/hop') return res.writeHead(302, { location: '/file' }).end();
    if (req.url === '/away') return res.writeHead(302, { location: otherBase + '/file' }).end();
    res.end('VENDOR');
  });
  await new Promise((r) => vendor.listen(0, '127.0.0.1', r));
  const vendorBase = `http://127.0.0.1:${vendor.address().port}`;
  try {
    const headers = { 'x-goog-api-key': 'secret-key' };
    // 기본(신뢰 출처 없음): 내부 주소는 막아요(SSRF 방지).
    await assert.rejects(download(vendorBase + '/file', headers), /안전하지 않은/);
    // base_url과 같은 출처는 받아요. 같은 출처 안의 리다이렉트에도 키를 붙여요.
    assert.equal((await download(vendorBase + '/hop', headers, { trustedOrigin: vendorBase })).toString(), 'VENDOR');
    assert.deepEqual(seen.filter((s) => s.who === 'vendor').map((s) => s.key), ['secret-key', 'secret-key']);
    // 다른 출처로 넘어가면(여기서는 내부 주소라) 막히고, 그쪽으로 키가 새지 않아요.
    await assert.rejects(download(vendorBase + '/away', headers, { trustedOrigin: vendorBase }), /안전하지 않은/);
    assert.equal(seen.filter((s) => s.who === 'other').length, 0);
    // 허용 출처 목록에 없는 곳으로는 키를 붙이지 않아요.
    seen.length = 0;
    assert.equal((await download(otherBase + '/file', headers, { trustedOrigin: otherBase, authOrigins: [vendorBase] })).toString(), 'OTHER');
    assert.equal(seen[0].key, '');
  } finally {
    vendor.close();
    other.close();
  }
});
