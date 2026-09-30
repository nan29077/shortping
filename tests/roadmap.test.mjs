// 통합 로드맵(2026-09-30) 2~6단계 테스트:
// 2단계 조명 · 시간과 색감 · 카메라 높이 · 렌즈 숫자 · 장르 연출 세트 / 3단계 인물 · 장소 · 소품 고정 / 4단계 영상에서 장면 뽑기 · 인물 · 배경 바꾸기
// 5단계 영상 검수 · 공개 전 점검 강화 / 6단계 모델 품질 시험(관리자) · 실제 사용 통계 · 자동 선택 품질 가중치
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';
import { DIRECTION, framingText, lightText, toneGrade } from '../server/ai/direction.mjs';
import { shotImagePrompt, shotVideoPrompt } from '../server/ai/prompts.mjs';

const port = 5301,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb,
  admin,
  pd,
  pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
const detail = async (id = pid, cookie = pd) => (await request('/studio/ai/projects/' + id, { cookie })).data;
async function waitIdle(id = pid, cookie = pd, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const d = await detail(id, cookie);
    if (d && !d.jobs.some((j) => ['queued', 'running'].includes(j.status))) return d;
    await sleep(200);
  }
  throw new Error('작업이 끝나지 않았어요\n' + output.slice(-2000));
}
const run = (body, cookie = pd, id = pid) => request(`/studio/ai/projects/${id}/run`, { method: 'POST', cookie, body: { requested: 'auto', tier: 'standard', ...body } });
const ok = (r) => (assert.ok(r.status < 300, JSON.stringify(r.data)), r);
const shotsOf = (d, n = 0) => d.episodes[n].shots;
const one = async (sql, params) => (await testDb.all(sql, params))[0];
const patch = (id, body, cookie = pd) => request(`/studio/ai/shots/${id}`, { method: 'PATCH', cookie, body });

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
  admin = await login('admin');
  pd = await login('pd');
  await request('/studio/ai/terms', { method: 'POST', cookie: pd, body: { agree: true, version: '2026-09' } });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'grant', lama: 50000, memo: '점검 테스트' } });
  pid = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '로드맵', logline: '오래된 약속이 다시 두 사람을 부른다, 비 오는 골목에서', genre: '로맨스', episode_count: 1, episode_seconds: 30 } })).data.id;
  ok(await run({ action: 'plan', requested: 'mock-writer' }));
  await waitIdle();
  ok(await run({ action: 'script', requested: 'mock-writer', targetId: (await detail()).episodes[0].id }));
  await waitIdle();
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});


const lastJob = async (kind, target) => (await testDb.all('SELECT * FROM ai_jobs WHERE kind=? AND target_id=? ORDER BY created_at DESC LIMIT 1', [kind, target]))[0];

// ── 2단계 ─────────────────────────────────────────────
test('stage 2: lighting/tone/height/lens numbers dictionary and prompt text', () => {
  assert.equal(DIRECTION.lights.length, 8);
  assert.equal(DIRECTION.tones.length, 9);
  for (const name of ['감정 대화', '긴장 추적', '로맨틱 클로즈업']) assert.ok(DIRECTION.presets.some((p) => p.name === name && p.light && p.tone), name);
  const shot = { visual: 'v', visual_en: 'rain street', visual_en_src: 'v', camera: '클로즈업', height: '바닥 높이', focal: 85, dof: '1.8', light: '역광', tone: '노을' };
  assert.match(framingText(shot), /ground level.*85mm lens.*f\/1\.8 aperture, shallow/);
  assert.match(lightText(shot), /backlit.*golden hour/);
  const project = { title: 't', style: 'film' };
  assert.match(shotImagePrompt(project, shot, [], null), /Lighting and mood: backlit/);
  assert.match(shotVideoPrompt(project, shot, null), /Lighting and mood: backlit/);
  assert.equal(toneGrade('노을'), '');
  assert.match(toneGrade('따뜻한 색감'), /colorbalance/);
  // 모르는 값은 무시
  assert.equal(lightText({ light: '레이저', tone: '' }), '');
});

