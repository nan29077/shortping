import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// 숏핑 스튜디오(AI 제작) · 라마 · AI 연결 통합 테스트.
// 실제 AI 대신 개발용 가짜 AI와, 공급사 API 형식을 흉내 내는 로컬 가짜 서버를 씁니다.
const port = 5189,
  vendorPort = 5190,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  vendor,
  output = '',
  pd,
  admin,
  viewer;
const vendorHits = [];
async function request(url, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readDb = (sql, params = []) => {
  const db = new DatabaseSync(path.join(dataDir, 'shortping.sqlite'), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
};
async function newPd(tag) {
  const email = `${tag}-${runId}@studio.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'StudioTest!2026', name: '스튜디오 ' + tag } });
  await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role: 'pd', status: 'active', name: '스튜디오 ' + tag, phone: '' } });
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'StudioTest!2026' } })).cookie;
  return { id: reg.data.user.id, cookie };
}
async function waitJobs(cookie, projectId, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = (await request('/studio/ai/projects/' + projectId, { cookie })).data;
    if (!p.jobs.some((j) => ['queued', 'running'].includes(j.status))) return p;
    await sleep(250);
  }
  throw new Error('AI 작업이 끝나지 않았어요\n' + output.slice(-2000));
}
async function waitJob(cookie, jobId, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const j = (await request('/studio/ai/tools/jobs/' + jobId, { cookie })).data;
    if (!['queued', 'running'].includes(j.status)) return j;
    await sleep(250);
  }
  throw new Error('job timeout');
}

// 공급사 흉내: OpenAI 호환 채팅, fal 대기열(영상), 항상 실패하는 모델
const clip = readFileSync('public/demo/preview.mp4');
const polls = new Map();
before(async () => {
  vendor = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    vendorHits.push({ url: req.url, auth: req.headers.authorization || '' });
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/v1/chat/completions') {
      const { model } = JSON.parse(body);
      if (req.headers.authorization !== 'Bearer emu-key') return json(401, { error: { message: 'bad key' } });
      return json(200, {
        choices: [
          {
            message: {
              content:
                '설명: 아래는 기획안입니다.\n```json\n' +
                JSON.stringify({
                  title: '에뮬레이터 기획',
                  logline: '가짜 공급사가 쓴 기획',
                  synopsis: '가짜 공급사가 만든 줄거리입니다. 두 사람의 비밀이 드러납니다.',
                  style: 'emulated style',
                  characters: [{ name: '가온', role: '주인공', description: '용감함', look: 'young woman with red scarf' }],
                  episodes: [{ number: 1, title: '에뮬 1화', summary: '시작' }],
                }) +
                '\n```',
            },
          },
        ],
        usage: { prompt_tokens: 800, completion_tokens: 1200 },
        model,
      });
    }
    if (req.url === '/v1/models') return json(req.headers.authorization === 'Bearer emu-key' ? 200 : 401, { data: [{ id: 'emu-writer' }, { id: 'emu-writer-pro' }] });
    if (req.url.startsWith('/fal/good-video') && req.method === 'POST') {
      const id = randomUUID();
      polls.set(id, 0);
      return json(200, { request_id: id, status_url: `http://127.0.0.1:${vendorPort}/fal/status/${id}`, response_url: `http://127.0.0.1:${vendorPort}/fal/result/${id}` });
    }
    if (req.url.startsWith('/fal/broken-video')) return json(500, { detail: 'overloaded' });
    if (req.url.startsWith('/fal/status/')) {
      const id = req.url.split('/').pop();
      polls.set(id, (polls.get(id) || 0) + 1);
      return json(200, { status: polls.get(id) >= 2 ? 'COMPLETED' : 'IN_PROGRESS' });
    }
    if (req.url.startsWith('/fal/result/')) return json(200, { video: { url: `http://127.0.0.1:${vendorPort}/files/clip.mp4` } });
    if (req.url === '/files/clip.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': clip.length });
      return res.end(clip);
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => vendor.listen(vendorPort, '127.0.0.1', r));
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: '',
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
  viewer = await login('viewer');
});
after(() => {
  child?.kill();
  vendor?.close();
});

test('lama wallet: welcome bonus once, test charge, idempotency, admin grant and revoke', async () => {
  assert.equal((await request('/lama', { cookie: viewer })).status, 403);
  const first = await request('/lama', { cookie: pd });
  assert.equal(first.status, 200);
  assert.equal(first.data.wallet.bonus, 300);
  assert.equal(first.data.policy.unit_won, 10);
  assert.equal((await request('/lama', { cookie: pd })).data.wallet.bonus, 300);
  const key = randomUUID();
  const charges = await Promise.all([1, 2].map(() => request('/lama/charge', { method: 'POST', cookie: pd, body: { productId: 'lama-10k', idempotencyKey: key } })));
  charges.forEach((c) => assert.equal(c.status, 200));
  assert.equal(new Set(charges.map((c) => c.data.id)).size, 1);
  const w = (await request('/lama', { cookie: pd })).data.wallet;
  assert.equal(w.paid, 1000);
  assert.equal(w.total, 1300);
  const grant = await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'grant', lama: 50, memo: '테스트 지급' } });
  assert.equal(grant.data.wallet.bonus, 350);
  assert.equal((await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'revoke', lama: 99999, memo: '과다 회수' } })).status, 400);
  assert.equal((await request('/admin/lama/adjust', { method: 'POST', cookie: pd, body: { userId: 'demo-pd', action: 'grant', lama: 5, memo: '권한 없음' } })).status, 403);
  const overview = await request('/admin/lama', { cookie: admin });
  assert.equal(overview.status, 200);
  assert.ok(overview.data.summary.charge_amount >= 10000);
  // 장부 합계 = 지갑 잔액
  const [wallet] = readDb('SELECT paid_balance,bonus_balance,held_paid,held_bonus FROM lama_wallets WHERE user_id=?', ['demo-pd']);
  const [sum] = readDb('SELECT SUM(paid_delta) AS p, SUM(bonus_delta) AS b, SUM(held_delta) AS h FROM lama_ledger WHERE user_id=?', ['demo-pd']);
  assert.equal(sum.p, wallet.paid_balance);
  assert.equal(sum.b, wallet.bonus_balance);
  assert.equal(sum.h, wallet.held_paid + wallet.held_bonus);
});

