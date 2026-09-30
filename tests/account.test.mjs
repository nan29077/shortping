// 계정·운영 고도화(2026-09-29) 검증: 이메일·문자 발송 설정(log·webhook), 비밀번호 찾기, 휴대폰 인증,
// 회원 탈퇴, 계좌번호 암호화(이전·가림·전체 보기 기록), 구독 배분 규칙(진행률·상한·가중치·제외·PD 상한 재분배),
// 공개 목록 칸 제한, 썸네일 클릭 중복 방지, 상태 확인(DB), 입력 오류 문구.
// SQLite(기본)와 PostgreSQL(TEST_PG_ADMIN_URL 지정) 모두에서 같은 결과가 나와야 합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';

const port = 5291,
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
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
const PASSWORD = 'AccountTest!2026';
async function newUser(tag, role = 'viewer') {
  const email = `${tag}-${runId.slice(0, 8)}@account.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: PASSWORD, name: '계정 ' + tag } });
  assert.equal(reg.status, 200, reg.text);
  if (role !== 'viewer')
    assert.equal(
      (await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role, status: 'active', name: '계정 ' + tag, phone: '' } })).status,
      200,
    );
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).cookie;
  return { id: reg.data.user.id, email, cookie };
}
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
// 발송 기록(log 방식)에서 가장 최근 메시지를 찾습니다. 재설정 메일은 응답과 따로 보내므로 잠깐 기다립니다.
async function outboxFor(userId, purpose, after = '') {
  for (let i = 0; i < 40; i++) {
    const rows = await testDb.all(
      'SELECT * FROM message_outbox WHERE user_id=? AND purpose=? AND created_at>? ORDER BY created_at DESC',
      [userId, purpose, after],
    );
    if (rows.length) return rows[0];
    await sleep(100);
  }
  return null;
}

before(async () => {
  testDb = await prepareTestDb(runId, dataDir);
  await start();
  admin = await login('admin');
});
after(async () => {
  if (child) await stop();
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('health check touches the database', async () => {
  const r = await request('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('admin messaging settings: secret is stored encrypted and never returned; webhook provider signs requests', async () => {
  const viewer = await login('viewer');
  assert.equal((await request('/admin/messaging', { cookie: viewer })).status, 403);
  const first = await request('/admin/messaging', { cookie: admin });
  assert.equal(first.status, 200);
  assert.equal(first.data.config.email_provider, 'log'); // 개발·테스트 기본값
  assert.ok(first.data.providers.some((p) => p.id === 'webhook'));

  // 웹훅 받는 쪽(중계 서버 흉내)
  const received = [];
  const hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/relay`;
  try {
    const saved = await request('/admin/messaging', {
      method: 'PUT',
      cookie: admin,
      body: { email_provider: 'webhook', sms_provider: 'log', webhook_url: hookUrl, secret: 'top-secret-value', sender_name: '숏핑', sender_email: 'no-reply@shortping.test' },
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.config.secret_set, true);
    assert.ok(!saved.text.includes('top-secret-value'));
    const again = await request('/admin/messaging', { cookie: admin });
    assert.ok(!again.text.includes('top-secret-value'));
    assert.equal(again.data.config.secret_set, true);
    const [row] = await testDb.all("SELECT value FROM platform_settings WHERE key='messaging_config'");
    assert.ok(!row.value.includes('top-secret-value'), 'DB에도 평문이 없어야 함');
    // 비밀값을 보내지 않고 저장하면 기존 비밀값 유지
    assert.equal((await request('/admin/messaging', { method: 'PUT', cookie: admin, body: { sender_name: '숏핑 운영' } })).data.config.secret_set, true);

    const sent = await request('/admin/messaging/test', { method: 'POST', cookie: admin, body: { channel: 'email', to: 'ops@account.test' } });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-shortping-secret'], 'top-secret-value');
    assert.match(received[0].headers['x-shortping-signature'], /^sha256=[a-f0-9]{64}$/);
    assert.equal(received[0].body.to, 'ops@account.test');
    assert.equal(received[0].body.channel, 'email');
    const outbox = (await request('/admin/messaging', { cookie: admin })).data.outbox;
    assert.equal(outbox[0].status, 'sent');
    assert.equal(outbox[0].provider, 'webhook');
    assert.ok(!outbox[0].recipient.includes('ops@'), '수신자는 가려서 기록');
  } finally {
    hook.close();
  }
  // 웹훅이 실패하면 502 + 실패 기록
  await request('/admin/messaging', { method: 'PUT', cookie: admin, body: { webhook_url: 'http://127.0.0.1:9/nowhere' } });
  assert.equal((await request('/admin/messaging/test', { method: 'POST', cookie: admin, body: { channel: 'email', to: 'ops@account.test' } })).status, 502);
  const [failed] = await testDb.all("SELECT status FROM message_outbox WHERE purpose='test' ORDER BY created_at DESC LIMIT 1");
  assert.equal(failed.status, 'failed');
  // 꺼 두면 발송이 필요한 기능은 503으로 안내
  await request('/admin/messaging', { method: 'PUT', cookie: admin, body: { email_provider: 'none', secret: '' } });
  const off = await request('/auth/password-reset/request', { method: 'POST', body: { email: 'nobody@account.test' } });
  assert.equal(off.status, 503);
  assert.match(off.data.error, /이메일 발송을 설정하지 않았어요/);
  assert.equal((await request('/admin/messaging', { cookie: admin })).data.config.secret_set, false);
  assert.equal((await request('/admin/messaging', { method: 'PUT', cookie: admin, body: { email_provider: 'log', sms_provider: 'log', webhook_url: '' } })).status, 200);
});