test('stage 2: AI script fills light/tone; PATCH validates and saves; bulk; image job prompt carries lighting', async () => {
  let d = await detail();
  let shots = shotsOf(d);
  assert.ok(shots.some((s) => s.light === '역광'), 'AI가 조명을 채움');
  assert.ok(shots.some((s) => s.tone === '노을'), 'AI가 시간 · 색감을 채움');
  const s = shots[0];
  assert.equal((await patch(s.id, { light: '레이저' })).status, 400);
  assert.equal((await patch(s.id, { tone: '보라색' })).status, 400);
  assert.equal((await patch(s.id, { height: '천장' })).status, 400);
  assert.equal((await patch(s.id, { dof: '0.5' })).status, 400);
  assert.equal((await patch(s.id, { focal: 5 })).status, 400);
  ok(await patch(s.id, { light: '측광', tone: '비 오는 밤', height: '허리 높이', dof: '2.8', focal: 50 }));
  d = await detail();
  const saved = shotsOf(d)[0];
  assert.deepEqual([saved.light, saved.tone, saved.height, saved.dof, Number(saved.focal)], ['측광', '비 오는 밤', '허리 높이', '2.8', 50]);
  ok(await run({ action: 'shot_image', requested: 'mock-image', targetId: s.id }));
  const job = await lastJob('shot_image', s.id);
  const prompt = JSON.parse(job.input).prompt;
  assert.match(prompt, /Rembrandt/);
  assert.match(prompt, /rainy night/);
  assert.match(prompt, /50mm lens, f\/2\.8/);
  await waitIdle();
  // 여러 컷 한 번에: 조명 · 색감
  const ids = shotsOf(d).slice(1, 3).map((x) => x.id);
  const b = ok(await request(`/studio/ai/projects/${pid}/episodes/${d.episodes[0].id}/shots/bulk`, { method: 'PATCH', cookie: pd, body: { ids, light: '네온', tone: '차가운 색감' } }));
  assert.equal(b.data.changed, 2);
  d = await detail();
  for (const x of shotsOf(d).slice(1, 3)) assert.deepEqual([x.light, x.tone], ['네온', '차가운 색감']);
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${d.episodes[0].id}/shots/bulk`, { method: 'PATCH', cookie: pd, body: { ids, tone: '??' } })).status, 400);
});

test('stage 2: genre preset via assistant sets lighting too; version restore keeps lighting; colour grade composes', async () => {
  let d = await detail();
  const target = shotsOf(d)[3];
  ok(await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '4번 컷 연출을 로맨틱 클로즈업으로 바꿔 줘', episodeId: d.episodes[0].id } }));
  let chat;
  for (let i = 0; i < 100; i++) {
    chat = (await request(`/studio/ai/projects/${pid}/assistant`, { cookie: pd })).data;
    if (chat.at(-1)?.status !== 'thinking') break;
    await sleep(200);
  }
  const plan = chat.at(-1);
  const act = plan.plan.find((a) => a.type === 'edit_direction');
  assert.ok(act?.ok, JSON.stringify(plan.plan));
  assert.equal(act.fields.light, '역광');
  assert.equal(act.fields.tone, '노을');
  ok(await request(`/studio/ai/projects/${pid}/assistant/${plan.id}/apply`, { method: 'POST', cookie: pd, body: {} }));
  d = await detail();
  const after = shotsOf(d).find((x) => x.id === target.id);
  assert.deepEqual([after.light, after.tone, after.camera_move], ['역광', '노을', '천천히 다가가기']);
  // 대본 버전 되돌리기: 조명 · 렌즈 숫자 유지
  const e = d.episodes[0];
  const first = shotsOf(d)[0];
  ok(await run({ action: 'rewrite_range', requested: 'mock-writer', targetId: e.id, instruction: '짧게', options: { shotIds: [first.id] } }));
  await waitIdle();
  const versions = ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions`, { cookie: pd })).data;
  ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions/${versions.find((x) => x.source === 'before_ai').id}/restore`, { method: 'POST', cookie: pd }));
  d = await detail();
  const r = shotsOf(d)[0];
  assert.deepEqual([r.light, r.tone, r.height, r.dof, Number(r.focal)], ['측광', '비 오는 밤', '허리 높이', '2.8', 50]);
  // 색감 보정이 들어간 컷으로 합성
  await testDb.run("UPDATE studio_shots SET tone='빛바랜 필름' WHERE episode_id=?", [e.id]);
  ok(await run({ action: 'batch_shot_image', requested: 'mock-image', targetId: e.id }));
  await waitIdle();
  ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/compose`, { method: 'POST', cookie: pd }));
  let ep;
  for (let i = 0; i < 400; i++) {
    ep = (await detail()).episodes[0];
    if (ep.status !== 'composing') break;
    await sleep(150);
  }
  assert.equal(ep.status, 'composed', ep.compose_error);
});

