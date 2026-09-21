import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileSync, renameSync } from 'node:fs';

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
// 핑 충전(테스트 결제)과 핑으로 회차·작품 열기
const chargePings = (cookie, productId = 'ping-10k', idempotencyKey = randomUUID()) =>
  request('/pings/charge', { method: 'POST', cookie, body: { productId, idempotencyKey } });
const unlock = (cookie, body) =>
  request('/pings/unlock', {
    method: 'POST',
    cookie,
    body: { idempotencyKey: randomUUID(), ...body },
  });
const registerBuyer = async (prefix, name = '핑 검수') =>
  (
    await request('/auth/register', {
      method: 'POST',
      body: { email: `${prefix}-${runId}@example.test`, password: 'LocalTest!2026', name },
    })
  ).cookie;
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
test('ping unlocks ignore client prices, are atomic and idempotent for concurrent requests', async () => {
  // 원화 회차·작품 결제는 없어졌다. 원화 결제는 구독만 받는다.
  assert.equal(
    (
      await request('/checkout', {
        method: 'POST',
        cookie: viewer,
        body: { kind: 'drama', dramaId: 'midnight', idempotencyKey: randomUUID() },
      })
    ).status,
    400,
  );
  const chargeKey = randomUUID();
  const charges = await Promise.all([1, 2].map(() => chargePings(viewer, 'ping-10k', chargeKey)));
  charges.forEach((r) => assert.equal(r.status, 200));
  assert.equal(new Set(charges.map((r) => r.data.id)).size, 1);
  assert.equal(charges[0].data.amount, 10000);
  assert.equal((await request('/pings', { cookie: viewer })).data.wallet.total, 100);
  const detail = (await request('/dramas/midnight', { cookie: viewer })).data;
  assert.equal(detail.episode_pings, 5);
  assert.equal(detail.locked_count, 9);
  // 9편 × 5핑 = 45핑, 전체 열기 20% 할인 → 36핑
  assert.equal(detail.title_pings, 36);
  const key = randomUUID();
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      request('/pings/unlock', {
        method: 'POST',
        cookie: viewer,
        body: { dramaId: 'midnight', all: true, pings: 1, idempotencyKey: key },
      }),
    ),
  );
  results.forEach((r) => assert.equal(r.status, 200));
  assert.equal(new Set(results.map((r) => r.data.id)).size, 1);
  assert.equal(results[0].data.pings, 36);
  const library = (await request('/library', { cookie: viewer })).data;
  assert.equal(library.orders.filter((o) => o.kind === 'ping_title').length, 1);
  assert.equal(library.orders.filter((o) => o.kind === 'ping_charge').length, 1);
  assert.deepEqual(library.purchases, ['midnight']);
  assert.equal(library.wallet.total, 64);
  assert.equal(
    (await request('/dramas/midnight', { cookie: viewer })).data.episodes[3].locked,
    false,
  );
  const play = await fetch(base + '/api/play/midnight/4', {
    headers: { cookie: viewer, Range: 'bytes=0-63' },
  });
  assert.equal(play.status, 206);
  assert.equal((await unlock(viewer, { dramaId: 'midnight', all: true })).status, 409);
  assert.equal((await unlock(viewer, { dramaId: 'midnight', episode: 5 })).status, 409);
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
test('studio exposes operational and subscription data only to administrators', async () => {
  const a = await request('/studio', { cookie: admin });
  assert.equal(a.data.operations.database, 'SQLite');
  assert.equal(a.data.operations.demo, true);
  assert.ok(Array.isArray(a.data.subscriptions));
  const p = await request('/studio', { cookie: pd });
  assert.equal(p.data.operations, null);
  assert.deepEqual(p.data.subscriptions, []);
  assert.deepEqual(p.data.users, []);
  assert.deepEqual(p.data.logs, []);
});
test('support tickets are private, validated, and answered only by administrators', async () => {
  assert.equal((await request('/support')).status, 401);
  assert.equal(
    (
      await request('/support', {
        method: 'POST',
        cookie: viewer,
        body: { category: '이용 문의', title: '짧음', body: '짧음' },
      })
    ).status,
    400,
  );
  const submitted = await request('/support', {
    method: 'POST',
    cookie: viewer,
    body: {
      category: '결제 · 구독',
      title: '구독 이용 문의',
      body: '테스트 구독 종료 방법을 알려주세요.',
    },
  });
  assert.equal(submitted.status, 201);
  const id = submitted.data.id;
  assert.ok((await request('/support', { cookie: viewer })).data.some((t) => t.id === id));
  assert.ok(!(await request('/support', { cookie: pd })).data.some((t) => t.id === id));
  assert.ok((await request('/support', { cookie: admin })).data.some((t) => t.id === id));
  for (const cookie of [viewer, pd])
    assert.equal(
      (
        await request('/admin/support/' + id, {
          method: 'PATCH',
          cookie,
          body: { reply: '허용되지 않는 답변' },
        })
      ).status,
      403,
    );
  assert.equal(
    (await request('/admin/support/' + id, { method: 'PATCH', cookie: admin, body: { reply: '' } }))
      .status,
    400,
  );
  assert.equal(
    (
      await request('/admin/support/missing', {
        method: 'PATCH',
        cookie: admin,
        body: { reply: '없는 문의 답변' },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request('/admin/support/' + id, {
        method: 'PATCH',
        cookie: admin,
        body: { reply: '마이페이지에서 테스트 구독을 종료할 수 있어요.' },
      })
    ).status,
    200,
  );
  const ticket = (await request('/support', { cookie: viewer })).data.find((t) => t.id === id);
  assert.equal(ticket.status, 'answered');
  assert.match(ticket.reply, /마이페이지/);
  assert.ok(ticket.replied_at);
  assert.ok(
    (await request('/studio', { cookie: admin })).data.logs.some(
      (l) => l.action === 'support:replied' && l.target_id === id,
    ),
  );
});
test('logout invalidates the server session', async () => {
  const c = await login('viewer');
  assert.equal((await request('/auth/me', { cookie: c })).data.user.role, 'viewer');
  await request('/auth/logout', { method: 'POST', cookie: c });
  assert.equal((await request('/auth/me', { cookie: c })).data.user, null);
  assert.equal((await request('/library', { cookie: c })).status, 401);
});

const draftBody = {
  title: '정밀 검수 작품',
  tagline: '업로드와 심사를 확인합니다',
  synopsis: '파일 등록부터 관리자 심사까지 점검하는 테스트 작품입니다.',
  genre: '로맨스',
  free_episodes: 1,
  image: '/images/hero.webp',
};
const makeDraft = async () => {
  const r = await request('/studio/dramas', { method: 'POST', cookie: pd, body: draftBody });
  assert.equal(r.status, 200);
  return r.data.id;
};
const saveEpisode = (id, number, video = '/demo/preview.mp4') =>
  request('/studio/dramas/' + id + '/episodes', {
    method: 'POST',
    cookie: pd,
    body: { number, title: `${number}화 검수`, duration: 90, video },
  });

test('media decoder rejects spoofed signatures, validates posters, and measures video duration', async () => {
  for (const [type, bytes] of [
    ['video/mp4', Buffer.from('0000ftypisom0000')],
    ['image/png', Buffer.from('89504e470d0a1a0a0000000000000000', 'hex')],
  ]) {
    const body = new FormData();
    body.set('file', new Blob([bytes], { type }), 'broken');
    assert.equal(
      (await request('/studio/upload', { method: 'POST', cookie: pd, body })).status,
      400,
    );
  }
  const image = new FormData();
  image.set(
    'file',
    new Blob([readFileSync('public/images/hero.webp')], { type: 'image/webp' }),
    'poster.webp',
  );
  const poster = await request('/studio/upload', { method: 'POST', cookie: pd, body: image });
  assert.equal(poster.status, 200);
  assert.ok(poster.data.width > 0);
  assert.equal(
    (
      await request('/studio/dramas', {
        method: 'POST',
        cookie: pd,
        body: { ...draftBody, image: '/images/missing.webp' },
      })
    ).status,
    400,
  );
  const body = new FormData();
  body.set(
    'file',
    new Blob([readFileSync('public/demo/preview.mp4')], { type: 'video/mp4' }),
    'real.mp4',
  );
  const video = await request('/studio/upload', { method: 'POST', cookie: pd, body });
  assert.equal(video.status, 200);
  assert.equal(video.data.duration, 12);
  const id = await makeDraft();
  assert.equal((await saveEpisode(id, 1, video.data.url)).status, 200);
  assert.equal(
    (await request('/studio/dramas/' + id, { cookie: pd })).data.episodes[0].duration,
    12,
  );
  // Isolated test file loss must block both submission and later approval.
  const file = path.resolve('data/tests', runId, 'uploads', path.basename(video.data.url));
  renameSync(file, file + '.held');
  try {
    assert.equal(
      (await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd })).status,
      400,
    );
  } finally {
    renameSync(file + '.held', file);
  }
  assert.equal(
    (await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd })).status,
    200,
  );
  renameSync(file, file + '.held');
  try {
    assert.equal(
      (
        await request('/admin/dramas/' + id + '/review', {
          method: 'POST',
          cookie: admin,
          body: { status: 'published' },
        })
      ).status,
      400,
    );
  } finally {
    renameSync(file + '.held', file);
  }
  assert.equal((await request('/studio/dramas/' + id, { cookie: admin })).data.status, 'pending');
});