test('settlement revenue converts to lama with the same withholding as payouts', async () => {
  const seller = await newPd('convert');
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { settle_hold_days: 0 } });
  try {
    const created = await request('/studio/dramas', {
      method: 'POST',
      cookie: seller.cookie,
      body: { title: '전환 검수 작품', tagline: '정산을 라마로', synopsis: '정산 수익을 라마로 바꾸는 흐름을 확인합니다.', genre: '로맨스', free_episodes: 1, episode_pings: 100, image: '/images/hero.webp', rights_confirmed: true },
    });
    for (const n of [1, 2])
      await request(`/studio/dramas/${created.data.id}/episodes`, { method: 'POST', cookie: seller.cookie, body: { number: n, title: n + '화', duration: 12, video: '/demo/preview.mp4' } });
    assert.equal((await request(`/studio/dramas/${created.data.id}/submit`, { method: 'POST', cookie: seller.cookie })).status, 200);
    await request(`/admin/dramas/${created.data.id}/review`, { method: 'POST', cookie: admin, body: { status: 'published' } });
    await request('/pings/charge', { method: 'POST', cookie: viewer, body: { productId: 'ping-30k', idempotencyKey: randomUUID() } });
    assert.equal((await request('/pings/unlock', { method: 'POST', cookie: viewer, body: { dramaId: created.data.id, episode: 2, idempotencyKey: randomUUID() } })).status, 200);
    const before = (await request('/lama', { cookie: seller.cookie })).data;
    assert.equal(before.convertible, 7000);
    const conv = await request('/lama/convert', { method: 'POST', cookie: seller.cookie });
    assert.equal(conv.status, 201);
    const income = Math.floor((7000 * 3.3) / 110);
    const local = Math.floor(income * 0.1);
    assert.equal(conv.data.incomeTax, income);
    assert.equal(conv.data.lama, Math.ceil((7000 - income - local) / 10));
    const after = (await request('/lama', { cookie: seller.cookie })).data;
    assert.equal(after.wallet.paid, conv.data.lama);
    assert.equal(after.convertible, 0);
    const settlement = (await request('/studio/settlement', { cookie: seller.cookie })).data;
    assert.equal(settlement.balance.available, 0);
    assert.equal(settlement.payouts[0].method, 'lama');
    assert.equal(settlement.payouts[0].status, 'paid');
    // 다시 전환할 금액이 없다.
    assert.equal((await request('/lama/convert', { method: 'POST', cookie: seller.cookie })).status, 400);
    // 세무 대장에도 지급으로 잡힌다.
    const tax = (await request('/admin/tax', { cookie: admin })).data;
    assert.ok(tax.paid.some((p) => p.pd_id === seller.id && Number(p.income_tax) === income));
  } finally {
    await request('/admin/settings', { method: 'PUT', cookie: admin, body: { settle_hold_days: 7 } });
  }
});

test('AI providers: encrypted keys, presets, connection test, model registry and admin-only access', async () => {
  assert.equal((await request('/admin/ai', { cookie: pd })).status, 403);
  const created = await request('/admin/ai/providers', {
    method: 'POST',
    cookie: admin,
    body: { name: '에뮬 채팅', kind: 'openai_compatible', base_url: `http://127.0.0.1:${vendorPort}/v1`, country: 'CN', api_key: 'emu-key-wrong' },
  });
  assert.equal(created.status, 201);
  let list = (await request('/admin/ai', { cookie: admin })).data;
  const view = list.providers.find((p) => p.id === created.data.id);
  assert.equal(view.key_hint, '••••rong');
  assert.equal(view.has_key, true);
  assert.equal('api_key_enc' in view, false);
  assert.ok(!JSON.stringify(list).includes('emu-key-wrong'));
  const [row] = readDb('SELECT api_key_enc FROM ai_providers WHERE id=?', [created.data.id]);
  assert.match(row.api_key_enc, /^v1:/);
  assert.ok(!row.api_key_enc.includes('emu-key'));
  // 틀린 키 → 연결 실패, 키 교체 → 성공
  let t = await request(`/admin/ai/providers/${created.data.id}/test`, { method: 'POST', cookie: admin });
  assert.equal(t.data.ok, false);
  await request(`/admin/ai/providers/${created.data.id}`, { method: 'PATCH', cookie: admin, body: { name: '에뮬 채팅', kind: 'openai_compatible', base_url: `http://127.0.0.1:${vendorPort}/v1`, country: 'CN', api_key: 'emu-key' } });
  t = await request(`/admin/ai/providers/${created.data.id}/test`, { method: 'POST', cookie: admin });
  assert.equal(t.data.ok, true);
  // 빈 키로 수정하면 기존 키 유지
  await request(`/admin/ai/providers/${created.data.id}`, { method: 'PATCH', cookie: admin, body: { name: '에뮬 채팅(수정)', kind: 'openai_compatible', base_url: `http://127.0.0.1:${vendorPort}/v1`, country: 'CN' } });
  assert.equal((await request(`/admin/ai/providers/${created.data.id}/test`, { method: 'POST', cookie: admin })).data.ok, true);
  // 프리셋(중국 모델 포함)
  const preset = await request('/admin/ai/presets', { method: 'POST', cookie: admin, body: { name: 'MiniMax Hailuo' } });
  assert.equal(preset.status, 201);
  list = (await request('/admin/ai', { cookie: admin })).data;
  assert.ok(list.providers.some((p) => p.name === 'MiniMax Hailuo' && p.country === 'CN' && !p.has_key));
  assert.ok(list.models.some((m) => m.provider_id === preset.data.id && m.capability === 'video'));
  // 키가 없는 공급사의 모델은 PD 선택 목록에 나오지 않는다.
  const pickable = (await request('/studio/ai/overview', { cookie: pd })).data.models;
  assert.ok(!pickable.some((m) => m.provider === 'MiniMax Hailuo'));
  // 모델 등록: 공급사 종류가 지원하지 않는 작업은 거부
  assert.equal((await request('/admin/ai/models', { method: 'POST', cookie: admin, body: { provider_id: created.data.id, capability: 'video', model_id: 'x', label: 'x', tier: 'draft', cost_usd: 0.1 } })).status, 400);
  const model = await request('/admin/ai/models', {
    method: 'POST',
    cookie: admin,
    body: { provider_id: created.data.id, capability: 'text', model_id: 'emu-writer', label: '에뮬 작가', tier: 'standard', cost_usd: 0.002, price_lama: 2, tags: ['korean', 'story'], priority: 100 },
  });
  assert.equal(model.status, 201);
  const models = (await request('/studio/ai/overview', { cookie: pd })).data.models;
  assert.ok(models.some((m) => m.id === model.data.id && m.lama_per_unit === 2));
  // 사용 기록이 없는 공급사는 삭제, 개발용 가짜 AI는 삭제 불가
  assert.equal((await request('/admin/ai/providers/mock', { method: 'DELETE', cookie: admin })).status, 400);
  assert.equal((await request(`/admin/ai/providers/${preset.data.id}`, { method: 'DELETE', cookie: admin })).data.deleted, true);
});