test('password reset: same answer for unknown emails, single-use token, expiry, all sessions revoked', async () => {
  const u = await newUser('reset');
  const known = await request('/auth/password-reset/request', { method: 'POST', body: { email: u.email } });
  const unknown = await request('/auth/password-reset/request', { method: 'POST', body: { email: 'ghost-' + runId + '@account.test' } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.data, unknown.data, '가입 여부와 상관없이 같은 응답');
  const mail = await outboxFor(u.id, 'password_reset');
  assert.ok(mail, '재설정 메일 기록');
  const token = /token=([a-f0-9]{64})/.exec(mail.body)?.[1];
  assert.ok(token);
  // DB에는 토큰 원문이 아니라 해시만
  const [stored] = await testDb.all('SELECT token_hash FROM password_resets WHERE user_id=?', [u.id]);
  assert.notEqual(stored.token_hash, token);

  const short = await request('/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'short' } });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /8자 이상/);
  const ok = await request('/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'NewPassword!2026' } });
  assert.equal(ok.status, 200, ok.text);
  // 기존 로그인은 모두 끊김
  assert.equal((await request('/auth/me', { cookie: u.cookie })).data.user, null);
  // 한 번 쓴 링크는 다시 못 씀
  assert.equal((await request('/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'Another!2026x' } })).status, 400);
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: u.email, password: PASSWORD } })).status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: u.email, password: 'NewPassword!2026' } })).status, 200);

  // 만료된 링크
  const stamp = new Date().toISOString();
  await request('/auth/password-reset/request', { method: 'POST', body: { email: u.email } });
  const mail2 = await outboxFor(u.id, 'password_reset', stamp);
  const token2 = /token=([a-f0-9]{64})/.exec(mail2.body)[1];
  await testDb.run('UPDATE password_resets SET expires_at=? WHERE used_at IS NULL AND user_id=?', [new Date(Date.now() - 1000).toISOString(), u.id]);
  const expired = await request('/auth/password-reset/confirm', { method: 'POST', body: { token: token2, password: 'Expired!2026x' } });
  assert.equal(expired.status, 400);
  assert.match(expired.data.error, /만료/);
});

