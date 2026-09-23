// 모바일 앱 토큰 로그인(2026-09-23): 앱은 쿠키 대신 Bearer 토큰을, 영상·음성처럼 머리글을 못 붙이는 주소에는
// 세션에 묶인 미디어 토큰(?mt=)을 씁니다. 웹(쿠키) 동작은 그대로인지, 앱 출처 CORS·CSRF 규칙이 맞는지 확인합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';

const port = 5244,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(url, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data, text, headers: r.headers, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const APP = 'capacitor://localhost';

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
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('web login keeps cookies and never returns a token', async () => {
  const r = await call('/api/auth/demo', { method: 'POST', body: { role: 'viewer' } });
  assert.equal(r.status, 200);
  assert.ok(r.cookie?.startsWith('sp_session='));
  assert.equal(r.data.token, undefined);
  const me = await call('/api/auth/me', { headers: { cookie: r.cookie } });
  assert.equal(me.data.user.role, 'viewer');
});

test('app login returns a bearer token; CORS preflight and CSRF rules for the app origin', async () => {
  const pre = await call('/api/auth/login', { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-client' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), APP);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  // 모르는 출처에는 CORS를 열지 않는다
  const evil = await call('/api/auth/me', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const login = await call('/api/auth/demo', { method: 'POST', body: { role: 'pd' }, headers: { Origin: APP, 'X-Client': 'app' } });
  assert.equal(login.status, 200, login.text);
  assert.match(login.data.token, /^[a-f0-9]{64}$/);
  const auth = { Authorization: 'Bearer ' + login.data.token, Origin: APP };
  const me = await call('/api/auth/me', { headers: auth });
  assert.equal(me.data.user.role, 'pd');
  // 토큰으로 보낸 쓰기 요청은 앱 출처에서도 통과
  const write = await call('/api/notifications/read', { method: 'POST', body: {}, headers: auth });
  assert.equal(write.status, 200, write.text);
  // 앱 출처라도 토큰 없이(쿠키로) 보낸 쓰기 요청은 막는다
  const web = await call('/api/auth/demo', { method: 'POST', body: { role: 'viewer' } });
  const csrf = await call('/api/notifications/read', { method: 'POST', body: {}, headers: { Origin: APP, cookie: web.cookie } });
  assert.equal(csrf.status, 403);
  // 잘못된 토큰은 로그인되지 않음
  const bad = await call('/api/auth/me', { headers: { Authorization: 'Bearer ' + 'f'.repeat(64) } });
  assert.equal(bad.data.user, null);
  // 세션 목록에서 지금 기기를 알아본다
  const sessions = await call('/api/account/sessions', { headers: auth });
  assert.equal(sessions.status, 200);
  assert.ok(sessions.data.some((s) => s.current));
});

test('media token opens only media routes, is tamper-proof, and dies with the session', async () => {
  const login = await call('/api/auth/demo', { method: 'POST', body: { role: 'pd' }, headers: { 'X-Client': 'app' } });
  const auth = { Authorization: 'Bearer ' + login.data.token };
  const mt = await call('/api/auth/media-token', { headers: auth });
  assert.equal(mt.status, 200);
  assert.ok(mt.data.token && new Date(mt.data.expires_at) > new Date());
  const q = '?mt=' + encodeURIComponent(mt.data.token);
  // PD 전용 미디어 경로: 토큰이 맞으면 권한은 통과(파일이 없으니 404), 없거나 틀리면 403
  const sample = '/api/studio/ai/voices/sample/00000000-0000-0000-0000-000000000000.mp3';
  assert.equal((await call(sample)).status, 403);
  assert.equal((await call(sample + q)).status, 404);
  const [body, sig] = mt.data.token.split('.');
  const forged = Buffer.from(JSON.stringify({ s: 'a'.repeat(32), e: Date.now() + 3600000 })).toString('base64url');
  assert.equal((await call(sample + '?mt=' + forged + '.' + sig)).status, 403);
  assert.equal((await call(sample + '?mt=' + body + '.' + sig.slice(0, -2) + 'AA')).status, 403);
  // 미디어가 아닌 경로에서는 미디어 토큰으로 로그인되지 않음
  assert.equal((await call('/api/auth/me' + q)).data.user, null);
  // 공개 작품 재생도 미디어 토큰으로 열림(무료 1화)
  const play = await fetch(base + '/api/play/midnight/1' + q, { headers: { Range: 'bytes=0-1' } });
  assert.ok([200, 206].includes(play.status), String(play.status));
  // 로그아웃하면 로그인 토큰과 미디어 토큰이 함께 무효
  assert.equal((await call('/api/auth/logout', { method: 'POST', headers: auth })).status, 200);
  assert.equal((await call('/api/auth/me', { headers: auth })).data.user, null);
  assert.equal((await call(sample + q)).status, 403);
});

test('share links for missing content show an HTML page, not JSON', async () => {
  const r = await call('/share/drama/not-public');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /찾을 수 없는 작품이에요/);
});