test('studio production end to end with the development AI: plan, cast, script, voices, video, compose, export and review', async () => {
  const seller = await newPd('maker');
  const overview = await request('/studio/ai/overview', { cookie: seller.cookie });
  assert.equal(overview.data.agreed_at, null);
  const body = { title: '스튜디오 검수', logline: '비밀을 숨긴 두 사람이 한 집에 살게 된다', genre: '로맨스', tone: '설렘', episode_count: 2, episode_seconds: 20 };
  assert.equal((await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body })).status, 403);
  assert.equal((await request('/studio/ai/terms', { method: 'POST', cookie: seller.cookie, body: { agree: true, version: '2026-09' } })).status, 200);
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body });
  assert.equal(created.status, 201);
  const pid = created.data.id;
  // 다른 PD·시청자는 볼 수 없다.
  assert.equal((await request('/studio/ai/projects/' + pid, { cookie: pd })).status, 404);
  assert.equal((await request('/studio/ai/projects/' + pid, { cookie: viewer })).status, 403);
  // 개발용 가짜 작가를 직접 지정해 기획안 → 예상 라마와 실제 차감 비교
  const run = (action, extra = {}) => request(`/studio/ai/projects/${pid}/run`, { method: 'POST', cookie: seller.cookie, body: { action, requested: extra.requested || 'auto', tier: extra.tier || 'standard', targetId: extra.targetId, idempotencyKey: extra.idempotencyKey } });
  const est = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'plan', requested: 'mock-writer' } });
  assert.ok(est.data.lama >= 1);
  const start = (await request('/lama', { cookie: seller.cookie })).data.wallet;
  assert.equal(start.total, 300);
  // 같은 요청의 재전송은 작업 완료 시점에 관계없이 한 작업·한 차감으로 끝나야 합니다.
  const planKey = randomUUID();
  const plans = await Promise.all([run('plan', { requested: 'mock-writer', idempotencyKey: planKey }), run('plan', { requested: 'mock-writer', idempotencyKey: planKey })]);
  assert.ok(plans.every(r => r.status === 201), JSON.stringify(plans));
  assert.equal(plans[0].data.jobs[0].id, plans[1].data.jobs[0].id);
  let p = await waitJobs(seller.cookie, pid);
  assert.equal(p.jobs.filter(j => j.kind === 'plan').length, 1);
  const replay = await run('plan', { requested: 'mock-writer', idempotencyKey: planKey });
  assert.equal(replay.status, 201);
  assert.equal(replay.data.jobs[0].id, plans[0].data.jobs[0].id);
  assert.equal(p.characters.length, 3);
  assert.equal(p.episodes.length, 2);
  assert.match(p.episodes[0].title, /1화/);
  const planJob = p.jobs.find((j) => j.kind === 'plan');
  assert.equal(planJob.status, 'succeeded');
  assert.ok(planJob.charged_lama <= planJob.estimate_lama);
  // 캐릭터 이미지 → 대본 → 스토리보드 · 음성 → 영상
  for (const c of p.characters) assert.equal((await run('character_image', { targetId: c.id, requested: 'mock-image' })).status, 201);
  for (const e of p.episodes) assert.equal((await run('script', { targetId: e.id, requested: 'mock-writer' })).status, 201);
  p = await waitJobs(seller.cookie, pid);
  assert.ok(p.characters.every((c) => c.image.startsWith('/uploads/')));
  assert.ok(p.episodes.every((e) => e.shots.length >= 3));
  const ep = p.episodes[0];
  assert.ok(ep.shots.some((s) => s.speaker_id), '대사 화자가 인물과 연결돼야 한다');
  assert.equal((await run('batch_shot_image', { targetId: ep.id, tier: 'draft' })).status, 201);
  assert.equal((await run('batch_shot_tts', { targetId: ep.id })).status, 201);
  p = await waitJobs(seller.cookie, pid);
  let shots = p.episodes[0].shots;
  assert.ok(shots.every((s) => s.image));
  assert.ok(shots.filter((s) => s.dialogue).every((s) => s.audio && s.audio_seconds > 0));
  // 대사를 바꾸면 예전 음성은 지워진다(버전 기록은 남음).
  const talking = shots.find((s) => s.dialogue);
  const edited = await request('/studio/ai/shots/' + talking.id, { method: 'PATCH', cookie: seller.cookie, body: { scene: talking.scene, visual: talking.visual, dialogue: '대사를 바꿨어요', speaker_id: talking.speaker_id, camera: talking.camera, seconds: talking.seconds } });
  assert.equal(edited.data.audioReset, true);
  // 예전 음성 버전으로 되돌리기
  p = (await request('/studio/ai/projects/' + pid, { cookie: seller.cookie })).data;
  const oldVoice = p.assets.find((a) => a.target_id === talking.id && a.kind === 'audio');
  assert.equal((await request(`/studio/ai/assets/${oldVoice.id}/use`, { method: 'POST', cookie: seller.cookie })).status, 200);
  // 영상: 일부 컷만 만들고, 나머지는 스토리보드 이미지로 합성된다.
  assert.equal((await run('shot_video', { targetId: shots[0].id, tier: 'draft' })).status, 201);
  p = await waitJobs(seller.cookie, pid);
  shots = p.episodes[0].shots;
  assert.ok(shots[0].video.startsWith('/uploads/'));
  const media = await fetch(`${base}/api/studio/media/${shots[0].video.split('/').pop()}`, { headers: { cookie: seller.cookie } });
  assert.equal(media.status, 200);
  assert.equal((await fetch(`${base}/api/studio/media/${shots[0].video.split('/').pop()}`, { headers: { cookie: pd } })).status, 404);
  // 합성
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${ep.id}/compose`, { method: 'POST', cookie: seller.cookie })).status, 202);
  let composed;
  for (let i = 0; i < 240; i++) {
    composed = (await request(`/studio/ai/projects/${pid}/episodes/${ep.id}/compose`, { cookie: seller.cookie })).data;
    if (composed.status !== 'composing') break;
    await sleep(250);
  }
  assert.equal(composed.status, 'composed', composed.error);
  const total = shots.reduce((n, s) => n + Math.max(s.seconds, s.audio_seconds ? s.audio_seconds + 0.35 : 0), 0);
  assert.ok(Math.abs(composed.duration - total) <= 2, `합성 길이 ${composed.duration} vs ${total}`);
  const vtt = await fetch(`${base}/api/studio/ai/episodes/${ep.id}/subtitles`, { headers: { cookie: seller.cookie } });
  assert.match(await vtt.text(), /^WEBVTT/);
  // 1화만 합성됐으므로 내보내기는 1화만. 포스터가 없으면 인물 이미지를 쓴다.
  const exported = await request(`/studio/ai/projects/${pid}/export`, { method: 'POST', cookie: seller.cookie, body: { tagline: '한 집에 사는 두 비밀', episode_pings: 5, free_episodes: 1, submit: true } });
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  assert.equal(exported.data.submitted, true);
  const dramaId = exported.data.dramaId;
  const review = (await request('/studio/dramas/' + dramaId, { cookie: admin })).data;
  assert.equal(review.status, 'pending');
  assert.equal(review.ai_usage, 'full');
  assert.equal(review.episodes[0].source, 'studio');
  assert.equal(review.episodes[0].has_subtitles, 1);
  const provenance = (await request(`/studio/dramas/${dramaId}/provenance`, { cookie: admin })).data;
  assert.ok(provenance.models.some((m) => m.kind === 'shot_video'));
  assert.equal((await request(`/studio/dramas/${dramaId}/provenance`, { cookie: pd })).status, 404);
  // 심사 중에는 다시 내보낼 수 없다.
  assert.equal((await request(`/studio/ai/projects/${pid}/export`, { method: 'POST', cookie: seller.cookie, body: { tagline: '다시', submit: false } })).status, 409);
  assert.equal((await request(`/admin/dramas/${dramaId}/review`, { method: 'POST', cookie: admin, body: { status: 'published' } })).status, 200);
  const pub = (await request('/dramas/' + dramaId)).data;
  assert.equal(pub.ai_label, true);
  assert.equal(pub.episodes[0].has_subtitles, 1);
  assert.equal((await fetch(`${base}/api/subtitles/${dramaId}/1`)).status, 200);
  // 라마 장부: 예약·사용·반환이 지갑과 일치하고, 예약 잔액이 남지 않는다.
  const [w] = readDb('SELECT * FROM lama_wallets WHERE user_id=?', [seller.id]);
  const [s] = readDb('SELECT SUM(paid_delta) AS p, SUM(bonus_delta) AS b, SUM(held_delta) AS h FROM lama_ledger WHERE user_id=?', [seller.id]);
  assert.equal(w.held_paid + w.held_bonus, 0);
  assert.equal(s.h, 0);
  assert.equal(s.p, w.paid_balance);
  assert.equal(s.b, w.bonus_balance);
  const [charged] = readDb("SELECT SUM(charged_lama) AS n FROM ai_jobs WHERE user_id=? AND status='succeeded'", [seller.id]);
  assert.equal(300 - (w.paid_balance + w.bonus_balance), charged.n);
});

test('AI engine routing: vendor adapters, automatic fallback, refunds, limits, budget and blocked words', async () => {
  const seller = await newPd('router');
  await request('/studio/ai/terms', { method: 'POST', cookie: seller.cookie, body: { agree: true, version: '2026-09' } });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: seller.id, action: 'grant', lama: 2000, memo: '라우팅 검수' } });
  const fal = await request('/admin/ai/providers', { method: 'POST', cookie: admin, body: { name: '에뮬 fal', kind: 'fal', base_url: `http://127.0.0.1:${vendorPort}/fal`, country: 'US', api_key: 'fal-emu' } });
  const good = await request('/admin/ai/models', { method: 'POST', cookie: admin, body: { provider_id: fal.data.id, capability: 'video', model_id: 'good-video', label: '에뮬 영상', tier: 'premium', cost_usd: 0.1, price_lama: 4, tags: ['dialogue', 'closeup'], priority: 90, max_seconds: 10, image_input: true } });
  const broken = await request('/admin/ai/models', { method: 'POST', cookie: admin, body: { provider_id: fal.data.id, capability: 'video', model_id: 'broken-video', label: '고장 영상', tier: 'premium', cost_usd: 0.1, price_lama: 4, tags: ['dialogue', 'closeup'], priority: 100, max_seconds: 10, image_input: true } });
  const project = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body: { title: '라우팅', logline: '고장 난 모델을 건너뛰는지 확인한다', genre: '스릴러', episode_count: 1, episode_seconds: 20 } });
  const pid = project.data.id;
  const run = (action, extra = {}) => request(`/studio/ai/projects/${pid}/run`, { method: 'POST', cookie: seller.cookie, body: { action, tier: 'premium', requested: 'auto', ...extra } });
  // 자동 선택: 우선순위가 높은 에뮬 작가(OpenAI 호환)가 기획을 쓴다. 코드블록·설명이 섞인 응답도 읽는다.
  assert.equal((await run('plan')).status, 201);
  let p = await waitJobs(seller.cookie, pid);
  assert.equal(p.project.title, '에뮬레이터 기획');
  assert.equal(p.characters[0].name, '가온');
  const planJob = p.jobs.find((j) => j.kind === 'plan');
  assert.equal(planJob.model_label, '에뮬 작가');
  // 실제 사용량(2,000토큰 × 2라마/1천 토큰 = 4라마)만 차감
  assert.equal(planJob.charged_lama, 4);
  await run('script', { targetId: p.episodes[0].id, requested: 'mock-writer', tier: 'standard' });
  p = await waitJobs(seller.cookie, pid);
  const shot = p.episodes[0].shots.find((s) => s.dialogue) || p.episodes[0].shots[0];
  // 영상 자동 선택: 고장 난 모델이 먼저 선택되지만 실패하면 다음 모델로 넘어간다(비동기 대기열 결과 확인).
  const before = (await request('/lama', { cookie: seller.cookie })).data.wallet;
  assert.equal((await run('shot_video', { targetId: shot.id })).status, 201);
  p = await waitJobs(seller.cookie, pid, 90000);
  const vjob = p.jobs.find((j) => j.kind === 'shot_video');
  assert.equal(vjob.status, 'succeeded', vjob.error);
  assert.equal(vjob.model_label, '에뮬 영상');
  assert.ok(vendorHits.some((h) => h.url.startsWith('/fal/broken-video')));
  assert.ok(vendorHits.some((h) => h.url.startsWith('/fal/status/') && h.auth === 'Key fal-emu'));
  const after = (await request('/lama', { cookie: seller.cookie })).data.wallet;
  assert.equal(before.total - after.total, vjob.charged_lama);
  assert.ok(p.episodes[0].shots.find((s) => s.id === shot.id).video.startsWith('/uploads/'));
  // 직접 고른 모델이 계속 실패하면 재시도 후 전액 반환
  const refundBase = (await request('/lama', { cookie: seller.cookie })).data.wallet.total;
  assert.equal((await run('shot_video', { targetId: shot.id, requested: broken.data.id })).status, 201);
  p = await waitJobs(seller.cookie, pid, 90000);
  const failed = p.jobs.find((j) => j.kind === 'shot_video' && j.status === 'failed');
  assert.ok(failed);
  assert.match(failed.error, /500|overloaded/);
  assert.equal((await request('/lama', { cookie: seller.cookie })).data.wallet.total, refundBase);
  // PD 하루 한도
  await request(`/admin/ai/limits/${seller.id}`, { method: 'PUT', cookie: admin, body: { daily_lama: 1, monthly_lama: null, blocked: false } });
  let r = await run('shot_video', { targetId: shot.id, requested: good.data.id });
  assert.equal(r.status, 429);
  await request(`/admin/ai/limits/${seller.id}`, { method: 'PUT', cookie: admin, body: { daily_lama: null, monthly_lama: null, blocked: true } });
  assert.equal((await run('shot_video', { targetId: shot.id, requested: good.data.id })).status, 403);
  await request(`/admin/ai/limits/${seller.id}`, { method: 'PUT', cookie: admin, body: { daily_lama: null, monthly_lama: null, blocked: false } });
  // 플랫폼 월 예산(원가 기준)
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_monthly_budget_won: 1 } });
  r = await run('shot_video', { targetId: shot.id, requested: good.data.id });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /예산/);
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_monthly_budget_won: 1000000, ai_enabled: 0 } });
  assert.equal((await run('shot_video', { targetId: shot.id, requested: good.data.id })).status, 503);
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_enabled: 1 } });
  // 금칙어
  await request(`/studio/ai/projects/${pid}`, { method: 'PATCH', cookie: seller.cookie, body: { logline: '유명 배우 딥페이크 영상을 만든다' } });
  r = await run('plan');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /딥페이크/);
  // 라마 부족
  const poor = await newPd('poor');
  await request('/studio/ai/terms', { method: 'POST', cookie: poor.cookie, body: { agree: true, version: '2026-09' } });
  const pp = await request('/studio/ai/projects', { method: 'POST', cookie: poor.cookie, body: { title: '가난', logline: '라마가 부족한 PD의 작업을 확인한다', genre: '코미디', episode_count: 1, episode_seconds: 20 } });
  await request('/lama', { cookie: poor.cookie });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: poor.id, action: 'revoke', lama: 300, memo: '잔액 비우기' } });
  r = await request(`/studio/ai/projects/${pp.data.id}/run`, { method: 'POST', cookie: poor.cookie, body: { action: 'plan', requested: 'mock-writer' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'insufficient_lama');
  // 관리자 작업 모니터·모델 시험(라마 미차감)
  const tried = await request(`/admin/ai/models/mock-image/try`, { method: 'POST', cookie: admin, body: { prompt: '시험용 포스터' } });
  assert.equal(tried.status, 201);
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await request('/admin/ai/jobs/' + tried.data.id, { cookie: admin })).data;
    if (!['queued', 'running'].includes(job.status)) break;
    await sleep(200);
  }
  assert.equal(job.status, 'succeeded');
  assert.equal(job.charged_lama, 0);
  assert.match(job.output.url, /^\/uploads\//);
  const usage = (await request('/admin/ai', { cookie: admin })).data;
  assert.ok(usage.usage.byModel.some((m) => m.label === '에뮬 영상'));
});

