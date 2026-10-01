// 2026-10-01 전체 점검 수정 검증:
// 핑 전체 열기 범위(이후 연재 회차는 잠김) · AI 대본 다시 쓰기와 컷 작업 겹침 방지 · 떨어진 컷 구간 다시 쓰기
// · 컷 삭제(진행 중 작업 차단 · 버전 남김) · 내보낸 팀원의 옛 초대 링크 재가입 차단.
// SQLite(기본)와 PostgreSQL(TEST_PG_ADMIN_URL 지정) 모두에서 같은 결과가 나와야 합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';

const port = 5321,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb,
  admin,
  pd;
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
  const email = `${tag}-${runId}@fixes.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'FixesTest!2026', name: '점검 ' + tag } });
  assert.ok([200, 201].includes(reg.status), JSON.stringify(reg.data));
  if (role !== 'viewer') await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role, status: 'active', name: '점검 ' + tag, phone: '' } });
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'FixesTest!2026' } })).cookie;
  if (role === 'pd') await request('/studio/ai/terms', { method: 'POST', cookie, body: { agree: true, version: '2026-09' } });
  return { id: reg.data.user.id, email, cookie };
}
const detail = async (id, cookie = pd) => (await request('/studio/ai/projects/' + id, { cookie })).data;
async function waitIdle(id, cookie = pd, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const d = await detail(id, cookie);
    if (d && !d.jobs.some((j) => ['queued', 'running'].includes(j.status))) return d;
    await sleep(150);
  }
  throw new Error('작업이 끝나지 않았어요\n' + output.slice(-2000));
}
const run = (id, body, cookie = pd) => request(`/studio/ai/projects/${id}/run`, { method: 'POST', cookie, body: { requested: 'auto', tier: 'standard', ...body } });
const SCRIPT = `1화
S#1. 카페 - 밤
(창밖으로 비가 내린다. 서윤이 젖은 우산을 접는다)
서윤: 늦었네. 편지는 가져왔어?
도현: (편지를 내밀며) 이걸로 끝내자.
S#2. 골목 - 밤
(비에 젖은 서윤이 편지를 펼친다)
서윤: 이게... 무슨 뜻이야!
S#3. 버스 정류장 - 밤
도현: 미안해.
서윤: 가지 마.`;

before(async () => {
  testDb = await prepareTestDb(runId, dataDir);
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    // 가짜 AI를 조금 늦게 끝나게 해서 '진행 중' 상태를 확인할 수 있게 합니다.
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: testDb.url, PORT: String(port), APP_ORIGIN: base, ENABLE_DEMO: 'true', DATA_DIR: dataDir, UPLOAD_DIR: path.join(dataDir, 'uploads'), AI_MOCK_DELAY_MS: '900' },
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
  pd = await login('pd');
  await request('/studio/ai/terms', { method: 'POST', cookie: pd, body: { agree: true, version: '2026-09' } });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'grant', lama: 20000, memo: '점검 테스트' } });
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('핑 전체 열기는 결제 당시 회차까지만 열고, 이후 연재 회차는 따로 열어야 한다', async () => {
  const v = await newUser('series');
  assert.equal((await request('/pings/charge', { method: 'POST', cookie: v.cookie, body: { productId: 'ping-10k', idempotencyKey: randomUUID() } })).status, 200);
  const before = (await request('/dramas/midnight', { cookie: v.cookie })).data;
  const last = Math.max(...before.episodes.map((e) => e.number));
  const all = await request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'midnight', all: true, idempotencyKey: randomUUID() } });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.equal(all.data.unlocked, before.locked_count);
  // 같은 키로 다시 보내도 같은 주문(회차 번호 없음)
  const lib = (await request('/library', { cookie: v.cookie })).data;
  assert.ok(lib.purchases.includes('midnight'), '소장 작품 목록에는 보임');
  assert.equal(lib.orders.find((o) => o.id === all.data.id).episode ?? null, null);
  // PD가 다음 회차를 올리고 승인된 상황
  const next = last + 1;
  await testDb.run('INSERT INTO episodes (id,drama_id,number,title,video,duration,review_status) VALUES (?,?,?,?,?,?,?)', [randomUUID(), 'midnight', next, `${next}화`, '/demo/preview.mp4', 12, 'approved']);
  const after = (await request('/dramas/midnight', { cookie: v.cookie })).data;
  assert.equal(after.entitled, false);
  assert.equal(after.locked_count, 1);
  assert.equal(after.episodes.find((e) => e.number === next).locked, true);
  assert.equal(after.episodes.find((e) => e.number === last).locked, false);
  assert.equal((await fetch(`${base}/api/play/midnight/${next}`, { headers: { cookie: v.cookie, Range: 'bytes=0-15' } })).status, 403);
  assert.equal((await fetch(`${base}/api/play/midnight/${last}`, { headers: { cookie: v.cookie, Range: 'bytes=0-15' } })).status, 206);
  // 새 회차만 다시 전체 열기(1편 가격)
  const more = await request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'midnight', all: true, idempotencyKey: randomUUID() } });
  assert.equal(more.status, 200, JSON.stringify(more.data));
  assert.equal(more.data.unlocked, 1);
  assert.equal(more.data.pings, after.episode_pings);
  assert.equal((await fetch(`${base}/api/play/midnight/${next}`, { headers: { cookie: v.cookie, Range: 'bytes=0-15' } })).status, 206);
});

test('AI 대본 다시 쓰기와 같은 회차 컷 작업은 겹치지 않고, 떨어진 컷 구간은 사이 컷까지 함께 다시 쓴다', async () => {
  const pid = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '겹침', logline: '비 오는 밤, 한 통의 편지가 두 사람을 갈라놓는다', genre: '로맨스', tone: '애틋함', episode_count: 1, episode_seconds: 30 } })).data.id;
  await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { script_text: SCRIPT } });
  assert.equal((await run(pid, { action: 'parse_script' })).status, 201);
  // 대본을 나누는 동안에는 컷 작업을 시작하지 않는다(나눈 뒤 컷이 바뀌므로)
  let d = await waitIdle(pid);
  const e = d.episodes[0];
  assert.ok(e.shots.length >= 3, '컷 3개 이상');
  const batch = await run(pid, { action: 'batch_shot_image', targetId: e.id, requested: 'mock-image' });
  assert.equal(batch.status, 201, JSON.stringify(batch.data));
  const blocked = await run(pid, { action: 'script', targetId: e.id, requested: 'mock-writer' });
  assert.equal(blocked.status, 409, '컷 이미지 작업 중 대본 다시 쓰기 막힘');
  // 진행 중 작업이 있는 컷은 지울 수 없다
  const busyShot = e.shots[0];
  assert.equal((await request(`/studio/ai/shots/${busyShot.id}`, { method: 'DELETE', cookie: pd })).status, 409);
  d = await waitIdle(pid);
  // 대본 다시 쓰기가 진행 중이면 컷 작업이 막힌다
  const script = await run(pid, { action: 'script', targetId: e.id, requested: 'mock-writer' });
  assert.equal(script.status, 201, JSON.stringify(script.data));
  const shotDuring = await run(pid, { action: 'shot_image', targetId: d.episodes[0].shots[1].id, requested: 'mock-image' });
  assert.equal(shotDuring.status, 409, '대본 다시 쓰는 중 컷 이미지 막힘');
  d = await waitIdle(pid);
  // 떨어진 컷(1·3번)을 고르면 사이 2번 컷까지 포함해 다시 쓴다
  const shots = d.episodes[0].shots;
  assert.ok(shots.length >= 3);
  const range = await run(pid, { action: 'rewrite_range', targetId: e.id, requested: 'mock-writer', instruction: '대사를 짧게', options: { shotIds: [shots[0].id, shots[2].id] } });
  assert.equal(range.status, 201, JSON.stringify(range.data));
  const [job] = await testDb.all("SELECT input FROM ai_jobs WHERE project_id=? AND kind='rewrite_range' ORDER BY created_at DESC LIMIT 1", [pid]);
  assert.deepEqual(JSON.parse(job.input).shotIds, [shots[0].id, shots[1].id, shots[2].id]);
  d = await waitIdle(pid);
  // 컷 삭제는 지우기 전 대본을 버전으로 남긴다
  const target = d.episodes[0].shots[0];
  const del = await request(`/studio/ai/shots/${target.id}`, { method: 'DELETE', cookie: pd });
  assert.equal(del.status, 200);
  const versions = (await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions`, { cookie: pd })).data;
  const saved = versions.find((x) => x.source === 'before_delete');
  assert.ok(saved, '컷 지우기 전 버전');
  assert.equal(saved.shots.length, d.episodes[0].shots.length);
  const restore = await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions/${saved.id}/restore`, { method: 'POST', cookie: pd });
  assert.equal(restore.status, 200, JSON.stringify(restore.data));
  assert.equal((await detail(pid)).episodes[0].shots.length, d.episodes[0].shots.length, '되돌리면 지운 컷이 돌아옴');
});

test('소유자가 내보낸 팀원은 예전 초대 링크로 다시 들어올 수 없고, 새 초대로는 들어올 수 있다', async () => {
  const pid = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '팀', logline: '여럿이 함께 만드는 비 오는 밤의 이야기', genre: '로맨스', tone: '애틋함', episode_count: 1, episode_seconds: 30 } })).data.id;
  const editor = await newUser('editor', 'pd');
  const link = (await request(`/studio/ai/projects/${pid}/invites`, { method: 'POST', cookie: pd, body: { link: true, role: 'editor', pay_mode: 'sponsor', sponsor_limit: 0, max_uses: 5 } })).data.link;
  assert.equal((await request(`/studio/ai/invites/${link.token}/accept`, { method: 'POST', cookie: editor.cookie })).status, 200);
  assert.equal((await request(`/studio/ai/projects/${pid}/members/${editor.id}`, { method: 'DELETE', cookie: pd })).status, 200);
  assert.equal((await request('/studio/ai/projects/' + pid, { cookie: editor.cookie })).status, 404);
  const again = await request(`/studio/ai/invites/${link.token}/accept`, { method: 'POST', cookie: editor.cookie });
  assert.equal(again.status, 409, '옛 링크 재가입 막힘');
  assert.equal((await request('/studio/ai/projects/' + pid, { cookie: editor.cookie })).status, 404);
  // 다른 사람은 같은 링크로 들어올 수 있다
  const other = await newUser('other', 'pd');
  assert.equal((await request(`/studio/ai/invites/${link.token}/accept`, { method: 'POST', cookie: other.cookie })).status, 200);
  // 소유자가 새로 초대하면 다시 들어올 수 있다
  await sleep(5);
  const fresh = (await request(`/studio/ai/projects/${pid}/invites`, { method: 'POST', cookie: pd, body: { link: true, role: 'writer' } })).data.link;
  assert.equal((await request(`/studio/ai/invites/${fresh.token}/accept`, { method: 'POST', cookie: editor.cookie })).status, 200);
  assert.equal((await request('/studio/ai/projects/' + pid, { cookie: editor.cookie })).status, 200);
});

test('같은 요청 키를 다른 회차·종류에 다시 쓰면 예전 주문을 돌려주지 않고 409', async () => {
  const v = await newUser('idem');
  const key = randomUUID();
  assert.equal((await request('/pings/charge', { method: 'POST', cookie: v.cookie, body: { productId: 'ping-10k', idempotencyKey: key } })).status, 200);
  // 충전에 쓴 키로 구독
  assert.equal((await request('/checkout', { method: 'POST', cookie: v.cookie, body: { kind: 'subscription', idempotencyKey: key } })).status, 409);
  const k2 = randomUUID();
  const first = await request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'spring', episode: 5, idempotencyKey: k2 } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  // 같은 요청을 다시 보내면 같은 주문
  const again = await request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'spring', episode: 5, idempotencyKey: k2 } });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, first.data.id);
  // 같은 키로 다른 회차 · 전체 열기 · 다른 작품은 409
  assert.equal((await request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'spring', episode: 6, idempotencyKey: k2 } })).status, 409);
  assert.equal((await request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'spring', all: true, idempotencyKey: k2 } })).status, 409);
  assert.equal((await request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'midnight', episode: 5, idempotencyKey: k2 } })).status, 409);
});

test('노출 중단된 작품도 핑으로 연 회차는 계속 볼 수 있고, 나머지 · 구독만으로는 볼 수 없다', async () => {
  const buyer = await newUser('hidden-buyer');
  const stranger = await newUser('hidden-stranger');
  await request('/pings/charge', { method: 'POST', cookie: buyer.cookie, body: { productId: 'ping-10k', idempotencyKey: randomUUID() } });
  assert.equal((await request('/pings/unlock', { method: 'POST', cookie: buyer.cookie, body: { dramaId: 'moon', episode: 5, idempotencyKey: randomUUID() } })).status, 200);
  // 구독자(핑으로 연 회차 없음)
  assert.equal((await request('/checkout', { method: 'POST', cookie: stranger.cookie, body: { kind: 'subscription', idempotencyKey: randomUUID() } })).status, 200);
  const d = (await request('/dramas/moon', { cookie: admin })).data;
  assert.equal((await request('/admin/dramas/moon/pricing', { method: 'PATCH', cookie: admin, body: { free: false, episode_pings: d.episode_pings, free_episodes: d.free_episodes, badge: 'NEW', status: 'hidden' } })).status, 200);
  try {
    const play = (cookie, n) => fetch(`${base}/api/play/moon/${n}`, { headers: { ...(cookie ? { cookie } : {}), Range: 'bytes=0-15' } }).then((r) => r.status);
    assert.equal(await play(buyer.cookie, 5), 206, '연 회차는 계속 재생');
    assert.equal(await play(buyer.cookie, 6), 403, '안 연 회차는 막힘');
    assert.equal(await play(stranger.cookie, 5), 404, '구독만으로는 숨긴 작품 못 봄');
    assert.equal(await play(null, 1), 404);
    const detail = await request('/dramas/moon', { cookie: buyer.cookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.episodes.find((e) => e.number === 5).locked, false);
    assert.equal(detail.data.episodes.find((e) => e.number === 6).locked, true);
    assert.equal((await request('/dramas/moon', { cookie: stranger.cookie })).status, 404);
    assert.equal((await request('/history', { method: 'POST', cookie: buyer.cookie, body: { dramaId: 'moon', episode: 5, progress: 3 } })).status, 200);
    const lib = (await request('/library', { cookie: buyer.cookie })).data;
    assert.ok(lib.hidden_dramas.some((x) => x.id === 'moon'));
    // 숨긴 작품은 더 살 수 없다
    assert.equal((await request('/pings/unlock', { method: 'POST', cookie: buyer.cookie, body: { dramaId: 'moon', episode: 6, idempotencyKey: randomUUID() } })).status, 404);
  } finally {
    await request('/admin/dramas/moon/pricing', { method: 'PATCH', cookie: admin, body: { free: false, episode_pings: d.episode_pings, free_episodes: d.free_episodes, badge: d.badge || 'NEW', status: 'published' } });
  }
});

test('스튜디오 비공개 이미지는 /uploads에서도 만든 사람 · 관리자만 받고, 공개 자리에 쓰인 파일은 누구나 받는다', async () => {
  const [file] = await testDb.all("SELECT url, owner_id FROM media_files WHERE project_id IS NOT NULL AND (url LIKE '/uploads/%.png' OR url LIKE '/uploads/%.jpg' OR url LIKE '/uploads/%.webp') LIMIT 1");
  assert.ok(file?.url, '스튜디오 이미지 준비(앞 테스트에서 만든 컷 이미지)');
  const get = (cookie) => fetch(base + file.url, { headers: cookie ? { cookie } : {} }).then((r) => r.status);
  assert.equal(await get(null), 404, '로그인 없이 막힘');
  assert.equal(await get(pd), 200, '만든 PD');
  assert.equal(await get(admin), 200, '관리자');
  const other = await newUser('peeker', 'pd');
  assert.equal(await get(other.cookie), 404, '다른 PD 막힘');
  // 공개 자리(작품 표지)에 쓰이면 누구나
  const [drama] = await testDb.all("SELECT id,image FROM dramas WHERE id='spring'");
  await testDb.run('UPDATE dramas SET image=? WHERE id=?', [file.url, 'spring']);
  try {
    assert.equal(await get(null), 200);
  } finally {
    await testDb.run('UPDATE dramas SET image=? WHERE id=?', [drama.image, 'spring']);
  }
});

test('본문 없는 요청은 500이 아니라 400, 관리자는 회원을 탈퇴로 바꿀 수 없고 이용 제한 시 로그인이 끊긴다', async () => {
  const r = await fetch(base + '/api/auth/demo', { method: 'POST' });
  assert.equal(r.status, 400);
  const v = await newUser('suspend');
  assert.equal((await request('/admin/members/' + v.id, { method: 'PATCH', cookie: admin, body: { role: 'viewer', status: 'withdrawn', name: '점검 suspend', phone: '' } })).status, 400);
  assert.equal((await request('/library', { cookie: v.cookie })).status, 200);
  assert.equal((await request('/admin/users/' + v.id, { method: 'PATCH', cookie: admin, body: { role: 'viewer', status: 'suspended' } })).status, 200);
  assert.equal((await request('/admin/users/' + v.id, { method: 'PATCH', cookie: admin, body: { role: 'viewer', status: 'active' } })).status, 200);
  assert.equal((await request('/library', { cookie: v.cookie })).status, 401, '예전 로그인은 되살아나지 않음');
});

test('소유자가 이용 제한되면 협업자는 프로젝트를 열 수 없다', async () => {
  const owner = await newUser('owner', 'pd');
  const pid = (await request('/studio/ai/projects', { method: 'POST', cookie: owner.cookie, body: { title: '제한', logline: '소유자가 제한되면 팀원은 멈춘다', genre: '로맨스', tone: '애틋함', episode_count: 1, episode_seconds: 30 } })).data.id;
  const mate = await newUser('mate', 'pd');
  const link = (await request(`/studio/ai/projects/${pid}/invites`, { method: 'POST', cookie: owner.cookie, body: { link: true, role: 'editor', pay_mode: 'sponsor' } })).data.link;
  assert.equal((await request(`/studio/ai/invites/${link.token}/accept`, { method: 'POST', cookie: mate.cookie })).status, 200);
  assert.equal((await request('/studio/ai/projects/' + pid, { cookie: mate.cookie })).status, 200);
  await request('/admin/members/' + owner.id, { method: 'PATCH', cookie: admin, body: { role: 'pd', status: 'suspended', name: '점검 owner', phone: '' } });
  assert.equal((await request('/studio/ai/projects/' + pid, { cookie: mate.cookie })).status, 403);
});

test('기획 저장은 보낸 칸만 바꾸고, 보내지 않은 톤 · 스타일 · 시놉시스 · 중국 모델 제외는 그대로 둔다', async () => {
  const pid = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '부분 저장', logline: '보낸 칸만 바뀌는지 확인한다', genre: '로맨스', tone: '달달', style: '시네마틱', synopsis: '시놉시스가 있어요', episode_count: 2, episode_seconds: 30, exclude_cn: true } })).data.id;
  assert.equal((await request('/studio/ai/projects/' + pid, { method: 'PATCH', cookie: pd, body: { title: '바뀐 제목' } })).status, 200);
  assert.equal((await request('/studio/ai/projects/' + pid, { method: 'PATCH', cookie: pd, body: { episode_count: 3 } })).status, 200);
  const p = (await detail(pid)).project;
  assert.equal(p.title, '바뀐 제목');
  assert.equal(p.tone, '달달');
  assert.equal(p.style, '시네마틱');
  assert.equal(p.synopsis, '시놉시스가 있어요');
  assert.equal(Number(p.exclude_cn), 1);
  assert.equal(Number(p.episode_count), 3);
});
