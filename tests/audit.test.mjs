// 전체 점검 반영(2026-09-29) 0단계 테스트:
// H1 컷 부분 수정(보낸 칸만 바뀜) · H2 합성 중 수정 감지 · H3 라이브러리 주인 확인 · H4 버전 되돌리기(시드·검수 유지)
// M1 모델별 영상 길이 과금 · M6 대본 승인 초기화 · M7 버전 고르기와 입 모양 · M9 403 구분 · M10 목소리 미리듣기 제한
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';
import { unitsFor, publicError } from '../server/ai/engine.mjs';
import { VendorError } from '../server/ai/http.mjs';

const port = 5281,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb,
  admin,
  pd,
  pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
const detail = async (id = pid, cookie = pd) => (await request('/studio/ai/projects/' + id, { cookie })).data;
async function waitIdle(id = pid, cookie = pd, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const d = await detail(id, cookie);
    if (d && !d.jobs.some((j) => ['queued', 'running'].includes(j.status))) return d;
    await sleep(200);
  }
  throw new Error('작업이 끝나지 않았어요\n' + output.slice(-2000));
}
const run = (body, cookie = pd, id = pid) => request(`/studio/ai/projects/${id}/run`, { method: 'POST', cookie, body: { requested: 'auto', tier: 'standard', ...body } });
const ok = (r) => (assert.ok(r.status < 300, JSON.stringify(r.data)), r);
const shotsOf = (d, n = 0) => d.episodes[n].shots;
const one = async (sql, params) => (await testDb.all(sql, params))[0];
const patch = (id, body, cookie = pd) => request(`/studio/ai/shots/${id}`, { method: 'PATCH', cookie, body });

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
  pd = await login('pd');
  await request('/studio/ai/terms', { method: 'POST', cookie: pd, body: { agree: true, version: '2026-09' } });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'grant', lama: 50000, memo: '점검 테스트' } });
  pid = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '점검', logline: '오래된 약속이 다시 두 사람을 부른다, 비 오는 골목에서', genre: '로맨스', episode_count: 1, episode_seconds: 30 } })).data.id;
  ok(await run({ action: 'plan', requested: 'mock-writer' }));
  await waitIdle();
  ok(await run({ action: 'script', requested: 'mock-writer', targetId: (await detail()).episodes[0].id }));
  await waitIdle();
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('H1: shot PATCH changes only the fields sent (script tab edit is not overwritten by scene tab)', async () => {
  const s = shotsOf(await detail())[0];
  ok(await patch(s.id, { visual: '대본 탭에서 고친 화면' }));
  // 장면 탭은 연출 칸만 보냅니다(예전 화면·대사 값을 함께 보내지 않음).
  ok(await patch(s.id, { camera_move: '천천히 다가가기', effect: 'dream' }));
  const r = shotsOf(await detail())[0];
  assert.equal(r.visual, '대본 탭에서 고친 화면');
  assert.equal(r.dialogue, s.dialogue);
  assert.equal(r.camera_move, '천천히 다가가기');
  assert.equal(r.effect, 'dream');
  assert.equal(Number(r.seconds), Number(s.seconds));
  // 잘못된 길이는 여전히 막아요.
  assert.equal((await patch(s.id, { seconds: 30 })).status, 400);
});