test('AI tools for uploaded videos: automatic subtitles and poster candidates', async () => {
  const seller = await newPd('tools');
  await request('/studio/ai/terms', { method: 'POST', cookie: seller.cookie, body: { agree: true, version: '2026-09' } });
  await request('/lama', { cookie: seller.cookie });
  const d = await request('/studio/dramas', {
    method: 'POST',
    cookie: seller.cookie,
    body: { title: '도구 검수', tagline: '업로드 영상 AI 도구', synopsis: '업로드한 영상에 자동 자막과 포스터를 만듭니다.', genre: '청춘', free_episodes: 1, image: '/images/hero.webp', rights_confirmed: true },
  });
  // 샘플 영상에는 소리가 없어 자막을 만들 수 없다.
  await request(`/studio/dramas/${d.data.id}/episodes`, { method: 'POST', cookie: seller.cookie, body: { number: 1, title: '1화', duration: 12, video: '/demo/preview.mp4' } });
  const silent = await request('/studio/ai/tools/subtitles', { method: 'POST', cookie: seller.cookie, body: { dramaId: d.data.id, number: 1 } });
  assert.equal(silent.status, 400);
  // 소리가 있는 영상을 만들어 올린다.
  const ffmpeg = process.env.FFMPEG_PATH || (await import('ffmpeg-static')).default;
  const file = path.join(dataDir, 'with-audio.mp4');
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=360x640:d=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const form = new FormData();
  form.set('file', new Blob([readFileSync(file)], { type: 'video/mp4' }), 'with-audio.mp4');
  const up = await fetch(base + '/api/studio/upload', { method: 'POST', headers: { cookie: seller.cookie }, body: form });
  const uploaded = await up.json();
  assert.equal(up.status, 200, JSON.stringify(uploaded));
  await request(`/studio/dramas/${d.data.id}/episodes`, { method: 'POST', cookie: seller.cookie, body: { number: 1, title: '1화', duration: 4, video: uploaded.url } });
  const sub = await request('/studio/ai/tools/subtitles', { method: 'POST', cookie: seller.cookie, body: { dramaId: d.data.id, number: 1 } });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const subJob = await waitJob(seller.cookie, sub.data.id);
  assert.equal(subJob.status, 'succeeded', subJob.error);
  const detail = (await request('/studio/dramas/' + d.data.id, { cookie: seller.cookie })).data;
  assert.equal(detail.episodes[0].has_subtitles, 1);
  const poster = await request('/studio/ai/tools/poster', { method: 'POST', cookie: seller.cookie, body: { dramaId: d.data.id, prompt: '비 오는 밤' } });
  const posterJob = await waitJob(seller.cookie, poster.data.id);
  assert.equal(posterJob.status, 'succeeded');
  assert.equal((await request(`/studio/dramas/${d.data.id}/poster`, { method: 'PUT', cookie: seller.cookie, body: { image: posterJob.output.url } })).status, 200);
  // 남의 작품에는 쓸 수 없다.
  await request('/studio/ai/terms', { method: 'POST', cookie: pd, body: { agree: true, version: '2026-09' } });
  assert.equal((await request('/studio/ai/tools/poster', { method: 'POST', cookie: pd, body: { dramaId: d.data.id } })).status, 404);
});

