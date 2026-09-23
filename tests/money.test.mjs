// 돈이 오가는 경로의 동시 요청·조작 방지 검증 (2026-09-23 긴급 수정)
// SQLite(기본)와 PostgreSQL(TEST_PG_ADMIN_URL 지정) 모두에서 같은 결과가 나와야 합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';

const port = 5211,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb,
  admin,
  pd,
  pd2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
async function newUser(tag, role = 'viewer') {
  const email = `${tag}-${runId}@money.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'MoneyTest!2026', name: '돈 ' + tag } });
  assert.ok([200, 201].includes(reg.status), JSON.stringify(reg.data));
  if (role !== 'viewer')
    await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role, status: 'active', name: '돈 ' + tag, phone: '' } });
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'MoneyTest!2026' } })).cookie;
  return { id: reg.data.user.id, cookie };
}
const charge = (cookie, key = randomUUID()) => request('/pings/charge', { method: 'POST', cookie, body: { productId: 'ping-10k', idempotencyKey: key } });

before(async () => {
  testDb = await prepareTestDb(runId, dataDir);
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
  pd2 = await newUser('pd2', 'pd');
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError/.test(output), output.slice(-2000));
});

test('same charge key sent twice at once returns one order, never 500', async () => {
  let v, key;
  for (let round = 0; round < 4; round++) {
    v = await newUser('charge' + round);
    key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 6 }, () => charge(v.cookie, key)));
    rs.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.data)));
    assert.equal(new Set(rs.map((r) => r.data.id)).size, 1);
    assert.equal((await request('/pings', { cookie: v.cookie })).data.wallet.total, 100);
  }
  // 다른 회원이 같은 키를 쓰면 거절
  const other = await newUser('charge-other');
  assert.equal((await charge(other.cookie, key)).status, 409);
});

test('opening a whole title twice at once (different keys) charges only once', async () => {
  for (let round = 0; round < 4; round++) await unlockRound(round);
});
async function unlockRound(round) {
  const v = await newUser('unlock' + round);
  await charge(v.cookie);
  const before = (await request('/pings', { cookie: v.cookie })).data.wallet.total;
  const body = () => ({ dramaId: 'midnight', all: true, idempotencyKey: randomUUID() });
  const rs = await Promise.all(Array.from({ length: 6 }, () => request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: body() })));
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify(rs.map((r) => [r.status, r.data?.error])));
  rs.filter((r) => r.status !== 200).forEach((r) => assert.equal(r.status, 409));
  const after = (await request('/pings', { cookie: v.cookie })).data.wallet.total;
  assert.equal(before - after, ok[0].data.pings);
  const orders = await testDb.all("SELECT COUNT(*) AS n FROM orders WHERE user_id=? AND kind='ping_title'", [v.id]);
  assert.equal(Number(orders[0].n), 1);
  const entries = await testDb.all("SELECT COUNT(*) AS n FROM settlement_entries s JOIN orders o ON o.id=s.order_id WHERE o.user_id=?", [v.id]);
  assert.equal(Number(entries[0].n), 1);
}

test('episode unlock racing with whole-title unlock never pays twice for the same episode', async () => {
  const v = await newUser('race');
  await charge(v.cookie);
  const rs = await Promise.all([
    request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'spring', episode: 5, idempotencyKey: randomUUID() } }),
    request('/pings/unlock', { method: 'POST', cookie: v.cookie, body: { dramaId: 'spring', all: true, idempotencyKey: randomUUID() } }),
  ]);
  const spent = await testDb.all("SELECT COALESCE(SUM(pings),0) AS n FROM orders WHERE user_id=? AND kind IN ('ping_episode','ping_title')", [v.id]);
  const wallet = (await request('/pings', { cookie: v.cookie })).data.wallet.total;
  assert.equal(100 - Number(spent[0].n), wallet);
  // 전체 열기가 먼저 끝났다면 5화 단건은 거절, 단건이 먼저였다면 전체 열기는 5화를 빼고 계산
  const titles = await testDb.all("SELECT pings FROM orders WHERE user_id=? AND kind='ping_title'", [v.id]);
  if (rs[0].status === 200 && titles.length) assert.ok(Number(titles[0].pings) < 45);
  assert.ok(rs.some((r) => r.status === 200));
});

test('welcome lama is granted once even when the wallet is opened many times at once', async () => {
  let p;
  for (let round = 0; round < 4; round++) {
    p = await newUser('welcome' + round, 'pd');
    const rs = await Promise.all(Array.from({ length: 6 }, () => request('/lama', { cookie: p.cookie })));
    rs.forEach((r) => assert.equal(r.status, 200));
    const rows = await testDb.all("SELECT COUNT(*) AS n FROM lama_ledger WHERE user_id=? AND type='welcome'", [p.id]);
    assert.equal(Number(rows[0].n), 1);
  }
  const lk = randomUUID();
  const cs = await Promise.all([1, 2].map(() => request('/lama/charge', { method: 'POST', cookie: p.cookie, body: { productId: 'lama-10k', idempotencyKey: lk } })));
  cs.forEach((c) => assert.equal(c.status, 200, JSON.stringify(c.data)));
  assert.equal(new Set(cs.map((c) => c.data.id)).size, 1);
});

async function seedAvailable(pdId, amount) {
  const stamp = new Date(Date.now() - 30 * 86400000).toISOString();
  await testDb.run(
    "INSERT INTO settlement_entries (id,pd_id,order_id,drama_id,kind,period,gross,platform_fee,pg_fee,net,fee_rate,status,confirm_at,created_at) VALUES (?,?,NULL,NULL,'ping',?,?,0,0,?,30,'available',?,?)",
    [randomUUID(), pdId, stamp.slice(0, 7), amount, amount, stamp, stamp],
  );
}
const account = { bank_name: '국민은행', account_number: '123-456-7890', account_holder: '돈 PD' };

test('processing one payout twice at once (paid vs rejected) applies exactly one decision', async () => {
  for (let round = 0; round < 4; round++) await payoutRound(round);
});
async function payoutRound(round) {
  const pd2 = await newUser('payout' + round, 'pd');
  await request('/studio/tax', { method: 'PUT', cookie: pd2.cookie, body: { business_type: 'individual', ...account } });
  await seedAvailable(pd2.id, 50000);
  const payout = await request('/studio/payouts', { method: 'POST', cookie: pd2.cookie, body: {} });
  assert.equal(payout.status, 201, JSON.stringify(payout.data));
  const rs = await Promise.all([
    request('/admin/payouts/' + payout.data.id, { method: 'POST', cookie: admin, body: { action: 'paid' } }),
    request('/admin/payouts/' + payout.data.id, { method: 'POST', cookie: admin, body: { action: 'rejected', memo: '계좌 확인 필요' } }),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const [p] = await testDb.all('SELECT status FROM payouts WHERE id=?', [payout.data.id]);
  const entries = await testDb.all('SELECT status, payout_id FROM settlement_entries WHERE pd_id=?', [pd2.id]);
  if (p.status === 'paid') entries.forEach((e) => assert.equal(e.status, 'paid'));
  else entries.forEach((e) => assert.equal(e.status, 'available'));
  // 이미 처리된 출금은 다시 처리할 수 없다
  assert.equal((await request('/admin/payouts/' + payout.data.id, { method: 'POST', cookie: admin, body: { action: 'paid' } })).status, 409);
}

test('business tax rules apply only after an administrator verifies the business', async () => {
  const p = await newUser('biz', 'pd');
  await request('/studio/tax', { method: 'PUT', cookie: p.cookie, body: { business_type: 'business', business_no: '123-45-67890', business_name: '돈상회', ...account } });
  await seedAvailable(p.id, 100000);
  // 확인 전: 출금은 막히고, 라마 전환은 개인 기준(원천징수)으로 계산된다
  const blocked = await request('/studio/payouts', { method: 'POST', cookie: p.cookie, body: {} });
  assert.equal(blocked.status, 409);
  const conv = await request('/lama/convert', { method: 'POST', cookie: p.cookie, body: {} });
  assert.ok([200, 201].includes(conv.status), JSON.stringify(conv.data));
  assert.equal(conv.data.vat, 0);
  assert.ok(conv.data.incomeTax > 0);
  // 관리자가 확인한 뒤에는 사업자 기준(부가세 가산)
  await seedAvailable(p.id, 100000);
  assert.equal((await request('/admin/tax/' + p.id, { method: 'PATCH', cookie: admin, body: { business_type: 'business', verified: true } })).status, 200);
  const payout = await request('/studio/payouts', { method: 'POST', cookie: p.cookie, body: {} });
  assert.equal(payout.status, 201, JSON.stringify(payout.data));
  assert.equal(payout.data.vat, 10000);
  assert.equal(payout.data.payable, 110000);
});

test('subscription pool follows server-recorded plays by subscribers, not client history', async () => {
  const v = await newUser('sub');
  assert.equal((await request('/checkout', { method: 'POST', cookie: v.cookie, body: { kind: 'subscription', idempotencyKey: randomUUID() } })).status, 200);
  // 구독자가 유료 회차(4화)를 재생하면 기록된다. 무료 회차(1화)는 기록되지 않는다.
  assert.equal((await fetch(`${base}/api/play/midnight/4`, { headers: { cookie: v.cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/play/midnight/4`, { headers: { cookie: v.cookie, range: 'bytes=100-' } })).status, 206);
  assert.equal((await fetch(`${base}/api/play/midnight/1`, { headers: { cookie: v.cookie } })).status, 200);
  // 작품 소유자(PD)가 자기 작품을 재생해도, 화면이 보낸 시청 기록(60화)을 넣어도 가중치가 되지 않는다.
  await fetch(`${base}/api/play/midnight/8`, { headers: { cookie: pd } });
  await request('/history', { method: 'POST', cookie: pd, body: { dramaId: 'midnight', episode: 12, progress: 1 } });
  const views = await testDb.all('SELECT user_id, drama_id, episode FROM subscription_views ORDER BY episode');
  assert.deepEqual(views.map((r) => [r.user_id, r.episode]), [[v.id, 4]]);

  // 지난달(마감 가능)로 옮겨 배분을 확인한다: midnight(demo-pd) 3회, moon(demo-pd-2) 1회 재생
  const d = new Date();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15));
  const period = last.toISOString().slice(0, 7);
  const stamp = last.toISOString();
  await testDb.run('UPDATE subscription_views SET period=?, created_at=?', [period, stamp]);
  for (const ep of [5, 6]) await testDb.run('INSERT INTO subscription_views (user_id,drama_id,episode,period,created_at) VALUES (?,?,?,?,?)', [v.id, 'midnight', ep, period, stamp]);
  await testDb.run('INSERT INTO subscription_views (user_id,drama_id,episode,period,created_at) VALUES (?,?,?,?,?)', [v.id, 'moon', 5, period, stamp]);
  await testDb.run('UPDATE orders SET created_at=? WHERE user_id=? AND kind=?', [stamp, v.id, 'subscription']);
  const [{ n: pool }] = await testDb.all("SELECT SUM(amount - channel_fee) AS n FROM orders WHERE kind='subscription' AND created_at=?", [stamp]);
  // 더 앞 달에 마감 안 된 기록이 있으면 순서대로 마감하라고 막는다
  const older = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 15));
  await testDb.run('INSERT INTO subscription_views (user_id,drama_id,episode,period,created_at) VALUES (?,?,?,?,?)', [v.id, 'moon', 6, older.toISOString().slice(0, 7), older.toISOString()]);
  assert.equal((await request('/admin/settlements/close', { method: 'POST', cookie: admin, body: { period } })).status, 409);
  assert.equal((await request('/admin/settlements/close', { method: 'POST', cookie: admin, body: { period: older.toISOString().slice(0, 7) } })).status, 200);
  const closed = await request('/admin/settlements/close', { method: 'POST', cookie: admin, body: { period } });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.pool, Number(pool));
  const byPd = Object.fromEntries(closed.data.shares.map((s) => [s.pd_id, s]));
  assert.equal(byPd['demo-pd'].weight, 3);
  assert.equal(byPd['demo-pd-2'].weight, 1);
  assert.equal(byPd['demo-pd'].gross + byPd['demo-pd-2'].gross, Number(pool));
  // 잘못된 기간 형식은 거절
  assert.equal((await request('/admin/settlements/close', { method: 'POST', cookie: admin, body: { period: '2025-13' } })).status, 400);
});