test('phone verification: format check, wrong-code limit, success, daily send limit', async () => {
  const u = await newUser('phone');
  assert.equal((await request('/account/phone/send', { method: 'POST', cookie: u.cookie, body: { phone: '02-123-4567' } })).status, 400);
  const phone = '010-' + String(1000 + Math.floor(Math.random() * 8999)) + '-' + String(1000 + Math.floor(Math.random() * 8999));
  const s1 = await request('/account/phone/send', { method: 'POST', cookie: u.cookie, body: { phone: phone.replace(/-/g, '') } });
  assert.equal(s1.status, 200, s1.text);
  assert.equal(s1.data.phone, phone);
  const sms = await outboxFor(u.id, 'phone_verify');
  const code = /(\d{6})/.exec(sms.body)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 4; i++) {
    const r = await request('/account/phone/verify', { method: 'POST', cookie: u.cookie, body: { phone, code: wrong } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, new RegExp(`남은 기회 ${5 - i}번`));
  }
  assert.equal((await request('/account/phone/verify', { method: 'POST', cookie: u.cookie, body: { phone, code: wrong } })).status, 429);
  // 다섯 번 틀린 인증번호는 맞게 넣어도 안 됨
  assert.equal((await request('/account/phone/verify', { method: 'POST', cookie: u.cookie, body: { phone, code } })).status, 429);
  const after = new Date().toISOString();
  assert.equal((await request('/account/phone/send', { method: 'POST', cookie: u.cookie, body: { phone } })).status, 200);
  const code2 = /(\d{6})/.exec((await outboxFor(u.id, 'phone_verify', after)).body)[1];
  const ok = await request('/account/phone/verify', { method: 'POST', cookie: u.cookie, body: { phone, code: code2 } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.user.phone_verified, true);
  const me = (await request('/auth/me', { cookie: u.cookie })).data.user;
  assert.equal(me.phone, phone);
  assert.equal(me.phone_verified, true);
  // 하루 5번까지(이미 2번 보냄)
  for (let i = 0; i < 3; i++) assert.equal((await request('/account/phone/send', { method: 'POST', cookie: u.cookie, body: { phone } })).status, 200);
  const limit = await request('/account/phone/send', { method: 'POST', cookie: u.cookie, body: { phone } });
  assert.equal(limit.status, 429);
  assert.match(limit.data.error, /하루 5번/);
  // 다른 계정은 이미 인증된 번호를 쓸 수 없음
  const other = await newUser('phone2');
  assert.equal((await request('/account/phone/send', { method: 'POST', cookie: other.cookie, body: { phone } })).status, 409);
});

async function seedAvailable(pdId, amount) {
  const stamp = new Date(Date.now() - 30 * 86400000).toISOString();
  await testDb.run(
    "INSERT INTO settlement_entries (id,pd_id,order_id,drama_id,kind,period,gross,platform_fee,pg_fee,net,fee_rate,status,confirm_at,created_at) VALUES (?,?,NULL,NULL,'ping',?,?,0,0,?,30,'available',?,?)",
    [randomUUID(), pdId, stamp.slice(0, 7), amount, amount, stamp, stamp],
  );
}

test('account numbers: encrypted at rest, masked in admin lists, full for the owner, reveal is audited', async () => {
  const p = await newUser('bank', 'pd');
  const put = await request('/studio/tax', {
    method: 'PUT',
    cookie: p.cookie,
    body: { business_type: 'individual', bank_name: '국민은행', account_number: '110-123-456789', account_holder: '계정 PD' },
  });
  assert.equal(put.status, 200, put.text);
  const [profile] = await testDb.all('SELECT account_number FROM pd_tax_profiles WHERE user_id=?', [p.id]);
  assert.match(profile.account_number, /^enc:v1:/);
  assert.ok(!profile.account_number.includes('456789'));
  // PD 본인 설정 화면에는 전체 번호
  assert.equal((await request('/studio/settlement', { cookie: p.cookie })).data.profile.account_number, '110-123-456789');
  await seedAvailable(p.id, 50000);
  const payout = await request('/studio/payouts', { method: 'POST', cookie: p.cookie, body: {} });
  assert.equal(payout.status, 201, payout.text);
  const [stored] = await testDb.all('SELECT account_number FROM payouts WHERE id=?', [payout.data.id]);
  assert.match(stored.account_number, /^enc:v1:/);
  // 관리자 목록·세무 목록·회원 상세·PD 출금 내역은 가린 번호
  const list = (await request('/admin/settlements', { cookie: admin })).data.payouts.find((x) => x.id === payout.data.id);
  assert.equal(list.account_number, '110-***-***789');
  const tax = (await request('/admin/tax', { cookie: admin })).data.creators.find((x) => x.id === p.id);
  assert.equal(tax.account_number, '110-***-***789');
  const member = (await request('/admin/members/' + p.id, { cookie: admin })).data;
  assert.equal(member.tax.account_number, '110-***-***789');
  assert.equal(member.payouts[0].account_number, '110-***-***789');
  assert.equal((await request('/studio/settlement', { cookie: p.cookie })).data.payouts[0].account_number, '110-***-***789');
  // 전체 보기는 관리자만, 운영 기록이 남음
  assert.equal((await request('/admin/payouts/' + payout.data.id + '/account', { method: 'POST', cookie: p.cookie })).status, 403);
  const reveal = await request('/admin/payouts/' + payout.data.id + '/account', { method: 'POST', cookie: admin });
  assert.equal(reveal.status, 200);
  assert.equal(reveal.data.account_number, '110-123-456789');
  const logs = await testDb.all("SELECT actor_id FROM audit_logs WHERE action='payout:account-revealed' AND target_id=?", [payout.data.id]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor_id, 'demo-admin');
  // 출금 처리(지급 완료)도 그대로 동작
  assert.equal((await request('/admin/payouts/' + payout.data.id, { method: 'POST', cookie: admin, body: { action: 'paid' } })).status, 200);
});

test('withdrawal: blocked while a payout is pending, confirmation for forfeited balances, anonymized, email reusable', async () => {
  const w = await newUser('leave', 'pd');
  await request('/studio/tax', { method: 'PUT', cookie: w.cookie, body: { business_type: 'individual', bank_name: '신한은행', account_number: '100-200-300400', account_holder: '떠나는 PD' } });
  await seedAvailable(w.id, 30000);
  const payout = await request('/studio/payouts', { method: 'POST', cookie: w.cookie, body: {} });
  assert.equal(payout.status, 201);
  const check = await request('/account/withdraw', { cookie: w.cookie });
  assert.ok(check.data.blockers.length > 0);
  const blocked = await request('/account/withdraw', { method: 'POST', cookie: w.cookie, body: { password: PASSWORD, confirm: true } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /출금 신청/);
  // 관리자가 반려하면 정산금이 다시 '출금 가능'으로 돌아옴 → 사라지는 항목이 있어 확인이 필요
  assert.equal((await request('/admin/payouts/' + payout.data.id, { method: 'POST', cookie: admin, body: { action: 'rejected', memo: '탈퇴 요청' } })).status, 200);
  assert.equal((await request('/account/withdraw', { method: 'POST', cookie: w.cookie, body: { password: 'wrong-password' } })).status, 400);
  const confirm = await request('/account/withdraw', { method: 'POST', cookie: w.cookie, body: { password: PASSWORD } });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.data.code, 'confirm_required');
  assert.ok((await request('/account/withdraw', { cookie: w.cookie })).data.warnings.some((x) => /정산금/.test(x)));
  const done = await request('/account/withdraw', { method: 'POST', cookie: w.cookie, body: { password: PASSWORD, reason: '테스트 탈퇴', confirm: true } });
  assert.equal(done.status, 200, done.text);
  // 로그인 불가, 세션 삭제, 개인정보 지움, 금전 기록은 남김
  assert.equal((await request('/auth/me', { cookie: w.cookie })).data.user, null);
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: w.email, password: PASSWORD } })).status, 401);
  const [row] = await testDb.all('SELECT email,name,status,password,phone,withdrawn_at FROM users WHERE id=?', [w.id]);
  assert.equal(row.status, 'withdrawn');
  assert.equal(row.name, '탈퇴한 회원');
  assert.equal(row.email, `withdrawn+${w.id}@deleted.local`);
  assert.equal(row.password, '');
  assert.ok(row.withdrawn_at);
  const [taxRow] = await testDb.all('SELECT account_number,account_holder FROM pd_tax_profiles WHERE user_id=?', [w.id]);
  assert.equal(taxRow.account_number, '');
  assert.equal(taxRow.account_holder, '');
  assert.equal((await testDb.all('SELECT id FROM payouts WHERE pd_id=?', [w.id])).length, 1);
  assert.equal((await testDb.all('SELECT id FROM settlement_entries WHERE pd_id=?', [w.id])).length, 1);
  // 같은 이메일로 다시 가입할 수 있음
  const again = await request('/auth/register', { method: 'POST', body: { email: w.email, password: PASSWORD, name: '다시 온 회원' } });
  assert.equal(again.status, 200, again.text);
  // 공용 테스트 계정은 탈퇴 불가
  assert.equal((await request('/account/withdraw', { method: 'POST', cookie: await login('viewer'), body: { password: 'x', confirm: true } })).status, 400);
});