async function autopilotOf(cookie, pid) {
  return (await request('/studio/ai/projects/' + pid, { cookie })).data;
}
async function waitAutopilot(cookie, pid, statuses, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const d = await autopilotOf(cookie, pid);
    if (d.autopilot && statuses.includes(d.autopilot.status) && !d.jobs.some((j) => ['queued', 'running'].includes(j.status)) && !d.episodes.some((e) => e.status === 'composing')) return d;
    await sleep(400);
  }
  throw new Error('autopilot timeout\n' + output.slice(-1500));
}

test('autopilot builds a whole draft within a lama cap, pauses on the cap and can be stopped with refunds', async () => {
  const seller = await newPd('auto');
  await request('/studio/ai/terms', { method: 'POST', cookie: seller.cookie, body: { agree: true, version: '2026-09' } });
  await request('/lama', { cookie: seller.cookie });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: seller.id, action: 'grant', lama: 3000, memo: '자동 제작 검수' } });
  const mockChoices = { text: { requested: 'mock-writer', tier: 'standard' }, image: { requested: 'mock-image', tier: 'draft' }, tts: { requested: 'mock-voice', tier: 'standard' }, video: { requested: 'mock-video-fast', tier: 'draft' } };
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body: { title: '자동 제작', logline: '한 번에 초안을 만드는 자동 제작을 확인한다', genre: '판타지', episode_count: 2, episode_seconds: 20 } });
  const pid = created.data.id;
  const est = await request(`/studio/ai/projects/${pid}/autopilot/estimate`, { method: 'POST', cookie: seller.cookie, body: { choices: mockChoices, includeVideo: true } });
  assert.equal(est.status, 200);
  assert.deepEqual(est.data.stages.map((x) => x.stage), ['plan', 'cast', 'script', 'board', 'voice', 'video', 'compose']);
  assert.ok(est.data.total > 0);
  const start = await request(`/studio/ai/projects/${pid}/autopilot`, { method: 'POST', cookie: seller.cookie, body: { choices: mockChoices, includeVideo: true, cap: 2500 } });
  assert.equal(start.status, 201);
  assert.equal((await request(`/studio/ai/projects/${pid}/autopilot`, { method: 'POST', cookie: seller.cookie, body: { choices: mockChoices } })).status, 409);
  const activity = (await request('/studio/ai/activity', { cookie: seller.cookie })).data;
  assert.ok(activity.autopilots.some((a) => a.id === pid));
  const done = await waitAutopilot(seller.cookie, pid, ['done', 'paused']);
  assert.equal(done.autopilot.status, 'done', done.autopilot.message);
  assert.ok(done.characters.every((c) => c.image));
  assert.ok(done.episodes.every((e) => e.video && e.status === 'composed'));
  assert.ok(done.episodes.flatMap((e) => e.shots).every((sh) => sh.image && sh.video && (!sh.dialogue || sh.audio)));
  assert.ok(done.spent <= 2500);
  assert.ok(done.costs.some((c) => c.kind === 'shot_video'));
  // 최대 라마가 작으면 멈추고 이유를 알려 준다.
  const small = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body: { title: '작은 상한', logline: '상한을 넘으면 멈추는지 확인한다', genre: '코미디', episode_count: 1, episode_seconds: 20 } });
  await request(`/studio/ai/projects/${small.data.id}/autopilot`, { method: 'POST', cookie: seller.cookie, body: { choices: mockChoices, includeVideo: true, cap: 5 } });
  const paused = await waitAutopilot(seller.cookie, small.data.id, ['paused', 'done']);
  assert.equal(paused.autopilot.status, 'paused');
  assert.match(paused.autopilot.message, /최대 5라마/);
  // 기본 상한(예상치 기준)과 자동 선택만으로도 중간에 멈추지 않고 끝까지 간다(예상이 실제보다 작지 않아야 함).
  const auto = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body: { title: '기본 상한', logline: '기본 상한으로 끝까지 가는지 확인한다', genre: '로맨스', episode_count: 2, episode_seconds: 20 } });
  const autoEst = await request(`/studio/ai/projects/${auto.data.id}/autopilot/estimate`, { method: 'POST', cookie: seller.cookie, body: {} });
  assert.equal((await request(`/studio/ai/projects/${auto.data.id}/autopilot`, { method: 'POST', cookie: seller.cookie, body: {} })).status, 201);
  const autoDone = await waitAutopilot(seller.cookie, auto.data.id, ['done', 'paused']);
  assert.equal(autoDone.autopilot.status, 'done', autoDone.autopilot.message);
  assert.ok(autoDone.spent <= autoEst.data.total, `실제 ${autoDone.spent} ≤ 예상 ${autoEst.data.total}`);
  // 멈추기: 대기 중인 작업은 취소·환불, 장부는 예약 0으로 맞는다.
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_concurrency: 1 } });
  try {
    const stopMe = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body: { title: '멈춤', logline: '자동 제작을 멈추는지 확인한다', genre: '청춘', episode_count: 3, episode_seconds: 20 } });
    await request(`/studio/ai/projects/${stopMe.data.id}/autopilot`, { method: 'POST', cookie: seller.cookie, body: { choices: mockChoices } });
    let d;
    for (let i = 0; i < 100; i++) {
      d = await autopilotOf(seller.cookie, stopMe.data.id);
      if (d.autopilot?.stage === 'script' || d.autopilot?.stage === 'cast') break;
      await sleep(150);
    }
    const stop = await request(`/studio/ai/projects/${stopMe.data.id}/autopilot/stop`, { method: 'POST', cookie: seller.cookie });
    assert.equal(stop.status, 200);
    assert.equal((await autopilotOf(seller.cookie, stopMe.data.id)).autopilot.status, 'stopped');
    for (let i = 0; i < 100; i++) {
      d = await autopilotOf(seller.cookie, stopMe.data.id);
      if (!d.jobs.some((j) => ['queued', 'running'].includes(j.status))) break;
      await sleep(200);
    }
  } finally {
    await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_concurrency: 3 } });
  }
  const [w] = readDb('SELECT * FROM lama_wallets WHERE user_id=?', [seller.id]);
  const [sum] = readDb('SELECT SUM(paid_delta) AS p, SUM(bonus_delta) AS b, SUM(held_delta) AS h FROM lama_ledger WHERE user_id=?', [seller.id]);
  assert.equal(w.held_paid + w.held_bonus, 0);
  assert.equal(sum.h, 0);
  assert.equal(sum.b, w.bonus_balance);
  // 관리자 프로젝트 모니터
  const monitor = (await request('/admin/ai/projects', { cookie: admin })).data;
  assert.ok(monitor.some((m) => m.id === pid && Number(m.composed) === 2));
});

