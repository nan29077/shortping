// 힉스필드 벤치마킹 고도화(2026-09-29) 통합 테스트:
// 1단계 컷 연출(샷 크기·앵글·렌즈·움직임 20종·강도·연출 세트) · 시작/끝 장면(앞 컷 이어받기·끝 장면 이미지) · 모델 선택(카메라·끝 장면)
// 2단계 인물 카드(자세 참고 자동 선택 · 인물 닮음 점수)
// 3단계 컷 보정(붓 마스크 부분 수정 · 인페인팅 모델 · 화질 올리기 이미지/영상 · 공개 전 점검)
// 4단계 후보 여러 장(이미지·영상) · 후보 AI 검수와 추천 · 합성 효과 · AI 조수 연출 바꾸기/되돌리기
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareTestDb } from './_db.mjs';
import { runFfmpeg, probeMedia } from '../server/media.mjs';
import { promptFor } from '../server/ai/engine.mjs';
import { composeEpisode, stillMotion, effectFilter } from '../server/ai/compose.mjs';
import { DIRECTION, CAMERA_MOVES, motionText, framingText } from '../server/ai/direction.mjs';

const port = 5271,
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
async function request(url, { method = 'GET', body, cookie, form } = {}) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
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
const patchShot = (s, body, cookie = pd) =>
  request(`/studio/ai/shots/${s.id}`, {
    method: 'PATCH',
    cookie,
    body: { scene: s.scene, visual: s.visual, dialogue: s.dialogue, speaker_id: s.speaker_id, camera: s.camera, seconds: Number(s.seconds), ...body },
  });
const lastJob = async (kind, target) => (await testDb.all('SELECT * FROM ai_jobs WHERE kind=? AND target_id=? ORDER BY created_at DESC LIMIT 1', [kind, target]))[0];

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
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'grant', lama: 50000, memo: '연출 테스트' } });
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '카메라', logline: '한 장면이 모든 것을 바꾼다, 비 오는 밤의 고백', genre: '로맨스', tone: '애틋함', episode_count: 1, episode_seconds: 30 } });
  pid = created.data.id;
  ok(await run({ action: 'plan', requested: 'mock-writer' }));
  await waitIdle();
  const d = await detail();
  ok(await run({ action: 'script', requested: 'mock-writer', targetId: d.episodes[0].id }));
  await waitIdle();
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('direction dictionary: 20 moves, every complex move has a simple fallback, prompts in English', () => {
  assert.equal(CAMERA_MOVES.length, 20);
  for (const legacy of ['고정', '천천히 다가가기', '천천히 멀어지기', '왼쪽으로 패닝', '오른쪽으로 패닝', '위로 틸트', '핸드헬드', '따라가기']) assert.ok(CAMERA_MOVES.includes(legacy), '예전 값 유지: ' + legacy);
  for (const m of DIRECTION.moves.filter((x) => x.complex)) {
    assert.ok(CAMERA_MOVES.includes(m.fallback), m.id);
    assert.ok(!DIRECTION.moves.find((x) => x.id === m.fallback).complex, '대체 움직임은 쉬운 움직임');
  }
  for (const p of DIRECTION.presets) {
    assert.ok(CAMERA_MOVES.includes(p.move), p.name);
    assert.ok(!p.angle || DIRECTION.angles.some((a) => a.id === p.angle), p.name);
    assert.ok(!p.lens || DIRECTION.lenses.some((a) => a.id === p.lens), p.name);
  }
  const shot = { camera: '클로즈업', angle: '올려다봄', lens: '배경 흐림', camera_move: '인물 주위 돌기', move_strength: '강하게' };
  assert.equal(framingText(shot), 'close-up, low angle looking up, shallow depth of field, soft bokeh background');
  assert.match(motionText(shot), /dramatic and fast orbiting camera/);
  assert.match(motionText(shot, { basic: true }), /pan right/);
  // 카메라 제어가 약한 모델에는 쉬운 움직임 프롬프트로
  const input = { prompt: 'full', promptBasic: 'basic' };
  assert.equal(promptFor({ label: 'Wan 2.2 (fal)', model_id: 'fal-ai/wan/v2.2', kind: 'fal' }, input).prompt, 'basic');
  assert.equal(promptFor({ label: 'Hailuo 02', model_id: 'MiniMax-Hailuo-02', kind: 'minimax' }, input).prompt, 'basic');
  assert.equal(promptFor({ label: 'Kling 2.5 Turbo (fal)', model_id: 'fal-ai/kling-video', kind: 'fal' }, input).prompt, 'full');
  assert.equal(promptFor({ label: 'Veo 3.1', model_id: 'veo-3.1', kind: 'gemini' }, input).prompt, 'full');
  assert.equal(promptFor({ label: 'Wan', kind: 'fal' }, { prompt: 'only' }).prompt, 'only');
});

