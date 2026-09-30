import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import {
  randomUUID,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
  createHash,
  createHmac,
} from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { openDb, migrate } from './db.mjs';
import { seed, hashPassword } from './seed.mjs';
import { inspectMedia, precheck } from './media.mjs';
import { loadSettings } from './settings.mjs';
import {
  backfillEntries,
  platformRateFor,
  recordPingSale,
  refreshEntries,
  periodOf,
} from './settlement.mjs';
import {
  channelFeeRate,
  creditPings,
  debitPings,
  episodePingsOf,
  titlePingsOf,
  unitMilliOf,
  walletOf,
} from './pings.mjs';
import { studioRoutes } from './routes-studio.mjs';
import { adminRoutes } from './routes-admin.mjs';
import { uploadRoutes } from './routes-upload.mjs';
import { lamaRoutes } from './routes-lama.mjs';
import { EDITABLE_EPISODE, episodeEditable, serialRoutes } from './routes-serial.mjs';
import { applyThumbs, thumbClick } from './thumbs.mjs';
import { notify } from './notify.mjs';
import { createAiEngine } from './ai/engine.mjs';
import { benchRoutes } from './ai/bench.mjs';
import { createRenderWorker } from './ai/render-worker.mjs';
import { adminAiRoutes, seedMock } from './ai/routes-admin-ai.mjs';
import { studioAiRoutes } from './ai/routes-studio-ai.mjs';
import { allowLocalDownloads } from './ai/http.mjs';
import { appearanceFromSettings } from './home-appearance.mjs';
import { layoutOf } from './home-layout.mjs';
import { injectHomeTags, sharePage, socialOrigin } from './social.mjs';
import { accountRoutes } from './routes-account.mjs';
import { migrateAccountNumbers } from './bank-secret.mjs';
import { publicDrama } from './public-fields.mjs';
import { looksInternal, zodMessage } from './errors.mjs';
import { GENRES } from './genres.mjs';

const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const demo = !production && process.env.ENABLE_DEMO !== 'false';
const port = Number(process.env.PORT || 3033);
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
if (production && (!process.env.DATABASE_URL || !origin.startsWith('https://')))
  throw new Error('Production requires DATABASE_URL and HTTPS APP_ORIGIN');
const db = await openDb();
await migrate(db);
if (demo) await seed(db);
// 평문으로 남아 있던 출금 계좌번호를 암호화합니다(여러 번 실행해도 안전).
await migrateAccountNumbers(db);
const randomAvatar = () => `/avatars/block-${String(randomInt(1, 31)).padStart(2, '0')}.webp`;
// 프로필이 없으면 만들고, 예전 기본 아바타(ping-*.svg)는 새 블록 아바타로 바꾼 뒤 결과를 돌려줍니다(쿼리 한 번).
async function ensureProfile(id) {
  return db.get(
    "INSERT INTO user_profiles (user_id,avatar) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET avatar=CASE WHEN user_profiles.avatar LIKE '/avatars/ping-%.svg' THEN excluded.avatar ELSE user_profiles.avatar END RETURNING avatar,bio,auto_next,auto_unlock",
    [id, randomAvatar()],
  );
}
// 시작할 때는 손볼 필요가 있는 회원(프로필 없음·예전 아바타)만 처리합니다.
for (const user of await db.all(
  "SELECT u.id FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE p.user_id IS NULL OR p.avatar LIKE '/avatars/ping-%.svg'",
))
  await ensureProfile(user.id);
const startupSettings = await loadSettings(db);
await backfillEntries(db, startupSettings);
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
else if (production)
  // 로드밸런서·CDN 뒤에서 이 값이 없으면 모든 요청이 프록시 IP 하나로 보여, 요청 제한이 전체 사용자 공용이 됩니다.
  console.warn(
    '[숏핑] ⚠ TRUST_PROXY_HOPS가 설정되지 않았습니다. 프록시(ALB·Cloudflare·nginx) 뒤에서 운영한다면 프록시 수(보통 1)로 지정하세요. ' +
      '지정하지 않으면 요청 제한·기록 IP가 프록시 주소 하나로 묶입니다. (관리자 > 서비스 상태에도 경고가 표시됩니다)',
  );
// 기본 동작은 바꾸지 않고, 프록시 머리글이 붙은 요청이 오는지만 기록해 관리자 화면 경고에 씁니다.
const proxySeen = { count: 0, lastAt: null };
if (!process.env.TRUST_PROXY_HOPS)
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-for']) {
      if (!proxySeen.count && production)
        console.warn('[숏핑] ⚠ X-Forwarded-For 머리글이 붙은 요청이 들어왔어요. 프록시 뒤라면 TRUST_PROXY_HOPS를 설정해 주세요.');
      proxySeen.count++;
      proxySeen.lastAt = new Date().toISOString();
    }
    next();
  });
const proxyStatus = () => ({
  hops: process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : 0,
  forwardedSeen: proxySeen.count > 0,
  seenCount: proxySeen.count,
  lastSeenAt: proxySeen.lastAt,
});
app.use(
  helmet({
    contentSecurityPolicy: production
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", 'data:'],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    // 앱(다른 출처의 화면)에서 포스터 · 영상을 불러올 수 있게 합니다. 보호된 영상은 로그인 · 미디어 토큰으로 따로 막습니다.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(express.json({ limit: '256kb' }));
// 모바일 앱(안드로이드 · iOS)은 앱 안의 화면(capacitor://localhost, https://localhost)에서 운영 서버로 요청합니다.
// 앱은 쿠키 대신 Authorization: Bearer 토큰을 쓰므로, 이 출처에는 쿠키 없이(credentials 없이) CORS를 허용합니다.
const appOrigins = new Set([
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  ...String(process.env.APP_CLIENT_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean),
]);
const bearerOf = (req) => {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(String(req.get('authorization') || ''));
  return m ? m[1] : '';
};
app.use((req, res, next) => {
  const o = req.get('origin');
  if (o && appOrigins.has(o) && o !== origin && (req.path.startsWith('/api/') || req.path.startsWith('/uploads/'))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Client, Range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.get('origin') &&
    // 앱 출처는 토큰(Bearer)이나 앱 머리글(X-Client: app, 로그인 요청)이 있는 요청만 받습니다.
    // 이 머리글은 사전 확인(preflight)을 거쳐야 하고, 쿠키를 싣는 요청은 사전 확인에서 막히므로 쿠키 로그인을 도용할 수 없어요.
    !(appOrigins.has(req.get('origin')) && (bearerOf(req) || req.get('x-client') === 'app')) &&
    ![origin, ...(production ? [] : [`http://127.0.0.1:${port}`])].includes(req.get('origin')) &&
    // 개발 모드에서만 Cloudflare Tunnel 외부 미리보기 주소 허용
    !(!production && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(req.get('origin')))
  )
    return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
  next();
});
// Integration tests drive hundreds of calls from one address; production keeps the real limits.
const testing = process.env.NODE_ENV === 'test';
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: testing ? 20_000 : 240,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // 영상 재생(구간 요청이 많음)·자막·스튜디오 미디어는 한 편을 볼 때도 요청이 수십 번 생겨 일반 한도에서 뺍니다.
    skip: (req) => req.method === 'GET' && /^\/(play\/|dramas\/[^/]+\/trailer$|studio\/media\/|subtitles\/|studio\/ai\/episodes\/[^/]+\/subtitles$|studio\/ai\/voices\/sample\/)/.test(req.path),
  }),
);
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: testing ? 2_000 : 40,
  message: { error: '잠시 후 다시 시도해 주세요.' },
});
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const now = () => new Date().toISOString();
const publicUser = (u) =>
  u
    ? {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        avatar: u.avatar,
        bio: u.bio || '',
        auto_next: u.auto_next !== 0,
        auto_unlock: u.auto_unlock === 1 || u.auto_unlock === true,
        // 본인에게만 내려가는 값(로그인 사용자 정보)
        phone: u.phone || '',
        phone_verified: Boolean(u.phone_verified_at),
      }
    : null;
const cookieToken = (req) => {
  const raw = req.headers.cookie
    ?.split(';')
    .find((c) => c.trim().startsWith('sp_session='))
    ?.trim()
    .slice(11);
  return raw ? createHash('sha256').update(raw).digest('hex') : '';
};
// 지금 요청의 로그인 세션(앱은 Bearer 토큰, 웹은 쿠키). 둘 다 서버에는 해시로만 저장합니다.
const sessionToken = (req) => {
  const bearer = bearerOf(req);
  return bearer ? createHash('sha256').update(bearer).digest('hex') : cookieToken(req);
};
// 미디어 토큰: 앱의 <video>·<audio>·<track>은 머리글(Authorization)을 보낼 수 없어서, 로그인 세션에 묶인
// 짧은 서명 토큰을 주소(?mt=)에 붙여 재생 · 자막 · 스튜디오 미디어만 열어 줍니다. 로그아웃하면 함께 무효가 됩니다.
const mediaSecret =
  process.env.MEDIA_TOKEN_SECRET ||
  (await (async () => {
    const row = await db.get("SELECT value FROM platform_settings WHERE key='media_token_secret'");
    if (row?.value) return row.value;
    await db.run("INSERT INTO platform_settings (key,value,updated_at) VALUES ('media_token_secret',?,?) ON CONFLICT(key) DO NOTHING", [randomBytes(32).toString('hex'), now()]);
    return (await db.get("SELECT value FROM platform_settings WHERE key='media_token_secret'")).value;
  })());