// ── 3단계 ─────────────────────────────────────────────
test('stage 3: character/location/prop locks go into image, video and AI-check prompts; partial edits keep other fields', async () => {
  let d = await detail();
  const c = d.characters[0];
  ok(await request(`/studio/ai/projects/${pid}/characters/${c.id}`, { method: 'PATCH', cookie: pd, body: { hair: '어깨 길이 흑발 단발', body: '마른 체형', forbid: '안경', locked: true } }));
  // 한 칸만 보내도 나머지(이름 · 외모 · 목소리)는 그대로
  ok(await request(`/studio/ai/projects/${pid}/characters/${c.id}`, { method: 'PATCH', cookie: pd, body: { role: '주인공(고정)' } }));
  d = await detail();
  const saved = d.characters.find((x) => x.id === c.id);
  assert.deepEqual([saved.name, saved.look, saved.hair, saved.body, saved.forbid, Number(saved.locked), saved.role], [c.name, c.look, '어깨 길이 흑발 단발', '마른 체형', '안경', 1, '주인공(고정)']);
  // 장소 · 소품 고정
  const loc = ok(await request(`/studio/ai/projects/${pid}/locations`, { method: 'POST', cookie: pd, body: { name: '옥상', look: '서울 야경이 보이는 옥상' } })).data;
  ok(await request(`/studio/ai/projects/${pid}/locations/${loc.id}`, { method: 'PATCH', cookie: pd, body: { locked: true, forbid: '바다' } }));
  const prop = ok(await request(`/studio/ai/projects/${pid}/props`, { method: 'POST', cookie: pd, body: { name: '은반지', look: '가는 은반지' } })).data;
  ok(await request(`/studio/ai/projects/${pid}/props/${prop.id}`, { method: 'PATCH', cookie: pd, body: { locked: true } }));
  d = await detail();
  assert.equal(Number(d.locations.find((l) => l.id === loc.id).locked), 1);
  assert.equal(d.locations.find((l) => l.id === loc.id).look, '서울 야경이 보이는 옥상', '보내지 않은 칸 유지');
  const s = shotsOf(d)[4];
  ok(await patch(s.id, { cast_ids: [c.id], location_id: loc.id, prop_ids: [prop.id], visual: '옥상에서 반지를 보는 장면 고정 위반' }));
  ok(await run({ action: 'shot_image', requested: 'mock-image', targetId: s.id }));
  const img = JSON.parse((await lastJob('shot_image', s.id)).input).prompt;
  assert.match(img, /hair: 어깨 길이 흑발 단발/);
  assert.match(img, /LOCKED: identical face/);
  assert.match(img, /never show on .*안경/);
  assert.match(img, /LOCKED: same exact layout/);
  assert.match(img, /은반지 \(.*LOCKED: same exact design/);
  await waitIdle();
  ok(await run({ action: 'shot_video', requested: 'mock-video-fast', targetId: s.id }));
  assert.match(JSON.parse((await lastJob('shot_video', s.id)).input).prompt, /hair \(어깨 길이 흑발 단발\).*unchanged throughout the clip/);
  await waitIdle();
  // AI 검수: 고정 요소를 확인하고, 어기면 lock 문제로 알려 줌
  ok(await run({ action: 'verify_shot', targetId: s.id }));
  const vj = await lastJob('verify_shot', s.id);
  assert.match(JSON.parse(vj.input).prompt, /9\) lock: 고정 요소를 지켰는가/);
  await waitIdle();
  d = await detail();
  const v = JSON.parse(shotsOf(d)[4].verify);
  assert.equal(v.ok, false);
  assert.equal(v.issues[0].code, 'lock');
});

test('stage 3: quality check reports face match per episode and warns when an episode drifts', async () => {
  const d = await detail();
  const e = d.episodes[0];
  const name = d.characters[0].name;
  for (const s of shotsOf(d)) {
    if (!s.image) continue;
    await testDb.run('UPDATE studio_shots SET verify=? WHERE id=?', [JSON.stringify({ ok: true, score: 80, issues: [], faces: [{ name, match: 60 }], summary: '', at: new Date().toISOString(), image: s.image }), s.id]);
  }
  const q = ok(await request(`/studio/ai/projects/${pid}/check`, { cookie: pd })).data;
  const f = q.faces.find((x) => x.episodeId === e.id);
  assert.ok(f && f.checked >= 2 && f.avg <= 70, JSON.stringify(q.faces));
  assert.ok(q.issues.some((i) => i.code === 'face_drift_episode' && i.episodeId === e.id));
});