test('subscription distribution: progress threshold, per-subscriber caps, weight, exclusion, PD cap redistribution', async () => {
  const period = '2024-01';
  const at = (i) => new Date(Date.UTC(2024, 0, 10, 0, 0, i)).toISOString();
  const s1 = await newUser('sub1');
  const s2 = await newUser('sub2');
  const c = await newUser('subpd', 'pd');
  await testDb.run(
    "INSERT INTO dramas (id,owner_id,title,tagline,synopsis,genre,image,status,created_at) VALUES (?,?,?,?,?,?,?,'draft',?)",
    ['acct-c-' + runId.slice(0, 8), c.id, '배분 검증', '배분 검증', '배분 검증용 작품입니다.', '로맨스', '/images/hero.webp', at(0)],
  );
  const cDrama = 'acct-c-' + runId.slice(0, 8);
  // 풀: 1만원 × 2 = 20,000원
  for (const s of [s1, s2])
    await testDb.run(
      "INSERT INTO orders (id,user_id,drama_id,kind,amount,status,idempotency_key,created_at,channel,channel_fee) VALUES (?,?,NULL,'subscription',10000,'test_paid',?,?,'web',0)",
      [randomUUID(), s.id, randomUUID(), at(1)],
    );
  const view = (user, drama, ep, i, qualified = 1) =>
    testDb.run('INSERT INTO subscription_views (user_id,drama_id,episode,period,created_at,qualified) VALUES (?,?,?,?,?,?)', [user, drama, ep, period, at(i), qualified]);
  let i = 10;
  for (let ep = 1; ep <= 25; ep++) await view(s1.id, 'midnight', ep, i++); // demo-pd: 25회 중 작품당 상한 20회
  for (let ep = 1; ep <= 5; ep++) await view(s1.id, 'moon', ep, i++); // demo-pd-2: 구독자 상한(24)에 걸려 4회만
  await view(s1.id, 'moon', 6, i++, 0); // 진행률 기준 미달 → 제외
  for (let ep = 1; ep <= 10; ep++) await view(s2.id, cDrama, ep, i++); // PD C: 10회

  const settings = (await request('/admin/settings', { cookie: admin })).data.settings;
  assert.equal(settings.sub_min_progress_pct, 30);
  assert.equal((await request('/admin/settings', { method: 'PUT', cookie: admin, body: { sub_view_rules_enabled: 1, sub_cap_per_drama: 20, sub_cap_per_user: 24 } })).status, 200);
  // PD 개별 설정: demo-pd-2 가중치 2배, demo-pd는 풀의 40% 상한
  const pd = await login('pd');
  assert.equal((await request('/admin/members/demo-pd-2/subscription-override', { method: 'PUT', cookie: pd, body: { weight: 2, excluded: false, cap_pct: 0 } })).status, 403);
  assert.equal((await request('/admin/members/demo-pd-2/subscription-override', { method: 'PUT', cookie: admin, body: { weight: 2, excluded: false, cap_pct: 0, memo: '독점 계약' } })).status, 200);
  assert.equal((await request('/admin/members/demo-pd/subscription-override', { method: 'PUT', cookie: admin, body: { weight: 1, excluded: false, cap_pct: 40 } })).status, 200);
  assert.equal((await request('/admin/members/demo-pd/subscription-override', { method: 'PUT', cookie: admin, body: { weight: 9, excluded: false, cap_pct: 40 } })).status, 400);
  assert.ok((await testDb.all("SELECT id FROM audit_logs WHERE action LIKE 'sub-override:%' AND target_id='demo-pd-2'")).length >= 1);
  assert.equal((await request('/admin/members/demo-pd-2', { cookie: admin })).data.subscriptionOverride.weight, 2);

  const preview = async () => {
    const r = await request('/admin/subscription/preview?period=' + period, { cookie: admin });
    assert.equal(r.status, 200, r.text);
    return { ...r.data, by: Object.fromEntries(r.data.shares.map((s) => [s.pd_id, s])) };
  };
  // 인정 재생: A(demo-pd) 20, B(demo-pd-2) 4, C 10 → 가중: A 20, B 8, C 10 (합 38)
  // A 몫 20,000×20/38 = 10,526 > 상한 8,000 → 8,000. 남은 12,000을 B:C = 8:10으로 → 5,333.3 / 6,666.7
  // 절사 후 남은 1원은 가중이 가장 큰 C에게 → A 8,000 · B 5,333 · C 6,667
  let p = await preview();
  assert.equal(p.pool, 20000);
  assert.equal(p.by['demo-pd'].weight, 20);
  assert.equal(p.by['demo-pd-2'].weight, 4);
  assert.equal(p.by[c.id].weight, 10);
  assert.equal(p.capped_views, 6);
  assert.equal(p.by['demo-pd'].capped, true);
  assert.equal(p.by['demo-pd'].gross, 8000);
  assert.equal(p.by['demo-pd-2'].gross, 5333);
  assert.equal(p.by[c.id].gross, 6667);
  assert.equal(p.undistributed, 0);
  // C 제외 → A 20, B 8: A 몫 14,285 > 8,000 → 8,000, B 12,000
  assert.equal((await request('/admin/members/' + c.id + '/subscription-override', { method: 'PUT', cookie: admin, body: { weight: 1, excluded: true, cap_pct: 0 } })).status, 200);
  p = await preview();
  assert.equal(p.by['demo-pd'].gross, 8000);
  assert.equal(p.by['demo-pd-2'].gross, 12000);
  assert.equal(p.by[c.id].gross, 0);
  // 규칙을 끄면 예전처럼 모든 재생(미달 포함, 상한 없음)을 셈: A 25, B 6
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { sub_view_rules_enabled: 0 } });
  p = await preview();
  assert.equal(p.by['demo-pd'].weight, 25);
  assert.equal(p.by['demo-pd-2'].weight, 6);
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { sub_view_rules_enabled: 1 } });
  // 제외를 풀고(기본값으로 되돌리면 개별 설정 삭제) 마감 → 정산 원장에 기록
  assert.equal((await request('/admin/members/' + c.id + '/subscription-override', { method: 'PUT', cookie: admin, body: { weight: 1, excluded: false, cap_pct: 0 } })).data.override, null);
  const closed = await request('/admin/settlements/close', { method: 'POST', cookie: admin, body: { period } });
  assert.equal(closed.status, 200, closed.text);
  const entries = Object.fromEntries(
    (await testDb.all("SELECT pd_id, gross FROM settlement_entries WHERE kind='subscription' AND period=?", [period])).map((e) => [e.pd_id, Number(e.gross)]),
  );
  assert.deepEqual(entries, { 'demo-pd': 8000, 'demo-pd-2': 5333, [c.id]: 6667 });
  // 원래 값으로 되돌림
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { sub_cap_per_drama: 20, sub_cap_per_user: 200 } });
  await request('/admin/members/demo-pd/subscription-override', { method: 'PUT', cookie: admin, body: { weight: 1, excluded: false, cap_pct: 0 } });
  await request('/admin/members/demo-pd-2/subscription-override', { method: 'PUT', cookie: admin, body: { weight: 1, excluded: false, cap_pct: 0 } });
});