test('a channel hidden by an administrator cannot be re-published by its PD', async () => {
  const p = await newUser('chan', 'pd');
  const body = { name: '숨김 방송국', slug: 'hide-' + runId.slice(0, 8), status: 'active' };
  assert.equal((await request('/studio/channel', { method: 'PUT', cookie: p.cookie, body })).status, 200);
  const ch = (await testDb.all('SELECT id FROM channels WHERE owner_id=?', [p.id]))[0];
  assert.equal((await request('/admin/channels/' + ch.id, { method: 'PATCH', cookie: admin, body: { status: 'hidden', featured: false } })).status, 200);
  assert.equal((await request('/studio/channel', { method: 'PUT', cookie: p.cookie, body })).status, 409);
  assert.equal((await request('/studio/channel', { method: 'PUT', cookie: p.cookie, body: { ...body, status: 'hidden', tagline: '수정은 가능' } })).status, 200);
  assert.equal((await testDb.all('SELECT status FROM channels WHERE id=?', [ch.id]))[0].status, 'hidden');
  // 관리자가 다시 공개하면 PD도 자유롭게 바꿀 수 있다
  await request('/admin/channels/' + ch.id, { method: 'PATCH', cookie: admin, body: { status: 'active', featured: false } });
  assert.equal((await request('/studio/channel', { method: 'PUT', cookie: p.cookie, body: { ...body, status: 'draft' } })).status, 200);
});

test('PD dashboard orders do not reveal buyer ids or idempotency keys', async () => {
  const r = await request('/studio', { cookie: pd });
  assert.equal(r.status, 200);
  assert.ok(r.data.orders.length > 0);
  for (const o of r.data.orders) {
    assert.equal(o.user_id, undefined);
    assert.equal(o.idempotency_key, undefined);
  }
});

test('tax report groups by payment date in Korean time and accepts a year', async () => {
  const r = await request('/admin/tax?year=2025', { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.year, '2025');
  assert.equal((await request('/admin/tax?year=20x5', { cookie: admin })).status, 400);
});
