// 힉스필드 · 폴로 벤치마킹(2026-09-30) 검증: 첫 컷 미리 보기(프로젝트 없이 이미지 1장) → 예상 라마 · 실행 · 결과 → 새 프로젝트 포스터 · 스타일 참고.
// SQLite(기본)와 PostgreSQL(TEST_PG_ADMIN_URL 지정) 모두에서 같은 결과가 나와야 합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';

const port = 5294,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data, text, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
async function start() {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: testDb.url, PORT: String(port), APP_ORIGIN: base, ENABLE_DEMO: 'true', DATA_DIR: dataDir, UPLOAD_DIR: path.join(dataDir, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const begin = Date.now();
  for (;;) {
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {}
    if (Date.now() - begin > 30000) throw new Error(output);
    await sleep(200);
  }
}
async function stop() {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([exited, sleep(12000)]);
}
before(async () => {
  testDb = await prepareTestDb(runId, dataDir);
  await start();
});
after(async () => {
  if (child) await stop();
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('첫 컷 미리 보기: 예상 라마 → 실행 → 이미지 → 새 프로젝트의 포스터 · 스타일 참고', async () => {
  const pd = await login('pd');
  await request('/studio/ai/terms', { method: 'POST', cookie: pd, body: { agree: true, version: '2026-09' } });
  const body = { logline: '비 오는 밤, 한 통의 편지가 두 사람을 갈라놓는다', genre: '로맨스', tone: '쓸쓸한', style: 'cinematic Korean drama', tier: 'standard' };
  const before = (await request('/lama', { cookie: pd })).data.wallet.total;
  const est = await request('/studio/ai/tools/first-shot/estimate', { method: 'POST', cookie: pd, body });
  assert.equal(est.status, 200, est.text);
  assert.ok(est.data.lama > 0 && /자동 선택/.test(est.data.model) && est.data.wallet.total === before);
  // 아이디어가 너무 짧으면 400
  assert.equal((await request('/studio/ai/tools/first-shot', { method: 'POST', cookie: pd, body: { ...body, logline: '짧' } })).status, 400);
  const run = await request('/studio/ai/tools/first-shot', { method: 'POST', cookie: pd, body });
  assert.equal(run.status, 201, run.text);
  assert.equal(run.data.lama, est.data.lama);
  let job;
  for (let i = 0; i < 200; i++) {
    job = (await request('/studio/ai/tools/jobs/' + run.data.id, { cookie: pd })).data;
    if (job.status === 'succeeded' || job.status === 'failed') break;
    await sleep(150);
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.match(job.output.url, /^\/uploads\/.+\.(jpg|png|webp)$/);
  const after = (await request('/lama', { cookie: pd })).data.wallet.total;
  assert.equal(before - after, Number(job.charged_lama));
  // 다른 사람의 작업은 볼 수 없어요
  const viewer = await login('viewer');
  assert.equal((await request('/studio/ai/tools/jobs/' + run.data.id, { cookie: viewer })).status, 403);

  const made = await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '첫 컷 시험', logline: body.logline, genre: '로맨스', episode_count: 1, episode_seconds: 30 } });
  assert.equal(made.status, 201, made.text);
  assert.equal((await request(`/studio/ai/projects/${made.data.id}/poster`, { method: 'PUT', cookie: pd, body: { image: job.output.url } })).status, 200);
  assert.equal((await request(`/studio/ai/projects/${made.data.id}/settings`, { method: 'PATCH', cookie: pd, body: { style_refs: [job.output.url] } })).status, 200);
  const d = (await request('/studio/ai/projects/' + made.data.id, { cookie: pd })).data;
  assert.equal(d.project.poster, job.output.url);
  assert.deepEqual(JSON.parse(d.project.style_refs), [job.output.url]);
});

test('대본을 다시 써도 같은 순번 컷 ID가 유지되고, 같은 계정의 다른 세션이 먼저 고치면 409', async () => {
  const pd = await login('pd');
  await request('/studio/ai/terms', { method: 'POST', cookie: pd, body: { agree: true, version: '2026-09' } });
  const made = await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: 'ID 유지', logline: '비 오는 밤 고백과 반전이 한 컷에', genre: '로맨스', episode_count: 1, episode_seconds: 30 } });
  const pid = made.data.id;
  const run = (body) => request(`/studio/ai/projects/${pid}/run`, { method: 'POST', cookie: pd, body: { requested: 'auto', tier: 'standard', ...body } });
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      const d = (await request('/studio/ai/projects/' + pid, { cookie: pd })).data;
      if (!d.jobs.some((j) => ['queued', 'running'].includes(j.status))) return d;
      await sleep(150);
    }
    throw new Error('idle');
  };
  assert.equal((await run({ action: 'plan', requested: 'mock-writer' })).status, 201);
  let d = await idle();
  assert.equal((await run({ action: 'script', requested: 'mock-writer', targetId: d.episodes[0].id })).status, 201);
  d = await idle();
  const before = d.episodes[0].shots.map((s) => s.id);
  assert.ok(before.length > 0);
  assert.equal((await run({ action: 'script', requested: 'mock-writer', targetId: d.episodes[0].id })).status, 201);
  d = await idle();
  const after = d.episodes[0].shots.map((s) => s.id);
  const kept = before.slice(0, Math.min(before.length, after.length));
  assert.deepEqual(after.slice(0, kept.length), kept, '같은 순번의 컷 ID가 유지돼요');

  // 같은 계정 · 다른 세션(두 번째 로그인)에서 먼저 고친 뒤, 첫 세션이 옛 기준 시각으로 저장하면 409
  const shot = d.episodes[0].shots[0];
  const pd2 = await login('pd');
  const base = shot.updated_at ?? null;
  const first = await request(`/studio/ai/shots/${shot.id}`, { method: 'PATCH', cookie: pd, body: { visual: shot.visual + ' (A)', base_updated_at: base } });
  assert.equal(first.status, 200, first.text);
  const fresh = (await request('/studio/ai/projects/' + pid, { cookie: pd })).data.episodes[0].shots[0];
  // 같은 세션은 최신 기준으로 계속 저장돼요
  assert.equal((await request(`/studio/ai/shots/${shot.id}`, { method: 'PATCH', cookie: pd, body: { visual: shot.visual + ' (A2)', base_updated_at: fresh.updated_at } })).status, 200);
  const fresh2 = (await request('/studio/ai/projects/' + pid, { cookie: pd })).data.episodes[0].shots[0];
  // 다른 세션이 옛 기준(fresh.updated_at)으로 저장하면 충돌
  const stale = await request(`/studio/ai/shots/${shot.id}`, { method: 'PATCH', cookie: pd2, body: { visual: shot.visual + ' (B)', base_updated_at: fresh.updated_at } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.data.code, 'edit_conflict');
  // 최신 기준이면 다른 세션도 저장돼요
  assert.equal((await request(`/studio/ai/shots/${shot.id}`, { method: 'PATCH', cookie: pd2, body: { visual: shot.visual + ' (B2)', base_updated_at: fresh2.updated_at } })).status, 200);
});