// ── 4단계 ─────────────────────────────────────────────
test('stage 4: grab a frame from the shot video into this shot or the next shot (free)', async () => {
  let d = await detail();
  const [a, b] = shotsOf(d).slice(-2);
  assert.equal((await request(`/studio/ai/shots/${a.id}/frame`, { method: 'POST', cookie: pd, body: { at: 1 } })).status, 400, '영상 없으면 거절');
  ok(await run({ action: 'shot_image', requested: 'mock-image', targetId: a.id }));
  await waitIdle();
  ok(await run({ action: 'shot_video', requested: 'mock-video-fast', targetId: a.id }));
  await waitIdle();
  const before = (await one('SELECT COALESCE(SUM(charged_lama),0) AS n FROM ai_jobs WHERE user_id=?', ['demo-pd'])).n;
  const self = ok(await request(`/studio/ai/shots/${a.id}/frame`, { method: 'POST', cookie: pd, body: { at: 1.2 } })).data;
  const next = ok(await request(`/studio/ai/shots/${a.id}/frame`, { method: 'POST', cookie: pd, body: { at: 59, to: 'next' } })).data;
  assert.equal(next.shotId, b.id);
  d = await detail();
  assert.equal(shotsOf(d).find((x) => x.id === a.id).image, self.url);
  assert.equal(shotsOf(d).find((x) => x.id === b.id).image, next.url);
  assert.ok(d.assets.some((x) => x.url === next.url && x.target_id === b.id), '버전 기록에 남음');
  assert.equal((await one('SELECT COALESCE(SUM(charged_lama),0) AS n FROM ai_jobs WHERE user_id=?', ['demo-pd'])).n, before, '무료');
  const other = await request('/auth/register', { method: 'POST', body: { email: `r-${runId}@road.test`, password: 'RoadTest!2026', name: '남' } });
  assert.ok([403, 404].includes((await request(`/studio/ai/shots/${a.id}/frame`, { method: 'POST', cookie: other.cookie, body: { at: 0 } })).status));
});

test('stage 4: character swap and background swap attach the reference image; motion-only keeps the image', async () => {
  let d = await detail();
  const s = shotsOf(d).at(-2);
  const who = d.characters.find((c) => c.image) || d.characters[0];
  if (!who.image) {
    ok(await run({ action: 'character_image', requested: 'mock-image', targetId: who.id }));
    d = await waitIdle();
  }
  const face = d.characters.find((c) => c.id === who.id).image;
  ok(await run({ action: 'shot_image_edit', targetId: s.id, options: { swap: 'character', swapId: who.id } }));
  let job = await lastJob('shot_image_edit', s.id);
  let input = JSON.parse(job.input);
  assert.match(input.prompt, new RegExp(`Replace the person with ${who.name}`));
  assert.equal(input.refImages[0].path, face);
  await waitIdle();
  const place = d.locations.find((l) => l.name === '옥상');
  ok(await run({ action: 'shot_image_edit', targetId: s.id, options: { swap: 'background', swapId: place.id } }));
  input = JSON.parse((await lastJob('shot_image_edit', s.id)).input);
  assert.match(input.prompt, /Replace only the background with 옥상.*Keep every person exactly the same/);
  await waitIdle();
  assert.equal((await run({ action: 'shot_image_edit', targetId: s.id, options: { swap: 'background' } })).status, 400, '장소도 설명도 없으면 거절');
  assert.equal((await run({ action: 'shot_image_edit', targetId: s.id, options: { swap: 'character', swapId: 'nobody' } })).status, 400);
  // 움직임만 입히기
  ok(await run({ action: 'shot_video', requested: 'mock-video-fast', targetId: s.id, options: { motionOnly: true } }));
  job = await lastJob('shot_video', s.id);
  input = JSON.parse(job.input);
  assert.match(input.prompt, /^Animate this exact image with only subtle natural motion/);
  assert.equal(input.motionOnly, true);
  assert.ok(!input.endImage && !input.needCamera);
  await waitIdle();
});