test('a subscriber view counts only after enough progress; views go up once per day', async () => {
  const s = await newUser('watcher');
  assert.equal((await request('/checkout', { method: 'POST', cookie: s.cookie, body: { kind: 'subscription', idempotencyKey: randomUUID() } })).status, 200);
  const viewsOf = async () => (await request('/dramas')).data.find((d) => d.id === 'midnight').views;
  const before = await viewsOf();
  assert.equal((await fetch(`${base}/api/play/midnight/5`, { headers: { cookie: s.cookie } })).status, 200);
  const q = async () => (await testDb.all('SELECT qualified FROM subscription_views WHERE user_id=? AND drama_id=? AND episode=5', [s.id, 'midnight']))[0].qualified;
  assert.equal(Number(await q()), 0);
  // 12초 회차의 16%(2초)는 기준(30%) 미달
  await request('/history', { method: 'POST', cookie: s.cookie, body: { dramaId: 'midnight', episode: 5, progress: 2 } });
  assert.equal(Number(await q()), 0);
  assert.equal(await viewsOf(), before);
  await sleep(2000);
  await request('/history', { method: 'POST', cookie: s.cookie, body: { dramaId: 'midnight', episode: 5, progress: 5 } });
  assert.equal(Number(await q()), 1);
  assert.equal(await viewsOf(), before + 1);
  // 같은 날 같은 회차는 조회수에 한 번만
  await request('/history', { method: 'POST', cookie: s.cookie, body: { dramaId: 'midnight', episode: 5, progress: 9 } });
  assert.equal(await viewsOf(), before + 1);
});

