// 장르·진열 분류(2026-09-30) 검증: 단일 기준표(server/genres.json) → 서버 검증·AI 스튜디오 목록,
// 방송국 진열 카테고리 추천(이름으로 만들며 진열), 시청자 방송국 화면 동기화.
// SQLite(기본)와 PostgreSQL(TEST_PG_ADMIN_URL 지정) 모두에서 같은 결과가 나와야 합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';

const port = 5293,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb,
  admin;
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
const login = async (role) =>
  (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
async function start() {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: testDb.url,
      PORT: String(port),
      APP_ORIGIN: base,
      ENABLE_DEMO: 'true',
      DATA_DIR: dataDir,
      UPLOAD_DIR: path.join(dataDir, 'uploads'),
    },
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
  admin = await login('admin');
});
after(async () => {
  if (child) await stop();
  await testDb?.close();
  assert.ok(
    !/TypeError|ReferenceError|SyntaxError|is not defined/.test(output),
    output.slice(-3000),
  );
});

import table from '../server/genres.json' with { type: 'json' };

test('장르 기준표: AI 스튜디오 목록과 서버 검증이 같은 표를 써요', async () => {
  const pd = await login('pd');
  const ov = await request('/studio/ai/overview', { cookie: pd });
  assert.equal(ov.status, 200, ov.text);
  assert.deepEqual(ov.data.genres, table.genres);
  // 기존 5개 장르는 그대로 앞에 남아 있어야 해요(저장된 작품 호환).
  assert.deepEqual(table.genres.slice(0, 5), ['로맨스', '스릴러', '판타지', '코미디', '청춘']);
  assert.equal(
    new Set([...table.genres, ...table.shelves]).size,
    table.genres.length + table.shelves.length,
  );
  await request('/studio/ai/terms', {
    method: 'POST',
    cookie: pd,
    body: { agree: true, version: '2026-09' },
  });
  const made = await request('/studio/ai/projects', {
    method: 'POST',
    cookie: pd,
    body: {
      title: '사극 시험',
      logline: '왕좌를 둘러싼 비밀과 배신',
      genre: '사극',
      episode_count: 1,
      episode_seconds: 30,
    },
  });
  assert.equal(made.status, 201, made.text);
  const bad = await request('/studio/ai/projects', {
    method: 'POST',
    cookie: pd,
    body: {
      title: '없는 장르',
      logline: '없는 장르로 만들어 봐요',
      genre: '없는장르',
      episode_count: 1,
      episode_seconds: 30,
    },
  });
  assert.equal(bad.status, 400, bad.text);
});

test('진열 카테고리: 추천 이름으로 만들며 진열 · 중복 없음 · 시청자 방송국에 바로 보임', async () => {
  const pd = await login('pd');
  const studio = (await request('/studio/channel', { cookie: pd })).data;
  const drama = studio.dramas[0];
  assert.ok(drama, '진열할 작품이 있어야 해요');
  const put = (body) =>
    request('/studio/dramas/' + drama.id + '/category', { method: 'PATCH', cookie: pd, body });

  const first = await put({ category_name: '미스터리' });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.created, true);
  let now = (await request('/studio/channel', { cookie: pd })).data;
  const cat = now.categories.find((c) => c.name === '미스터리');
  assert.ok(cat);
  assert.equal(now.dramas.find((d) => d.id === drama.id).category_id, cat.id);

  const again = await put({ category_name: '미스터리' });
  assert.equal(again.data.created, false);
  assert.equal(again.data.category_id, cat.id);
  now = (await request('/studio/channel', { cookie: pd })).data;
  assert.equal(now.categories.filter((c) => c.name === '미스터리').length, 1);

  // 시청자 방송국 화면도 같은 카테고리·진열을 보여요.
  const viewer = await login('viewer');
  const pub = await request('/channels/' + now.channel.id, { cookie: viewer });
  assert.equal(pub.status, 200, pub.text);
  assert.ok(pub.data.categories.some((c) => c.name === '미스터리'));

  assert.equal((await put({})).status, 400);
  const cleared = await put({ category_id: null });
  assert.equal(cleared.status, 200, cleared.text);
  now = (await request('/studio/channel', { cookie: pd })).data;
  assert.equal(now.dramas.find((d) => d.id === drama.id).category_id, null);

  // 최대 30개까지 만들 수 있어요(예전 12개 제한 해제).
  const names = table.shelves
    .concat(
      table.genres,
      Array.from({ length: 30 }, (_, i) => '직접 ' + (i + 1)),
    )
    .filter((n) => !now.categories.some((c) => c.name === n));
  for (const n of names.slice(0, 30 - now.categories.length)) {
    const r = await request('/studio/channel/categories', {
      method: 'POST',
      cookie: pd,
      body: { name: n },
    });
    assert.equal(r.status, 201, r.text);
  }
  now = (await request('/studio/channel', { cookie: pd })).data;
  assert.equal(now.categories.length, 30);
  const over = await request('/studio/channel/categories', {
    method: 'POST',
    cookie: pd,
    body: { name: '초과 진열' },
  });
  assert.equal(over.status, 400);
  assert.match(over.data.error || over.text, /30개/);
  const overName = await put({ category_name: '초과 진열' });
  assert.equal(overName.status, 400);
});