test('private inspection, uploaded file ownership, episode correction and deletion are enforced', async () => {
  const other = await request('/auth/login', {
    method: 'POST',
    body: { email: newUser.email, password: 'LocalTest!2026' },
  });
  assert.equal(other.status, 200);
  const id = await makeDraft();
  assert.equal((await request('/studio/dramas/' + id, { cookie: viewer })).status, 403);
  assert.equal((await request('/studio/dramas/' + id, { cookie: other.cookie })).status, 403);
  assert.equal(
    (
      await request('/studio/dramas/' + id + '/episodes', {
        method: 'POST',
        cookie: other.cookie,
        body: { number: 1, title: '우회', duration: 12, video: '/demo/preview.mp4' },
      })
    ).status,
    403,
  );
  const body = new FormData();
  body.set(
    'file',
    new Blob([readFileSync('public/images/hero.webp')], { type: 'image/webp' }),
    'poster.webp',
  );
  const poster = await request('/studio/upload', { method: 'POST', cookie: pd, body });
  assert.equal(
    (
      await request('/studio/dramas', {
        method: 'POST',
        cookie: other.cookie,
        body: { ...draftBody, image: poster.data.url },
      })
    ).status,
    403,
  );
  await saveEpisode(id, 2);
  assert.equal(
    (await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd })).status,
    400,
  );
  await saveEpisode(id, 1);
  assert.equal(
    (await request('/studio/dramas/' + id + '/episodes/1', { method: 'DELETE', cookie: pd }))
      .status,
    409,
  );
  assert.equal(
    (await request('/studio/dramas/' + id + '/episodes/2', { method: 'DELETE', cookie: pd }))
      .status,
    200,
  );
  assert.equal((await request('/studio/dramas/' + id, { cookie: pd })).data.episodes.length, 1);
  await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd });
  assert.equal(
    (await request('/studio/dramas/' + id + '/episodes/1', { method: 'DELETE', cookie: pd }))
      .status,
    409,
  );
  assert.equal(
    (await request('/studio/dramas/' + id, { method: 'PATCH', cookie: pd, body: draftBody }))
      .status,
    409,
  );
});

test('concurrent submissions and reviews commit once and preserve review reasons', async () => {
  const id = await makeDraft();
  await saveEpisode(id, 1);
  const submitted = await Promise.all(
    [1, 2].map(() => request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd })),
  );
  assert.deepEqual(submitted.map((r) => r.status).sort(), [200, 409]);
  const reviewed = await Promise.all(
    [1, 2].map(() =>
      request('/admin/dramas/' + id + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'rejected', note: '1화 표지 보완 필요' },
      }),
    ),
  );
  assert.deepEqual(reviewed.map((r) => r.status).sort(), [200, 409]);
  await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd });
  const detail = (await request('/studio/dramas/' + id, { cookie: pd })).data;
  assert.equal(detail.reviews.length, 3);
  assert.equal(detail.reviews.filter((r) => r.status === 'rejected').length, 1);
  assert.ok(detail.reviews.some((r) => r.note === '1화 표지 보완 필요'));
  assert.equal((await request('/dramas/' + id)).status, 404);
  assert.equal((await fetch(base + '/api/play/' + id + '/1')).status, 404);
});