test('public catalog hides internal columns; thumbnail clicks count once per viewer per day', async () => {
  const list = (await request('/dramas')).data;
  for (const d of list) {
    assert.equal('owner_id' in d, false);
    assert.equal('review_note' in d, false);
    assert.equal('rights_confirmed' in d, false);
  }
  const detail = (await request('/dramas/midnight')).data;
  assert.equal('owner_id' in detail, false);
  assert.equal(detail.episodes.length, 12);
  // 작품 주인은 관리용 칸도 받음
  assert.equal((await request('/dramas/midnight', { cookie: await login('pd') })).data.owner_id, 'demo-pd');
  const ch = (await request('/channels')).data[0];
  assert.equal('owner_id' in ch, false);
  assert.equal('admin_hidden' in ch, false);

  const [a, b] = [randomUUID(), randomUUID()];
  for (const id of [a, b])
    await testDb.run("INSERT INTO drama_thumbnails (id,drama_id,url,active,reviewed,created_at) VALUES (?,?,'/images/hero.webp',1,1,?)", [id, 'moon', new Date().toISOString()]);
  for (let n = 0; n < 3; n++) await request('/dramas/moon?t=' + a);
  const viewer = await login('viewer');
  await request('/dramas/moon?t=' + a, { cookie: viewer });
  await request('/dramas/moon?t=' + a, { cookie: viewer });
  const [row] = await testDb.all('SELECT clicks FROM drama_thumbnails WHERE id=?', [a]);
  assert.equal(Number(row.clicks), 2, '익명(IP) 1번 + 로그인 회원 1번');
});