const MEDIA_TOKEN_TTL = 6 * 3600 * 1000;
const mediaSign = (body) => createHmac('sha256', mediaSecret).update(body).digest('base64url');
const makeMediaToken = (sessionHash) => {
  const body = Buffer.from(JSON.stringify({ s: sessionHash.slice(0, 32), e: Date.now() + MEDIA_TOKEN_TTL })).toString('base64url');
  return `${body}.${mediaSign(body)}`;
};
const MEDIA_PATHS = /^\/(play\/|dramas\/[^/]+\/trailer$|subtitles\/|studio\/media\/|studio\/ai\/episodes\/[^/]+\/subtitles$|studio\/ai\/voices\/sample\/)/;
async function mediaUser(req) {
  const raw = typeof req.query?.mt === 'string' ? req.query.mt : '';
  if (!raw || !['GET', 'HEAD'].includes(req.method) || !MEDIA_PATHS.test(req.path)) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const want = mediaSign(body);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  let claim;
  try {
    claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claim || typeof claim.s !== 'string' || claim.s.length !== 32 || !(Number(claim.e) > Date.now())) return null;
  return db.get(
    'SELECT u.*,p.avatar,p.bio,p.auto_next,p.auto_unlock FROM users u JOIN sessions s ON s.user_id=u.id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE substr(s.token,1,32)=? AND s.expires_at>? AND u.status=?',
    [claim.s, now(), 'active'],
  );
}
app.use('/api', async (req, res, next) => {
  try {
    const token = sessionToken(req);
    // 같은 계정의 다른 기기 · 탭을 구분하는 짧은 세션 표식(토큰 자체는 저장하지 않아요)
    req.sessionKey = token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : '';
    req.user = token
      ? await db.get(
          'SELECT u.*,p.avatar,p.bio,p.auto_next,p.auto_unlock FROM users u JOIN sessions s ON s.user_id=u.id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE s.token=? AND s.expires_at>? AND u.status=?',
          [token, now(), 'active'],
        )
      : null;
    if (!req.user && !token) req.user = (await mediaUser(req)) || null;
    next();
  } catch (e) {
    next(e);
  }
});
const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: '로그인 후 이용해 주세요.' });
const roles =
  (...allowed) =>
  (req, res, next) =>
    req.user && allowed.includes(req.user.role)
      ? next()
      : res.status(403).json({ error: '접근 권한이 없습니다.' });
async function session(req, res, user) {
  await db.run('DELETE FROM sessions WHERE expires_at<?', [now()]);
  const old = sessionToken(req);
  if (old) await db.run('DELETE FROM sessions WHERE token=?', [old]);
  const token = randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)', [
    createHash('sha256').update(token).digest('hex'),
    user.id,
    new Date(Date.now() + 7 * 86400000).toISOString(),
  ]);
  await db.run('UPDATE users SET last_login_at=? WHERE id=?', [now(), user.id]);
  // 앱(X-Client: app)은 쿠키를 쓰지 않으므로 로그인 토큰을 응답에 담아 줍니다(앱이 보관).
  const isApp = req.get('x-client') === 'app';
  if (!isApp)
    res.cookie('sp_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      maxAge: 7 * 86400000,
      path: '/',
    });
  res.json({ user: publicUser({ ...user, ...(await ensureProfile(user.id)) }), ...(isApp ? { token } : {}) });
}
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(8).max(128),
});
app.get('/api/config', async (req, res) => {
  const settings = await loadSettings(db);
  res.json({
    demo,
    androidUrl: process.env.ANDROID_STORE_URL || null,
    iosUrl: process.env.IOS_STORE_URL || null,
    subscriptionPrice: settings.subscription_price,
    subscriptionDays: settings.subscription_days,
    defaultFreeEpisodes: settings.default_free_episodes,
    pingUnitWon: settings.ping_unit_won,
    defaultEpisodePings: settings.default_episode_pings,
    titleUnlockDiscount: settings.title_unlock_discount,
    homeAppearance: appearanceFromSettings(settings, { live: true }),
    homeLayout: publicLayout(settings),
  });
});
// 시청자에게 보내는 메인 화면 구성: 공지 띠는 켜져 있고 게시 기간 안일 때만 보냅니다.
function publicLayout(settings) {
  const layout = layoutOf(settings.home_layout);
  const n = layout.notice;
  const t = now();
  const live = n.enabled && n.text && (!n.start || n.start <= t) && (!n.end || n.end > t);
  return { ...layout, notice: live ? { text: n.text, link: n.link, tone: n.tone } : null };
}
// 로드밸런서·모니터링용: DB까지 실제로 응답하는지 확인하고, 안 되면 503을 돌려줍니다.
app.get('/api/health', async (req, res) => {
  try {
    await db.get('SELECT 1 AS ok');
    res.json({ ok: true, database: db.engine });
  } catch (e) {
    console.error('[숏핑] 상태 확인: DB 응답 없음', e?.message);
    res.status(503).json({ ok: false, error: '데이터베이스에 연결할 수 없어요.' });
  }
});
app.get('/api/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/demo', authLimiter, async (req, res) => {
  if (!demo) fail(404, '사용할 수 없는 기능입니다.');
  const role = z.enum(['admin', 'pd', 'viewer']).parse(req.body.role);
  const user = await db.get('SELECT * FROM users WHERE id=?', [`demo-${role}`]);
  if (user.status !== 'active') fail(403, '이용이 제한된 계정입니다.');
  await session(req, res, user);
});
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const c = credentials.extend({ name: z.string().trim().min(2).max(30) }).parse(req.body);
  if (await db.get('SELECT id FROM users WHERE email=?', [c.email]))
    fail(409, '이미 가입된 이메일입니다.');
  const user = { id: randomUUID(), email: c.email, name: c.name, role: 'viewer', status: 'active' };
  // 동시에 같은 이메일로 가입하면 UNIQUE 제약이 막아 주므로, 그 결과로 중복 여부를 판정합니다.
  await db.run(
    'INSERT INTO users (id,email,name,password,role,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING',
    [user.id, c.email, c.name, hashPassword(c.password), 'viewer', now()],
  );
  if (!(await db.get('SELECT id FROM users WHERE id=?', [user.id])))
    fail(409, '이미 가입된 이메일입니다.');
  await session(req, res, user);
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const c = credentials.parse(req.body);
  const user = await db.get('SELECT * FROM users WHERE email=?', [c.email]);
  const [salt, hash] = (
    user?.password || '00000000000000000000000000000000:' + '0'.repeat(128)
  ).split(':');
  const valid = timingSafeEqual(scryptSync(c.password, salt, 64), Buffer.from(hash, 'hex'));
  if (!user || !valid || user.status !== 'active')
    fail(401, '이메일 또는 비밀번호를 확인해 주세요.');
  await session(req, res, user);
});
app.get('/api/auth/media-token', requireAuth, (req, res) => {
  const token = sessionToken(req);
  if (!token) fail(401, '로그인 후 이용해 주세요.');
  res.json({ token: makeMediaToken(token), expires_at: new Date(Date.now() + MEDIA_TOKEN_TTL).toISOString() });
});
app.post('/api/auth/logout', async (req, res) => {
  await db.run('DELETE FROM sessions WHERE token=?', [sessionToken(req)]);
  res.clearCookie('sp_session', { path: '/' }).json({ ok: true });
});
app.patch('/api/account/profile', requireAuth, async (req, res) => {
  const b = z
    .object({
      name: z.string().trim().min(2).max(30),
      bio: z.string().trim().max(160),
      auto_next: z.boolean(),
      // 보내지 않으면 기존 값을 유지합니다(시청 화면에서 따로 켜고 끌 수 있음).
      auto_unlock: z.boolean().optional(),
      avatar: z
        .string()
        .regex(
          /^\/(avatars\/block-(0[1-9]|[12][0-9]|30)\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/,
        ),
    })
    .parse(req.body);
  const profile = await ensureProfile(req.user.id);
  if (b.avatar.startsWith('/avatars/') && b.avatar !== profile.avatar)
    fail(403, '기본 아바타는 계정에 자동 배정됩니다.');
  if (b.avatar.startsWith('/uploads/')) {
    const file = await db.get('SELECT owner_id FROM media_files WHERE url=?', [b.avatar]);
    if (file?.owner_id !== req.user.id)
      fail(403, '본인이 업로드한 프로필 이미지만 사용할 수 있어요.');
  }
  await checkMedia(req, b.avatar);
  const autoUnlock = b.auto_unlock ?? Number(profile.auto_unlock) === 1;
  await db.transaction(async () => {
    await db.run('UPDATE users SET name=? WHERE id=?', [b.name, req.user.id]);
    await db.run(
      'UPDATE user_profiles SET avatar=?,bio=?,auto_next=?,auto_unlock=? WHERE user_id=?',
      [b.avatar, b.bio, b.auto_next ? 1 : 0, autoUnlock ? 1 : 0, req.user.id],
    );
  });
  await dropOldAvatar(req.user.id, profile.avatar, b.avatar).catch((e) => console.error('avatar cleanup', e?.message));
  res.json({
    user: publicUser({
      ...req.user,
      ...b,
      auto_next: b.auto_next ? 1 : 0,
      auto_unlock: autoUnlock ? 1 : 0,
    }),
  });
});
// 잠긴 회차를 보유 핑으로 자동으로 열지. 결제 화면에서 바로 켜고 끌 수 있게 따로 둡니다.
app.put('/api/account/auto-unlock', requireAuth, async (req, res) => {
  const b = z.object({ enabled: z.boolean() }).parse(req.body);
  await ensureProfile(req.user.id);
  await db.run('UPDATE user_profiles SET auto_unlock=? WHERE user_id=?', [
    b.enabled ? 1 : 0,
    req.user.id,
  ]);
  res.json({ auto_unlock: b.enabled });
});
app.get('/api/account/sessions', requireAuth, async (req, res) => {
  const sessions = await db.all(
    'SELECT expires_at,token FROM sessions WHERE user_id=? AND expires_at>? ORDER BY expires_at DESC',
    [req.user.id, now()],
  );
  res.json(
    sessions.map((s) => ({ current: s.token === sessionToken(req), expires_at: s.expires_at })),
  );
});
app.post('/api/account/revoke-sessions', requireAuth, async (req, res) => {
  await db.run('DELETE FROM sessions WHERE user_id=? AND token<>?', [
    req.user.id,
    sessionToken(req),
  ]);
  res.json({ ok: true });
});
app.post('/api/account/password', requireAuth, authLimiter, async (req, res) => {
  if (req.user.id.startsWith('demo-'))
    fail(400, '공용 테스트 계정은 비밀번호를 변경할 수 없습니다.');
  const b = z
    .object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128),
    })
    .parse(req.body);
  const [salt, hash] = req.user.password.split(':');
  if (!timingSafeEqual(scryptSync(b.currentPassword, salt, 64), Buffer.from(hash, 'hex')))
    fail(400, '현재 비밀번호가 일치하지 않습니다.');
  if (b.currentPassword === b.newPassword) fail(400, '기존과 다른 비밀번호를 입력해 주세요.');
  await db.transaction(async () => {
    await db.run('UPDATE users SET password=? WHERE id=?', [
      hashPassword(b.newPassword),
      req.user.id,
    ]);
    await db.run('DELETE FROM sessions WHERE user_id=? AND token<>?', [
      req.user.id,
      sessionToken(req),
    ]);
  });
  res.json({ ok: true });
});
app.delete('/api/account/history', requireAuth, async (req, res) => {
  await db.run('DELETE FROM history WHERE user_id=?', [req.user.id]);
  res.json({ ok: true });
});
// 회차 공개 여부: 연재 중인 작품에 새로 올린 회차는 회차 단위 심사(pending)를 거쳐 승인(approved)돼야 보입니다.
// 예약 공개 회차(scheduled)는 정한 시각이 되면 공개 처리기가 approved로 바꿉니다.
const VISIBLE = "e.review_status='approved'";
const catalogSql =
  `SELECT d.*, c.name AS channel_name, c.slug AS channel_slug, c.status AS channel_status, (SELECT COUNT(*) FROM episodes e WHERE e.drama_id=d.id AND ${VISIBLE}) AS episode_count, (SELECT COUNT(*) FROM episodes e WHERE e.drama_id=d.id) AS episode_total, (SELECT COUNT(*) FROM episodes e WHERE e.drama_id=d.id AND e.source='studio') AS studio_episodes, (SELECT COUNT(*) FROM episodes e WHERE e.drama_id=d.id AND e.review_status='pending') AS pending_episodes FROM dramas d LEFT JOIN channels c ON c.id=d.channel_id`;
