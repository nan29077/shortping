import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { openDb, migrate } from './db.mjs';
import { seed, hashPassword } from './seed.mjs';

const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const demo = !production && process.env.ENABLE_DEMO !== 'false';
const port = Number(process.env.PORT || 5173);
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
if (production && (!process.env.DATABASE_URL || !origin.startsWith('https://')))
  throw new Error('Production requires DATABASE_URL and HTTPS APP_ORIGIN');
const db = await openDb();
await migrate(db);
if (demo) await seed(db);
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
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
  }),
);
app.use(express.json({ limit: '256kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.get('origin') &&
    ![origin, ...(production ? [] : [`http://127.0.0.1:${port}`])].includes(req.get('origin'))
  )
    return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
  next();
});
app.use(
  '/api',
  rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }),
);
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  message: { error: '잠시 후 다시 시도해 주세요.' },
});
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const now = () => new Date().toISOString();
const publicUser = (u) =>
  u ? { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status } : null;
const cookieToken = (req) => {
  const raw = req.headers.cookie
    ?.split(';')
    .find((c) => c.trim().startsWith('sp_session='))
    ?.trim()
    .slice(11);
  return raw ? createHash('sha256').update(raw).digest('hex') : '';
};
app.use('/api', async (req, res, next) => {
  try {
    const token = cookieToken(req);
    req.user = token
      ? await db.get(
          'SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>? AND u.status=?',
          [token, now(), 'active'],
        )
      : null;
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
  const old = cookieToken(req);
  if (old) await db.run('DELETE FROM sessions WHERE token=?', [old]);
  const token = randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)', [
    createHash('sha256').update(token).digest('hex'),
    user.id,
    new Date(Date.now() + 7 * 86400000).toISOString(),
  ]);
  res.cookie('sp_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    maxAge: 7 * 86400000,
    path: '/',
  });
  res.json({ user: publicUser(user) });
}
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(8).max(128),
});
app.get('/api/config', (req, res) =>
  res.json({
    demo,
    androidUrl: process.env.ANDROID_STORE_URL || null,
    iosUrl: process.env.IOS_STORE_URL || null,
  }),
);
app.get('/api/health', (req, res) => res.json({ ok: true, database: db.engine }));
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
  await db.run('INSERT INTO users (id,email,name,password,role,created_at) VALUES (?,?,?,?,?,?)', [
    user.id,
    c.email,
    c.name,
    hashPassword(c.password),
    'viewer',
    now(),
  ]);
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
app.post('/api/auth/logout', async (req, res) => {
  await db.run('DELETE FROM sessions WHERE token=?', [cookieToken(req)]);
  res.clearCookie('sp_session', { path: '/' }).json({ ok: true });
});
const catalogSql =
  'SELECT d.*, (SELECT COUNT(*) FROM episodes e WHERE e.drama_id=d.id) AS episode_count FROM dramas d';