test('H2: editing a shot while composing marks the episode dirty so the stale render is not accepted', async () => {
  const d = await detail();
  const e = d.episodes[0];
  await testDb.run("UPDATE studio_episodes SET status='composing',compose_dirty=0 WHERE id=?", [e.id]);
  ok(await patch(shotsOf(d)[1].id, { dialogue: '합성 중에 고친 대사' }));
  const row = await one('SELECT status,compose_dirty FROM studio_episodes WHERE id=?', [e.id]);
  assert.equal(row.status, 'composing');
  assert.equal(Number(row.compose_dirty), 1);
  await testDb.run("UPDATE studio_episodes SET status='scripted',compose_dirty=0 WHERE id=?", [e.id]);
  ok(await run({ action: 'batch_shot_image', requested: 'mock-image', targetId: e.id }));
  await waitIdle();
  const compose = async () => {
    ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/compose`, { method: 'POST', cookie: pd }));
    let ep;
    for (let i = 0; i < 400; i++) {
      ep = (await detail()).episodes[0];
      if (ep.status !== 'composing') break;
      await sleep(100);
    }
    return ep;
  };
  // 실제 합성 중에 컷을 고치면: 합성본은 남지만 '완료'로 확정하지 않고 다시 합성하라고 알려요.
  ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/compose`, { method: 'POST', cookie: pd }));
  // 합성기가 컷을 읽고 만들기 시작한 뒤(진행률이 오른 뒤)에 고칩니다.
  for (let i = 0; i < 400; i++) {
    const row = await one('SELECT status,compose_progress FROM studio_episodes WHERE id=?', [e.id]);
    if (row.status !== 'composing' || Number(row.compose_progress) > 0) break;
    await sleep(20);
  }
  assert.equal((await one('SELECT status FROM studio_episodes WHERE id=?', [e.id])).status, 'composing', '합성이 너무 빨리 끝났어요');
  ok(await patch(shotsOf(d)[0].id, { dialogue: '합성하는 사이에 고친 대사' }));
  let ep;
  for (let i = 0; i < 400; i++) {
    ep = (await detail()).episodes[0];
    if (ep.status !== 'composing') break;
    await sleep(100);
  }
  assert.equal(ep.status, 'scripted');
  assert.match(ep.compose_error, /다시 합성/);
  // 다시 합성하면 완료
  ep = await compose();
  assert.equal(ep.status, 'composed', ep.compose_error);
  assert.equal(Number((await one('SELECT compose_dirty FROM studio_episodes WHERE id=?', [e.id])).compose_dirty), 0);
});

test('M6: direct script edits reset a given script approval; direction-only edits keep it', async () => {
  const d = await detail();
  const e = d.episodes[0];
  const s = shotsOf(d)[0];
  await testDb.run("UPDATE studio_episodes SET script_review='approved' WHERE id=?", [e.id]);
  ok(await patch(s.id, { angle: '올려다봄' }));
  assert.equal((await one('SELECT script_review FROM studio_episodes WHERE id=?', [e.id])).script_review, 'approved');
  ok(await patch(s.id, { dialogue: '승인 뒤에 고친 대사' }));
  assert.equal((await one('SELECT script_review FROM studio_episodes WHERE id=?', [e.id])).script_review, '');
  await testDb.run("UPDATE studio_episodes SET script_review='requested' WHERE id=?", [e.id]);
  ok(await request(`/studio/ai/shots/${s.id}/move`, { method: 'POST', cookie: pd, body: { direction: 'down' } }));
  assert.equal((await one('SELECT script_review FROM studio_episodes WHERE id=?', [e.id])).script_review, '');
  ok(await request(`/studio/ai/shots/${s.id}/move`, { method: 'POST', cookie: pd, body: { direction: 'up' } }));
});

test('H4: restoring a script version keeps seed lock, end frame and the matching AI check', async () => {
  let d = await detail();
  const e = d.episodes[0];
  ok(await run({ action: 'shot_image', requested: 'mock-image', targetId: shotsOf(d)[0].id }));
  d = await waitIdle();
  const s = shotsOf(d)[0];
  const verify = JSON.stringify({ ok: true, score: 90, issues: [], faces: [], summary: '좋아요', at: new Date().toISOString(), image: s.image });
  await testDb.run('UPDATE studio_shots SET seed=?,seed_lock=1,end_frame=1,verify=? WHERE id=?', [424242, verify, s.id]);
  ok(await run({ action: 'rewrite_range', requested: 'mock-writer', targetId: e.id, instruction: '대사를 짧게', options: { shotIds: [s.id] } }));
  await waitIdle();
  const versions = ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions`, { cookie: pd })).data;
  const v = versions.find((x) => x.source === 'before_ai');
  ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions/${v.id}/restore`, { method: 'POST', cookie: pd }));
  const r = await one('SELECT seed,seed_lock,end_frame,verify,image FROM studio_shots WHERE episode_id=? ORDER BY sort_order LIMIT 1', [e.id]);
  assert.equal(Number(r.seed), 424242);
  assert.equal(Number(r.seed_lock), 1);
  assert.equal(Number(r.end_frame), 1);
  assert.equal(r.image, s.image);
  assert.equal(JSON.parse(r.verify).score, 90);
});