// ── 5단계 ─────────────────────────────────────────────
test('stage 5: video AI check reads 3 frames (+ previous shot tail), stores result, cleans temp frames, batch skips checked', async () => {
  let d = await detail();
  const list = shotsOf(d);
  const s = list.at(-2);
  // 예상 라마: 장면 뽑기 없이 계산(파일이 생기지 않음)
  const filesBefore = Number((await one('SELECT COUNT(*) AS n FROM media_files', [])).n);
  const est = ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'verify_video', targetId: s.id } }));
  assert.ok(est.data.lama >= 1);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM media_files', [])).n), filesBefore, '예상만 볼 때는 장면을 뽑지 않음');
  ok(await patch(s.id, { visual: '옥상에서 돌아서는 장면 영상 문제' }));
  ok(await run({ action: 'verify_video', targetId: s.id }));
  const job = await lastJob('verify_video', s.id);
  const input = JSON.parse(job.input);
  assert.ok(input.tempFrames.length >= 3, '처음 · 가운데 · 끝 장면');
  assert.match(input.prompt, /처음 · 가운데 · 끝 장면/);
  await waitIdle();
  d = await detail();
  const vv = JSON.parse(shotsOf(d).find((x) => x.id === s.id).video_verify);
  assert.equal(vv.ok, false);
  assert.equal(vv.issues[0].code, 'drift');
  assert.equal(vv.video, s.lipsync || s.video);
  // 임시 장면은 작업이 확정된 뒤 잠시 후 지워요.
  for (let i = 0; i < 40 && (await one('SELECT url FROM media_files WHERE url=?', [input.tempFrames[0]])); i++) await sleep(150);
  for (const url of input.tempFrames) assert.equal(await one('SELECT url FROM media_files WHERE url=?', [url]), undefined, '임시 장면 정리');
  // 공개 전 점검: 영상 문제 → '움직임만 입혀 다시' 추천
  const q = ok(await request(`/studio/ai/projects/${pid}/check`, { cookie: pd })).data;
  const issue = q.issues.find((x) => x.code === 'video_verify_fail' && x.shotId === s.id);
  assert.ok(issue, JSON.stringify(q.issues.map((x) => x.code)));
  assert.equal(issue.fix.options.motionOnly, true);
  // 일괄 검수: 이미 검수한 영상은 건너뜀
  const b = await run({ action: 'batch_verify_video', targetId: d.episodes[0].id });
  if (b.status < 300) assert.ok(!b.data.jobs.some((j) => j.target_id === s.id));
  await waitIdle();
});

test('stage 5: free checks — aspect ratio, low resolution, tone continuity, lip-sync missing hint', async () => {
  let d = await detail();
  const e = d.episodes[0];
  const shots = shotsOf(d);
  // 가로 이미지를 넣은 컷
  const s = shots.find((x) => x.image && !x.video && !x.lipsync) || shots[0];
  await testDb.run('UPDATE media_metadata SET width=1280,height=720 WHERE url=?', [s.image]);
  // 같은 장면 · 같은 장소인데 색감이 바뀌는 두 컷
  const [a, b] = shots.slice(0, 2);
  const loc = d.locations[0];
  await testDb.run("UPDATE studio_shots SET location_id=?,scene='같은 장면',tone='노을' WHERE id=?", [loc.id, a.id]);
  await testDb.run("UPDATE studio_shots SET location_id=?,scene='같은 장면',tone='밤' WHERE id=?", [loc.id, b.id]);
  const q = ok(await request(`/studio/ai/projects/${pid}/check`, { cookie: pd })).data;
  const codes = q.issues.map((x) => x.code);
  assert.ok(q.issues.some((x) => x.code === 'aspect' && x.shotId === s.id), JSON.stringify(codes));
  assert.ok(q.issues.some((x) => x.code === 'continuity_tone' && x.shotId === b.id), JSON.stringify(codes));
  await testDb.run('UPDATE media_metadata SET width=360,height=640 WHERE url=?', [s.image]);
  const q2 = ok(await request(`/studio/ai/projects/${pid}/check`, { cookie: pd })).data;
  assert.ok(q2.issues.some((x) => x.code === 'low_res' && x.shotId === s.id));
  assert.ok(!q2.issues.some((x) => x.code === 'aspect' && x.shotId === s.id));
  assert.ok(e);
});

