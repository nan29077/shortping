import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const port = 5188,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID();
let child,
  output = '',
  viewer,
  pd,
  admin,
  newUser,
  created;
async function request(url, { method = 'GET', body, cookie, headers = {} } = {}) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  return {
    status: r.status,
    data,
    cookie: r.headers.get('set-cookie')?.split(';')[0],
    headers: r.headers,
  };
}
const login = async (role) => {
  const r = await request('/auth/demo', { method: 'POST', body: { role } });
  assert.equal(r.status, 200);
  return r.cookie;
};
before(async () => {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: '',
      PORT: String(port),
      APP_ORIGIN: base,
      ENABLE_DEMO: 'true',
      DATA_DIR: path.resolve('data/tests', runId),
      UPLOAD_DIR: path.resolve('data/tests', runId, 'uploads'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(async () => {
      try {
        const r = await fetch(base + '/api/health');
        if (r.ok) {
          clearInterval(poll);
          resolve();
        }
      } catch {}
      if (Date.now() - start > 30000) {
        clearInterval(poll);
        reject(new Error(output));
      }
    }, 200);
  });
  viewer = await login('viewer');
  pd = await login('pd');
  admin = await login('admin');
});
after(() => child?.kill());
test('catalog contains original drama metadata and excludes private video URLs', async () => {
  const r = await request('/dramas');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 8);
  const d = await request('/dramas/midnight');
  assert.equal(d.data.episodes.length, 12);
  assert.equal(d.data.episodes[2].locked, false);
  assert.equal(d.data.episodes[3].locked, true);
  assert.equal('video' in d.data.episodes[0], false);
});
test('free video supports byte ranges; premium video is protected server-side', async () => {
  const free = await fetch(base + '/api/play/midnight/1', { headers: { Range: 'bytes=0-1023' } });
  assert.equal(free.status, 206);
  assert.match(free.headers.get('content-type'), /video\/mp4/);
  assert.equal((await free.arrayBuffer()).byteLength, 1024);
  assert.equal((await request('/play/midnight/4')).status, 403);
  assert.equal((await fetch(base + '/demo/preview.mp4')).status, 404);
  assert.equal((await request('/play/midnight/500')).status, 403);
});
test('role authorization blocks viewer studio and PD admin actions', async () => {
  assert.equal((await request('/studio', { cookie: viewer })).status, 403);
  assert.equal((await request('/studio', { cookie: pd })).status, 200);
  assert.equal(
    (
      await request('/admin/users/demo-viewer', {
        method: 'PATCH',
        cookie: pd,
        body: { role: 'admin', status: 'active' },
      })
    ).status,
    403,
  );
  assert.equal((await request('/library')).status, 401);
});
test('email signup always creates viewer and password login persists secure session', async () => {
  const email = `qa-${runId}@example.test`;
  const reg = await request('/auth/register', {
    method: 'POST',
    body: { email, password: 'LocalTest!2026', name: '통합 검증', role: 'admin' },
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.user.role, 'viewer');
  assert.equal('password' in reg.data.user, false);
  newUser = reg.data.user;
  const bad = await request('/auth/login', {
    method: 'POST',
    body: { email, password: 'incorrect-password' },
  });
  assert.equal(bad.status, 401);
  const ok = await request('/auth/login', {
    method: 'POST',
    body: { email, password: 'LocalTest!2026' },
  });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await request('/auth/me', { cookie: ok.cookie })).data.user.id, newUser.id);
  assert.equal(
    (
      await request('/auth/register', {
        method: 'POST',
        body: { email, password: 'LocalTest!2026', name: '통합 검증' },
      })
    ).status,
    409,
  );
});
test('cross-origin mutations are rejected', async () => {
  const r = await request('/auth/demo', {
    method: 'POST',
    body: { role: 'admin' },
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(r.status, 403);
});
test('favorites persist, remain isolated by account and can be removed', async () => {
  assert.equal(
    (
      await request('/favorites/midnight', {
        method: 'POST',
        cookie: viewer,
        body: { active: true },
      })
    ).status,
    200,
  );
  assert.deepEqual((await request('/library', { cookie: viewer })).data.favorites, ['midnight']);
  assert.deepEqual((await request('/library', { cookie: pd })).data.favorites, []);
  await request('/favorites/midnight', { method: 'POST', cookie: viewer, body: { active: false } });
  assert.deepEqual((await request('/library', { cookie: viewer })).data.favorites, []);
});
test('watch progress validates episode and access before persisting', async () => {
  assert.equal(
    (
      await request('/history', {
        method: 'POST',
        cookie: viewer,
        body: { dramaId: 'midnight', episode: 4, progress: 5 },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/history', {
        method: 'POST',
        cookie: viewer,
        body: { dramaId: 'midnight', episode: 1, progress: 5 },
      })
    ).status,
    200,
  );
  const h = (await request('/library', { cookie: viewer })).data.history[0];
  assert.equal(h.episode, 1);
  assert.equal(h.progress, 5);
});
test('checkout ignores client price, is atomic and idempotent for concurrent requests', async () => {
  const key = randomUUID();
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      request('/checkout', {
        method: 'POST',
        cookie: viewer,
        body: { kind: 'drama', dramaId: 'midnight', amount: 1, idempotencyKey: key },
      }),
    ),
  );
  results.forEach((r) => assert.equal(r.status, 200));
  assert.equal(new Set(results.map((r) => r.data.id)).size, 1);
  assert.equal(results[0].data.amount, 3900);
  const library = (await request('/library', { cookie: viewer })).data;
  assert.equal(library.orders.length, 1);
  assert.deepEqual(library.purchases, ['midnight']);
  assert.equal(
    (await request('/dramas/midnight', { cookie: viewer })).data.episodes[3].locked,
    false,
  );
  const play = await fetch(base + '/api/play/midnight/4', {
    headers: { cookie: viewer, Range: 'bytes=0-63' },
  });
  assert.equal(play.status, 206);
  assert.equal(
    (
      await request('/checkout', {
        method: 'POST',
        cookie: viewer,
        body: { kind: 'drama', dramaId: 'midnight', idempotencyKey: randomUUID() },
      })
    ).status,
    409,
  );
});
test('subscription unlocks other titles and cancellation preserves purchased titles', async () => {
  assert.equal(
    (
      await request('/checkout', {
        method: 'POST',
        cookie: viewer,
        body: { kind: 'subscription', idempotencyKey: randomUUID() },
      })
    ).status,
    200,
  );
  assert.equal((await request('/dramas/moon', { cookie: viewer })).data.entitled, true);
  assert.equal(
    (
      await request('/checkout', {
        method: 'POST',
        cookie: viewer,
        body: { kind: 'subscription', idempotencyKey: randomUUID() },
      })
    ).status,
    409,
  );
  await request('/subscription/cancel', { method: 'POST', cookie: viewer });
  assert.equal((await request('/dramas/moon', { cookie: viewer })).data.entitled, false);
  assert.equal((await request('/dramas/midnight', { cookie: viewer })).data.entitled, true);
});
test('PD creates private draft; empty draft cannot be submitted', async () => {
  const r = await request('/studio/dramas', {
    method: 'POST',
    cookie: pd,
    body: {
      title: '검증용 새로운 이야기',
      tagline: '진실이 시작되는 순간',
      synopsis: '테스트를 위한 충분한 길이의 작품 줄거리입니다.',
      genre: '스릴러',
      price: 2900,
      free_episodes: 1,
      image: '/images/shadow.webp',
    },
  });
  assert.equal(r.status, 200);
  created = r.data.id;
  assert.equal((await request('/dramas/' + created)).status, 404);
  assert.equal(
    (await request('/studio/dramas/' + created + '/submit', { method: 'POST', cookie: pd })).status,
    400,
  );
});
test('upload checks file signature and protects videos from public direct access', async () => {
  const bad = new FormData();
  bad.set('file', new Blob(['not an mp4'], { type: 'video/mp4' }), 'bad.mp4');
  assert.equal(
    (await request('/studio/upload', { method: 'POST', cookie: pd, body: bad })).status,
    400,
  );
  const good = new FormData();
  good.set(
    'file',
    new Blob([readFileSync('public/demo/preview.mp4')], { type: 'video/mp4' }),
    'teaser.mp4',
  );
  const r = await request('/studio/upload', { method: 'POST', cookie: pd, body: good });
  assert.equal(r.status, 200);
  assert.match(r.data.url, /\.mp4$/);
  assert.equal((await fetch(base + r.data.url)).status, 404);
  assert.equal(
    (
      await request('/studio/dramas/' + created + '/episodes', {
        method: 'POST',
        cookie: pd,
        body: { number: 1, title: '시작', duration: 12, video: r.data.url },
      })
    ).status,
    200,
  );
});
test('PD submission -> admin rejection -> revision -> approval -> public playback', async () => {
  assert.equal(
    (await request('/studio/dramas/' + created + '/submit', { method: 'POST', cookie: pd })).status,
    200,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + created + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'rejected', note: '' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + created + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'rejected', note: '표지 검토 완료 후 재제출' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/dramas/' + created, { cookie: pd })).data.review_note,
    '표지 검토 완료 후 재제출',
  );
  assert.equal(
    (await request('/studio/dramas/' + created + '/submit', { method: 'POST', cookie: pd })).status,
    200,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + created + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'published', note: '승인' },
      })
    ).status,
    200,
  );
  assert.equal((await request('/dramas/' + created)).status, 200);
  assert.equal(
    (await fetch(base + '/api/play/' + created + '/1', { headers: { Range: 'bytes=0-20' } }))
      .status,
    206,
  );
  assert.equal(
    (
      await request('/studio/dramas/' + created + '/episodes', {
        method: 'POST',
        cookie: pd,
        body: { number: 2, title: '우회 수정', duration: 12, video: '/demo/preview.mp4' },
      })
    ).status,
    409,
  );
});
test('admin user management, audit trail, and protected administrator', async () => {
  assert.equal(
    (
      await request('/admin/users/' + newUser.id, {
        method: 'PATCH',
        cookie: admin,
        body: { role: 'pd', status: 'active' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/admin/users/demo-admin', {
        method: 'PATCH',
        cookie: admin,
        body: { role: 'viewer', status: 'suspended' },
      })
    ).status,
    400,
  );
  const s = await request('/studio', { cookie: admin });
  assert.ok(s.data.logs.length >= 3);
  assert.equal(s.data.users.find((u) => u.id === newUser.id).role, 'pd');
});
test('logout invalidates the server session', async () => {
  const c = await login('viewer');
  assert.equal((await request('/auth/me', { cookie: c })).data.user.role, 'viewer');
  await request('/auth/logout', { method: 'POST', cookie: c });
  assert.equal((await request('/auth/me', { cookie: c })).data.user, null);
  assert.equal((await request('/library', { cookie: c })).status, 401);
});
