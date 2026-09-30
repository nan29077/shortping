import { z } from 'zod';
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { hashPassword } from './seed.mjs';
import { loadSettings } from './settings.mjs';
import { walletOf } from './pings.mjs';
import { lamaWalletOf } from './lama.mjs';
import { periodOf, subscriptionPlan, subscriptionPool } from './settlement.mjs';
import { maskAccount, openAccount, plaintextAccountCount } from './bank-secret.mjs';
import {
  channelReady,
  disabledMessage,
  loadMessagingConfig,
  providers,
  publicMessagingConfig,
  recentOutbox,
  saveMessagingConfig,
  sendEmail,
  sendSms,
} from './messaging.mjs';

// 계정·운영 고도화(2026-09-29)
//  - 비밀번호 찾기(이메일 재설정 링크) · 휴대폰 문자 인증 · 회원 탈퇴
//  - 최고 관리자: 이메일·문자 발송 설정 / 발송 기록, 운영 점검 경고, 구독 배분 개별 설정·미리보기, 계좌번호 전체 보기(기록 남김)
const RESET_TTL_MS = 30 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const PHONE_DAILY_LIMIT = 5;
const PHONE_MAX_ATTEMPTS = 5;
const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const changedRows = (r) => Number(r?.rowCount ?? r?.changes ?? 0);
// 한국 휴대폰 번호(010·011·016·017·018·019). 하이픈·공백은 무시합니다.
export function normalizePhone(value) {
  const digits = String(value || '').replace(/[\s-]/g, '');
  if (!/^01[016789]\d{7,8}$/.test(digits)) return null;
  return digits.length === 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}
const RESET_SENT = '입력한 이메일로 가입된 계정이 있다면 비밀번호 재설정 안내를 보냈어요. 메일함(스팸함 포함)을 확인해 주세요.';