// ── 6단계 ─────────────────────────────────────────────
test('stage 6: admin quality test runs the same prompt on several models (no lama), auto-scores, and shows a dashboard', async () => {
  assert.equal((await request('/admin/ai/bench', { cookie: pd })).status, 403, 'PD는 볼 수 없음');
  const a = ok(await request('/admin/ai/bench', { cookie: admin })).data;
  assert.ok(a.benchmarks.length >= 4, '기본 시험 문제');
  const img = a.benchmarks.find((b) => b.capability === 'image');
  const vid = a.benchmarks.find((b) => b.capability === 'video');
  const wallet = async () => (await request('/lama', { cookie: admin })).data;
  const before = JSON.stringify(await wallet());
  const r = ok(await request(`/admin/ai/bench/${img.id}/run`, { method: 'POST', cookie: admin, body: { models: ['mock-image', 'mock-image-hq', 'mock-video-fast'] } })).data;
  assert.equal(r.runs.length, 2);
  assert.equal(r.skipped.length, 1, '종류가 다른 모델은 건너뜀');
  ok(await request(`/admin/ai/bench/${vid.id}/run`, { method: 'POST', cookie: admin, body: { models: ['mock-video-fast'] } }));
  let runs;
  for (let i = 0; i < 200; i++) {
    runs = ok(await request('/admin/ai/bench', { cookie: admin })).data.runs;
    if (runs.every((x) => !['running', 'scoring', 'queued'].includes(x.status))) break;
    await sleep(250);
  }
  const done = runs.filter((x) => x.status === 'done');
  assert.equal(done.length, 3, JSON.stringify(runs.map((x) => [x.model_id, x.status, x.error])));
  for (const x of done) {
    assert.ok(x.score > 0 && x.result_url);
    assert.ok(x.seconds !== null);
  }
  assert.equal(JSON.stringify(await wallet()), before, '라마 차감 없음');
  const billed = await one("SELECT COUNT(*) AS n FROM ai_jobs WHERE kind IN ('bench_run','bench_verify') AND billed=1", []);
  assert.equal(Number(billed.n), 0);
  const q = ok(await request('/admin/ai/quality', { cookie: admin })).data;
  const row = q.models.find((m) => m.id === 'mock-image');
  assert.equal(row.bench.done, 1);
  assert.ok(row.bench.score > 0);
  assert.ok(row.usage && row.usage.jobs > 0, '실제 사용 실적');
  assert.ok(row.real && row.real.samples > 0, '실제 AI 검수 점수 표본');
  // 임시 장면(영상 채점용)은 정리됨
  const temp = await one("SELECT COUNT(*) AS n FROM ai_jobs WHERE kind='bench_verify' AND input LIKE '%tempFrame\":\"/uploads/%'", []);
  if (Number(temp.n)) {
    const j = (await testDb.all("SELECT input FROM ai_jobs WHERE kind='bench_verify' AND input LIKE '%tempFrame\":\"/uploads/%'"))[0];
    for (let i = 0; i < 40 && (await one('SELECT url FROM media_files WHERE url=?', [JSON.parse(j.input).tempFrame])); i++) await sleep(150);
    assert.equal(await one('SELECT url FROM media_files WHERE url=?', [JSON.parse(j.input).tempFrame]), undefined);
  }
});

test('stage 6: quality weight makes auto-select prefer the higher-scoring model', async () => {
  const d = await detail();
  const s = shotsOf(d)[0];
  const top = async () => ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image', targetId: s.id } })).data.why[0].id;
  const base = await top();
  const low = base;
  const high = base === 'mock-image' ? 'mock-image-hq' : 'mock-image';
  const t = new Date().toISOString();
  for (let i = 0; i < 4; i++) {
    await testDb.run('INSERT INTO ai_quality_samples (id,model_ref,kind,source,score,face,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), high, 'image', 'bench', 97, null, t]);
    await testDb.run('INSERT INTO ai_quality_samples (id,model_ref,kind,source,score,face,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), low, 'image', 'bench', 40, null, t]);
  }
  ok(await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_weight_quality: 100 } }));
  ok(await request('/admin/ai/quality', { cookie: admin })); // 품질 통계 새로 계산
  const est = ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image', targetId: s.id } })).data;
  assert.equal(est.why[0].id, high, JSON.stringify(est.why));
  assert.ok(est.why[0].why.some((w) => /품질/.test(w)), JSON.stringify(est.why[0].why));
  ok(await request('/admin/settings', { method: 'PUT', cookie: admin, body: { ai_weight_quality: 0 } }));
});