test('M7: picking an older video or voice clears the lip-sync clip made for the old one', async () => {
  let d = await detail();
  const s = shotsOf(d)[2];
  ok(await run({ action: 'shot_image', requested: 'mock-image', targetId: s.id }));
  await waitIdle();
  ok(await run({ action: 'shot_video', requested: 'mock-video-fast', targetId: s.id }));
  await waitIdle();
  ok(await run({ action: 'shot_video', requested: 'mock-video-fast', targetId: s.id }));
  d = await waitIdle();
  const vids = d.assets.filter((a) => a.target_id === s.id && a.kind === 'video');
  assert.ok(vids.length >= 2);
  await testDb.run('UPDATE studio_shots SET lipsync=? WHERE id=?', [vids[0].url, s.id]);
  ok(await request(`/studio/ai/assets/${vids[1].id}/use`, { method: 'POST', cookie: pd }));
  const row = await one('SELECT video,lipsync FROM studio_shots WHERE id=?', [s.id]);
  assert.equal(row.video, vids[1].url);
  assert.equal(row.lipsync, '');
});

test('H3: library save is owner-only; import drops images owned by someone else', async () => {
  const d = await detail();
  const c = d.characters[0];
  ok(await request('/studio/ai/library', { method: 'POST', cookie: pd, body: { kind: 'character', projectId: pid, sourceId: c.id } }));
  const other = await request('/studio/ai/library', { method: 'POST', cookie: admin, body: { kind: 'character', projectId: pid, sourceId: c.id } });
  assert.ok([403, 404].includes(other.status), JSON.stringify(other.data));
  // 다른 계정 파일을 가리키는 라이브러리 항목(예전 버전에서 저장된 것)
  const foreign = `/uploads/${randomUUID()}.png`;
  await testDb.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [foreign, 'demo-admin', 'image/png', new Date().toISOString()]);
  const lid = randomUUID();
  await testDb.run('INSERT INTO studio_library (id,owner_id,kind,name,image,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [
    lid, 'demo-pd', 'location', '남의 골목', foreign, JSON.stringify({ look: '비 오는 골목' }), new Date().toISOString(), new Date().toISOString(),
  ]);
  const r = ok(await request(`/studio/ai/projects/${pid}/library/import`, { method: 'POST', cookie: pd, body: { libraryId: lid } }));
  assert.equal(r.data.dropped, 1);
  const loc = await one('SELECT image FROM studio_locations WHERE id=?', [r.data.id]);
  assert.equal(loc.image, '');
});

test('M1: video is billed for the seconds the chosen model really makes', () => {
  assert.equal(unitsFor('video', { seconds: 7 }, { model_id: 'kling-v2-5-turbo' }), 10);
  assert.equal(unitsFor('video', { seconds: 5 }, { model_id: 'veo-3.1-fast' }), 6);
  assert.equal(unitsFor('video', { seconds: 7 }, { model_id: 'mock-video' }), 7);
  assert.equal(unitsFor('video', { seconds: 7 }), 7);
});

test('M9: a 403 from a provider is reported as a refusal, not as a broken key', () => {
  const e403 = new VendorError('AI 공급사 오류(403): region not allowed', { status: 403, retryable: false });
  const e401 = new VendorError('AI 공급사 오류(401): bad key', { status: 401, retryable: false });
  assert.match(publicError(e403), /거절/);
  assert.match(publicError(e401), /인증/);
});

test('M10: voice preview only for listed voices; job list exposes flags', async () => {
  assert.equal((await request('/studio/ai/voices/preview', { method: 'POST', cookie: pd, body: { model: 'mock-voice', voice: 'made-up-voice' } })).status, 400);
  assert.equal((await request('/studio/ai/voices/preview', { method: 'POST', cookie: pd, body: { model: 'mock-voice', voice: 'mock-female' } })).status, 202);
  const d = await detail();
  assert.ok(d.jobs.length && d.jobs.every((j) => 'flags' in j));
});