// 작품 주인·관리자는 심사 중인 회차도 봅니다.
const seesAll = (user, d) => !!user && (user.role === 'admin' || user.id === d.owner_id);
app.get('/api/dramas', async (req, res) =>
  // 썸네일 A/B 비교 중인 작품은 시청자마다 정해진 후보 이미지를 보여 줍니다.
  // 공개 목록에는 시청자 화면에 필요한 칸만 보냅니다(심사 의견·소유자 ID 등 내부 정보 제외).
  res.json(
    (await applyThumbs(db, await db.all(catalogSql + " WHERE d.status='published' ORDER BY d.views DESC"), req.user?.id || req.ip)).map(
      publicDrama,
    ),
  ),
);
// 썸네일 A/B 클릭: 같은 사람(로그인 회원 또는 IP)은 후보마다 하루 한 번만 셉니다(새로고침·반복 호출로 부풀리기 방지).
const kstDay = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const changedRows = (r) => Number(r?.rowCount ?? r?.changes ?? 0);
async function countThumbClick(req, dramaId, thumbId) {
  if (!/^[a-f0-9-]{36}$/.test(thumbId)) return;
  const key = req.user ? 'u:' + req.user.id : 'ip:' + (req.ip || '');
  const r = await db
    .run('INSERT INTO thumb_click_marks (viewer_key,thumb_id,day) VALUES (?,?,?) ON CONFLICT DO NOTHING', [key, thumbId, kstDay()])
    .catch(() => null);
  if (changedRows(r)) await thumbClick(db, dramaId, thumbId);
}
app.get('/api/dramas/:id', async (req, res) => {
  const d = await db.get(catalogSql + ' WHERE d.id=?', [req.params.id]);
  if (!d || (d.status !== 'published' && req.user?.role !== 'admin' && d.owner_id !== req.user?.id))
    fail(404, '작품을 찾을 수 없습니다.');
  const entitled = await hasAccess(req.user, d);
  if (typeof req.query.t === 'string') await countThumbClick(req, d.id, req.query.t);
  const settings = await loadSettings(db);
  const owned = await ownedEpisodes(req.user, d.id);
  const episodes = await db.all(
    "SELECT id,number,title,duration,source,thumbnail,review_status,publish_at,CASE WHEN video='/demo/preview.mp4' THEN 1 ELSE 0 END AS is_demo,CASE WHEN subtitles<>'' THEN 1 ELSE 0 END AS has_subtitles FROM episodes e WHERE drama_id=?" +
      (seesAll(req.user, d) ? '' : ` AND ${VISIBLE}`) +
      ' ORDER BY number',
    [d.id],
  );
  const isLocked = (number) => !entitled && number > d.free_episodes && !owned.includes(number);
  const lockedCount = episodes.filter((e) => isLocked(e.number)).length;
  const perEpisode = episodePingsOf(d, settings);
  res.json({
    // 작품 주인·관리자는 관리용 칸(심사 의견 등)까지, 시청자는 공개 칸만 받습니다.
    ...(seesAll(req.user, d) ? d : publicDrama(d)),
    entitled,
    // AI 기본법에 따른 생성형 AI 결과물 표시: PD 자가 신고 또는 스튜디오 제작 회차가 있으면 표시
    ai_label: d.ai_usage !== 'none' || Number(d.studio_episodes) > 0,
    episode_pings: perEpisode,
    title_pings: titlePingsOf(lockedCount, perEpisode, settings),
    title_discount: lockedCount > 1 ? settings.title_unlock_discount : 0,
    locked_count: lockedCount,
    episodes: episodes.map((e) => ({
      ...e,
      owned: owned.includes(e.number),
      locked: isLocked(e.number),
    })),
  });
});
// 핑으로 연 회차는 작품 전체 열기·구독과 별개로 그 회차만 열어 줍니다.
async function ownedEpisodes(user, dramaId) {
  if (!user) return [];
  return (
    await db.all('SELECT episode FROM episode_entitlements WHERE user_id=? AND drama_id=?', [
      user.id,
      dramaId,
    ])
  ).map((r) => Number(r.episode));
}
async function canWatch(user, d, number) {
  if (number <= d.free_episodes || (await hasAccess(user, d))) return true;
  return !!(
    user &&
    (await db.get(
      'SELECT user_id FROM episode_entitlements WHERE user_id=? AND drama_id=? AND episode=?',
      [user.id, d.id, number],
    ))
  );
}
// 구독 풀 배분 근거: 무료 회차가 아니고, 작품 소유자·관리자가 아니며, 작품·회차를 따로 사지 않았고,
// 지금 구독 중인 회원이 재생한 경우에만 그 달 기록을 한 번 남깁니다.
async function recordSubscriptionView(user, d, number) {
  if (!user || d.free || number <= d.free_episodes) return;
  if (user.role === 'admin' || user.id === d.owner_id) return;
  const stamp = now();
  if (!(await db.get('SELECT user_id FROM subscriptions WHERE user_id=? AND expires_at>?', [user.id, stamp])))
    return;
  if (await db.get('SELECT user_id FROM entitlements WHERE user_id=? AND drama_id=?', [user.id, d.id])) return;
  if (
    await db.get('SELECT user_id FROM episode_entitlements WHERE user_id=? AND drama_id=? AND episode=?', [
      user.id,
      d.id,
      number,
    ])
  )
    return;
  // 재생을 시작한 기록만으로는 배분에 넣지 않습니다(qualified=0). 시청 위치 보고(/api/history)로
  // 회차 길이의 기준 %를 넘겨 봤다는 것이 확인되면 1로 바뀝니다. 기준이 0%면 바로 인정합니다.
  const settings = await loadSettings(db);
  const instant = Number(settings.sub_min_progress_pct || 0) <= 0 ? 1 : 0;
  await db.run(
    'INSERT INTO subscription_views (user_id,drama_id,episode,period,created_at,qualified) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    [user.id, d.id, number, periodOf(stamp), stamp, instant],
  );
}
// 시청 위치 보고가 기준(회차 길이의 sub_min_progress_pct %)을 넘으면: 조회수 +1(회원·회차당 하루 한 번),
// 이번 달 구독 재생 기록을 '인정'으로 바꿉니다. 재생 시작 후 실제로 흐른 시간이 기준 시간의 절반(2배속 허용)도
// 안 되면 구독 배분에는 아직 넣지 않습니다(위치만 앞으로 보내는 조작 방지).
async function recordQualifiedView(user, d, episode, progress) {
  if (!user || user.role === 'admin' || user.id === d.owner_id) return;
  const settings = await loadSettings(db);
  const pct = Math.min(100, Math.max(0, Number(settings.sub_min_progress_pct ?? 30)));
  const duration = Number(episode.duration) || 0;
  const needed = (duration * pct) / 100;
  if (progress < needed) return;
  const marked = await db.run(
    'INSERT INTO view_marks (user_id,drama_id,episode,day) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
    [user.id, d.id, episode.number, kstDay()],
  );
  if (changedRows(marked)) await db.run('UPDATE dramas SET views=views+1 WHERE id=?', [d.id]);
  const stamp = now();
  const earliest = new Date(Date.now() - (needed / 2) * 1000).toISOString();
  await db.run(
    'UPDATE subscription_views SET qualified=1 WHERE user_id=? AND drama_id=? AND episode=? AND period=? AND qualified=0 AND created_at<=?',
    [user.id, d.id, episode.number, periodOf(stamp), earliest],
  );
}
// 하루 단위 중복 방지 표시는 며칠 지나면 필요 없으니 정리합니다.
setInterval(() => {
  const old = new Date(Date.now() - 3 * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
  void db.run('DELETE FROM view_marks WHERE day<?', [old]).catch(() => {});
  void db.run('DELETE FROM thumb_click_marks WHERE day<?', [old]).catch(() => {});
}, 6 * 3600 * 1000).unref();
async function hasAccess(user, d) {
  if (d.free) return true;
  if (!user) return false;
  if (user.role === 'admin' || user.id === d.owner_id) return true;
  return !!(
    (await db.get('SELECT user_id FROM entitlements WHERE user_id=? AND drama_id=?', [
      user.id,
      d.id,
    ])) ||
    (await db.get('SELECT user_id FROM subscriptions WHERE user_id=? AND expires_at>?', [
      user.id,
      now(),
    ]))
  );
}
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
mkdirSync(uploadDir, { recursive: true });
app.get('/api/play/:id/:number', async (req, res) => {
  const d = await db.get('SELECT * FROM dramas WHERE id=?', [req.params.id]);
  if (!d || (d.status !== 'published' && req.user?.role !== 'admin' && d.owner_id !== req.user?.id))
    fail(404, '작품을 찾을 수 없습니다.');
  const number = z.coerce.number().int().min(1).parse(req.params.number);
  if (!(await canWatch(req.user, d, number)))
    fail(403, '이 회차는 회차 구매, 작품 소장 또는 구독 후 시청할 수 있어요.');
  const e = await db.get('SELECT * FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
  if (!e?.video || (e.review_status !== 'approved' && !seesAll(req.user, d))) fail(404, '영상이 아직 등록되지 않았습니다.');
  // 첫 재생 요청(처음부터 받는 요청)일 때만 구독 시청 기록을 남깁니다.
  if (!/^bytes=(?!0-)/.test(String(req.headers.range || '')))
    await recordSubscriptionView(req.user, d, number).catch((err) =>
      console.error('subscription view', err?.message),
    );
  const file = e.video.startsWith('/demo/')
    ? path.resolve('public/demo/preview.mp4')
    : path.join(uploadDir, path.basename(e.video));
  res.sendFile(file, (err) => {
    if (err && !res.headersSent)
      res.status(404).json({ error: '영상 파일이 아직 준비되지 않았습니다.' });
  });
});
// 예고편: 공개 작품의 예고편은 누구나 볼 수 있습니다(홍보용).
app.get('/api/dramas/:id/trailer', async (req, res) => {
  const d = await db.get('SELECT status,owner_id,trailer FROM dramas WHERE id=?', [req.params.id]);
  if (!d || !d.trailer || !/^\/uploads\/[a-f0-9-]+\.mp4$/.test(d.trailer) || (d.status !== 'published' && !seesAll(req.user, d)))
    fail(404, '예고편이 없어요.');
  res.sendFile(path.join(uploadDir, path.basename(d.trailer)), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '예고편 파일을 찾을 수 없어요.' });
  });
});
app.get('/api/library', requireAuth, async (req, res) => {
  const u = req.user.id;
  res.json({
    favorites: (await db.all('SELECT drama_id FROM favorites WHERE user_id=?', [u])).map(
      (x) => x.drama_id,
    ),
    history: await db.all('SELECT * FROM history WHERE user_id=? ORDER BY updated_at DESC', [u]),
    orders: await db.all(
      'SELECT o.*,d.title,(SELECT e.episode FROM episode_entitlements e WHERE e.order_id=o.id) AS episode FROM orders o LEFT JOIN dramas d ON d.id=o.drama_id WHERE o.user_id=? ORDER BY o.created_at DESC',
      [u],
    ),
    purchases: (await db.all('SELECT drama_id FROM entitlements WHERE user_id=?', [u])).map(
      (x) => x.drama_id,
    ),
    channels: (await db.all('SELECT channel_id FROM channel_follows WHERE user_id=?', [u])).map(
      (x) => x.channel_id,
    ),
    episodes: await db.all(
      'SELECT drama_id, episode FROM episode_entitlements WHERE user_id=? ORDER BY drama_id, episode',
      [u],
    ),
    wallet: await walletOf(db, u),
    subscription:
      (await db.get('SELECT * FROM subscriptions WHERE user_id=? AND expires_at>?', [u, now()])) ||
      null,
  });
});
app.post('/api/favorites/:id', requireAuth, async (req, res) => {
  const d = await db.get("SELECT id FROM dramas WHERE id=? AND status='published'", [
    req.params.id,
  ]);
  if (!d) fail(404, '작품을 찾을 수 없습니다.');
  const active = z.boolean().parse(req.body.active);
  if (active)
    await db.run('INSERT INTO favorites (user_id,drama_id) VALUES (?,?) ON CONFLICT DO NOTHING', [
      req.user.id,
      d.id,
    ]);
  else await db.run('DELETE FROM favorites WHERE user_id=? AND drama_id=?', [req.user.id, d.id]);
  res.json({ ok: true });
});
app.post('/api/history', requireAuth, async (req, res) => {
  const b = z
    .object({
      dramaId: z.string(),
      episode: z.number().int().positive(),
      progress: z.number().min(0).max(86400),
    })
    .parse(req.body);
  const d = await db.get("SELECT * FROM dramas WHERE id=? AND status='published'", [b.dramaId]);
  if (!d) fail(404, '작품을 찾을 수 없습니다.');
  if (!(await canWatch(req.user, d, b.episode))) fail(403, '시청 권한이 없습니다.');
  const episode = await db.get(
    `SELECT id,number,duration FROM episodes e WHERE drama_id=? AND number=?${seesAll(req.user, d) ? '' : ' AND ' + VISIBLE}`,
    [d.id, b.episode],
  );
  if (!episode) fail(404, '회차를 찾을 수 없습니다.');
  await db.run(
    'INSERT INTO history (user_id,drama_id,episode,progress,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,drama_id) DO UPDATE SET episode=excluded.episode,progress=excluded.progress,updated_at=excluded.updated_at',
    [req.user.id, b.dramaId, b.episode, b.progress, now()],
  );
  // 조회수·구독 배분 인정(실패해도 시청 위치 저장에는 영향 없음)
  await recordQualifiedView(req.user, d, episode, b.progress).catch((err) => console.error('qualified view', err?.message));
  res.json({ ok: true });
});
// 원화 결제는 숏핑 패스(구독)만 남았습니다. 회차·작품은 핑으로 엽니다(/api/pings/unlock).
// 구독은 PG 빌키 연동 전까지 테스트 결제로 동작합니다.
app.post('/api/checkout', requireAuth, async (req, res) => {
  if (!demo) fail(503, '결제 서비스 연동 준비 중입니다.');
  const settings = await loadSettings(db);
  const b = z
    .object({ kind: z.literal('subscription'), idempotencyKey: z.string().uuid() })
    .parse(req.body);
  const result = await moneyTx(async () => {
    await db.lockUser(req.user.id);
    const existing = await db.get('SELECT * FROM orders WHERE idempotency_key=?', [
      b.idempotencyKey,
    ]);
    if (existing) {
      if (existing.user_id !== req.user.id) fail(409, '중복 요청입니다.');
      return { id: existing.id, amount: existing.amount, status: existing.status, kind: existing.kind };
    }
    if (
      await db.get('SELECT user_id FROM subscriptions WHERE user_id=? AND expires_at>?', [
        req.user.id,
        now(),
      ])
    )
      fail(409, '이미 구독 중입니다.');
    const id = randomUUID(),
      createdAt = now(),
      amount = settings.subscription_price;
    await db.run(
      'INSERT INTO orders (id,user_id,drama_id,kind,amount,status,idempotency_key,created_at,channel,channel_fee) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        req.user.id,
        null,
        'subscription',
        amount,
        'test_paid',
        b.idempotencyKey,
        createdAt,
        'web',
        Math.round((amount * settings.pg_fee_rate) / 100),
      ],
    );
    await db.run(
      'INSERT INTO subscriptions (user_id,order_id,expires_at,auto_renew) VALUES (?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET order_id=excluded.order_id,expires_at=excluded.expires_at,auto_renew=0',
      [req.user.id, id, new Date(Date.now() + settings.subscription_days * 86400000).toISOString()],
    );
    return { id, amount, status: 'test_paid', kind: 'subscription' };
  });
  res.json(result);
});