test('validation errors carry a readable Korean message; admins see only their own tickets on the viewer page', async () => {
  const r = await request('/auth/register', { method: 'POST', body: { email: 'short@account.test', password: 'short', name: '짧은비번' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /비밀번호는 8자 이상/);
  assert.equal(r.data.field, 'password');
  const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await bad.text(), /\/root\/|node_modules|SyntaxError/);

  const viewer = await login('viewer');
  await request('/support', { method: 'POST', cookie: viewer, body: { category: '이용 문의', title: '시청자 문의', body: '시청자가 남긴 문의 내용입니다.' } });
  await request('/support', { method: 'POST', cookie: admin, body: { category: '이용 문의', title: '관리자 문의', body: '관리자가 직접 남긴 문의입니다.' } });
  const all = (await request('/support', { cookie: admin })).data;
  assert.ok(all.some((t) => t.title === '시청자 문의'));
  const mine = (await request('/support?mine=1', { cookie: admin })).data;
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((t) => t.user_id === 'demo-admin'));
});

test('avatar uploads: size limits, and replacing an avatar removes the old uploaded file', async () => {
  const sharp = (await import('sharp')).default;
  const u = await newUser('avatar');
  const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } }).png().toBuffer();
  const upload = async (buf) => {
    const body = new FormData();
    body.set('file', new Blob([buf], { type: 'image/png' }), 'a.png');
    const r = await fetch(base + '/api/account/avatar', { method: 'POST', headers: { cookie: u.cookie }, body });
    return { status: r.status, data: await r.json() };
  };
  const tiny = await upload(await png(32, 32));
  assert.equal(tiny.status, 400);
  assert.match(tiny.data.error, /64~4096px/);
  const first = await upload(await png(120, 120));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const me = (await request('/auth/me', { cookie: u.cookie })).data.user;
  const profile = { name: me.name, bio: '', auto_next: true };
  assert.equal((await request('/account/profile', { method: 'PATCH', cookie: u.cookie, body: { ...profile, avatar: first.data.url } })).status, 200);
  const second = await upload(await png(200, 200));
  assert.equal((await request('/account/profile', { method: 'PATCH', cookie: u.cookie, body: { ...profile, avatar: second.data.url } })).status, 200);
  assert.equal((await testDb.all('SELECT url FROM media_files WHERE url=?', [first.data.url])).length, 0, '전 프로필 이미지는 지워짐');
  assert.equal((await testDb.all('SELECT url FROM media_files WHERE url=?', [second.data.url])).length, 1);
});