test('shot rewrite and voice sample; admin routing rules, China policy, breaker, discovery, bulk pricing, analytics and safety log', async () => {
  const seller = await newPd('tune');
  await request('/studio/ai/terms', { method: 'POST', cookie: seller.cookie, body: { agree: true, version: '2026-09' } });
  await request('/lama', { cookie: seller.cookie });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: seller.id, action: 'grant', lama: 1000, memo: '고도화 검수' } });
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body: { title: '다듬기', logline: '컷 고치기와 목소리 미리듣기를 확인한다', genre: '로맨스', episode_count: 1, episode_seconds: 20 } });
  const pid = created.data.id;
  const run = (body) => request(`/studio/ai/projects/${pid}/run`, { method: 'POST', cookie: seller.cookie, body });
  await run({ action: 'plan', requested: 'mock-writer' });
  let p = await waitJobs(seller.cookie, pid);
  await run({ action: 'script', targetId: p.episodes[0].id, requested: 'mock-writer' });
  p = await waitJobs(seller.cookie, pid);
  const shot = p.episodes[0].shots.find((x) => x.dialogue);
  assert.equal((await run({ action: 'rewrite_shot', targetId: shot.id, requested: 'mock-writer' })).status, 400);
  assert.equal((await run({ action: 'rewrite_shot', targetId: shot.id, requested: 'mock-writer', instruction: '더 긴장감 있게' })).status, 201);
  const c = p.characters[0];
  assert.equal((await run({ action: 'voice_sample', targetId: c.id, requested: 'mock-voice' })).status, 201);
  p = await waitJobs(seller.cookie, pid);
  const rewritten = p.episodes[0].shots.find((x) => x.id === shot.id);
  assert.match(rewritten.scene, /수정/, JSON.stringify(p.jobs.filter((j) => j.kind === 'rewrite_shot')));
  assert.notEqual(rewritten.dialogue, shot.dialogue);
  assert.ok(p.characters.find((x) => x.id === c.id).voice_sample.startsWith('/uploads/'));

  // 라우팅 규칙: 표준 등급 이미지는 HQ 대신 저가 가짜 이미지 모델을 먼저 쓴다.
  assert.equal((await request('/admin/ai/routes', { method: 'PUT', cookie: admin, body: { capability: 'image', tier: 'standard', model_ids: ['mock-writer'] } })).status, 400);
  assert.equal((await request('/admin/ai/routes', { method: 'PUT', cookie: admin, body: { capability: 'image', tier: 'standard', model_ids: ['mock-image'] } })).status, 200);
  const est = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'character_image', targetId: c.id, tier: 'standard' } });
  assert.match(est.data.model, /가짜 이미지 \(개발용\)/);
  await request('/admin/ai/routes', { method: 'PUT', cookie: admin, body: { capability: 'image', tier: 'standard', model_ids: [] } });
  const est2 = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'character_image', targetId: c.id, tier: 'standard' } });
  assert.match(est2.data.model, /HQ/);

  // 중국 모델 정책: 에뮬 작가(중국, 우선순위 100)
  const list = (await request('/admin/ai', { cookie: admin })).data;
  const cnModel = list.models.find((m) => m.model_id === 'emu-writer');
  assert.ok(cnModel);
  let e = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'plan' } });
  assert.match(e.data.model, /에뮬 작가/);
  await request(`/studio/ai/projects/${pid}`, { method: 'PATCH', cookie: seller.cookie, body: { exclude_cn: true } });
  e = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'plan' } });
  assert.doesNotMatch(e.data.model, /에뮬 작가/);
  e = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'plan', requested: cnModel.id } });
  assert.equal(e.status, 400);
  assert.match(e.data.error, /중국/);
  await request(`/studio/ai/projects/${pid}`, { method: 'PATCH', cookie: seller.cookie, body: { exclude_cn: false } });
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_allow_cn: 0 } });
  const picker = (await request('/studio/ai/overview', { cookie: seller.cookie })).data.models;
  assert.ok(!picker.some((m) => m.country === 'CN'));
  e = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'plan' } });
  assert.doesNotMatch(e.data.model, /에뮬 작가/);
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_allow_cn: 1 } });

  // 장애 차단: 연속 실패 기준을 1로 낮추고 고장 모델을 직접 쓰면 공급사가 잠시 제외된다.
  const fal = list.providers.find((x) => x.name === '에뮬 fal');
  const broken = list.models.find((m) => m.model_id === 'broken-video');
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_breaker_failures: 1 } });
  try {
    await run({ action: 'shot_video', targetId: shot.id, requested: broken.id });
    await waitJobs(seller.cookie, pid, 90000);
    let view = (await request('/admin/ai', { cookie: admin })).data.providers.find((x) => x.id === fal.id);
    assert.ok(view.cooldown_until, '공급사가 잠시 제외돼야 한다');
    assert.equal(view.status, 'error');
    assert.equal((await request(`/admin/ai/providers/${fal.id}/reset`, { method: 'POST', cookie: admin })).status, 200);
    view = (await request('/admin/ai', { cookie: admin })).data.providers.find((x) => x.id === fal.id);
    assert.equal(view.cooldown_until, null);
    assert.equal(view.fail_streak, 0);
  } finally {
    await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_breaker_failures: 5 } });
  }
  // 공급사 동시 작업·월 예산 설정 저장
  const chat = list.providers.find((x) => x.name.startsWith('에뮬 채팅'));
  await request(`/admin/ai/providers/${chat.id}`, { method: 'PATCH', cookie: admin, body: { name: chat.name, kind: 'openai_compatible', base_url: chat.base_url, country: 'CN', max_concurrency: 2, monthly_budget_won: 1 } });
  let v = (await request('/admin/ai', { cookie: admin })).data.providers.find((x) => x.id === chat.id);
  assert.equal(v.max_concurrency, 2);
  assert.equal(v.monthly_budget_won, 1);
  // 월 예산을 다 쓴 공급사는 자동 선택에서 빠진다(이미 원가가 쌓여 있음).
  e = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: seller.cookie, body: { action: 'plan' } });
  assert.doesNotMatch(e.data.model, /에뮬 작가/);
  await request(`/admin/ai/providers/${chat.id}`, { method: 'PATCH', cookie: admin, body: { name: chat.name, kind: 'openai_compatible', base_url: chat.base_url, country: 'CN', max_concurrency: 0, monthly_budget_won: 0 } });
  // 모델 목록 불러오기
  const found = await request(`/admin/ai/providers/${chat.id}/discover`, { method: 'POST', cookie: admin });
  assert.equal(found.status, 200);
  assert.deepEqual(found.data.models.map((m) => [m.id, m.added]), [['emu-writer', true], ['emu-writer-pro', false]]);
  // 가격 일괄 조정
  const bulk = await request('/admin/ai/models/bulk', { method: 'POST', cookie: admin, body: { action: 'multiply', factor: 2, capability: 'text' } });
  assert.equal(bulk.status, 200);
  const after = (await request('/admin/ai', { cookie: admin })).data.models.find((m) => m.id === cnModel.id);
  assert.equal(after.lama_per_unit, 4);
  await request('/admin/ai/models/bulk', { method: 'POST', cookie: admin, body: { action: 'auto', capability: 'text' } });
  // 분석
  const analytics = (await request('/admin/ai/analytics?days=7', { cookie: admin })).data;
  assert.equal(analytics.series.length, 7);
  assert.ok(analytics.series.at(-1).jobs > 0);
  assert.ok(analytics.models.some((m) => m.label === '고장 영상' && m.failed > 0));
  // 안전 기록: 금칙어 시도는 기록된다.
  const bad = await run({ action: 'rewrite_shot', targetId: shot.id, requested: 'mock-writer', instruction: '딥페이크 느낌으로' });
  assert.equal(bad.status, 400);
  const safety = (await request('/admin/ai/safety', { cookie: admin })).data;
  assert.ok(safety.some((x) => x.user_id === seller.id && x.term === '딥페이크'));
  assert.equal((await request('/admin/ai/safety', { cookie: seller.cookie })).status, 403);
});