export function accountRoutes({
  app,
  db,
  fail,
  now,
  roles,
  requireAuth,
  authLimiter,
  sessionToken,
  publicUser,
  origin,
  proxyStatus,
  production,
}) {
  const audit = (actorId, action, targetId) =>
    db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [
      randomUUID(),
      actorId,
      action,
      targetId,
      now(),
    ]);
  const passwordMatches = (stored, password) => {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const want = Buffer.from(hash, 'hex');
    const got = scryptSync(password, salt, 64);
    return want.length === got.length && timingSafeEqual(want, got);
  };

  // ── 비밀번호 찾기 ─────────────────────────────────────────────
  // 가입 여부와 상관없이 늘 같은 응답을 돌려줘 계정이 있는지 알아낼 수 없게 합니다.
  app.post('/api/auth/password-reset/request', authLimiter, async (req, res) => {
    const b = z
      .object({ email: z.email().max(254).transform((v) => v.toLowerCase()) })
      .parse(req.body);
    if (!(await channelReady(db, 'email'))) fail(503, disabledMessage('email'));
    const user = await db.get("SELECT id,email,name FROM users WHERE email=? AND status='active'", [b.email]);
    if (user && !user.id.startsWith('demo-')) {
      // 같은 계정에 15분 동안 3번까지만 보냅니다(메일 폭탄 방지). 넘어도 응답은 같아요.
      const recent = await db.get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id=? AND created_at>?', [
        user.id,
        new Date(Date.now() - 15 * 60_000).toISOString(),
      ]);
      if (Number(recent?.n || 0) < 3) {
        const token = randomBytes(32).toString('hex');
        const stamp = now();
        await db.run('INSERT INTO password_resets (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)', [
          randomUUID(),
          user.id,
          sha256(token),
          new Date(Date.now() + RESET_TTL_MS).toISOString(),
          stamp,
        ]);
        const link = `${origin}/#/reset?token=${token}`;
        // 응답 시간으로 가입 여부가 드러나지 않도록 발송은 기다리지 않습니다(결과는 발송 기록에 남아요).
        void sendEmail(db, {
          to: user.email,
          subject: '[숏핑] 비밀번호 재설정 안내',
          text: `${user.name}님, 아래 링크에서 30분 안에 새 비밀번호를 정해 주세요.\n${link}\n\n요청하지 않았다면 이 메일을 무시해 주세요. 비밀번호는 바뀌지 않아요.`,
          html: `<p>${user.name.replace(/[<>&"]/g, '')}님, 아래 버튼을 눌러 30분 안에 새 비밀번호를 정해 주세요.</p><p><a href="${link}">비밀번호 재설정하기</a></p><p>요청하지 않았다면 이 메일을 무시해 주세요.</p>`,
          purpose: 'password_reset',
          userId: user.id,
        }).catch((e) => console.error('[숏핑] 재설정 메일 발송 실패', e.message));
      }
    }
    res.json({ ok: true, message: RESET_SENT });
  });
  app.post('/api/auth/password-reset/confirm', authLimiter, async (req, res) => {
    const b = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64}$/, '재설정 링크가 올바르지 않아요.'),
        password: z.string().min(8, '비밀번호는 8자 이상 입력해 주세요.').max(128),
      })
      .parse(req.body);
    const expired = '재설정 링크가 만료되었거나 이미 사용되었어요. 비밀번호 찾기를 다시 요청해 주세요.';
    await db.transaction(async () => {
      const row = await db.get('SELECT * FROM password_resets WHERE token_hash=?', [sha256(b.token)]);
      if (!row || row.used_at || row.expires_at <= now()) fail(400, expired);
      await db.lockUser(row.user_id);
      // 동시에 두 번 눌러도 한 번만 쓰이도록 조건부로 표시합니다.
      if (!changedRows(await db.run('UPDATE password_resets SET used_at=? WHERE id=? AND used_at IS NULL', [now(), row.id])))
        fail(400, expired);
      const user = await db.get('SELECT id,status FROM users WHERE id=?', [row.user_id]);
      if (!user || user.status !== 'active') fail(400, expired);
      await db.run('UPDATE users SET password=? WHERE id=?', [hashPassword(b.password), user.id]);
      // 다른 재설정 링크와 모든 로그인(이 기기 포함)을 끊습니다.
      await db.run('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL', [now(), user.id]);
      await db.run('DELETE FROM sessions WHERE user_id=?', [user.id]);
      await audit(user.id, 'user:password-reset', user.id);
    });
    res.json({ ok: true, message: '새 비밀번호로 바꿨어요. 다시 로그인해 주세요.' });
  });

  // ── 휴대폰 인증 ─────────────────────────────────────────────
  app.post('/api/account/phone/send', requireAuth, authLimiter, async (req, res) => {
    const b = z.object({ phone: z.string().max(20) }).parse(req.body);
    const phone = normalizePhone(b.phone);
    if (!phone) fail(400, '휴대폰 번호를 확인해 주세요. 예) 010-1234-5678');
    if (!(await channelReady(db, 'sms'))) fail(503, disabledMessage('sms'));
    const taken = await db.get(
      "SELECT id FROM users WHERE phone=? AND phone_verified_at IS NOT NULL AND id<>? AND status='active'",
      [phone, req.user.id],
    );
    if (taken) fail(409, '이미 다른 계정에서 인증한 번호예요.');
    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    await db.transaction(async () => {
      await db.lockUser(req.user.id);
      const sent = await db.get('SELECT COUNT(*) AS n FROM phone_verifications WHERE user_id=? AND created_at>?', [
        req.user.id,
        new Date(Date.now() - 86400_000).toISOString(),
      ]);
      if (Number(sent?.n || 0) >= PHONE_DAILY_LIMIT)
        fail(429, `인증번호는 하루 ${PHONE_DAILY_LIMIT}번까지 받을 수 있어요. 내일 다시 시도해 주세요.`);
      await db.run(
        'INSERT INTO phone_verifications (id,user_id,phone,code_hash,attempts,expires_at,created_at) VALUES (?,?,?,?,0,?,?)',
        [id, req.user.id, phone, sha256(id + ':' + code), expiresAt, now()],
      );
    });
    try {
      await sendSms(db, {
        to: phone,
        text: `[숏핑] 인증번호 ${code}를 5분 안에 입력해 주세요.`,
        purpose: 'phone_verify',
        userId: req.user.id,
      });
    } catch (e) {
      // 보내지 못한 인증번호는 하루 횟수에서 빼 줍니다.
      await db.run('DELETE FROM phone_verifications WHERE id=?', [id]).catch(() => {});
      throw e;
    }
    res.json({ ok: true, phone, expires_at: expiresAt });
  });
  app.post('/api/account/phone/verify', requireAuth, authLimiter, async (req, res) => {
    const b = z
      .object({ phone: z.string().max(20), code: z.string().trim().regex(/^\d{6}$/, '인증번호 6자리를 입력해 주세요.') })
      .parse(req.body);
    const phone = normalizePhone(b.phone);
    if (!phone) fail(400, '휴대폰 번호를 확인해 주세요. 예) 010-1234-5678');
    const row = await db.get(
      'SELECT * FROM phone_verifications WHERE user_id=? AND phone=? AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [req.user.id, phone],
    );
    if (!row || row.expires_at <= now()) fail(400, '인증번호가 만료되었어요. 인증번호를 다시 받아 주세요.');
    if (Number(row.attempts) >= PHONE_MAX_ATTEMPTS)
      fail(429, `인증번호를 ${PHONE_MAX_ATTEMPTS}번 틀렸어요. 새 인증번호를 받아 주세요.`);
    const want = Buffer.from(row.code_hash, 'hex');
    const got = Buffer.from(sha256(row.id + ':' + b.code), 'hex');
    if (!timingSafeEqual(want, got)) {
      // 동시에 여러 번 보내도 기회가 늘지 않도록 조건부로 올립니다.
      const r = await db.run('UPDATE phone_verifications SET attempts=attempts+1 WHERE id=? AND attempts<?', [row.id, PHONE_MAX_ATTEMPTS]);
      const left = PHONE_MAX_ATTEMPTS - Number(row.attempts) - 1;
      if (!changedRows(r) || left <= 0) fail(429, `인증번호를 ${PHONE_MAX_ATTEMPTS}번 틀렸어요. 새 인증번호를 받아 주세요.`);
      fail(400, `인증번호가 맞지 않아요. (남은 기회 ${left}번)`);
    }
    const stamp = now();
    await db.transaction(async () => {
      if (!changedRows(await db.run('UPDATE phone_verifications SET verified_at=? WHERE id=? AND verified_at IS NULL', [stamp, row.id])))
        fail(409, '이미 확인한 인증번호예요.');
      await db.run('UPDATE users SET phone=?, phone_verified_at=? WHERE id=?', [phone, stamp, req.user.id]);
    });
    res.json({ ok: true, user: publicUser({ ...req.user, phone, phone_verified_at: stamp }) });
  });

  // ── 회원 탈퇴 ─────────────────────────────────────────────
  // 막는 경우: 처리 중인 출금 신청, 진행 중인 AI 작업(예약된 라마), 마지막 관리자.
  // 확인이 필요한 경우(confirm: true): 남은 유료 핑·라마, 아직 받지 않은 정산금 — 탈퇴하면 사라져요.
  async function withdrawCheck(user) {
    const blockers = [];
    const warnings = [];
    const payouts = await db.get("SELECT COUNT(*) AS n FROM payouts WHERE pd_id=? AND status IN ('requested','approved')", [user.id]);
    if (Number(payouts?.n || 0) > 0)
      blockers.push('처리 중인 출금 신청이 있어요. 출금이 끝난 뒤(또는 관리자 반려 후) 탈퇴할 수 있어요.');
    const lama = await lamaWalletOf(db, user.id);
    if (lama.held > 0) blockers.push('진행 중인 AI 제작 작업이 있어요. 작업이 끝난 뒤 탈퇴할 수 있어요.');
    if (user.role === 'admin') {
      const others = await db.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active' AND id<>?", [user.id]);
      if (!Number(others?.n || 0)) blockers.push('마지막 관리자 계정은 탈퇴할 수 없어요. 다른 관리자를 먼저 지정해 주세요.');
    }
    const pings = await walletOf(db, user.id);
    if (pings.paid > 0) warnings.push(`충전한 핑 ${pings.paid.toLocaleString('ko-KR')}핑이 사라져요.`);
    if (pings.bonus > 0) warnings.push(`보너스 핑 ${pings.bonus.toLocaleString('ko-KR')}핑이 사라져요.`);
    if (lama.total > 0) warnings.push(`라마 ${lama.total.toLocaleString('ko-KR')}라마가 사라져요.`);
    const unsettled = await db.get(
      "SELECT COALESCE(SUM(net),0) AS n FROM settlement_entries WHERE pd_id=? AND status IN ('pending','available')",
      [user.id],
    );
    if (Number(unsettled?.n || 0) > 0)
      warnings.push(`아직 출금하지 않은 정산금 ${Number(unsettled.n).toLocaleString('ko-KR')}원을 받을 수 없게 돼요.`);
    const sub = await db.get('SELECT expires_at FROM subscriptions WHERE user_id=? AND expires_at>?', [user.id, now()]);
    if (sub) warnings.push('이용 중인 숏핑 패스가 바로 끝나요.');
    return { blockers, warnings };
  }
  app.get('/api/account/withdraw', requireAuth, async (req, res) => {
    res.json({ ...(await withdrawCheck(req.user)), demo: req.user.id.startsWith('demo-') });
  });
  app.post('/api/account/withdraw', requireAuth, authLimiter, async (req, res) => {
    const b = z
      .object({
        password: z.string().min(1, '비밀번호를 입력해 주세요.').max(128),
        reason: z.string().trim().max(500).default(''),
        confirm: z.boolean().default(false),
      })
      .parse(req.body);
    if (req.user.id.startsWith('demo-')) fail(400, '공용 테스트 계정은 탈퇴할 수 없어요.');
    if (!passwordMatches(req.user.password, b.password)) fail(400, '비밀번호가 일치하지 않아요.');
    await db.transaction(async () => {
      await db.lockUser(req.user.id);
      const user = await db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
      if (!user || user.status !== 'active') fail(409, '이미 탈퇴했거나 이용이 제한된 계정이에요.');
      const { blockers, warnings } = await withdrawCheck(user);
      if (blockers.length) fail(409, blockers.join(' '));
      if (warnings.length && !b.confirm)
        throw Object.assign(new Error('탈퇴하면 사라지는 항목이 있어요. 확인 후 다시 진행해 주세요.'), {
          status: 409,
          code: 'confirm_required',
        });
      const stamp = now();
      // 금전 기록(주문·핑·라마·정산·출금 장부)은 법정 보관을 위해 남기고, 개인을 알아볼 수 있는 정보만 지웁니다.
      await db.run(
        "UPDATE users SET status='withdrawn', withdrawn_at=?, email=?, name='탈퇴한 회원', password='', phone='', phone_verified_at=NULL WHERE id=?",
        [stamp, `withdrawn+${user.id}@deleted.local`, user.id],
      );
      await db.run("UPDATE user_profiles SET bio='' WHERE user_id=?", [user.id]);
      await db.run(
        "UPDATE pd_tax_profiles SET business_no='', business_name='', rep_name='', business_class='', business_item='', tax_email='', bank_name='', account_number='', account_holder='', contact='', address='', updated_at=? WHERE user_id=?",
        [stamp, user.id],
      );
      await db.run('DELETE FROM sessions WHERE user_id=?', [user.id]);
      await db.run('DELETE FROM password_resets WHERE user_id=?', [user.id]);
      await db.run('DELETE FROM phone_verifications WHERE user_id=?', [user.id]);
      await db.run('DELETE FROM favorites WHERE user_id=?', [user.id]);
      await db.run('DELETE FROM history WHERE user_id=?', [user.id]);
      await db.run('DELETE FROM channel_follows WHERE user_id=?', [user.id]);
      await db.run('DELETE FROM notifications WHERE user_id=?', [user.id]);
      await db.run('UPDATE subscriptions SET expires_at=?, auto_renew=0 WHERE user_id=? AND expires_at>?', [stamp, user.id, stamp]);
      // PD였다면 방송국과 공개 작품을 시청자 화면에서 내립니다(작품·정산 기록은 남김).
      await db.run("UPDATE channels SET status='hidden', admin_hidden=1 WHERE owner_id=?", [user.id]);
      await db.run("UPDATE dramas SET status='hidden' WHERE owner_id=? AND status='published'", [user.id]);
      await audit(user.id, 'user:withdrawn', user.id);
      if (b.reason)
        await db.run('INSERT INTO member_notes (id,user_id,actor_id,note,created_at) VALUES (?,?,?,?,?)', [
          randomUUID(),
          user.id,
          user.id,
          '탈퇴 사유: ' + b.reason,
          stamp,
        ]);
    });
    res.clearCookie('sp_session', { path: '/' }).json({ ok: true, message: '탈퇴가 완료됐어요. 그동안 숏핑을 이용해 주셔서 고마워요.' });
  });

  // ── 최고 관리자: 이메일 · 문자 발송 설정 ───────────────────────────
  const providerList = () =>
    Object.entries(providers).map(([id, p]) => ({ id, label: p.label, channels: p.channels }));
  app.get('/api/admin/messaging', roles('admin'), async (req, res) => {
    res.json({
      config: publicMessagingConfig(await loadMessagingConfig(db)),
      providers: providerList(),
      outbox: await recentOutbox(db, 50),
      production,
    });
  });
  app.put('/api/admin/messaging', roles('admin'), async (req, res) => {
    const ids = Object.keys(providers);
    const b = z
      .object({
        email_provider: z.string().refine((v) => ids.includes(v), '알 수 없는 발송 방식이에요.'),
        sms_provider: z.string().refine((v) => ids.includes(v), '알 수 없는 발송 방식이에요.'),
        webhook_url: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(500)]),
        // 보내지 않으면 기존 비밀값 유지, 빈 문자열이면 지우기
        secret: z.string().max(500).optional(),
        sender_name: z.string().trim().max(40),
        sender_email: z.union([z.literal(''), z.email().max(254)]),
        sender_number: z.string().trim().max(20).regex(/^[0-9-]*$/, '발신 번호는 숫자와 하이픈만 입력해 주세요.'),
      })
      .partial()
      .parse(req.body);
    const saved = await saveMessagingConfig(db, b, req.user.id);
    await audit(req.user.id, 'messaging:updated:' + Object.keys(b).filter((k) => k !== 'secret').concat(b.secret !== undefined ? ['secret'] : []).join(','), 'messaging');
    res.json({ config: publicMessagingConfig(saved) });
  });
  app.post('/api/admin/messaging/test', roles('admin'), async (req, res) => {
    const b = z.object({ channel: z.enum(['email', 'sms']), to: z.string().trim().min(3).max(254) }).parse(req.body);
    if (b.channel === 'email' && !z.email().safeParse(b.to).success) fail(400, '받는 이메일 주소를 확인해 주세요.');
    const phone = b.channel === 'sms' ? normalizePhone(b.to) : null;
    if (b.channel === 'sms' && !phone) fail(400, '받는 휴대폰 번호를 확인해 주세요.');
    const sent =
      b.channel === 'email'
        ? await sendEmail(db, {
            to: b.to,
            subject: '[숏핑] 테스트 메일',
            text: '숏핑 이메일 발송 설정이 잘 되어 있어요.',
            html: '<p>숏핑 이메일 발송 설정이 잘 되어 있어요.</p>',
            purpose: 'test',
            userId: req.user.id,
          })
        : await sendSms(db, { to: phone, text: '[숏핑] 문자 발송 설정이 잘 되어 있어요.', purpose: 'test', userId: req.user.id });
    await audit(req.user.id, `messaging:test:${b.channel}`, sent.id);
    res.json({ ok: true, ...sent });
  });

  // ── 최고 관리자: 운영 점검 경고 ─────────────────────────────────
  app.get('/api/admin/readiness', roles('admin'), async (req, res) => {
    const warnings = [];
    const proxy = proxyStatus();
    if (!proxy.hops && (production || proxy.forwardedSeen))
      warnings.push({
        id: 'proxy',
        level: proxy.forwardedSeen ? 'danger' : 'warning',
        title: '프록시 뒤에서 운영한다면 TRUST_PROXY_HOPS를 설정해야 해요',
        text:
          (proxy.forwardedSeen
            ? `최근 X-Forwarded-For 머리글이 붙은 요청이 들어왔어요(마지막 ${new Date(proxy.lastSeenAt).toLocaleString('ko-KR')}, ${proxy.seenCount}건). 로드밸런서·CDN을 거치고 있다는 뜻이에요. `
            : '') +
          '이 값이 없으면 모든 요청이 프록시 IP 하나로 보여 요청 제한이 전체 사용자 공용이 되고, 기록에 남는 IP도 틀려져요. 프록시 수(보통 1)를 서버 환경변수 TRUST_PROXY_HOPS에 넣어 주세요.',
      });
    if (production && !process.env.AI_SECRET_KEY)
      warnings.push({
        id: 'secret-key',
        level: 'danger',
        title: 'AI_SECRET_KEY가 없어요',
        text: '계좌번호·발송 비밀값·AI API 키를 암호화하는 키예요. 설정하기 전에는 새 계좌번호가 암호화되지 않은 채 저장돼요.',
      });
    const plain = await plaintextAccountCount(db);
    if (plain)
      warnings.push({
        id: 'plain-accounts',
        level: 'warning',
        title: `암호화되지 않은 계좌번호 ${plain}건`,
        text: '암호화 키를 설정한 뒤 서버를 다시 시작하면 자동으로 암호화돼요.',
      });
    const m = await loadMessagingConfig(db);
    if (m.email_provider === 'none')
      warnings.push({ id: 'email', level: 'warning', title: '이메일 발송이 꺼져 있어요', text: '회원이 비밀번호 찾기를 쓸 수 없어요. ‘이메일 · 문자 발송’에서 연결해 주세요.' });
    if (m.sms_provider === 'none')
      warnings.push({ id: 'sms', level: 'info', title: '문자 발송이 꺼져 있어요', text: '휴대폰 인증을 쓸 수 없어요. 필요할 때 ‘이메일 · 문자 발송’에서 연결해 주세요.' });
    if (production && (m.email_provider === 'log' || m.sms_provider === 'log'))
      warnings.push({ id: 'log-provider', level: 'danger', title: '운영 환경에서 ‘기록만 남기기’ 발송을 쓰고 있어요', text: '실제로 메일·문자가 나가지 않아요. 웹훅이나 업체 연결로 바꿔 주세요.' });
    res.json({ warnings, proxy: { hops: proxy.hops, forwarded_seen: proxy.forwardedSeen } });
  });

  // ── 최고 관리자: 구독 배분 개별 설정(PD별 가중치·제외·상한) ──────────────
  app.get('/api/admin/subscription/overrides', roles('admin'), async (req, res) => {
    res.json(
      await db.all(
        `SELECT o.*, u.name, u.email, u.role, a.name AS updated_by_name FROM subscription_overrides o
         JOIN users u ON u.id=o.user_id LEFT JOIN users a ON a.id=o.updated_by ORDER BY o.updated_at DESC`,
      ),
    );
  });
  app.put('/api/admin/members/:id/subscription-override', roles('admin'), async (req, res) => {
    const b = z
      .object({
        weight: z.number().min(0).max(5),
        excluded: z.boolean(),
        cap_pct: z.number().min(0).max(100),
        memo: z.string().trim().max(200).default(''),
      })
      .parse(req.body);
    const member = await db.get('SELECT id FROM users WHERE id=?', [req.params.id]);
    if (!member) fail(404, '회원을 찾을 수 없습니다.');
    const isDefault = b.weight === 1 && !b.excluded && b.cap_pct === 0 && !b.memo;
    await db.transaction(async () => {
      if (isDefault) await db.run('DELETE FROM subscription_overrides WHERE user_id=?', [member.id]);
      else
        await db.run(
          'INSERT INTO subscription_overrides (user_id,weight,excluded,cap_pct,memo,updated_at,updated_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET weight=excluded.weight,excluded=excluded.excluded,cap_pct=excluded.cap_pct,memo=excluded.memo,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
          [member.id, b.weight, b.excluded ? 1 : 0, b.cap_pct, b.memo, now(), req.user.id],
        );
      await audit(req.user.id, isDefault ? 'sub-override:reset' : `sub-override:w${b.weight}:${b.excluded ? 'excluded' : 'included'}:cap${b.cap_pct}`, member.id);
    });
    res.json({ ok: true, override: isDefault ? null : { user_id: member.id, ...b, excluded: b.excluded ? 1 : 0 } });
  });
  // 마감 전에 이번 규칙으로 계산하면 어떻게 나뉘는지 미리 봅니다(저장하지 않음).
  app.get('/api/admin/subscription/preview', roles('admin'), async (req, res) => {
    const period = z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .parse(req.query.period || periodOf(now()));
    const settings = await loadSettings(db);
    const pool = await subscriptionPool(db, period);
    const plan = await subscriptionPlan(db, period, pool, settings);
    const names = new Map(
      (await db.all("SELECT id,name FROM users WHERE role IN ('pd','admin')")).map((u) => [u.id, u.name]),
    );
    res.json({ period, pool, ...plan.summary, shares: plan.rows.map((r) => ({ ...r, name: names.get(r.pd_id) || '' })) });
  });

  // ── 계좌번호 전체 보기(관리자, 운영 기록 남김) ──────────────────────
  app.post('/api/admin/payouts/:id/account', roles('admin'), async (req, res) => {
    const payout = await db.get('SELECT id,bank_name,account_number,account_holder FROM payouts WHERE id=?', [req.params.id]);
    if (!payout) fail(404, '출금 요청을 찾을 수 없습니다.');
    await audit(req.user.id, 'payout:account-revealed', payout.id);
    res.json({ bank_name: payout.bank_name, account_number: openAccount(payout.account_number), account_holder: payout.account_holder });
  });
  app.post('/api/admin/tax/:id/account', roles('admin'), async (req, res) => {
    const t = await db.get('SELECT user_id,bank_name,account_number,account_holder FROM pd_tax_profiles WHERE user_id=?', [req.params.id]);
    if (!t) fail(404, '정산 정보를 찾을 수 없습니다.');
    await audit(req.user.id, 'tax:account-revealed', t.user_id);
    res.json({ bank_name: t.bank_name, account_number: openAccount(t.account_number), account_holder: t.account_holder });
  });
  return { maskAccount, normalizePhone, sessionToken };
}