// ── 핑(포인트) ─────────────────────────────────────────────────────────
// 같은 멱등키가 거의 동시에 들어와 고유 키 충돌이 나면, 한 번 더 실행해 이미 만들어진 주문을 돌려줍니다.
const moneyTx = async (fn) => {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (db.isUnique(e)) return db.transaction(fn);
    throw e;
  }
};
const orderShape = (o, extra = {}) => ({
  id: o.id,
  kind: o.kind,
  amount: o.amount,
  pings: o.pings,
  bonus: o.bonus_pings,
  status: o.status,
  ...extra,
});
app.get('/api/pings', requireAuth, async (req, res) => {
  const settings = await loadSettings(db);
  res.json({
    wallet: await walletOf(db, req.user.id),
    products: await db.all(
      "SELECT id,channel,name,price,pings,bonus_pings,badge FROM ping_products WHERE active=1 AND channel='web' ORDER BY sort_order, price",
    ),
    ledger: await db.all(
      'SELECT l.id,l.type,l.paid_delta,l.bonus_delta,l.paid_after,l.bonus_after,l.drama_id,l.episode,l.memo,l.created_at,d.title FROM ping_ledger l LEFT JOIN dramas d ON d.id=l.drama_id WHERE l.user_id=? ORDER BY l.created_at DESC LIMIT 100',
      [req.user.id],
    ),
    policy: {
      unit_won: settings.ping_unit_won,
      default_episode_pings: settings.default_episode_pings,
      title_unlock_discount: settings.title_unlock_discount,
    },
  });
});
// 충전: 지금은 테스트 결제입니다. PG·인앱결제 연동 시 이 경로는 "결제 승인 확인 후 적립"으로 바뀌고,
// 적립 로직(creditPings)은 그대로 씁니다. 테스트 환경에서는 인앱 채널 상품도 적립해 정산을 시뮬레이션합니다.
app.post('/api/pings/charge', requireAuth, async (req, res) => {
  if (!demo) fail(503, '결제 서비스 연동 준비 중입니다.');
  const b = z
    .object({ productId: z.string().min(1).max(80), idempotencyKey: z.string().uuid() })
    .parse(req.body);
  const settings = await loadSettings(db);
  const result = await moneyTx(async () => {
    await db.lockUser(req.user.id);
    const existing = await db.get('SELECT * FROM orders WHERE idempotency_key=?', [
      b.idempotencyKey,
    ]);
    if (existing) {
      if (existing.user_id !== req.user.id || existing.kind !== 'ping_charge')
        fail(409, '중복 요청입니다.');
      return orderShape(existing, { wallet: await walletOf(db, req.user.id) });
    }
    const product = await db.get('SELECT * FROM ping_products WHERE id=? AND active=1', [
      b.productId,
    ]);
    if (!product) fail(404, '충전 상품을 찾을 수 없습니다.');
    const feeRate = channelFeeRate(product.channel, settings);
    const id = randomUUID(),
      createdAt = now();
    await db.run(
      'INSERT INTO orders (id,user_id,drama_id,kind,amount,status,idempotency_key,created_at,channel,channel_fee,pings,bonus_pings,product_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        req.user.id,
        null,
        'ping_charge',
        product.price,
        'test_paid',
        b.idempotencyKey,
        createdAt,
        product.channel,
        Math.round((product.price * feeRate) / 100),
        product.pings,
        product.bonus_pings,
        product.id,
      ],
    );
    const credited = await creditPings(db, {
      userId: req.user.id,
      type: 'charge',
      source: 'charge',
      channel: product.channel,
      orderId: id,
      paid: product.pings,
      bonus: product.bonus_pings,
      unitMilli: unitMilliOf(product.price, product.pings, feeRate),
      memo: product.name,
    });
    return {
      id,
      kind: 'ping_charge',
      amount: product.price,
      pings: product.pings,
      bonus: product.bonus_pings,
      status: 'test_paid',
      wallet: credited.wallet,
    };
  });
  res.json(result);
});
// 회차 한 편 또는 작품 전체(할인)를 핑으로 엽니다. 사용한 핑의 순매출이 PD 정산으로 넘어갑니다.
app.post('/api/pings/unlock', requireAuth, async (req, res) => {
  const b = z
    .object({
      dramaId: z.string().min(1).max(80),
      episode: z.number().int().min(1).max(500).optional(),
      all: z.boolean().default(false),
      idempotencyKey: z.string().uuid(),
    })
    .parse(req.body);
  const settings = await loadSettings(db);
  const result = await moneyTx(async () => {
    // 지갑·보유 회차 검사보다 먼저 회원을 잠가, 두 번 누르거나 두 탭에서 동시에 열어도 한 번만 결제됩니다.
    await db.lockUser(req.user.id);
    const existing = await db.get('SELECT * FROM orders WHERE idempotency_key=?', [
      b.idempotencyKey,
    ]);
    if (existing) {
      if (existing.user_id !== req.user.id || !['ping_episode', 'ping_title'].includes(existing.kind))
        fail(409, '중복 요청입니다.');
      const episode = await db.get('SELECT episode FROM episode_entitlements WHERE order_id=?', [
        existing.id,
      ]);
      return orderShape(existing, {
        episode: episode?.episode ?? null,
        wallet: await walletOf(db, req.user.id),
      });
    }
    const drama = await db.get("SELECT * FROM dramas WHERE id=? AND status='published'", [
      b.dramaId,
    ]);
    if (!drama) fail(404, '작품을 찾을 수 없습니다.');
    if (drama.free) fail(400, '무료로 공개된 작품입니다.');
    if (await hasAccess(req.user, drama)) fail(409, '이미 모든 회차를 볼 수 있어요.');
    const perEpisode = episodePingsOf(drama, settings);
    const owned = await ownedEpisodes(req.user, drama.id);
    const numbers = (
      await db.all(`SELECT number FROM episodes e WHERE drama_id=? AND ${VISIBLE} ORDER BY number`, [drama.id])
    ).map((e) => Number(e.number));
    const locked = numbers.filter((n) => n > drama.free_episodes && !owned.includes(n));
    let pings, kind;
    if (b.all) {
      if (!locked.length) fail(409, '열 수 있는 잠긴 회차가 없어요.');
      pings = titlePingsOf(locked.length, perEpisode, settings);
      kind = 'ping_title';
    } else {
      if (!b.episode) fail(400, '열 회차를 선택해 주세요.');
      if (!numbers.includes(b.episode)) fail(404, '회차를 찾을 수 없습니다.');
      if (b.episode <= drama.free_episodes) fail(400, '무료로 볼 수 있는 회차입니다.');
      if (owned.includes(b.episode)) fail(409, '이미 연 회차입니다.');
      pings = perEpisode;
      kind = 'ping_episode';
    }
    const id = randomUUID(),
      createdAt = now();
    await db.run(
      'INSERT INTO orders (id,user_id,drama_id,kind,amount,status,idempotency_key,created_at,channel,pings) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, req.user.id, drama.id, kind, 0, 'ping_paid', b.idempotencyKey, createdAt, 'ping', pings],
    );
    const spent = await debitPings(db, {
      userId: req.user.id,
      pings,
      type: 'spend',
      orderId: id,
      dramaId: drama.id,
      episode: b.all ? null : b.episode,
      memo: b.all ? `전체 열기 ${locked.length}편` : `${b.episode}화`,
    });
    if (b.all)
      await db.run(
        'INSERT INTO entitlements (user_id,drama_id,order_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
        [req.user.id, drama.id, id],
      );
    else
      await db.run(
        'INSERT INTO episode_entitlements (user_id,drama_id,episode,order_id,created_at) VALUES (?,?,?,?,?)',
        [req.user.id, drama.id, b.episode, id, createdAt],
      );
    await recordPingSale(db, {
      order: { id, created_at: createdAt },
      drama,
      gross: Math.floor(spent.valueMilli / 1000),
      rate: await platformRateFor(db, drama.owner_id, settings),
      settings,
    });
    return {
      id,
      kind,
      pings,
      episode: b.all ? null : b.episode,
      unlocked: b.all ? locked.length : 1,
      wallet: spent.wallet,
    };
  });
  res.json(result);
});
// 테스트 결제(데모)에서는 화면 안내대로 즉시 종료합니다. 실제 결제 환경에서는 자동 갱신만 끄고
// 이미 결제한 기간이 끝날 때까지 이용권을 유지합니다(환불은 별도 절차).
app.post('/api/subscription/cancel', requireAuth, async (req, res) => {
  if (demo)
    await db.run('UPDATE subscriptions SET expires_at=?,auto_renew=0 WHERE user_id=?', [
      now(),
      req.user.id,
    ]);
  else await db.run('UPDATE subscriptions SET auto_renew=0 WHERE user_id=?', [req.user.id]);
  res.json({ ok: true, immediate: demo });
});
app.get('/api/studio', roles('pd', 'admin'), async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const ds = await db.all(
    catalogSql + (isAdmin ? '' : ' WHERE d.owner_id=?') + ' ORDER BY d.created_at DESC',
    isAdmin ? [] : [req.user.id],
  );
  // PD에게는 구매자 식별 정보(회원 ID·멱등키)를 보내지 않습니다.
  const orders = await db.all(
    (isAdmin
      ? 'SELECT o.*'
      : 'SELECT o.id,o.drama_id,o.kind,o.amount,o.status,o.created_at,o.channel,o.pings,o.bonus_pings') +
      ',d.title,(SELECT se.gross FROM settlement_entries se WHERE se.order_id=o.id) AS sale_value FROM orders o LEFT JOIN dramas d ON o.drama_id=d.id' +
      (isAdmin ? '' : ' WHERE d.owner_id=?') +
      ' ORDER BY o.created_at DESC',
    isAdmin ? [] : [req.user.id],
  );
  res.json({
    dramas: ds,
    orders,
    subscriptions: isAdmin
      ? await db.all(
          'SELECT s.user_id,s.expires_at,s.auto_renew,u.name,u.email FROM subscriptions s JOIN users u ON s.user_id=u.id ORDER BY s.expires_at DESC',
        )
      : [],
    operations: isAdmin
      ? {
          database: process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite',
          environment: production ? 'production' : 'development',
          demo,
          androidReady: Boolean(process.env.ANDROID_STORE_URL),
          iosReady: Boolean(process.env.IOS_STORE_URL),
        }
      : null,
    users: isAdmin
      ? await db.all(
          'SELECT u.id,u.email,u.name,u.role,u.status,u.created_at,p.avatar FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id ORDER BY u.created_at DESC',
        )
      : [],
    logs: isAdmin
      ? await db.all(
          'SELECT a.*,u.name FROM audit_logs a JOIN users u ON a.actor_id=u.id ORDER BY a.created_at DESC LIMIT 30',
        )
      : [],
  });
});
const dramaSchema = z.object({
  title: z.string().trim().min(2).max(70),
  tagline: z.string().trim().min(2).max(120),
  synopsis: z.string().trim().min(10).max(3000),
  genre: z.enum(GENRES),
  free: z.boolean().default(false),
  episode_pings: z.number().int().min(0).max(1000).default(0),
  free_episodes: z.number().int().min(1).max(50),
  image: z.string().regex(/^\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/),
  // 권리·AI 자가 신고(외부 제작 영상). 보내지 않으면 기존 값을 유지합니다.
  rights_confirmed: z.boolean().optional(),
  likeness_confirmed: z.boolean().optional(),
  ai_usage: z.enum(['none', 'partial', 'full']).optional(),
});
async function saveDeclaration(id, b) {
  if (b.rights_confirmed === undefined && b.likeness_confirmed === undefined && b.ai_usage === undefined)
    return;
  const d = await db.get('SELECT rights_confirmed,likeness_confirmed,ai_usage FROM dramas WHERE id=?', [id]);
  await db.run(
    'UPDATE dramas SET rights_confirmed=?,likeness_confirmed=?,ai_usage=?,declared_at=? WHERE id=?',
    [
      (b.rights_confirmed ?? Number(d.rights_confirmed) === 1) ? 1 : 0,
      (b.likeness_confirmed ?? Number(d.likeness_confirmed) === 1) ? 1 : 0,
      b.ai_usage ?? d.ai_usage,
      now(),
      id,
    ],
  );
}
async function checkMedia(req, url) {
  if (url.startsWith('/uploads/')) {
    const file = await db.get('SELECT * FROM media_files WHERE url=?', [url]);
    if (!file || (file.owner_id !== req.user.id && req.user.role !== 'admin'))
      fail(403, '본인이 업로드한 파일만 사용할 수 있어요.');
  }
  if (!existsSync(mediaPath(url)))
    fail(400, '등록된 파일을 찾을 수 없습니다. 다시 업로드해 주세요.');
}
const mediaPath = (url) =>
  url.startsWith('/uploads/')
    ? path.join(uploadDir, path.basename(url))
    : path.resolve('public', url.slice(1));