app.get('/api/dramas', async (req, res) =>
  res.json(await db.all(catalogSql + " WHERE d.status='published' ORDER BY d.views DESC")),
);
app.get('/api/dramas/:id', async (req, res) => {
  const d = await db.get(catalogSql + ' WHERE d.id=?', [req.params.id]);
  if (!d || (d.status !== 'published' && req.user?.role !== 'admin' && d.owner_id !== req.user?.id))
    fail(404, '작품을 찾을 수 없습니다.');
  const entitled = await hasAccess(req.user, d);
  const episodes = await db.all(
    "SELECT id,number,title,duration,CASE WHEN video='/demo/preview.mp4' THEN 1 ELSE 0 END AS is_demo FROM episodes WHERE drama_id=? ORDER BY number",
    [d.id],
  );
  res.json({
    ...d,
    entitled,
    episodes: episodes.map((e) => ({ ...e, locked: !entitled && e.number > d.free_episodes })),
  });
});
async function hasAccess(user, d) {
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
  if (number > d.free_episodes && !(await hasAccess(req.user, d)))
    fail(403, '이 회차는 작품 구매 또는 구독 후 시청할 수 있어요.');
  const e = await db.get('SELECT * FROM episodes WHERE drama_id=? AND number=?', [d.id, number]);
  if (!e?.video) fail(404, '영상이 아직 등록되지 않았습니다.');
  const file = e.video.startsWith('/demo/')
    ? path.resolve('public/demo/preview.mp4')
    : path.join(uploadDir, path.basename(e.video));
  res.sendFile(file, (err) => {
    if (err && !res.headersSent)
      res.status(404).json({ error: '영상 파일이 아직 준비되지 않았습니다.' });
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
      'SELECT o.*,d.title FROM orders o LEFT JOIN dramas d ON d.id=o.drama_id WHERE o.user_id=? ORDER BY o.created_at DESC',
      [u],
    ),
    purchases: (await db.all('SELECT drama_id FROM entitlements WHERE user_id=?', [u])).map(
      (x) => x.drama_id,
    ),
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
  if (b.episode > d.free_episodes && !(await hasAccess(req.user, d)))
    fail(403, '시청 권한이 없습니다.');
  if (!(await db.get('SELECT id FROM episodes WHERE drama_id=? AND number=?', [d.id, b.episode])))
    fail(404, '회차를 찾을 수 없습니다.');
  await db.run(
    'INSERT INTO history (user_id,drama_id,episode,progress,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,drama_id) DO UPDATE SET episode=excluded.episode,progress=excluded.progress,updated_at=excluded.updated_at',
    [req.user.id, b.dramaId, b.episode, b.progress, now()],
  );
  res.json({ ok: true });
});
app.post('/api/checkout', requireAuth, async (req, res) => {
  if (!demo) fail(503, '결제 서비스 연동 준비 중입니다.');
  const b = z
    .object({
      kind: z.enum(['drama', 'subscription']),
      dramaId: z.string().optional(),
      idempotencyKey: z.string().uuid(),
    })
    .parse(req.body);
  const result = await db.transaction(async () => {
    if (db.engine === 'postgresql')
      await db.get('SELECT id FROM users WHERE id=? FOR UPDATE', [req.user.id]);
    const existing = await db.get('SELECT * FROM orders WHERE idempotency_key=?', [
      b.idempotencyKey,
    ]);
    if (existing) {
      if (existing.user_id !== req.user.id) fail(409, '중복 요청입니다.');
      return existing;
    }
    let amount = 7900,
      dramaId = null;
    if (b.kind === 'drama') {
      const d = await db.get("SELECT * FROM dramas WHERE id=? AND status='published'", [
        b.dramaId || '',
      ]);
      if (!d) fail(404, '작품을 찾을 수 없습니다.');
      if (
        await db.get('SELECT user_id FROM entitlements WHERE user_id=? AND drama_id=?', [
          req.user.id,
          d.id,
        ])
      )
        fail(409, '이미 구매한 작품입니다.');
      amount = d.price;
      dramaId = d.id;
    } else if (
      await db.get('SELECT user_id FROM subscriptions WHERE user_id=? AND expires_at>?', [
        req.user.id,
        now(),
      ])
    )
      fail(409, '이미 구독 중입니다.');
    const id = randomUUID();
    await db.run(
      'INSERT INTO orders (id,user_id,drama_id,kind,amount,status,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, req.user.id, dramaId, b.kind, amount, 'test_paid', b.idempotencyKey, now()],
    );
    if (b.kind === 'drama')
      await db.run(
        'INSERT INTO entitlements (user_id,drama_id,order_id) VALUES (?,?,?) ON CONFLICT DO NOTHING',
        [req.user.id, dramaId, id],
      );
    else
      await db.run(
        'INSERT INTO subscriptions (user_id,order_id,expires_at,auto_renew) VALUES (?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET order_id=excluded.order_id,expires_at=excluded.expires_at,auto_renew=0',
        [req.user.id, id, new Date(Date.now() + 30 * 86400000).toISOString()],
      );
    return { id, amount, status: 'test_paid' };
  });
  res.json(result);
});
app.post('/api/subscription/cancel', requireAuth, async (req, res) => {
  await db.run('UPDATE subscriptions SET expires_at=?,auto_renew=0 WHERE user_id=?', [
    now(),
    req.user.id,
  ]);
  res.json({ ok: true });
});
app.get('/api/studio', roles('pd', 'admin'), async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const ds = await db.all(
    catalogSql + (isAdmin ? '' : ' WHERE d.owner_id=?') + ' ORDER BY d.created_at DESC',
    isAdmin ? [] : [req.user.id],
  );
  const orders = await db.all(
    'SELECT o.*,d.title FROM orders o LEFT JOIN dramas d ON o.drama_id=d.id' +
      (isAdmin ? '' : ' WHERE d.owner_id=?') +
      ' ORDER BY o.created_at DESC',
    isAdmin ? [] : [req.user.id],
  );
  res.json({
    dramas: ds,
    orders,
    users: isAdmin
      ? await db.all(
          'SELECT id,email,name,role,status,created_at FROM users ORDER BY created_at DESC',
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
  genre: z.enum(['로맨스', '스릴러', '판타지', '코미디', '청춘']),
  price: z.number().int().min(0).max(100000),
  free_episodes: z.number().int().min(1).max(50),
  image: z.string().regex(/^\/(images\/[a-z0-9-]+\.webp|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/),
});
async function checkMedia(req, url) {
  if (url.startsWith('/uploads/')) {
    const file = await db.get('SELECT * FROM media_files WHERE url=?', [url]);
    if (!file || (file.owner_id !== req.user.id && req.user.role !== 'admin'))
      fail(403, '본인이 업로드한 파일만 사용할 수 있어요.');
  }
}
app.post('/api/studio/dramas', roles('pd', 'admin'), async (req, res) => {
  const b = dramaSchema.parse(req.body),
    id = randomUUID();
  await checkMedia(req, b.image);
  await db.run(
    'INSERT INTO dramas (id,owner_id,title,tagline,synopsis,genre,image,price,free_episodes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      req.user.id,
      b.title,
      b.tagline,
      b.synopsis,
      b.genre,
      b.image,
      b.price,
      b.free_episodes,
      now(),
    ],
  );
  res.json({ id });
});
async function owned(req) {
  const d = await db.get('SELECT * FROM dramas WHERE id=?', [req.params.id]);
  if (!d) fail(404, '작품을 찾을 수 없습니다.');
  if (req.user.role !== 'admin' && d.owner_id !== req.user.id)
    fail(403, '본인 작품만 수정할 수 있습니다.');
  return d;
}
app.patch('/api/studio/dramas/:id', roles('pd', 'admin'), async (req, res) => {
  const d = await owned(req);
  if (d.status === 'published' || d.status === 'pending')
    fail(409, '임시저장 또는 반려된 작품만 수정할 수 있어요.');
  const b = dramaSchema.parse(req.body);
  await checkMedia(req, b.image);
  await db.run(
    'UPDATE dramas SET title=?,tagline=?,synopsis=?,genre=?,image=?,price=?,free_episodes=? WHERE id=?',
    [b.title, b.tagline, b.synopsis, b.genre, b.image, b.price, b.free_episodes, d.id],
  );
  res.json({ ok: true });
});
app.post('/api/studio/dramas/:id/submit', roles('pd', 'admin'), async (req, res) => {
  const d = await owned(req);
  if (!['draft', 'rejected'].includes(d.status)) fail(409, '현재 상태에서는 제출할 수 없습니다.');
  if (!(await db.get("SELECT id FROM episodes WHERE drama_id=? AND video<>''", [d.id])))
    fail(400, '영상이 포함된 회차를 먼저 등록해 주세요.');
  const episodes = await db.all(
    'SELECT number,video FROM episodes WHERE drama_id=? ORDER BY number',
    [d.id],
  );
  if (episodes.some((e, index) => e.number !== index + 1 || !e.video))
    fail(400, '1화부터 빠진 회차 없이 영상을 등록해 주세요.');
  await db.run("UPDATE dramas SET status='pending',review_note='' WHERE id=?", [d.id]);
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
  limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    cb(null, ['video/mp4', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
app.post('/api/studio/upload', roles('pd', 'admin'), upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) fail(400, 'MP4, JPG, PNG, WEBP 파일만 업로드할 수 있어요.');
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
  await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [
    url,
    req.user.id,
    f.mimetype,
    now(),
  ]);
  res.json({ url, type: f.mimetype });
});
app.get('/uploads/:file', (req, res) => {
  if (!/^[a-f0-9-]+\.(jpg|png|webp)$/.test(req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(uploadDir, req.params.file));
});
app.post('/api/studio/dramas/:id/episodes', roles('pd', 'admin'), async (req, res) => {
  const d = await owned(req);
  if (!['draft', 'rejected'].includes(d.status))
    fail(409, '임시저장 또는 반려 상태에서 회차를 수정해 주세요.');
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
  await db.run(
    'INSERT INTO episodes (id,drama_id,number,title,video,duration) VALUES (?,?,?,?,?,?) ON CONFLICT(drama_id,number) DO UPDATE SET title=excluded.title,video=excluded.video,duration=excluded.duration',
    [randomUUID(), d.id, b.number, b.title, b.video, b.duration],
  );
  res.json({ ok: true });
});
app.post('/api/admin/dramas/:id/review', roles('admin'), async (req, res) => {
  const b = z
    .object({ status: z.enum(['published', 'rejected']), note: z.string().max(1000).default('') })
    .parse(req.body);
  const d = await owned(req);
  if (d.status !== 'pending') fail(409, '심사 대기 중인 작품만 처리할 수 있어요.');
  if (b.status === 'rejected' && !b.note.trim()) fail(400, '반려 사유를 입력해 주세요.');
  await db.run('UPDATE dramas SET status=?,review_note=? WHERE id=?', [b.status, b.note, d.id]);
  await db.run(
    'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
    [randomUUID(), req.user.id, b.status, d.id, now()],
  );
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
  await db.run('UPDATE users SET role=?,status=? WHERE id=?', [b.role, b.status, req.params.id]);
  await db.run(
    'INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)',
    [randomUUID(), req.user.id, `user:${b.role}:${b.status}`, req.params.id, now()],
  );
  res.json({ ok: true });
});
app.use('/api', (req, res) => res.status(404).json({ error: '요청을 찾을 수 없습니다.' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError)
    return res.status(400).json({
      error: '입력 내용을 확인해 주세요.',
      details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: '업로드 제한을 확인해 주세요. 최대 250MB입니다.' });
  console.error(err.message);
  res.status(err.status || 500).json({
    error: err.status ? err.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  });
});
// Demo videos are intentionally served only by the access-controlled API.
app.use('/demo', (req, res) => res.sendStatus(404));
if (production) {
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
  app.use(vite.middlewares);
}
const server = app.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(`숏핑 → http://localhost:${port} · ${db.engine} · demo=${demo}`),
);
async function shutdown() {
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