test('all roles receive one persistent random avatar and cannot choose another default', async () => {
  for (const role of ['viewer', 'pd', 'admin']) {
    const cookie = await login(role);
    const u = (await request('/auth/me', { cookie })).data.user;
    assert.match(u.avatar, /^\/avatars\/block-(0[1-9]|[12][0-9]|30)\.webp$/);
    const otherAvatar = u.avatar.endsWith('30.webp')
      ? '/avatars/block-29.webp'
      : '/avatars/block-30.webp';
    assert.equal(
      (
        await request('/account/profile', {
          method: 'PATCH',
          cookie,
          body: { name: u.name, bio: '', avatar: otherAvatar, auto_next: true },
        })
      ).status,
      403,
    );
    const changed = await request('/account/profile', {
      method: 'PATCH',
      cookie,
      body: {
        name: u.name,
        bio: '계정 설정 검수',
        avatar: u.avatar,
        auto_next: false,
        role: 'admin',
      },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.role, role);
    const again = await login(role);
    const saved = (await request('/auth/me', { cookie: again })).data.user;
    assert.equal(saved.avatar, u.avatar);
    assert.equal(saved.auto_next, false);
    assert.equal(saved.bio, '계정 설정 검수');
  }
  assert.equal((await request('/account/profile', { method: 'PATCH', body: {} })).status, 401);
});

test('viewer profile uploads accept real images and block videos and foreign media', async () => {
  const cookie = await login('viewer');
  const body = new FormData();
  body.set(
    'file',
    new Blob([readFileSync('public/images/hero.webp')], { type: 'image/webp' }),
    'profile.webp',
  );
  const uploaded = await request('/account/avatar', { method: 'POST', cookie, body });
  assert.equal(uploaded.status, 200);
  const u = (await request('/auth/me', { cookie })).data.user;
  const profile = { name: u.name, bio: '사진 등록', avatar: uploaded.data.url, auto_next: true };
  assert.equal(
    (await request('/account/profile', { method: 'PATCH', cookie, body: profile })).status,
    200,
  );
  assert.equal(
    (await request('/account/profile', { method: 'PATCH', cookie: admin, body: profile })).status,
    403,
  );
  assert.equal(
    (
      await request('/account/profile', {
        method: 'PATCH',
        cookie,
        body: { ...profile, avatar: '/avatars/block-31.webp' },
      })
    ).status,
    400,
  );
  const video = new FormData();
  video.set(
    'file',
    new Blob([readFileSync('public/demo/preview.mp4')], { type: 'video/mp4' }),
    'video.mp4',
  );
  assert.equal(
    (await request('/account/avatar', { method: 'POST', cookie, body: video })).status,
    400,
  );
  const again = await login('viewer');
  assert.equal((await request('/auth/me', { cookie: again })).data.user.avatar, uploaded.data.url);
});

test('password change verifies current password and invalidates other sessions only', async () => {
  const email = `security-${runId}@example.com`;
  const reg = await request('/auth/register', {
    method: 'POST',
    body: { email, password: 'Initial!2026', name: '보안 검수' },
  });
  const second = await request('/auth/login', {
    method: 'POST',
    body: { email, password: 'Initial!2026' },
  });
  const cookie = reg.cookie;
  assert.equal(
    (
      await request('/account/password', {
        method: 'POST',
        cookie,
        body: { currentPassword: 'wrong', newPassword: 'Changed!2026' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/account/password', {
        method: 'POST',
        cookie,
        body: { currentPassword: 'Initial!2026', newPassword: 'Changed!2026' },
      })
    ).status,
    200,
  );
  assert.equal((await request('/auth/me', { cookie: second.cookie })).data.user, null);
  assert.ok((await request('/auth/me', { cookie })).data.user);
  assert.equal(
    (await request('/auth/login', { method: 'POST', body: { email, password: 'Initial!2026' } }))
      .status,
    401,
  );
  const current = await request('/auth/login', {
    method: 'POST',
    body: { email, password: 'Changed!2026' },
  });
  assert.equal(current.status, 200);
  assert.equal(
    (await request('/account/revoke-sessions', { method: 'POST', cookie: current.cookie })).status,
    200,
  );
  assert.equal((await request('/auth/me', { cookie })).data.user, null);
  const sessions = (await request('/account/sessions', { cookie: current.cookie })).data;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].current, true);
  assert.equal('token' in sessions[0], false);
});

test('clearing history is scoped to the current user and preserves favorites and purchases', async () => {
  const cookie = await login('viewer');
  await request('/history', {
    method: 'POST',
    cookie,
    body: { dramaId: 'midnight', episode: 1, progress: 5 },
  });
  const before = (await request('/library', { cookie })).data;
  assert.ok(before.history.length);
  assert.equal((await request('/account/history', { method: 'DELETE', cookie })).status, 200);
  const after = (await request('/library', { cookie })).data;
  assert.deepEqual(after.history, []);
  assert.deepEqual(after.favorites, before.favorites);
  assert.deepEqual(after.purchases, before.purchases);
});

test('free published dramas unlock every episode without pings', async () => {
  const cookie = await login('pd');
  const a = await login('admin');
  const created = await request('/studio/dramas', {
    method: 'POST',
    cookie,
    body: { ...draftBody, title: '무료 공개 검수', free: true },
  });
  const id = created.data.id;
  for (const number of [1, 2])
    assert.equal(
      (
        await request('/studio/dramas/' + id + '/episodes', {
          method: 'POST',
          cookie,
          body: { number, title: '무료 회차', duration: 12, video: '/demo/preview.mp4' },
        })
      ).status,
      200,
    );
  assert.equal(
    (await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie })).status,
    200,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + id + '/review', {
        method: 'POST',
        cookie: a,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  assert.equal((await request('/dramas/' + id)).data.episodes[1].locked, false);
  assert.equal(
    (await fetch(base + '/api/play/' + id + '/2', { headers: { Range: 'bytes=0-10' } })).status,
    206,
  );
});

test('only the super administrator can change the public home appearance', async () => {
  const initial = await request('/config');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.homeAppearance.theme, 'cinematic');
  assert.match(initial.data.homeAppearance.image, /home-cinematic\.webp$/);

  const panel = await request('/admin/home-appearance', { cookie: admin });
  assert.equal(panel.status, 200);
  assert.equal(panel.data.themes.length, 5);
  assert.deepEqual(
    panel.data.themes.map((theme) => theme.id),
    ['cinematic', 'bright', 'fantasy', 'classic', 'medieval'],
  );

  const body = {
    theme: 'fantasy',
    eyebrow: 'STEP INTO ANOTHER WORLD',
    headline: '상상 너머,',
    highlight: '새로운 세계.',
    description: '현실을 잠시 벗어나\n새로운 주인공을 만나보세요.',
    caption: '짧은 장면에서 시작되는 큰 세계',
    copyright: '© 2026 SHORTPING',
  };
  assert.equal(
    (await request('/admin/home-appearance', { method: 'PUT', cookie: viewer, body })).status,
    403,
  );
  assert.equal(
    (await request('/admin/home-appearance', { method: 'PUT', cookie: pd, body })).status,
    403,
  );
  const changed = await request('/admin/home-appearance', {
    method: 'PUT',
    cookie: admin,
    body,
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.appearance.theme, 'fantasy');
  assert.equal(changed.data.appearance.image, '/images/home-fantasy.webp');
  assert.equal((await request('/config')).data.homeAppearance.description, body.description);
});