test('AI fills angle/lens when scripting; shot direction is validated and saved; bulk preset', async () => {
  let d = await detail();
  const shots = shotsOf(d);
  assert.ok(shots.some((s) => s.angle === '올려다봄'), 'AI가 앵글을 채움');
  assert.ok(shots.some((s) => s.lens === '넓게'), 'AI가 화면 느낌을 채움');
  const s = shots[0];
  assert.equal((await patchShot(s, { angle: '엉뚱한 앵글' })).status, 400);
  assert.equal((await patchShot(s, { lens: '없는 렌즈' })).status, 400);
  assert.equal((await patchShot(s, { move_strength: '아주 세게' })).status, 400);
  assert.equal((await patchShot(s, { effect: 'explode' })).status, 400);
  ok(await patchShot(s, { camera: '클로즈업', camera_move: '인물 주위 돌기', angle: '어깨 너머', lens: '망원 압축', move_strength: '약하게', effect: 'flashback' }));
  d = await detail();
  const saved = shotsOf(d)[0];
  assert.equal(saved.angle, '어깨 너머');
  assert.equal(saved.lens, '망원 압축');
  assert.equal(saved.move_strength, '약하게');
  assert.equal(saved.effect, 'flashback');
  // 여러 컷에 연출 세트 한 번에(고백 장면)
  const ids = shotsOf(d).slice(1, 3).map((x) => x.id);
  const b = ok(await request(`/studio/ai/projects/${pid}/episodes/${d.episodes[0].id}/shots/bulk`, { method: 'PATCH', cookie: pd, body: { ids, camera: '클로즈업', camera_move: '천천히 다가가기', angle: '눈높이', lens: '배경 흐림', move_strength: '약하게', effect: 'dream' } }));
  assert.equal(b.data.changed, 2);
  d = await detail();
  for (const x of shotsOf(d).slice(1, 3)) {
    assert.equal(x.lens, '배경 흐림');
    assert.equal(x.effect, 'dream');
  }
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${d.episodes[0].id}/shots/bulk`, { method: 'PATCH', cookie: pd, body: { ids, angle: '??' } })).status, 400);
});

test('image prompt carries framing; video prompt carries motion, prefers camera-strong models and gets a basic fallback', async () => {
  const d = await detail();
  const s = shotsOf(d)[0];
  ok(await run({ action: 'shot_image', targetId: s.id, requested: 'mock-image' }));
  await waitIdle();
  const img = JSON.parse((await lastJob('shot_image', s.id)).input);
  assert.match(img.prompt, /Framing: close-up, over-the-shoulder angle, telephoto lens/);
  ok(await run({ action: 'shot_video', targetId: s.id }));
  const vj = await lastJob('shot_video', s.id);
  const vin = JSON.parse(vj.input);
  assert.equal(vin.needCamera, true);
  assert.match(vin.prompt, /subtle and gentle orbiting camera/);
  assert.match(vin.promptBasic, /pan right/);
  await waitIdle();
  // 예상 라마 설명: 카메라 움직임을 잘 따르는 모델이라는 이유
  const est = ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_video', targetId: s.id } }));
  assert.ok(est.data.why.some((w) => w.why.includes('복잡한 카메라 움직임을 잘 따라 해요')), JSON.stringify(est.data.why));
});

test('start/end frames: continue from previous shot (free), chosen end image, owned media only', async () => {
  let d = await detail();
  const [a, b] = shotsOf(d);
  // 앞 컷 영상이 없으면 이어받을 수 없음
  const first = await request(`/studio/ai/shots/${a.id}/continue`, { method: 'POST', cookie: pd });
  assert.equal(first.status, 400, '첫 컷은 앞 컷이 없음');
  const lamaBefore = (await detail()).wallet;
  ok(await request(`/studio/ai/shots/${b.id}/continue`, { method: 'POST', cookie: pd })); // a는 앞 테스트에서 영상이 있음
  d = await detail();
  const b2 = shotsOf(d)[1];
  assert.ok(b2.image && b2.image !== b.image, '시작 이미지가 앞 컷 마지막 장면으로');
  assert.deepEqual(d.wallet, lamaBefore, '라마가 들지 않음');
  assert.ok(d.assets.some((x) => x.target_id === b.id && x.kind === 'image' && x.url === b2.image && /앞 컷\(1번\) 마지막 장면/.test(x.model_label)));
  const meta = await probeMedia(path.join(dataDir, 'uploads', path.basename(b2.image)));
  assert.ok(meta.width > 0);
  // 끝 장면: 이 프로젝트 이미지만
  const other = await login('admin');
  assert.equal((await patchShot(b2, { end_image: '/uploads/00000000-0000-0000-0000-000000000000.jpg' })).status, 403);
  // 같은 주인의 다른 프로젝트 이미지도 끝 장면으로는 못 씀
  const p2 = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '다른 작품', logline: '다른 프로젝트의 이미지는 섞이지 않는다', genre: '로맨스', episode_count: 1, episode_seconds: 30 } })).data.id;
  ok(await run({ action: 'plan', requested: 'mock-writer' }, pd, p2));
  await waitIdle(p2);
  const c2 = (await detail(p2)).characters[0];
  ok(await run({ action: 'character_image', targetId: c2.id, requested: 'mock-image' }, pd, p2));
  await waitIdle(p2);
  const foreign = (await detail(p2)).characters[0].image;
  assert.ok(foreign);
  assert.equal((await patchShot(b2, { end_image: foreign })).status, 403);
  ok(await patchShot(b2, { end_image: a.image || shotsOf(d)[0].image }));
  ok(await run({ action: 'shot_video', targetId: b2.id }));
  const vin = JSON.parse((await lastJob('shot_video', b2.id)).input);
  assert.equal(vin.endImage.path, shotsOf(d)[0].image, '고른 끝 장면이 영상 작업에 들어감');
  const est = ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image', targetId: b2.id } }));
  assert.ok(est.data.lama > 0);
  await waitIdle();
  assert.ok(other);
  // 끝 장면 이미지는 저장 공간 정리 대상이 아님(참조 자리 26곳)
  const st = await request('/admin/storage', { cookie: admin });
  assert.equal(st.data.checked_places, 30);
});

test('character card: pose refs picked per shot; face match from AI verify; quality flags low match', async () => {
  let d = await detail();
  const c = d.characters[0];
  ok(await run({ action: 'character_image', targetId: c.id, requested: 'mock-image' }));
  await waitIdle();
  ok(await run({ action: 'character_sheet', targetId: c.id, requested: 'mock-image', options: { poses: ['front', 'full', 'smile'] } }));
  d = await waitIdle();
  const refs = JSON.parse(d.characters[0].refs);
  const full = refs.find((r) => r.pose === 'full').url;
  const smile = refs.find((r) => r.pose === 'smile').url;
  const s = shotsOf(d)[2];
  ok(await patchShot(s, { cast_ids: [c.id], speaker_id: null, dialogue: '', camera: '풀샷', emotion: '담담' }));
  ok(await run({ action: 'shot_image', targetId: s.id, requested: 'mock-image' }));
  let input = JSON.parse((await lastJob('shot_image', s.id)).input);
  assert.ok(input.refImages.some((r) => r.path === full), '전신 샷에는 전신 참고');
  await waitIdle();
  ok(await patchShot(s, { cast_ids: [c.id], speaker_id: null, dialogue: '', camera: '클로즈업', emotion: '기쁨', visual: 'MOCK_FACE 웃는 얼굴 클로즈업' }));
  ok(await run({ action: 'shot_image', targetId: s.id, requested: 'mock-image' }));
  input = JSON.parse((await lastJob('shot_image', s.id)).input);
  assert.ok(input.refImages.some((r) => r.path === smile), '기쁜 클로즈업에는 웃는 표정 참고');
  await waitIdle();
  ok(await run({ action: 'verify_shot', targetId: s.id }));
  d = await waitIdle();
  const v = JSON.parse(shotsOf(d)[2].verify);
  assert.equal(v.ok, true);
  assert.equal(v.faces[0].name, c.name);
  assert.equal(v.faces[0].match, 45);
  const q = ok(await request(`/studio/ai/projects/${pid}/check`, { cookie: pd }));
  assert.ok(q.data.issues.some((i) => i.code === 'face_mismatch' && i.shotId === s.id), JSON.stringify(q.data.issues.map((i) => i.code)));
});

test('retouch: brush mask upload, inpaint model only for masked edits, expression edit', async () => {
  let d = await detail();
  const s = shotsOf(d)[0];
  const work = path.join(tmpdir(), 'higgs-' + runId);
  await mkdir(work, { recursive: true });
  const maskFile = path.join(work, 'mask.png');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=720x1280', '-vf', 'drawbox=x=200:y=300:w=200:h=200:color=white:t=fill', '-frames:v', '1', '-y', maskFile]);
  const form = new FormData();
  form.append('file', new Blob([await readFile(maskFile)], { type: 'image/png' }), 'mask.png');
  const up = ok(await request(`/studio/ai/shots/${s.id}/mask`, { method: 'POST', cookie: pd, form }));
  assert.match(up.data.url, new RegExp(`^/masks/${s.id}\\.[a-f0-9-]+\\.png$`), '마스크는 비공개 폴더 · 이 컷에 묶임');
  assert.equal((await fetch(base + up.data.url)).status === 200 && (await fetch(base + up.data.url)).headers.get('content-type')?.startsWith('image/'), false, '주소로 열리지 않음');
  // 마스크는 포스터·끝 장면 같은 다른 자리에 쓸 수 없음
  assert.equal((await patchShot(s, { end_image: up.data.url })).status, 400);
  // 비율이 다른 마스크는 거절
  const wide = path.join(work, 'wide.png');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=1280x720', '-frames:v', '1', '-y', wide]);
  const wform = new FormData();
  wform.append('file', new Blob([await readFile(wide)], { type: 'image/png' }), 'mask.png');
  assert.equal((await request(`/studio/ai/shots/${s.id}/mask`, { method: 'POST', cookie: pd, form: wform })).status, 400);
  // PNG가 아니면 거절
  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('not a png')], { type: 'image/png' }), 'mask.png');
  assert.equal((await request(`/studio/ai/shots/${s.id}/mask`, { method: 'POST', cookie: pd, form: bad })).status, 400);
  // 다른 PD는 이 컷에 마스크를 올릴 수 없음
  const other = await request('/auth/register', { method: 'POST', body: { email: `h-${runId}@higgs.test`, password: 'HiggsTest!2026', name: '다른 PD' } });
  assert.ok(other.status < 300);
  const oform = new FormData();
  oform.append('file', new Blob([await readFile(maskFile)], { type: 'image/png' }), 'mask.png');
  assert.ok([403, 404].includes((await request(`/studio/ai/shots/${s.id}/mask`, { method: 'POST', cookie: other.cookie, form: oform })).status));
  // 칠한 부분만 고치기 → 인페인팅 모델이 먼저
  const est = ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image_edit', targetId: s.id, instruction: '손을 자연스럽게', options: { mask: up.data.url } } }));
  assert.ok(est.data.why.some((w) => w.id === 'mock-inpaint' && w.rank === 1), JSON.stringify(est.data.why));
  ok(await run({ action: 'shot_image_edit', targetId: s.id, instruction: '손을 자연스럽게', options: { mask: up.data.url } }));
  const job = await lastJob('shot_image_edit', s.id);
  assert.equal(job.model_ref, 'mock-inpaint');
  assert.equal(JSON.parse(job.input).maskImage.path, up.data.url);
  await waitIdle();
  // 마스크 없는 수정·일반 이미지는 인페인팅 모델을 쓰지 않음
  ok(await run({ action: 'shot_image_edit', targetId: s.id, instruction: '표정만 옅은 미소로 바꿔 줘' }));
  assert.notEqual((await lastJob('shot_image_edit', s.id)).model_ref, 'mock-inpaint');
  await waitIdle();
  const used = await testDb.all("SELECT COUNT(*) AS n FROM ai_jobs WHERE kind='shot_image' AND model_ref='mock-inpaint'");
  assert.equal(Number(used[0].n), 0);
  // 다른 컷의 마스크는 못 씀(컷에 묶임)
  const s2 = shotsOf(d)[1];
  assert.equal((await run({ action: 'shot_image_edit', targetId: s2.id, instruction: '고쳐', options: { mask: up.data.url } })).status, 400);
  // 없는(만료된) 마스크·공개 업로드 주소는 못 씀
  assert.equal((await run({ action: 'shot_image_edit', targetId: s.id, instruction: '고쳐', options: { mask: '/masks/00000000-0000-0000-0000-000000000000.png' } })).status, 400);
  assert.equal((await run({ action: 'shot_image_edit', targetId: s.id, instruction: '고쳐', options: { mask: s.image } })).status, 400);
  d = await detail();
  assert.ok(d.assets.filter((a) => a.target_id === s.id && a.kind === 'image').length >= 3, '고친 이미지는 버전 기록에');
  await rm(work, { recursive: true, force: true });
});

test('upscale image and video: price-gated capability, applied once, batch skips done shots, quality hint', async () => {
  let d = await detail();
  const s = shotsOf(d)[0];
  const admin2 = await request('/admin/ai', { cookie: admin });
  assert.ok(admin2.data.capabilities.upscale && admin2.data.capabilities.upscale_video);
  assert.equal((await request('/admin/ai/models/mock-upscale/try', { method: 'POST', cookie: admin, body: { prompt: 'test' } })).status, 400);
  const before = s.image;
  ok(await run({ action: 'shot_upscale', targetId: s.id }));
  d = await waitIdle();
  const s2 = shotsOf(d)[0];
  assert.notEqual(s2.image, before);
  assert.equal(JSON.parse(s2.upscaled).image, s2.image);
  const meta = await probeMedia(path.join(dataDir, 'uploads', path.basename(s2.image)));
  assert.equal(meta.width, 1080);
  assert.equal((await run({ action: 'shot_upscale', targetId: s.id })).status, 400, '이미 올린 이미지');
  // 영상: 컷 1은 영상이 있음(앞 테스트) → 올리기
  const q1 = ok(await request(`/studio/ai/projects/${pid}/check`, { cookie: pd }));
  assert.ok(q1.data.issues.some((i) => i.code === 'not_upscaled'));
  const clip = s2.lipsync || s2.video;
  assert.ok(clip);
  ok(await run({ action: 'shot_upscale_video', targetId: s.id }));
  d = await waitIdle();
  const s3 = shotsOf(d)[0];
  const now = s3.lipsync || s3.video;
  assert.notEqual(now, clip);
  assert.equal(JSON.parse(s3.upscaled).video, now);
  const vm = await probeMedia(path.join(dataDir, 'uploads', path.basename(now)));
  assert.equal(vm.width, 1080);
  // 회차 일괄: 이미 올린 컷은 빼고
  const r = await run({ action: 'batch_shot_upscale_video', targetId: d.episodes[0].id });
  const withClip = shotsOf(d).filter((x) => (x.lipsync || x.video) && x.id !== s.id).length;
  if (withClip) assert.equal(r.data.jobs.length, withClip);
  else assert.equal(r.status, 400);
  await waitIdle();
  // 가격을 정하지 않은(0) 화질 올리기 모델은 준비 중
  await testDb.run("UPDATE ai_models SET price_lama=0 WHERE id IN ('mock-upscale','mock-upscale-video')");
  const next = shotsOf(await detail())[1];
  assert.equal((await run({ action: 'shot_upscale', targetId: next.id })).status, 503);
  await testDb.run("UPDATE ai_models SET price_lama=2 WHERE id='mock-upscale'");
  await testDb.run("UPDATE ai_models SET price_lama=1 WHERE id='mock-upscale-video'");
});

test('candidates: several images in one batch, AI check marks the best, picking carries the check; video max 2', async () => {
  let d = await detail();
  const s = shotsOf(d)[3];
  const one = ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image', targetId: s.id, requested: 'mock-image' } }));
  const three = ok(await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image', targetId: s.id, requested: 'mock-image', options: { count: 3 } } }));
  assert.equal(three.data.lama, one.data.lama * 3);
  assert.equal(three.data.jobs, 3);
  const r = ok(await run({ action: 'shot_image', targetId: s.id, requested: 'mock-image', options: { count: 3 } }));
  assert.equal(r.data.jobs.length, 3);
  d = await waitIdle();
  const batch = d.assets.filter((a) => a.target_id === s.id && a.batch);
  assert.equal(batch.length, 3);
  assert.equal(new Set(batch.map((a) => a.batch)).size, 1);
  const seeds = (await testDb.all("SELECT input FROM ai_jobs WHERE kind='shot_image' AND target_id=? ORDER BY created_at DESC LIMIT 3", [s.id])).map((x) => JSON.parse(x.input).seed);
  assert.equal(new Set(seeds).size, 3, '후보마다 다른 시드');
  assert.ok(shotsOf(d)[3].image, '컷에는 먼저 끝난 후보가 들어감');
  ok(await run({ action: 'verify_candidates', targetId: s.id }));
  d = await waitIdle();
  const checked = d.assets.filter((a) => a.target_id === s.id && a.batch);
  assert.ok(checked.every((a) => a.verify && JSON.parse(a.verify).score > 0));
  assert.equal((await run({ action: 'verify_candidates', targetId: s.id })).status, 400, '검수할 후보가 남지 않음');
  const pick = checked.find((a) => a.url !== shotsOf(d)[3].image) || checked[0];
  ok(await request(`/studio/ai/assets/${pick.id}/use`, { method: 'POST', cookie: pd }));
  d = await detail();
  const cur = shotsOf(d)[3];
  assert.equal(cur.image, pick.url);
  assert.equal(JSON.parse(cur.verify).image, pick.url, '후보 검수 결과를 이어 씀');
  // 영상 후보는 2개까지
  assert.equal((await run({ action: 'shot_video', targetId: s.id, options: { count: 3 } })).status, 400);
  const v = ok(await run({ action: 'shot_video', targetId: s.id, options: { count: 2 } }));
  assert.equal(v.data.jobs.length, 2);
  d = await waitIdle();
  assert.equal(d.assets.filter((a) => a.target_id === s.id && a.kind === 'video' && a.batch).length, 2);
});

test('compose: every camera move and effect renders on stills and clips', async () => {
  const work = path.join(tmpdir(), 'higgs-compose-' + runId);
  await mkdir(work, { recursive: true });
  await copyFile(path.resolve('public/images/hero.webp'), path.join(work, 'still.webp'));
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', '-y', path.join(work, 'clip.mp4')]);
  const shots = [
    ...CAMERA_MOVES.map((m, i) => ({ id: 'm' + i, image: '/uploads/still.webp', camera_move: m, move_strength: ['약하게', '', '강하게'][i % 3], seconds: 1, dialogue: '', transition: 'cut' })),
    ...['flashback', 'dream', 'tension', 'mono', 'shock_zoom', 'heartbeat', 'shake'].map((fx, i) => ({ id: 'f' + i, image: '/uploads/still.webp', video: i % 2 ? '/uploads/clip.mp4' : '', effect: fx, camera_move: '고정', seconds: 1, dialogue: '', transition: 'cut' })),
  ];
  const out = await composeEpisode({ shots, uploadDir: work, nameOf: () => '' });
  assert.ok(out.duration >= shots.length - 1, String(out.duration));
  assert.equal(out.width, 720);
  for (const m of CAMERA_MOVES) assert.match(stillMotion(m, 720, 1280, 30, 1.8), /^zoompan=/);
  assert.equal(effectFilter('', 720, 1280), '');
  await rm(work, { recursive: true, force: true });
});

test('assistant: edit_direction applies a preset to shots and can be undone', async () => {
  let d = await detail();
  const before = shotsOf(d)[1];
  const msg = ok(await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '2번 컷 연출을 반전 공개로 바꿔 줘', episodeId: d.episodes[0].id } }));
  assert.ok(msg.data);
  let chat;
  for (let i = 0; i < 100; i++) {
    chat = (await request(`/studio/ai/projects/${pid}/assistant`, { cookie: pd })).data;
    if (chat.at(-1)?.status !== 'thinking') break;
    await sleep(200);
  }
  const plan = chat.at(-1);
  const act = plan.plan.find((a) => a.type === 'edit_direction');
  assert.ok(act?.ok, JSON.stringify(plan.plan));
  assert.equal(act.fields.camera_move, '빠르게 다가가기');
  ok(await request(`/studio/ai/projects/${pid}/assistant/${plan.id}/apply`, { method: 'POST', cookie: pd, body: {} }));
  d = await detail();
  assert.equal(shotsOf(d)[1].camera_move, '빠르게 다가가기');
  assert.equal(shotsOf(d)[1].move_strength, '강하게');
  ok(await request(`/studio/ai/projects/${pid}/assistant/${plan.id}/undo`, { method: 'POST', cookie: pd }));
  d = await detail();
  assert.equal(shotsOf(d)[1].camera_move, before.camera_move);
  assert.equal(shotsOf(d)[1].move_strength, before.move_strength);
});

test('script versions keep direction, end image and effect when restored', async () => {
  let d = await detail();
  const e = d.episodes[0];
  const s = shotsOf(d)[0];
  ok(await patchShot(s, { angle: '머리 위', lens: '넓게', move_strength: '강하게', effect: 'mono' }));
  ok(await run({ action: 'rewrite_range', requested: 'mock-writer', targetId: e.id, instruction: '대사를 짧게', options: { shotIds: [s.id] } }));
  await waitIdle();
  const versions = ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions`, { cookie: pd })).data;
  const v = versions.find((x) => x.source === 'before_ai');
  assert.ok(v);
  ok(await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions/${v.id}/restore`, { method: 'POST', cookie: pd }));
  d = await detail();
  const r = shotsOf(d)[0];
  assert.equal(r.angle, '머리 위');
  assert.equal(r.lens, '넓게');
  assert.equal(r.move_strength, '강하게');
  assert.equal(r.effect, 'mono');
});