test('chunked upload sessions are capped per user', async () => {
  const pd = await newUser('uploader', 'pd');
  const ids = [];
  for (let n = 0; n < 5; n++) {
    const r = await request('/studio/uploads', { method: 'POST', cookie: pd.cookie, body: { size: 1024, mime: 'video/mp4' } });
    assert.equal(r.status, 201, r.text);
    ids.push(r.data.id);
  }
  const over = await request('/studio/uploads', { method: 'POST', cookie: pd.cookie, body: { size: 1024, mime: 'video/mp4' } });
  assert.equal(over.status, 429);
  // 오래 멈춘 업로드는 만료되어 자리가 납니다.
  await testDb.run('UPDATE upload_sessions SET updated_at=? WHERE id=?', [new Date(Date.now() - 7 * 3600000).toISOString(), ids[0]]);
  assert.equal((await request('/studio/uploads', { method: 'POST', cookie: pd.cookie, body: { size: 1024, mime: 'video/mp4' } })).status, 201);
  assert.equal((await testDb.all('SELECT status FROM upload_sessions WHERE id=?', [ids[0]]))[0].status, 'expired');
});

test('readiness warns about proxies once forwarded requests arrive', async () => {
  const before = (await request('/admin/readiness', { cookie: admin })).data;
  assert.ok(!before.warnings.some((w) => w.id === 'proxy'));
  await request('/health', { headers: { 'X-Forwarded-For': '203.0.113.7' } });
  const after = (await request('/admin/readiness', { cookie: admin })).data;
  const w = after.warnings.find((x) => x.id === 'proxy');
  assert.ok(w);
  assert.match(w.title, /TRUST_PROXY_HOPS/);
});

test('plaintext account numbers left from before are encrypted at startup, idempotently', async () => {
  const p = await newUser('legacy', 'pd');
  await testDb.run(
    "INSERT INTO pd_tax_profiles (user_id,bank_name,account_number,account_holder,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET account_number=excluded.account_number",
    [p.id, '우리은행', '222-333-444555', '예전 PD', new Date().toISOString()],
  );
  const [already] = await testDb.all("SELECT user_id, account_number FROM pd_tax_profiles WHERE account_number LIKE 'enc:%' LIMIT 1");
  await stop();
  await start();
  admin = await login('admin');
  const [row] = await testDb.all('SELECT account_number FROM pd_tax_profiles WHERE user_id=?', [p.id]);
  assert.match(row.account_number, /^enc:v1:/);
  // 이미 암호화된 값은 다시 암호화하지 않음
  const [same] = await testDb.all('SELECT account_number FROM pd_tax_profiles WHERE user_id=?', [already.user_id]);
  assert.equal(same.account_number, already.account_number);
  const cookie = (await request('/auth/login', { method: 'POST', body: { email: p.email, password: PASSWORD } })).cookie;
  assert.equal((await request('/studio/settlement', { cookie })).data.profile.account_number, '222-333-444555');
  const plain = await testDb.all("SELECT COUNT(*) AS n FROM pd_tax_profiles WHERE account_number<>'' AND account_number NOT LIKE 'enc:%'");
  assert.equal(Number(plain[0].n), 0);
});