const publishDrama = async (overrides = {}) => {
  const created = await request('/studio/dramas', {
    method: 'POST',
    cookie: pd,
    body: { ...draftBody, free_episodes: 1, ...overrides },
  });
  assert.equal(created.status, 200);
  const id = created.data.id;
  assert.equal(
    (
      await request('/studio/dramas/' + id + '/episodes', {
        method: 'POST',
        cookie: pd,
        body: { number: 1, title: '1화', duration: 12, video: '/demo/preview.mp4' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd })).status,
    200,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + id + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  return id;
};

test('channels are public, owned by one PD, and only the owner can edit shelves', async () => {
  const list = await request('/channels');
  assert.equal(list.status, 200);
  assert.ok(list.data.length >= 2);
  assert.ok(list.data.every((c) => c.status === 'active'));
  const studio = list.data.find((c) => c.slug === 'shortping-studio');
  assert.ok(studio);
  assert.ok(studio.drama_count > 0);

  const detail = await request('/channels/' + studio.slug);
  assert.equal(detail.status, 200);
  assert.ok(detail.data.categories.length > 0);
  assert.ok(detail.data.dramas.every((d) => d.status === 'published'));

  // 시청자는 방송국을 만들 수 없고, PD는 자신의 방송국만 수정한다.
  assert.equal(
    (await request('/studio/channel', { method: 'PUT', cookie: viewer, body: {} })).status,
    403,
  );
  const mine = await request('/studio/channel', { cookie: pd });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.channel.owner_id, 'demo-pd');
  const taken = await request('/studio/channel', {
    method: 'PUT',
    cookie: pd,
    body: { name: '스튜디오 숏핑', slug: 'moonlight', status: 'active' },
  });
  assert.equal(taken.status, 409);

  const renamed = await request('/studio/channel', {
    method: 'PUT',
    cookie: pd,
    body: {
      name: '스튜디오 숏핑',
      slug: 'shortping-studio',
      tagline: '검수용 소개',
      description: '통합 테스트에서 수정한 소개입니다.',
      banner: '/images/channel-fantasy.webp',
      accent: '#bda7f0',
      theme: 'violet',
      banner_fit: 'cover',
      overlay: 30,
      greeting: '새로운 판타지를 만나보세요',
      status: 'active',
    },
  });
  assert.equal(renamed.status, 200);
  const decorated = (await request('/channels/shortping-studio')).data;
  assert.equal(decorated.tagline, '검수용 소개');
  assert.equal(decorated.banner, '/images/channel-fantasy.webp');
  assert.equal(decorated.theme, 'violet');
  assert.equal(decorated.banner_fit, 'cover');
  assert.equal(decorated.overlay, 30);
  assert.equal(decorated.greeting, '새로운 판타지를 만나보세요');

  const category = await request('/studio/channel/categories', {
    method: 'POST',
    cookie: pd,
    body: { name: '검수 진열대' },
  });
  assert.equal(category.status, 201);
  const categories = (await request('/studio/channel', { cookie: pd })).data.categories;
  const shelf = categories.find((c) => c.name === '검수 진열대');
  assert.ok(shelf);
  assert.equal(
    (
      await request('/studio/dramas/midnight/category', {
        method: 'PATCH',
        cookie: pd,
        body: { category_id: shelf.id },
      })
    ).status,
    200,
  );
  const shelved = await request('/channels/shortping-studio');
  assert.equal(shelved.data.dramas.find((d) => d.id === 'midnight').category_id, shelf.id);
  // 다른 방송국의 카테고리에는 진열할 수 없다.
  const moonlight = (await request('/channels/moonlight')).data;
  assert.equal(
    (
      await request('/studio/dramas/midnight/category', {
        method: 'PATCH',
        cookie: pd,
        body: { category_id: moonlight.categories[0].id },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request('/studio/channel/categories/' + moonlight.categories[0].id, {
        method: 'DELETE',
        cookie: pd,
      })
    ).status,
    404,
  );
  assert.equal(
    (await request('/studio/channel/categories/' + shelf.id, { method: 'DELETE', cookie: pd }))
      .status,
    200,
  );
});

test('viewers follow channels and the library reports the followed list', async () => {
  const channel = (await request('/channels')).data[0];
  assert.equal(
    (
      await request('/channels/' + channel.id + '/follow', {
        method: 'POST',
        body: { active: true },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('/channels/' + channel.id + '/follow', {
        method: 'POST',
        cookie: viewer,
        body: { active: true },
      })
    ).status,
    200,
  );
  assert.ok((await request('/library', { cookie: viewer })).data.channels.includes(channel.id));
  assert.equal((await request('/channels/' + channel.id, { cookie: viewer })).data.following, true);
  assert.equal(
    (
      await request('/channels/' + channel.id + '/follow', {
        method: 'POST',
        cookie: viewer,
        body: { active: false },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/library', { cookie: viewer })).data.channels.includes(channel.id),
    false,
  );
});

test('platform settings drive subscription price and are administrator only', async () => {
  assert.equal((await request('/admin/settings', { cookie: pd })).status, 403);
  const current = await request('/admin/settings', { cookie: admin });
  assert.equal(current.status, 200);
  const settings = current.data.settings;
  const updated = await request('/admin/settings', {
    method: 'PUT',
    cookie: admin,
    body: {
      ...settings,
      subscription_price: 9900,
      subscription_days: 45,
      settle_hold_days: 0,
      payout_min: 1000,
    },
  });
  assert.equal(updated.status, 200);
  assert.equal((await request('/config')).data.subscriptionPrice, 9900);
  assert.equal((await request('/config')).data.subscriptionDays, 45);

  const buyer = (
    await request('/auth/register', {
      method: 'POST',
      body: {
        email: `pass-${runId}@example.test`,
        password: 'LocalTest!2026',
        name: '구독 검수',
      },
    })
  ).cookie;
  const order = await request('/checkout', {
    method: 'POST',
    cookie: buyer,
    body: { kind: 'subscription', idempotencyKey: randomUUID() },
  });
  assert.equal(order.status, 200);
  // 서버 설정값으로 결제 금액이 계산된다.
  assert.equal(order.data.amount, 9900);
  const library = await request('/library', { cookie: buyer });
  const remaining =
    (new Date(library.data.subscription.expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(remaining > 44 && remaining <= 45);
});

test('ping spends build a settlement ledger with the configured platform share', async () => {
  const id = await publishWithEpisodes(3, { title: '정산 검수 작품', episode_pings: 20 });
  const buyer = await registerBuyer('settle', '정산 검수');
  assert.equal((await chargePings(buyer)).status, 200);
  const spent = await unlock(buyer, { dramaId: id, episode: 2 });
  assert.equal(spent.status, 200);
  assert.equal(spent.data.wallet.total, 80);
  const settlement = await request('/studio/settlement', { cookie: pd });
  assert.equal(settlement.status, 200);
  assert.equal(settlement.data.settings.platform_fee_rate, 30);
  const entry = settlement.data.entries.find((e) => e.drama_id === id);
  assert.ok(entry);
  assert.equal(entry.kind, 'ping');
  // 웹 결제(수수료 0%) 20핑 = 2,000원 → PD 70% / 플랫폼 30%
  assert.equal(entry.gross, 2000);
  assert.equal(entry.platform_fee, 600);
  assert.equal(entry.net, 1400);
  // settle_hold_days 를 0 으로 바꿔 두었으므로 즉시 출금 가능 상태가 된다.
  assert.equal(entry.status, 'available');
  assert.equal((await request('/studio/settlement', { cookie: viewer })).status, 403);
});

test('payout requests withhold 3.3% for individuals and lock the settled entries', async () => {
  const incomplete = await request('/studio/payouts', { method: 'POST', cookie: pd, body: {} });
  assert.equal(incomplete.status, 400);
  assert.equal(
    (
      await request('/studio/tax', {
        method: 'PUT',
        cookie: pd,
        body: { business_type: 'business', business_no: '123', bank_name: '국민은행' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/studio/tax', {
        method: 'PUT',
        cookie: pd,
        body: {
          business_type: 'individual',
          bank_name: '국민은행',
          account_number: '123-456-7890',
          account_holder: '스튜디오 숏핑',
        },
      })
    ).status,
    200,
  );
  const before = (await request('/studio/settlement', { cookie: pd })).data.balance;
  assert.ok(before.available > 0);
  const payout = await request('/studio/payouts', { method: 'POST', cookie: pd, body: {} });
  assert.equal(payout.status, 201);
  assert.equal(payout.data.amount, before.available);
  const incomeTax = Math.floor((before.available * 3) / 100);
  const localTax = Math.floor(incomeTax * 0.1);
  assert.equal(payout.data.incomeTax, incomeTax);
  assert.equal(payout.data.localTax, localTax);
  assert.equal(payout.data.payable, before.available - incomeTax - localTax);

  const after = (await request('/studio/settlement', { cookie: pd })).data.balance;
  assert.equal(after.available, 0);
  assert.equal(after.requested, before.available);
  // 중복 신청은 남은 금액이 없으므로 거부된다.
  assert.equal(
    (await request('/studio/payouts', { method: 'POST', cookie: pd, body: {} })).status,
    400,
  );

  assert.equal(
    (
      await request('/admin/payouts/' + payout.data.id, {
        method: 'POST',
        cookie: pd,
        body: { action: 'paid' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/admin/payouts/' + payout.data.id, {
        method: 'POST',
        cookie: admin,
        body: { action: 'rejected' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/admin/payouts/' + payout.data.id, {
        method: 'POST',
        cookie: admin,
        body: { action: 'rejected', memo: '계좌 정보 확인 필요' },
      })
    ).status,
    200,
  );
  // 반려하면 정산 금액이 다시 출금 가능 상태로 돌아온다.
  assert.equal(
    (await request('/studio/settlement', { cookie: pd })).data.balance.available,
    before.available,
  );
  const again = await request('/studio/payouts', { method: 'POST', cookie: pd, body: {} });
  assert.equal(again.status, 201);
  assert.equal(
    (
      await request('/admin/payouts/' + again.data.id, {
        method: 'POST',
        cookie: admin,
        body: { action: 'paid', memo: '지급 완료' },
      })
    ).status,
    200,
  );
  const paid = (await request('/studio/settlement', { cookie: pd })).data.balance;
  assert.equal(paid.available, 0);
  assert.equal(paid.paid, before.available);
  assert.equal(
    (
      await request('/admin/payouts/' + again.data.id, {
        method: 'POST',
        cookie: admin,
        body: { action: 'paid' },
      })
    ).status,
    409,
  );
});

test('business sellers are settled with VAT and appear in the tax register', async () => {
  const other = (
    await request('/auth/register', {
      method: 'POST',
      body: { email: `biz-${runId}@example.test`, password: 'LocalTest!2026', name: '사업자 PD' },
    })
  ).data.user;
  assert.equal(
    (
      await request('/admin/members/' + other.id, {
        method: 'PATCH',
        cookie: admin,
        body: { role: 'pd', status: 'active', name: '사업자 PD', phone: '010-1234-5678' },
      })
    ).status,
    200,
  );
  const owner = (
    await request('/auth/login', {
      method: 'POST',
      body: { email: `biz-${runId}@example.test`, password: 'LocalTest!2026' },
    })
  ).cookie;
  assert.equal(
    (
      await request('/studio/tax', {
        method: 'PUT',
        cookie: owner,
        body: {
          business_type: 'business',
          business_no: '123-45-67890',
          business_name: '이십세기 소년들',
          rep_name: '구영',
          bank_name: '국민은행',
          account_number: '111-222-333',
          account_holder: '이십세기 소년들',
        },
      })
    ).status,
    200,
  );
  const register = await request('/admin/tax', { cookie: admin });
  assert.equal(register.status, 200);
  const listed = register.data.creators.find((c) => c.id === other.id);
  assert.equal(listed.business_type, 'business');
  assert.equal(listed.business_no, '123-45-67890');
  assert.equal(listed.verified, 0);
  assert.equal(
    (
      await request('/admin/tax/' + other.id, {
        method: 'PATCH',
        cookie: admin,
        body: { business_type: 'business', verified: true, verified_note: '사업자등록증 확인' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/admin/tax', { cookie: admin })).data.creators.find((c) => c.id === other.id)
      .verified,
    1,
  );
  assert.equal((await request('/admin/tax', { cookie: pd })).status, 403);
});

test('administrators manage member records, notes and forced logout', async () => {
  const members = await request('/admin/members', { cookie: admin });
  assert.equal(members.status, 200);
  assert.ok(members.data.members.length >= 4);
  const target = members.data.members.find((m) => m.id === 'demo-viewer');
  assert.ok(target.order_count >= 0);

  const detail = await request('/admin/members/demo-viewer', { cookie: admin });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.member.id, 'demo-viewer');
  assert.ok(Array.isArray(detail.data.orders));
  assert.equal((await request('/admin/members', { cookie: viewer })).status, 403);

  assert.equal(
    (
      await request('/admin/members/demo-viewer/notes', {
        method: 'POST',
        cookie: admin,
        body: { note: '통합 테스트 메모' },
      })
    ).status,
    201,
  );
  assert.equal(
    (await request('/admin/members/demo-viewer', { cookie: admin })).data.notes[0].note,
    '통합 테스트 메모',
  );
  // 현재 관리자 계정과 공용 관리자 계정은 변경할 수 없다.
  assert.equal(
    (
      await request('/admin/members/demo-admin', {
        method: 'PATCH',
        cookie: admin,
        body: { role: 'viewer', status: 'active', name: '숏핑 관리자', phone: '' },
      })
    ).status,
    400,
  );

  const victim = await request('/auth/register', {
    method: 'POST',
    body: { email: `ban-${runId}@example.test`, password: 'LocalTest!2026', name: '제재 검수' },
  });
  assert.equal((await request('/auth/me', { cookie: victim.cookie })).data.user.status, 'active');
  assert.equal(
    (
      await request('/admin/members/' + victim.data.user.id, {
        method: 'PATCH',
        cookie: admin,
        body: { role: 'viewer', status: 'suspended', name: '제재 검수', phone: '' },
      })
    ).status,
    200,
  );
  // 이용 제한으로 바뀌면 기존 세션이 즉시 끊긴다.
  assert.equal((await request('/auth/me', { cookie: victim.cookie })).data.user, null);
  assert.equal(
    (
      await request('/auth/login', {
        method: 'POST',
        body: { email: `ban-${runId}@example.test`, password: 'LocalTest!2026' },
      })
    ).status,
    401,
  );
});

test('administrators reprice published dramas and hide them from the public catalog', async () => {
  const id = await publishDrama({ title: '가격 변경 검수' });
  assert.equal(
    (
      await request('/admin/dramas/' + id + '/pricing', {
        method: 'PATCH',
        cookie: pd,
        body: { episode_pings: 1, free_episodes: 1, badge: 'NEW', status: 'published' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + id + '/pricing', {
        method: 'PATCH',
        cookie: admin,
        body: { episode_pings: 7, free_episodes: 2, badge: 'HOT', status: 'published' },
      })
    ).status,
    200,
  );
  const repriced = (await request('/dramas/' + id)).data;
  assert.equal(repriced.episode_pings, 7);
  assert.equal(repriced.free_episodes, 2);
  assert.equal(repriced.badge, 'HOT');
  assert.equal(
    (
      await request('/admin/dramas/' + id + '/pricing', {
        method: 'PATCH',
        cookie: admin,
        body: { episode_pings: 7, free_episodes: 2, badge: 'HOT', status: 'hidden' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/dramas')).data.some((d) => d.id === id),
    false,
  );
  assert.equal((await request('/dramas/' + id)).status, 404);
});

test('subscription revenue is shared by watched episodes when a month is closed', async () => {
  const period = new Date().toISOString().slice(0, 7);
  const open = await request('/admin/settlements/close', {
    method: 'POST',
    cookie: admin,
    body: { period },
  });
  // 진행 중인 달은 마감할 수 없다.
  assert.equal(open.status, 400);
  const past = new Date();
  past.setMonth(past.getMonth() - 1);
  const closed = await request('/admin/settlements/close', {
    method: 'POST',
    cookie: admin,
    body: { period: past.toISOString().slice(0, 7) },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.pool, 0);
  assert.equal(
    (await request('/admin/settlements/close', { method: 'POST', cookie: pd, body: { period } }))
      .status,
    403,
  );

  const overview = await request('/admin/settlements', { cookie: admin });
  assert.equal(overview.status, 200);
  assert.ok(overview.data.totals.gross > 0);
  assert.ok(overview.data.creators.some((c) => c.id === 'demo-pd'));
  assert.ok(overview.data.payouts.length >= 1);

  // 다른 테스트에 영향을 주지 않도록 정산 기본값을 되돌린다.
  const settings = (await request('/admin/settings', { cookie: admin })).data.settings;
  assert.equal(
    (
      await request('/admin/settings', {
        method: 'PUT',
        cookie: admin,
        body: {
          ...settings,
          subscription_price: 7900,
          subscription_days: 30,
          settle_hold_days: 7,
          payout_min: 10000,
        },
      })
    ).status,
    200,
  );
});

const publishWithEpisodes = async (count, overrides = {}) => {
  const created = await request('/studio/dramas', {
    method: 'POST',
    cookie: pd,
    body: { ...draftBody, free_episodes: 1, ...overrides },
  });
  assert.equal(created.status, 200);
  const id = created.data.id;
  for (let number = 1; number <= count; number++)
    assert.equal(
      (
        await request('/studio/dramas/' + id + '/episodes', {
          method: 'POST',
          cookie: pd,
          body: { number, title: `${number}화`, duration: 12, video: '/demo/preview.mp4' },
        })
      ).status,
      200,
    );
  assert.equal(
    (await request('/studio/dramas/' + id + '/submit', { method: 'POST', cookie: pd })).status,
    200,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + id + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  return id;
};

test('single episode unlock with pings opens only that episode and is settled like a sale', async () => {
  const id = await publishWithEpisodes(3, { title: '회차 결제 검수', episode_pings: 7 });
  const cookie = await registerBuyer('ep', '회차 검수');
  const detail = await request('/dramas/' + id, { cookie });
  assert.equal(detail.data.episode_pings, 7);
  assert.equal(detail.data.episodes[0].locked, false);
  assert.equal(detail.data.episodes[1].locked, true);
  assert.equal((await request('/play/' + id + '/2', { cookie })).status, 403);

  // 핑이 없으면 열 수 없고, 화면이 충전으로 안내할 수 있게 부족 수치를 돌려준다.
  const poor = await unlock(cookie, { dramaId: id, episode: 2 });
  assert.equal(poor.status, 400);
  assert.equal(poor.data.code, 'insufficient_pings');
  assert.equal(poor.data.need, 7);
  assert.equal(poor.data.balance, 0);
  assert.equal((await request('/library', { cookie })).data.orders.length, 0);

  assert.equal((await chargePings(cookie, 'ping-5k')).status, 200);
  // 무료 회차는 핑 대상이 아니다.
  assert.equal((await unlock(cookie, { dramaId: id, episode: 1 })).status, 400);
  assert.equal((await unlock(cookie, { dramaId: id, episode: 9 })).status, 404);
  const order = await unlock(cookie, { dramaId: id, episode: 2 });
  assert.equal(order.status, 200);
  assert.equal(order.data.pings, 7);
  assert.equal(order.data.kind, 'ping_episode');
  assert.equal(order.data.wallet.total, 43);

  // 연 회차만 열리고 다음 회차는 그대로 잠겨 있다.
  assert.equal(
    (await fetch(base + '/api/play/' + id + '/2', { headers: { cookie, Range: 'bytes=0-10' } }))
      .status,
    206,
  );
  assert.equal((await request('/play/' + id + '/3', { cookie })).status, 403);
  const after = await request('/dramas/' + id, { cookie });
  assert.equal(after.data.episodes[1].locked, false);
  assert.equal(after.data.episodes[1].owned, true);
  assert.equal(after.data.episodes[2].locked, true);
  assert.equal(after.data.entitled, false);
  // 남은 잠긴 회차가 1편이면 전체 열기는 할인 없이 1편 가격이다.
  assert.equal(after.data.locked_count, 1);
  assert.equal(after.data.title_pings, 7);

  const library = await request('/library', { cookie });
  assert.deepEqual(library.data.episodes, [{ drama_id: id, episode: 2 }]);
  const episodeOrder = library.data.orders.find((o) => o.kind === 'ping_episode');
  assert.equal(episodeOrder.episode, 2);
  assert.equal(episodeOrder.pings, 7);
  assert.equal(episodeOrder.amount, 0);
  assert.equal(library.data.purchases.includes(id), false);
  const ledger = (await request('/pings', { cookie })).data.ledger;
  assert.deepEqual(
    ledger.map((l) => l.type).sort(),
    ['charge', 'spend'],
  );

  // 같은 회차를 다시 열 수 없고, 시청 기록도 연 회차까지만 저장된다.
  assert.equal((await unlock(cookie, { dramaId: id, episode: 2 })).status, 409);
  assert.equal(
    (
      await request('/history', {
        method: 'POST',
        cookie,
        body: { dramaId: id, episode: 2, progress: 4 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/history', {
        method: 'POST',
        cookie,
        body: { dramaId: id, episode: 3, progress: 4 },
      })
    ).status,
    403,
  );

  // 회차 매출도 PD 정산 원장에 남는다. 7핑 × 100원 = 700원
  const settlement = await request('/studio/settlement', { cookie: pd });
  const entry = settlement.data.entries.find((e) => e.drama_id === id && e.kind === 'ping');
  assert.ok(entry);
  assert.equal(entry.gross, 700);
  assert.equal(entry.net, 700 - Math.round(700 * 0.3));
});

test('owning a title or a pass makes ping unlocks unnecessary; default episode pings apply', async () => {
  const id = await publishWithEpisodes(2, { title: '회차 중복 결제 검수' });
  const cookie = await registerBuyer('own', '소장 검수');
  assert.equal((await chargePings(cookie)).status, 200);
  assert.equal((await unlock(cookie, { dramaId: id, all: true })).status, 200);
  assert.equal((await unlock(cookie, { dramaId: id, episode: 2 })).status, 409);
  // 구독 중이면 핑을 쓸 필요가 없다.
  const passId = await publishWithEpisodes(2, { title: '구독 회차 검수' });
  const subscriber = await registerBuyer('passer', '구독 검수');
  assert.equal(
    (
      await request('/checkout', {
        method: 'POST',
        cookie: subscriber,
        body: { kind: 'subscription', idempotencyKey: randomUUID() },
      })
    ).status,
    200,
  );
  assert.equal((await unlock(subscriber, { dramaId: passId, episode: 2 })).status, 409);
  // 회차 핑을 지정하지 않으면 요금 정책의 기본값을 사용한다.
  const fallback = await publishWithEpisodes(2, { title: '기본 회차가 검수' });
  const settings = (await request('/admin/settings', { cookie: admin })).data.settings;
  assert.equal(
    (await request('/dramas/' + fallback)).data.episode_pings,
    settings.default_episode_pings,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + fallback + '/pricing', {
        method: 'PATCH',
        cookie: admin,
        body: { episode_pings: 12, free_episodes: 1, badge: 'NEW', status: 'published' },
      })
    ).status,
    200,
  );
  assert.equal((await request('/dramas/' + fallback)).data.episode_pings, 12);
});

test('channel styling is stored and served to viewers', async () => {
  const saved = await request('/studio/channel', {
    method: 'PUT',
    cookie: pd,
    body: {
      name: '스튜디오 숏핑',
      slug: 'shortping-studio',
      tagline: '검수용 소개',
      greeting: '매주 목요일 밤 10시',
      description: '분위기 검수',
      accent: '#ff9d7a',
      theme: 'coral',
      banner_fit: 'cover',
      overlay: 70,
      status: 'active',
    },
  });
  assert.equal(saved.status, 200);
  const page = await request('/channels/shortping-studio');
  assert.equal(page.data.theme, 'coral');
  assert.equal(page.data.accent, '#ff9d7a');
  assert.equal(page.data.banner_fit, 'cover');
  assert.equal(page.data.overlay, 70);
  assert.equal(page.data.greeting, '매주 목요일 밤 10시');
  // 잘못된 값은 저장하지 않는다.
  assert.equal(
    (
      await request('/studio/channel', {
        method: 'PUT',
        cookie: pd,
        body: {
          name: '스튜디오 숏핑',
          slug: 'shortping-studio',
          theme: 'rainbow',
          status: 'active',
        },
      })
    ).status,
    400,
  );
});

test('guard rails: free titles, hidden dramas, fee caps and custom withholding', async () => {
  // 무료 공개 작품은 소장 결제 대상이 아니다.
  const free = await request('/studio/dramas', {
    method: 'POST',
    cookie: pd,
    body: { ...draftBody, title: '무료 결제 차단 검수', free: true },
  });
  const freeId = free.data.id;
  assert.equal(
    (
      await request('/studio/dramas/' + freeId + '/episodes', {
        method: 'POST',
        cookie: pd,
        body: { number: 1, title: '1화', duration: 12, video: '/demo/preview.mp4' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/studio/dramas/' + freeId + '/submit', { method: 'POST', cookie: pd })).status,
    200,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + freeId + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  assert.equal((await unlock(viewer, { dramaId: freeId, all: true })).status, 400);

  // 노출 중단 상태에서는 심사 없이 내용을 바꿀 수 없다.
  assert.equal(
    (
      await request('/admin/dramas/' + freeId + '/pricing', {
        method: 'PATCH',
        cookie: admin,
        body: { free: true, free_episodes: 1, badge: 'NEW', status: 'hidden' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/studio/dramas/' + freeId, {
        method: 'PATCH',
        cookie: pd,
        body: { ...draftBody, title: '무단 수정 시도' },
      })
    ).status,
    409,
  );

  // 수수료 합계는 100%를 넘을 수 없다.
  const settings = (await request('/admin/settings', { cookie: admin })).data.settings;
  assert.equal(
    (
      await request('/admin/settings', {
        method: 'PUT',
        cookie: admin,
        body: { ...settings, platform_fee_rate: 90, pg_fee_rate: 20 },
      })
    ).status,
    400,
  );
  // 부분 저장도 저장된 값과 합쳐서 같은 규칙으로 검사한다.
  assert.equal(
    (
      await request('/admin/settings', {
        method: 'PUT',
        cookie: admin,
        body: { platform_fee_rate: 85, pg_fee_rate: 20 },
      })
    ).status,
    400,
  );
  assert.equal(
    (await request('/admin/settings', { method: 'PUT', cookie: admin, body: {} })).status,
    400,
  );

  // 원천징수율을 바꾸면 총 공제액이 설정한 비율과 맞아야 한다 (지방소득세는 소득세의 10%).
  assert.equal(
    (
      await request('/admin/settings', {
        method: 'PUT',
        cookie: admin,
        body: { ...settings, withholding_rate: 5, settle_hold_days: 0, payout_min: 100 },
      })
    ).status,
    200,
  );
  const seller = await request('/auth/register', {
    method: 'POST',
    body: { email: `rate-${runId}@example.test`, password: 'LocalTest!2026', name: '요율 검수' },
  });
  assert.equal(
    (
      await request('/admin/members/' + seller.data.user.id, {
        method: 'PATCH',
        cookie: admin,
        body: { role: 'pd', status: 'active', name: '요율 검수', phone: '' },
      })
    ).status,
    200,
  );
  const sellerCookie = (
    await request('/auth/login', {
      method: 'POST',
      body: { email: `rate-${runId}@example.test`, password: 'LocalTest!2026' },
    })
  ).cookie;
  const title = await request('/studio/dramas', {
    method: 'POST',
    cookie: sellerCookie,
    body: { ...draftBody, title: '요율 검수 작품', episode_pings: 110, free_episodes: 1 },
  });
  const rateId = title.data.id;
  assert.equal(
    (
      await request('/studio/dramas/' + rateId + '/episodes', {
        method: 'POST',
        cookie: sellerCookie,
        body: { number: 1, title: '1화', duration: 12, video: '/demo/preview.mp4' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/studio/dramas/' + rateId + '/episodes', {
        method: 'POST',
        cookie: sellerCookie,
        body: { number: 2, title: '2화', duration: 12, video: '/demo/preview.mp4' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/studio/dramas/' + rateId + '/submit', { method: 'POST', cookie: sellerCookie }))
      .status,
    200,
  );
  assert.equal(
    (
      await request('/admin/dramas/' + rateId + '/review', {
        method: 'POST',
        cookie: admin,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  const shopper = await request('/auth/register', {
    method: 'POST',
    body: { email: `shopper-${runId}@example.test`, password: 'LocalTest!2026', name: '구매 검수' },
  });
  assert.equal((await chargePings(shopper.cookie, 'ping-30k')).status, 200);
  assert.equal((await unlock(shopper.cookie, { dramaId: rateId, episode: 2 })).status, 200);
  assert.equal(
    (
      await request('/studio/tax', {
        method: 'PUT',
        cookie: sellerCookie,
        body: {
          business_type: 'individual',
          bank_name: '국민은행',
          account_number: '111-222',
          account_holder: '요율 검수',
        },
      })
    ).status,
    200,
  );
  const balance = (await request('/studio/settlement', { cookie: sellerCookie })).data.balance;
  const payout = await request('/studio/payouts', { method: 'POST', cookie: sellerCookie, body: {} });
  assert.equal(payout.status, 201);
  const withheld = payout.data.incomeTax + payout.data.localTax;
  // 5% 설정이면 실제 공제 합계도 5% 안쪽이어야 한다 (원 단위 절사 오차 허용).
  assert.ok(Math.abs(withheld - Math.round(balance.available * 0.05)) <= 2, `공제 ${withheld}`);
  assert.equal(payout.data.payable, balance.available - withheld);
  assert.equal(
    (
      await request('/admin/settings', {
        method: 'PUT',
        cookie: admin,
        body: { ...settings },
      })
    ).status,
    200,
  );
});

test('ping economics: in-app channel fees, per-PD share, bonus-first spending, grants and revokes', async () => {
  // 권한: PD·시청자는 포인트 관리에 접근할 수 없다.
  assert.equal((await request('/admin/pings', { cookie: pd })).status, 403);
  assert.equal(
    (
      await request('/admin/pings/adjust', {
        method: 'POST',
        cookie: pd,
        body: { userId: 'demo-viewer', action: 'grant', pings: 5, memo: '권한 확인' },
      })
    ).status,
    403,
  );
  const id = await publishWithEpisodes(4, { title: '핑 경제 검수', episode_pings: 10 });

  // App Store 상품(수수료 30%): 14,000원 → 100핑. 1핑의 순매출은 14,000×70%÷100 = 98원.
  const product = await request('/admin/pings/products', {
    method: 'POST',
    cookie: admin,
    body: { channel: 'app_store', name: '100핑', price: 14000, pings: 100 },
  });
  assert.equal(product.status, 201);
  const iapBuyer = await registerBuyer('iap', '인앱 검수');
  // 시청자용 충전 목록에는 웹 상품만 보인다.
  const shelf = (await request('/pings', { cookie: iapBuyer })).data.products;
  assert.ok(shelf.every((p) => p.channel === 'web'));
  assert.ok(shelf.some((p) => p.id === 'ping-10k'));
  const iap = await chargePings(iapBuyer, product.data.id);
  assert.equal(iap.status, 200);
  assert.equal(iap.data.wallet.total, 100);

  // PD별 분배 비율: 플랫폼 20% (PD 80%)
  assert.equal(
    (
      await request('/admin/pings/rates/demo-pd', {
        method: 'PUT',
        cookie: admin,
        body: { platform_fee_rate: 20 },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/studio/settlement', { cookie: pd })).data.settings.platform_fee_rate,
    20,
  );
  const iapSpend = await unlock(iapBuyer, { dramaId: id, episode: 2 });
  assert.equal(iapSpend.status, 200);
  let entries = (await request('/studio/settlement', { cookie: pd })).data.entries.filter(
    (e) => e.drama_id === id,
  );
  // 10핑 × 98원 = 980원 → 플랫폼 20% 196원, PD 784원. 인앱 수수료를 뺀 순매출을 나누므로 비율이 지켜진다.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].gross, 980);
  assert.equal(entries[0].platform_fee, 196);
  assert.equal(entries[0].net, 784);
  assert.equal(entries[0].fee_rate, 20);
  // 공통 비율로 되돌리면 이후 매출부터 다시 30%가 적용된다(이미 기록된 정산은 그대로).
  assert.equal(
    (
      await request('/admin/pings/rates/demo-pd', {
        method: 'PUT',
        cookie: admin,
        body: { platform_fee_rate: null },
      })
    ).status,
    200,
  );

  // 웹 30,000원 상품: 300핑 + 보너스 15핑. 관리자 지급 5핑까지 보너스 20핑.
  const webBuyer = await registerBuyer('bonus', '보너스 검수');
  const webBuyerId = (await request('/auth/me', { cookie: webBuyer })).data.user?.id;
  assert.ok(webBuyerId);
  assert.equal((await chargePings(webBuyer, 'ping-30k')).status, 200);
  assert.equal(
    (
      await request('/admin/pings/adjust', {
        method: 'POST',
        cookie: admin,
        body: { userId: webBuyerId, action: 'grant', pings: 5, memo: '' },
      })
    ).status,
    400,
  );
  const granted = await request('/admin/pings/adjust', {
    method: 'POST',
    cookie: admin,
    body: { userId: webBuyerId, action: 'grant', pings: 5, memo: '오류 보상' },
  });
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.data.wallet, { paid: 300, bonus: 20, total: 320 });
  // 보너스 핑을 먼저 쓴다. 보너스도 충전 단가(100원)로 PD에게 정산된다(플랫폼 마케팅 부담).
  const bonusSpend = await unlock(webBuyer, { dramaId: id, episode: 3 });
  assert.equal(bonusSpend.status, 200);
  assert.deepEqual(bonusSpend.data.wallet, { paid: 300, bonus: 10, total: 310 });
  entries = (await request('/studio/settlement', { cookie: pd })).data.entries.filter(
    (e) => e.drama_id === id,
  );
  const bonusEntry = entries.find((e) => e.gross === 1000);
  assert.ok(bonusEntry, JSON.stringify(entries));
  assert.equal(bonusEntry.platform_fee, 300);
  assert.equal(bonusEntry.net, 700);
  const detail = (await request('/dramas/' + id, { cookie: webBuyer })).data;
  assert.equal(detail.locked_count, 2);
  // 2편 × 10핑 = 20핑 → 20% 할인 16핑
  assert.equal(detail.title_pings, 16);

  // 회수는 보너스부터 빼고, 잔액보다 많이 회수할 수 없다.
  const revoke = (pings) =>
    request('/admin/pings/adjust', {
      method: 'POST',
      cookie: admin,
      body: { userId: webBuyerId, action: 'revoke', pings, memo: '중복 지급 회수' },
    });
  assert.equal((await revoke(1000)).status, 400);
  const revoked = await revoke(15);
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.data.wallet, { paid: 295, bonus: 0, total: 295 });
  const ledger = (await request('/pings', { cookie: webBuyer })).data.ledger;
  assert.deepEqual(ledger.map((l) => l.type).sort(), ['charge', 'grant', 'revoke', 'spend']);

  // 포인트 관리 현황
  const overview = await request('/admin/pings', { cookie: admin });
  assert.equal(overview.status, 200);
  const appStore = overview.data.charges.find((c) => c.channel === 'app_store');
  assert.ok(Number(appStore.channel_fee) >= 4200);
  assert.ok(overview.data.summary.liability > 0);
  assert.ok(overview.data.ledger.some((l) => l.type === 'grant' && l.actor_name));
  assert.ok(overview.data.rates.some((r) => r.id === 'demo-pd'));

  // 판매된 상품은 삭제 대신 판매 중지, 판매 이력이 없으면 삭제
  const removed = await request('/admin/pings/products/' + product.data.id, {
    method: 'DELETE',
    cookie: admin,
  });
  assert.equal(removed.data.deactivated, true);
  assert.equal((await chargePings(iapBuyer, product.data.id)).status, 404);
  const spare = await request('/admin/pings/products', {
    method: 'POST',
    cookie: admin,
    body: { channel: 'web', name: '임시', price: 1000, pings: 10 },
  });
  const dropped = await request('/admin/pings/products/' + spare.data.id, {
    method: 'DELETE',
    cookie: admin,
  });
  assert.equal(dropped.data.deleted, true);

  // 회원 상세에 지갑과 핑 내역이 보인다.
  const member = await request('/admin/members/' + webBuyerId, { cookie: admin });
  assert.equal(member.data.wallet.total, 295);
  assert.ok(member.data.pingLedger.length >= 4);
});

test('auto unlock preference is kept by profile saves and toggled on its own', async () => {
  const cookie = await registerBuyer('auto', '자동 열기 검수');
  const me = async () => (await request('/auth/me', { cookie })).data.user;
  assert.equal((await me()).auto_unlock, false);
  assert.equal(
    (await request('/account/auto-unlock', { method: 'PUT', cookie, body: { enabled: true } }))
      .status,
    200,
  );
  assert.equal((await me()).auto_unlock, true);
  const user = await me();
  // 자동 열기 값을 보내지 않는 기존 프로필 저장은 설정을 지우지 않는다.
  const saved = await request('/account/profile', {
    method: 'PATCH',
    cookie,
    body: { name: user.name, bio: '', auto_next: true, avatar: user.avatar },
  });
  assert.equal(saved.status, 200);
  assert.equal((await me()).auto_unlock, true);
  assert.equal((await request('/account/auto-unlock', { method: 'PUT', body: { enabled: true } })).status, 401);
});