async function contentIssues(d) {
  const episodes = await db.all('SELECT * FROM episodes WHERE drama_id=? ORDER BY number', [d.id]);
  const thumbnails = await db.all('SELECT id,url,active,reviewed FROM drama_thumbnails WHERE drama_id=? AND active=1 ORDER BY created_at', [d.id]);
  const issues = [];
  if (!existsSync(mediaPath(d.image))) issues.push('포스터 파일을 찾을 수 없습니다.');
  if (!episodes.length) issues.push('영상이 포함된 회차를 먼저 등록해 주세요.');
  if (episodes.some((e, i) => e.number !== i + 1))
    issues.push('1화부터 빠진 회차 없이 영상을 등록해 주세요.');
  for (const e of episodes) {
    if (!e.video || !existsSync(mediaPath(e.video)))
      issues.push(`${e.number}화 영상 파일을 찾을 수 없습니다.`);
    if (!demo && e.video.startsWith('/demo/'))
      issues.push(`${e.number}화 샘플 영상을 실제 영상으로 교체해 주세요.`);
  }
  for (const t of thumbnails) if (!existsSync(mediaPath(t.url))) issues.push('썸네일 후보 파일을 찾을 수 없습니다.');
  return { episodes, thumbnails, issues };
}
async function contentEvent(req, id, status, note = '') {
  const timestamp = now();
  await db.run(
    'INSERT INTO content_reviews (id,drama_id,actor_id,status,note,created_at) VALUES (?,?,?,?,?,?)',
    [randomUUID(), id, req.user.id, status, note, timestamp],
  );
  await db.run(
    'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
    [randomUUID(), req.user.id, status, id, timestamp],
  );
}
app.post('/api/studio/dramas', roles('pd', 'admin'), async (req, res) => {
  const b = dramaSchema.parse(req.body),
    id = randomUUID();
  await checkMedia(req, b.image);
  const channel = await db.get('SELECT id FROM channels WHERE owner_id=?', [req.user.id]);
  await db.run(
    'INSERT INTO dramas (id,owner_id,title,tagline,synopsis,genre,image,free,episode_pings,free_episodes,created_at,channel_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      req.user.id,
      b.title,
      b.tagline,
      b.synopsis,
      b.genre,
      b.image,
      b.free ? 1 : 0,
      b.episode_pings,
      b.free_episodes,
      now(),
      channel?.id || null,
    ],
  );
  await saveDeclaration(id, b);
  res.json({ id });
});
async function owned(req, lock = false) {
  const d = await db.get(
    'SELECT * FROM dramas WHERE id=?' + (lock && db.engine === 'postgresql' ? ' FOR UPDATE' : ''),
    [req.params.id],
  );
  if (!d) fail(404, '작품을 찾을 수 없습니다.');
  if (req.user.role !== 'admin' && d.owner_id !== req.user.id)
    fail(403, '본인 작품만 수정할 수 있습니다.');
  return d;
}
app.get('/api/studio/dramas/:id', roles('pd', 'admin'), async (req, res) => {
  const d = await owned(req);
  const { episodes, thumbnails, issues } = await contentIssues(d);
  const owner = await db.get('SELECT name FROM users WHERE id=?', [d.owner_id]);
  const reviews = await db.all(
    'SELECT r.*,u.name FROM content_reviews r JOIN users u ON u.id=r.actor_id WHERE drama_id=? ORDER BY r.created_at DESC',
    [d.id],
  );
  const metas = await db.all(
    'SELECT m.* FROM media_metadata m JOIN episodes e ON e.video=m.url WHERE e.drama_id=?',
    [d.id],
  );
  res.json({
    ...d,
    episode_count: episodes.length,
    episodes: episodes.map((e) => {
      const meta = metas.find((m) => m.url === e.video);
      return {
        ...e,
        has_subtitles: e.subtitles ? 1 : 0,
        subtitles: undefined,
        width: meta ? Number(meta.width) : null,
        height: meta ? Number(meta.height) : null,
        warnings: meta ? precheck(meta) : [],
      };
    }),
    thumbnails,
    issues,
    reviews,
    owner_name: owner.name,
  });
});
app.patch('/api/studio/dramas/:id', roles('pd', 'admin'), async (req, res) => {
  await db.transaction(async () => {
    const d = await owned(req, true);
    // 공개·심사 중은 물론 노출 중단 상태도 잠급니다. 재심사 없이 내용이 바뀐 채
    // 관리자가 다시 공개로 돌리는 경로를 막기 위해서입니다.
    if (!['draft', 'rejected'].includes(d.status))
      fail(409, '임시저장 또는 반려된 작품만 수정할 수 있어요.');
    const b = dramaSchema.parse(req.body);
    await checkMedia(req, b.image);
    await db.run(
      'UPDATE dramas SET title=?,tagline=?,synopsis=?,genre=?,image=?,free=?,episode_pings=?,free_episodes=? WHERE id=?',
      [
        b.title,
        b.tagline,
        b.synopsis,
        b.genre,
        b.image,
        b.free ? 1 : 0,
        b.episode_pings,
        b.free_episodes,
        d.id,
      ],
    );
    await saveDeclaration(d.id, b);
  });
  res.json({ ok: true });
});
app.post('/api/studio/dramas/:id/submit', roles('pd', 'admin'), async (req, res) => {
  await db.transaction(async () => {
    const d = await owned(req, true);
    if (!['draft', 'rejected'].includes(d.status)) fail(409, '현재 상태에서는 제출할 수 없습니다.');
    const { issues } = await contentIssues(d);
    if (!Number(d.rights_confirmed))
      issues.push('작품 정보에서 권리 보유 확인에 동의해 주세요.');
    if (issues.length) fail(400, issues.join(' '));
    await db.run("UPDATE dramas SET status='pending',review_note='' WHERE id=?", [d.id]);
    await contentEvent(req, d.id, 'pending');
  });
  res.json({ ok: true });
});
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) =>
    cb(
      null,
      randomUUID() +
        ({ 'video/mp4': '.mp4', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[
          file.mimetype
        ] || '.invalid'),
    ),
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    cb(null, ['video/mp4', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
async function uploadMedia(req, res) {
  const f = req.file;
  if (!f) fail(400, 'MP4, JPG, PNG, WEBP 파일만 업로드할 수 있어요.');
  if (req.path === '/api/account/avatar') return res.json(await uploadAvatar(req, f));
  res.json(await registerMediaFile(f, req.user.id));
}
// 프로필 이미지는 일반 이미지 저장소가 아닙니다: 이미지 형식·크기(5MB)·가로세로(64~4096px)를 확인하고,
// 시청자 계정은 하루 20장까지만 올릴 수 있어요. 저장하지 않은 이미지는 저장 공간 정리에서 지워집니다.
const AVATAR_DAILY_LIMIT = 20;
async function uploadAvatar(req, f) {
  if (!f.mimetype.startsWith('image/')) {
    unlinkSync(f.path);
    fail(400, '프로필은 JPG, PNG, WEBP 이미지만 등록할 수 있어요.');
  }
  if (req.user.role === 'viewer') {
    const today = await db.get("SELECT COUNT(*) AS n FROM media_files WHERE owner_id=? AND mime LIKE 'image/%' AND created_at>?", [
      req.user.id,
      new Date(Date.now() - 86400000).toISOString(),
    ]);
    if (Number(today?.n || 0) >= AVATAR_DAILY_LIMIT) {
      unlinkSync(f.path);
      fail(429, '프로필 이미지는 하루 20번까지 올릴 수 있어요. 내일 다시 시도해 주세요.');
    }
  }
  const result = await registerMediaFile(f, req.user.id);
  const w = Number(result.width) || 0,
    h = Number(result.height) || 0;
  if (w < 64 || h < 64 || w > 4096 || h > 4096) {
    await db.run('DELETE FROM media_files WHERE url=?', [result.url]).catch(() => {});
    await rm(path.join(uploadDir, path.basename(result.url)), { force: true }).catch(() => {});
    fail(400, '프로필 이미지는 가로·세로 64~4096px 사이로 올려 주세요.');
  }
  return result;
}
// 프로필 이미지를 바꾸면 전에 올린 이미지(다른 곳에서 쓰지 않는 본인 파일)는 바로 지웁니다.
async function dropOldAvatar(userId, oldUrl, newUrl) {
  if (!oldUrl || oldUrl === newUrl || !/^\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/.test(oldUrl)) return;
  const file = await db.get('SELECT owner_id FROM media_files WHERE url=?', [oldUrl]);
  if (file?.owner_id !== userId) return;
  const used = await db.get(
    `SELECT 1 AS used WHERE EXISTS (SELECT 1 FROM user_profiles WHERE avatar=? AND user_id<>?)
       OR EXISTS (SELECT 1 FROM dramas WHERE image=?) OR EXISTS (SELECT 1 FROM channels WHERE banner=? OR logo=?)
       OR EXISTS (SELECT 1 FROM drama_thumbnails WHERE url=?) OR EXISTS (SELECT 1 FROM episodes WHERE thumbnail=?)
       OR EXISTS (SELECT 1 FROM studio_library WHERE image=?) OR EXISTS (SELECT 1 FROM studio_characters WHERE image=?)`,
    [oldUrl, userId, oldUrl, oldUrl, oldUrl, oldUrl, oldUrl, oldUrl, oldUrl],
  );
  if (used) return;
  await db.run('DELETE FROM media_files WHERE url=?', [oldUrl]);
  await rm(path.join(uploadDir, path.basename(oldUrl)), { force: true }).catch(() => {});
}
// 업로드된 파일(일반·분할 업로드 공통)의 형식을 확인하고 media_files에 등록합니다.
// 실패하면 파일을 지웁니다.
async function registerMediaFile(f, ownerId) {
  const head = Buffer.alloc(16),
    fd = openSync(f.path, 'r');
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  const ok =
    (f.mimetype === 'video/mp4' && head.toString('ascii', 4, 8) === 'ftyp') ||
    (f.mimetype === 'image/png' && head.toString('hex', 0, 8) === '89504e470d0a1a0a') ||
    (f.mimetype === 'image/jpeg' && head[0] === 255 && head[1] === 216) ||
    (f.mimetype === 'image/webp' &&
      head.toString('ascii', 0, 4) === 'RIFF' &&
      head.toString('ascii', 8, 12) === 'WEBP');
  if (!ok) {
    unlinkSync(f.path);
    fail(400, '파일 형식이 올바르지 않습니다.');
  }
  const url = '/uploads/' + f.filename;
  try {
    const metadata = await inspectMedia(f, f.mimetype);
    await db.transaction(async () => {
      await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [
        url,
        ownerId,
        f.mimetype,
        now(),
      ]);
      await db.run(
        'INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)',
        [url, metadata.duration, metadata.width, metadata.height, metadata.hasAudio ? 1 : 0],
      );
    });
    const warnings =
      f.mimetype === 'video/mp4' ? precheck({ ...metadata, has_audio: metadata.hasAudio ? 1 : 0 }) : [];
    return { url, type: f.mimetype, ...metadata, warnings };
  } catch (error) {
    if (existsSync(f.path)) unlinkSync(f.path);
    throw error;
  }
}
app.post('/api/studio/upload', roles('pd', 'admin'), upload.single('file'), uploadMedia);
app.post(
  '/api/account/avatar',
  requireAuth,
  multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) =>
      cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
  }).single('file'),
  uploadMedia,
);
app.get('/uploads/:file', (req, res) => {
  if (!/^[a-f0-9-]+\.(jpg|png|webp)$/.test(req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(uploadDir, req.params.file));
});
app.post('/api/studio/dramas/:id/episodes', roles('pd', 'admin'), async (req, res) => {
  await db.transaction(async () => {
    const d = await owned(req, true);
    const b = z
      .object({
        number: z.number().int().min(1).max(500),
        title: z.string().trim().min(1).max(100),
        video: z.string().regex(/^\/(uploads\/[a-f0-9-]+\.mp4|demo\/preview\.mp4)$/),
        duration: z.number().int().min(1).max(3600),
      })
      .parse(req.body);
    if (b.video.startsWith('/demo/') && !demo)
      fail(400, '샘플 영상은 개발 환경에서만 사용할 수 있습니다.');
    await checkMedia(req, b.video);
    const metadata = await db.get('SELECT duration FROM media_metadata WHERE url=?', [b.video]);
    const duration = b.video === '/demo/preview.mp4' ? 12 : metadata?.duration || b.duration;
    const existing = await db.get('SELECT * FROM episodes WHERE drama_id=? AND number=?', [d.id, b.number]);
    if (d.status === 'published') {
      // 연재 중인 작품: 공개된 회차는 그대로 두고, 새 회차(다음 번호)나 아직 공개 전인 회차만 올리고 고칩니다.
      if (existing && !EDITABLE_EPISODE.includes(existing.review_status))
        fail(409, existing.review_status === 'approved' ? '이미 공개된 회차는 바꿀 수 없어요. 새 회차로 올려 주세요.' : '심사 중이거나 공개 예약된 회차예요.');
      const last = await db.get('SELECT MAX(number) AS n FROM episodes WHERE drama_id=?', [d.id]);
      if (!existing && b.number !== Number(last?.n || 0) + 1) fail(409, `다음 회차(${Number(last?.n || 0) + 1}화)부터 순서대로 올려 주세요.`);
    } else if (!['draft', 'rejected'].includes(d.status)) fail(409, '임시저장 또는 반려 상태에서 회차를 수정해 주세요.');
    await db.run(
      'INSERT INTO episodes (id,drama_id,number,title,video,duration,review_status) VALUES (?,?,?,?,?,?,?) ON CONFLICT(drama_id,number) DO UPDATE SET title=excluded.title,video=excluded.video,duration=excluded.duration',
      [randomUUID(), d.id, b.number, b.title, b.video, duration, d.status === 'published' ? 'draft' : 'approved'],
    );
  });
  res.json({ ok: true });
});
app.delete('/api/studio/dramas/:id/episodes/:number', roles('pd', 'admin'), async (req, res) => {
  let subtitleFile = '';
  await db.transaction(async () => {
    const d = await owned(req, true);
    const number = z.coerce.number().int().min(1).parse(req.params.number);
    // 연재 중인 작품은 아직 공개 전인 마지막 회차만 지울 수 있어요.
    const target = await db.get('SELECT review_status FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
    if (!(['draft', 'rejected'].includes(d.status) || (d.status === 'published' && target && ['draft', 'rejected', 'pending', 'scheduled'].includes(target.review_status))))
      fail(409, '임시저장 또는 반려 상태에서 회차를 삭제해 주세요. 연재 중인 작품은 공개 전 회차만 지울 수 있어요.');
    const last = await db.get('SELECT MAX(number) AS number FROM episodes WHERE drama_id=?', [
      d.id,
    ]);
    if (Number(last?.number) !== number)
      fail(409, '회차 순서를 유지하기 위해 마지막 회차부터 삭제해 주세요.');
    const e = await db.get('SELECT subtitles FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
    await db.run('DELETE FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
    subtitleFile = e?.subtitles || '';
  });
  // 회차와 함께 그 회차의 자막 파일도 지웁니다(파일 이름은 형식 검사 후 사용).
  if (/^[a-f0-9-]+\.vtt$/.test(subtitleFile))
    await rm(path.join(uploadDir, 'subtitles', subtitleFile), { force: true }).catch(() => {});
  res.json({ ok: true });
});
app.post('/api/admin/dramas/:id/review', roles('admin'), async (req, res) => {
  const b = z
    .object({ status: z.enum(['published', 'rejected']), note: z.string().max(1000).default('') })
    .parse(req.body);
  const reviewed = await db.transaction(async () => {
    const d = await owned(req, true);
    if (d.status !== 'pending') fail(409, '심사 대기 중인 작품만 처리할 수 있어요.');
    if (b.status === 'rejected' && !b.note.trim()) fail(400, '반려 사유를 입력해 주세요.');
    if (b.status === 'published') {
      const { issues } = await contentIssues(d);
      if (issues.length) fail(400, issues.join(' '));
    }
    await db.run(
      'UPDATE dramas SET status=?,review_note=?,published_at=COALESCE(published_at,?) WHERE id=?',
      [b.status, b.note, b.status === 'published' ? now() : null, d.id],
    );
    // 작품 전체 승인 시 함께 심사한 회차는 모두 공개합니다(공개 예약이 있는 회차는 예약대로).
    if (b.status === 'published')
      await db.run(
        "UPDATE episodes SET review_status=CASE WHEN publish_at IS NOT NULL AND publish_at>? THEN 'scheduled' ELSE 'approved' END WHERE drama_id=? AND review_status IN ('draft','pending','rejected')",
        [now(), d.id],
      );
    // 관리자 검토 화면에 함께 표시된 썸네일 후보도 작품 승인 시에만 공개 실험 대상으로 허용합니다.
    if (b.status === 'published') await db.run('UPDATE drama_thumbnails SET reviewed=1 WHERE drama_id=? AND active=1', [d.id]);
    await contentEvent(req, d.id, b.status, b.note.trim());
    return d;
  });
  // PD에게 심사 결과 알림(알림 저장에 실패해도 심사 결과에는 영향 없음)
  await notify(db, reviewed.owner_id, {
    kind: 'drama_review',
    title: b.status === 'published' ? `${reviewed.title} 심사가 승인됐어요` : `${reviewed.title} 심사가 반려됐어요`,
    body: b.status === 'published' ? '시청자가 지금 볼 수 있어요.' : b.note.trim(),
    link: 'studio/contents',
  }).catch(() => {});
  res.json({ ok: true });
});
app.patch('/api/admin/users/:id', roles('admin'), async (req, res) => {
  const b = z
    .object({ role: z.enum(['viewer', 'pd', 'admin']), status: z.enum(['active', 'suspended']) })
    .parse(req.body);
  if (req.params.id === req.user.id || req.params.id === 'demo-admin')
    fail(400, '현재 관리자 계정은 변경할 수 없어요.');
  if (!(await db.get('SELECT id FROM users WHERE id=?', [req.params.id])))
    fail(404, '회원을 찾을 수 없습니다.');
  await db.transaction(async () => {
    await db.run('UPDATE users SET role=?,status=? WHERE id=?', [b.role, b.status, req.params.id]);
    await db.run(
      'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), req.user.id, `user:${b.role}:${b.status}`, req.params.id, now()],
    );
  });
  res.json({ ok: true });
});
app.get('/api/support', requireAuth, async (req, res) => {
  // 관리자도 시청자 화면의 '문의하기'(mine=1)에서는 본인 문의만 봅니다. 전체 문의는 관리자 화면에서 봅니다.
  const admin = req.user.role === 'admin' && req.query.mine !== '1';
  res.json(
    await db.all(
      'SELECT t.*,u.name FROM support_tickets t JOIN users u ON t.user_id=u.id' +
        (admin ? '' : ' WHERE t.user_id=?') +
        ' ORDER BY t.created_at DESC',
      admin ? [] : [req.user.id],
    ),
  );
});
app.post('/api/support', requireAuth, async (req, res) => {
  const b = z
    .object({
      category: z.enum(['이용 문의', '결제 · 구독', '콘텐츠 신고', 'PD · 제휴']),
      title: z.string().trim().min(2).max(100),
      body: z.string().trim().min(10).max(5000),
    })
    .parse(req.body);
  const id = randomUUID();
  await db.run(
    'INSERT INTO support_tickets (id,user_id,category,title,body,created_at) VALUES (?,?,?,?,?,?)',
    [id, req.user.id, b.category, b.title, b.body, now()],
  );
  res.status(201).json({ id });
});
app.patch('/api/admin/support/:id', roles('admin'), async (req, res) => {
  const b = z.object({ reply: z.string().trim().min(2).max(5000) }).parse(req.body);
  if (!(await db.get('SELECT id FROM support_tickets WHERE id=?', [req.params.id])))
    fail(404, '문의를 찾을 수 없습니다.');
  await db.transaction(async () => {
    await db.run("UPDATE support_tickets SET reply=?,status='answered',replied_at=? WHERE id=?", [
      b.reply,
      now(),
      req.params.id,
    ]);
    await db.run(
      'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), req.user.id, 'support:replied', req.params.id, now()],
    );
  });
  res.json({ ok: true });
});
const routeContext = {
  app,
  db,
  fail,
  now,
  roles,
  requireAuth,
  checkMedia,
  catalogSql,
  demo,
  uploadDir,
  mediaPath,
  owned,
  canWatch,
  registerMediaFile,
  contentIssues,
  episodeEditable,
};
studioRoutes(routeContext);
adminRoutes(routeContext);
accountRoutes({ ...routeContext, authLimiter, sessionToken, publicUser, origin, proxyStatus, production });
uploadRoutes(routeContext);
lamaRoutes(routeContext);
serialRoutes(routeContext);
// 숏핑 스튜디오(AI 제작): 개발 환경에서는 키 없이 쓰는 가짜 AI를 함께 등록합니다.
allowLocalDownloads(!production);
if (demo) await seedMock(db);
const aiEngine = createAiEngine({ db, uploadDir, demo });
// 회차·예고편 합성 대기열. COMPOSE_WORKER=external이면 별도 작업 프로세스(npm run worker)가 처리합니다.
const renderer = createRenderWorker({ db, uploadDir });
adminAiRoutes({ ...routeContext, engine: aiEngine });
// 모델 품질 시험 · 품질 대시보드(6단계, 최고 관리자 전용)
benchRoutes({ ...routeContext, engine: aiEngine });
studioAiRoutes({ ...routeContext, engine: aiEngine, renderer });
await aiEngine.start();
if (process.env.COMPOSE_WORKER !== 'external') {
  await renderer.recover();
  renderer.start();
}
// Confirmed sales become withdrawable on their own schedule, so refresh on a timer too.
setInterval(() => void refreshEntries(db).catch(() => {}), 60 * 60 * 1000).unref();
const shareBase = (req) => socialOrigin(req, origin, production);
// 공유 링크의 대상이 없거나 비공개가 되면 JSON 대신 안내 페이지를 보여 줍니다(카톡·문자에서 열었을 때).
const shareMissing = (req, res, what) => {
  const base = shareBase(req);
  res.status(404).set('Cache-Control', 'no-store').type('html').send(sharePage({
    title: `찾을 수 없는 ${what}이에요 | 숏핑`,
    description: `공개가 끝났거나 주소가 바뀐 ${what}이에요. 숏핑에서 다른 이야기를 만나 보세요.`,
    url: `${base}/`,
    image: `${base}/images/share-shortping.jpg`,
    destination: `${base}/#/home`,
  }));
};
app.get('/share/drama/:id', async (req, res) => {
  const drama = await db.get("SELECT id,title,tagline,synopsis,genre FROM dramas WHERE id=? AND status='published'", [req.params.id]);
  if (!drama) return shareMissing(req, res, '작품');
  const base = shareBase(req);
  res.set('Cache-Control', 'no-store').type('html').send(sharePage({
    title: `${drama.title} | 숏핑`,
    description: `${drama.genre} · ${drama.tagline || drama.synopsis || '지금 숏핑에서 만나보세요.'}`.slice(0, 160),
    url: `${base}/share/drama/${encodeURIComponent(drama.id)}`,
    image: `${base}/images/share-shortping.jpg`,
    destination: `${base}/#/drama/${encodeURIComponent(drama.id)}`,
  }));
});
app.get('/share/channel/:id', async (req, res) => {
  const channel = await db.get("SELECT id,name,tagline,description FROM channels WHERE (id=? OR slug=?) AND status='active'", [req.params.id, req.params.id]);
  if (!channel) return shareMissing(req, res, '방송국');
  const base = shareBase(req);
  res.set('Cache-Control', 'no-store').type('html').send(sharePage({
    title: `${channel.name} 방송국 | 숏핑`,
    description: (channel.tagline || channel.description || 'PD의 새로운 이야기를 숏핑에서 만나보세요.').slice(0, 160),
    url: `${base}/share/channel/${encodeURIComponent(channel.id)}`,
    image: `${base}/images/share-shortping.jpg`,
    destination: `${base}/#/channel/${encodeURIComponent(channel.id)}`,
  }));
});
app.use('/api', (req, res) => res.status(404).json({ error: '요청을 찾을 수 없습니다.' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError)
    // 첫 번째 문제를 한국어 문장으로 바꿔 error에 싣습니다(화면은 error를 그대로 보여 줍니다).
    // details(문제별 문장)와 field(첫 문제 항목)는 화면이 입력칸을 짚어 줄 때 씁니다.
    return res.status(400).json({
      error: zodMessage(err.issues[0]),
      field: err.issues[0]?.path?.join('.') || '',
      details: err.issues.map((i) => zodMessage(i)),
    });
  if (err instanceof multer.MulterError)
    return res.status(400).json({
      error:
        err.code === 'LIMIT_FILE_SIZE' && req.path === '/api/account/avatar'
          ? '프로필 이미지는 5MB 이하로 올려 주세요.'
          : '업로드 제한을 확인해 주세요. 영상은 최대 500MB입니다.',
    });
  // JSON 형식 오류·본문 크기 초과(express.json)는 사용자가 고칠 수 있는 요청 문제로 안내합니다.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '보낸 내용이 너무 커요.' });
  const status = Number(err.status || err.statusCode) || 500;
  // 5xx는 원인 추적을 위해 서버 기록에 스택까지 남깁니다(화면에는 정리된 문구만 보냅니다).
  if (status >= 500)
    console.error(`[숏핑] ${req.method} ${String(req.originalUrl || '').split('?')[0]} → ${status}\n${err.stack || err.message}`, err.detail ? '\n' + err.detail : '');
  else if (err.detail) console.error(err.message, '\n' + err.detail);
  // 직접 정한 안내(상태 코드가 있는 오류)만 보여 주고, 내부 경로·시스템 오류 원문은 감춥니다.
  const safe = Boolean(err.status) && !looksInternal(err.message);
  res.status(status).json({
    error: safe
      ? err.message
      : status === 404
        ? '요청한 항목을 찾을 수 없어요.'
        : status < 500
          ? '요청을 처리하지 못했어요. 입력 내용을 확인해 주세요.'
          : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    // 핑 부족처럼 화면이 다음 행동(충전하러 가기)을 정할 수 있는 오류는 코드와 수치를 함께 보냅니다.
    ...(err.status && err.code ? { code: err.code, need: err.need, balance: err.balance } : {}),
  });
});
// Demo videos are intentionally served only by the access-controlled API.
app.use('/demo', (req, res) => res.sendStatus(404));
if (production) {
  app.get('/', (req, res) => {
    const html = readFileSync(path.resolve('dist/index.html'), 'utf8');
    res.set('Cache-Control', 'no-store').type('html').send(injectHomeTags(html, shareBase(req)));
  });
  app.use(express.static('dist'));
  app.get('/{*path}', (req, res) => res.sendFile(path.resolve('dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: {
      middlewareMode: true,
      hmr: process.env.NODE_ENV === 'test' ? false : { host: '127.0.0.1', port: port + 1 },
    },
    appType: 'spa',
  });
  app.get('/', async (req, res) => {
    const html = await vite.transformIndexHtml('/', readFileSync(path.resolve('index.html'), 'utf8'));
    res.set('Cache-Control', 'no-store').type('html').send(injectHomeTags(html, shareBase(req)));
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(`숏핑 → http://localhost:${port} · ${db.engine} · demo=${demo}`),
);
// 종료 신호(SIGTERM·SIGINT): 새 연결을 받지 않고, 진행 중인 요청이 끝나길 최대 10초 기다린 뒤 DB를 닫고 끝냅니다.
// 두 번째 신호가 오거나 10초가 지나면 바로 끝냅니다(배포 도구·테스트가 멈추지 않게).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log(`[숏핑] ${signal} 받음 — 새 요청을 멈추고 종료합니다.`);
  const force = setTimeout(() => process.exit(0), 10_000);
  force.unref();
  // 새 AI 작업은 더 가져가지 않아요(진행 중인 것은 아래에서 다음 서버에 넘겨줘요).
  aiEngine.pause();
  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  } catch {
    /* 이미 닫힘 */
  }
  // 처리 중이던 AI 작업을 넘겨주고(다음 서버가 바로 이어받도록) DB를 닫습니다.
  await aiEngine.stop().catch(() => {});
  await Promise.resolve(db.close()).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
