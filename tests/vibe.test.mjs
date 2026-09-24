// AI 드라마 제작 고도화(2026-09-24) 통합 테스트:
// 모델 센터(계열 안내·왜 이 모델) · 프로젝트 예산 · 실패 작업 다시 시도 · AI 조수(계획→승인→실행→되돌리기, 무료)
// · 내 소재 올리기(사진·영상·녹음, 관리자 제한) · 컷 순서·일괄 작업 · 공개 전 점검 · 관리자 능력표·정책
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { prepareTestDb } from './_db.mjs';

const port = 5253,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId),
  tmp = path.join(dataDir, 'fixtures');
let child,
  output = '',
  testDb,
  admin,
  pd,
  pid,
  ep1;
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
const detail = async () => (await request('/studio/ai/projects/' + pid, { cookie: pd })).data;
async function waitIdle(timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const d = await detail();
    if (!d.jobs.some((j) => ['queued', 'running'].includes(j.status)) && !(d.chat || []).some((m) => m.status === 'thinking')) return d;
    await sleep(200);
  }
  throw new Error('작업이 끝나지 않았어요\n' + output.slice(-2000));
}
const run = (body) => request(`/studio/ai/projects/${pid}/run`, { method: 'POST', cookie: pd, body: { requested: 'auto', tier: 'standard', ...body } });
const upload = (shotId, kind, file, mime, name, source = 'upload') => {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(file)], { type: mime }), name);
  return request(`/studio/ai/shots/${shotId}/media?kind=${kind}&source=${source}`, { method: 'POST', cookie: pd, form });
};
const settings = (body) => request('/admin/settings', { method: 'PUT', cookie: admin, body });

before(async () => {
  testDb = await prepareTestDb(runId, dataDir);
  mkdirSync(tmp, { recursive: true });
  // 시험용 파일: 사진(PNG) · 4초 영상(MOV 대신 MP4) · 2초 녹음(WEBM/Opus) · 8초 영상(길이 제한 확인용)
  const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=360x640', '-frames:v', '1', path.join(tmp, 'pic.png')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=360x640:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(tmp, 'clip.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=320x240:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(tmp, 'long.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:d=2', '-c:a', 'libopus', path.join(tmp, 'voice.webm')]);
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
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'grant', lama: 20000, memo: '고도화 테스트' } });
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '바이브 제작', logline: '비밀을 숨긴 두 사람이 한 집에 살게 된다', genre: '로맨스', tone: '설렘', episode_count: 1, episode_seconds: 20 } });
  pid = created.data.id;
  assert.equal((await run({ action: 'plan' })).status, 201);
  let d = await waitIdle();
  ep1 = d.episodes[0].id;
  assert.equal((await run({ action: 'script', targetId: ep1 })).status, 201);
  d = await waitIdle();
  assert.ok(d.episodes[0].shots.length >= 3, 'script made shots');
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('model center: families, per-model family/stats, auto explanation, and estimate reasons', async () => {
  const ov = (await request('/studio/ai/overview', { cookie: pd })).data;
  const claude = ov.families.find((f) => f.id === 'claude');
  assert.deepEqual(claude.caps, ['text']);
  assert.ok(ov.families.find((f) => f.id === 'gemini').caps.includes('video'));
  assert.ok(ov.models.every((m) => m.family === 'mock'));
  assert.equal(ov.features.upload.enabled, true);
  assert.equal(ov.features.assistant, true);
  const ex = await request('/studio/ai/models/explain', { method: 'POST', cookie: pd, body: { items: [{ capability: 'image', tier: 'premium' }, { capability: 'video', tier: 'draft' }], projectId: pid } });
  assert.equal(ex.status, 200);
  assert.equal(ex.data.image[0].label, '가짜 이미지 HQ (개발용)'); // 고급 등급이면 고급 모델
  assert.ok(ex.data.image[0].why.length >= 1);
  assert.equal(ex.data.video[0].label, '가짜 영상 빠름 (개발용)');
  const shot = (await detail()).episodes[0].shots[0];
  const est = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image', targetId: shot.id, requested: 'auto', tier: 'draft' } });
  assert.equal(est.status, 200);
  assert.equal(est.data.capability, 'image');
  assert.ok(est.data.why.length >= 2, 'alternatives listed');
  assert.ok(est.data.lama >= 1);
  assert.equal(est.data.budget.limit, 0);
  // 다른 PD의 프로젝트로는 설명을 볼 수 없다
  const other = await login('viewer');
  assert.equal((await request('/studio/ai/models/explain', { method: 'POST', cookie: other, body: { items: [] } })).status, 403);
});

test('project budget asks before going over, and retry picks another model', async () => {
  const shots = (await detail()).episodes[0].shots;
  assert.equal((await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { budget_lama: 1 } })).status, 200);
  const over = await run({ action: 'shot_image', targetId: shots[0].id });
  assert.equal(over.status, 409);
  assert.equal(over.data.code, 'project_budget');
  const est = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'shot_image', targetId: shots[0].id } });
  assert.equal(est.data.budget.over, true);
  assert.equal((await run({ action: 'shot_image', targetId: shots[0].id, budgetOk: true })).status, 201);
  await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { budget_lama: 0 } });
  await waitIdle();
  // 일부러 실패하는 컷(가짜 AI는 프롬프트에 MOCK_FAIL이 있으면 실패) → 다른 모델로 자동 재시도
  await testDb.run('UPDATE studio_shots SET visual=?, visual_en=?, visual_en_src=? WHERE id=?', ['MOCK_FAIL 장면', 'MOCK_FAIL scene', 'MOCK_FAIL 장면', shots[1].id]);
  assert.equal((await run({ action: 'shot_image', targetId: shots[1].id, tier: 'draft' })).status, 201);
  let d = await waitIdle();
  const failed = d.jobs.find((j) => j.kind === 'shot_image' && j.target_id === shots[1].id && j.status === 'failed');
  assert.ok(failed, 'failed job present');
  assert.ok(failed.model_ref);
  // 성공한 작업은 다시 시도할 수 없다
  const okJob = d.jobs.find((j) => j.status === 'succeeded' && j.kind === 'shot_image');
  assert.equal((await request(`/studio/ai/jobs/${okJob.id}/retry`, { method: 'POST', cookie: pd, body: {} })).status, 400);
  await testDb.run('UPDATE studio_shots SET visual=?, visual_en=?, visual_en_src=? WHERE id=?', ['비 오는 밤거리', 'rainy street at night', '비 오는 밤거리', shots[1].id]);
  const retry = await request(`/studio/ai/jobs/${failed.id}/retry`, { method: 'POST', cookie: pd, body: { requested: 'auto' } });
  assert.equal(retry.status, 201, JSON.stringify(retry.data));
  const [row] = await testDb.all('SELECT model_ref FROM ai_jobs WHERE id=?', [retry.data.jobs[0].id]);
  assert.notEqual(row.model_ref, failed.model_ref, 'auto retry skips the failed model');
  d = await waitIdle();
  assert.ok(d.episodes[0].shots.find((s) => s.id === shots[1].id).image, 'retry produced an image');
  // 다른 사람의 작업은 다시 시도할 수 없다
  const stranger = await login('viewer');
  assert.equal((await request(`/studio/ai/jobs/${failed.id}/retry`, { method: 'POST', cookie: stranger, body: {} })).status, 403);
});

test('AI assistant: free plan → approve → run → undo; bad targets are dropped; daily limit', async () => {
  const before = (await request('/lama', { cookie: pd })).data.wallet.total;
  const d0 = await detail();
  const shots = d0.episodes[0].shots;
  const msg = await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '2번 컷 대사를 "지금 말해. 다 알고 있어."로 바꾸고 배경을 밤으로 고쳐 줘', episodeId: ep1, focus: shots[0].id } });
  assert.equal(msg.status, 201, JSON.stringify(msg.data));
  // 답을 만드는 중에는 새 말을 받지 않는다
  const busy = await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '하나 더' } });
  assert.ok([409, 201].includes(busy.status));
  let d = await waitIdle();
  const bot = d.chat.find((m) => m.id === msg.data.id);
  assert.equal(bot.status, 'ready', JSON.stringify(bot));
  const edit = bot.plan.find((a) => a.type === 'edit_shot');
  const img = bot.plan.find((a) => a.type === 'shot_image_edit');
  assert.ok(edit && edit.ok && edit.fields.dialogue === '지금 말해. 다 알고 있어.');
  assert.ok(img && img.ok && img.lama >= 1, JSON.stringify(bot.plan));
  // 대화는 무료
  assert.equal((await request('/lama', { cookie: pd })).data.wallet.total, before);
  const [chatJob] = await testDb.all("SELECT billed, estimate_lama FROM ai_jobs WHERE kind='assistant' ORDER BY created_at DESC LIMIT 1");
  assert.equal(Number(chatJob.billed), 0);
  const oldLine = shots[1].dialogue;
  const oldImage = d.episodes[0].shots[1].image;
  const applied = await request(`/studio/ai/projects/${pid}/assistant/${bot.id}/apply`, { method: 'POST', cookie: pd, body: {} });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.ok(applied.data.results.every((r) => r.ok || r.skipped));
  // 두 번 실행되지 않는다
  assert.equal((await request(`/studio/ai/projects/${pid}/assistant/${bot.id}/apply`, { method: 'POST', cookie: pd, body: {} })).status, 409);
  d = await waitIdle();
  const s1 = d.episodes[0].shots[1];
  assert.equal(s1.dialogue, '지금 말해. 다 알고 있어.');
  assert.notEqual(s1.image, oldImage, 'image edited by AI');
  assert.ok((await request('/lama', { cookie: pd })).data.wallet.total < before, 'AI work inside the plan is billed');
  // 되돌리기: 대사와 이미지가 원래대로(새 이미지는 버전 기록에 남음)
  assert.equal((await request(`/studio/ai/projects/${pid}/assistant/${bot.id}/undo`, { method: 'POST', cookie: pd })).status, 200);
  d = await detail();
  assert.equal(d.episodes[0].shots[1].dialogue, oldLine);
  assert.equal(d.episodes[0].shots[1].image, oldImage);
  assert.ok(d.assets.some((a) => a.target_id === s1.id && a.url === s1.image), 'new result kept as a version');
  assert.equal(d.chat.find((m) => m.id === bot.id).status, 'undone');
  // 없는 컷을 가리키면 그 작업은 빠진다(실행 버튼은 남은 작업만)
  const bad = await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '엉뚱 없는컷 고쳐 줘', episodeId: ep1 } });
  assert.equal(bad.status, 201);
  d = await waitIdle();
  const badBot = d.chat.find((m) => m.id === bad.data.id);
  assert.ok(badBot.plan.some((a) => !a.ok && a.note));
  // 계획 없는 질문은 답만
  const q = await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '이 작품 어때?', episodeId: ep1 } });
  d = await waitIdle();
  assert.equal(d.chat.find((m) => m.id === q.data.id).status, 'done');
  // 금칙어는 대화 전에 막는다
  const [{ n: before2 }] = await testDb.all("SELECT COUNT(*) AS n FROM studio_chat WHERE project_id=?", [pid]);
  await settings({ ai_blocked_terms: '금지어테스트' });
  assert.equal((await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '금지어테스트 넣어 줘' } })).status, 400);
  const [{ n: after2 }] = await testDb.all("SELECT COUNT(*) AS n FROM studio_chat WHERE project_id=?", [pid]);
  assert.equal(Number(after2), Number(before2));
  // 하루 대화 한도 · 끄기
  await settings({ ai_assistant_daily_limit: 1, ai_blocked_terms: '' });
  assert.equal((await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '한도 확인' } })).status, 429);
  await settings({ ai_assistant_daily_limit: 100, ai_assistant_enabled: 0 });
  assert.equal((await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '꺼짐 확인' } })).status, 403);
  await settings({ ai_assistant_enabled: 1 });
  // 다른 사람은 대화를 볼 수 없다
  const viewer = await login('viewer');
  assert.equal((await request(`/studio/ai/projects/${pid}/assistant`, { cookie: viewer })).status, 403);
  assert.equal((await request(`/studio/ai/projects/${pid}/assistant`, { method: 'DELETE', cookie: pd })).status, 200);
  assert.equal((await detail()).chat.length, 0);
});

test('my own media: photo, video (converted to MP4), recorded voice; admin limits and switch', async () => {
  const shots = (await detail()).episodes[0].shots;
  const pic = await upload(shots[0].id, 'image', path.join(tmp, 'pic.png'), 'image/png', 'pic.png');
  assert.equal(pic.status, 201, JSON.stringify(pic.data));
  const vid = await upload(shots[1].id, 'video', path.join(tmp, 'clip.mp4'), 'video/mp4', 'clip.mp4');
  assert.equal(vid.status, 201, JSON.stringify(vid.data));
  assert.equal(vid.data.seconds, 4);
  const rec = await upload(shots[2].id, 'audio', path.join(tmp, 'voice.webm'), 'audio/webm', 'voice.webm', 'record');
  assert.equal(rec.status, 201, JSON.stringify(rec.data));
  assert.match(rec.data.url, /\.mp3$/);
  let d = await detail();
  const [a, b, c] = d.episodes[0].shots;
  assert.equal(a.image, pic.data.url);
  assert.equal(b.video, vid.data.url);
  assert.equal(Number(b.seconds), 4);
  assert.equal(c.audio, rec.data.url);
  assert.ok(Number(c.audio_seconds) >= 1.5);
  assert.ok(d.assets.some((x) => x.url === rec.data.url && x.model_label === '직접 녹음'));
  // 가짜 확장자(내용은 PNG가 아님) · 형식 불일치
  assert.equal((await upload(shots[0].id, 'image', path.join(tmp, 'voice.webm'), 'image/png', 'x.png')).status, 400);
  // 관리자 제한: 영상 길이 · 사진 크기 · 끄기
  await settings({ studio_upload_video_seconds: 5 });
  const long = await upload(shots[1].id, 'video', path.join(tmp, 'long.mp4'), 'video/mp4', 'long.mp4');
  assert.equal(long.status, 400);
  assert.match(long.data.error, /5초/);
  await settings({ studio_upload_video_seconds: 60, studio_upload_enabled: 0 });
  assert.equal((await upload(shots[0].id, 'image', path.join(tmp, 'pic.png'), 'image/png', 'pic.png')).status, 403);
  assert.equal((await request('/studio/ai/overview', { cookie: pd })).data.features.upload.enabled, false);
  await settings({ studio_upload_enabled: 1 });
  // 다른 사람의 컷에는 올릴 수 없다
  const other = await login('viewer');
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path.join(tmp, 'pic.png'))], { type: 'image/png' }), 'p.png');
  assert.equal((await request(`/studio/ai/shots/${shots[0].id}/media?kind=image`, { method: 'POST', cookie: other, form })).status, 403);
  // 영상 빼기 → 이미지로 합성
  assert.equal((await request(`/studio/ai/shots/${shots[1].id}/media/video`, { method: 'DELETE', cookie: pd })).status, 200);
  d = await detail();
  assert.equal(d.episodes[0].shots[1].video, '');
  // 올린 파일이 남아 있어야 한다(임시 파일은 정리)
  const [{ n }] = await testDb.all('SELECT COUNT(*) AS n FROM media_files WHERE url IN (?,?,?)', [pic.data.url, vid.data.url, rec.data.url]);
  assert.equal(Number(n), 3);
});

test('storyboard: reorder, bulk edit, and regenerate only the chosen shots', async () => {
  let shots = (await detail()).episodes[0].shots;
  const ids = shots.map((s) => s.id);
  const reversed = [...ids].reverse();
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${ep1}/shots/order`, { method: 'POST', cookie: pd, body: { ids: reversed } })).status, 200);
  assert.deepEqual((await detail()).episodes[0].shots.map((s) => s.id), reversed);
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${ep1}/shots/order`, { method: 'POST', cookie: pd, body: { ids: reversed.slice(1) } })).status, 409);
  await request(`/studio/ai/projects/${pid}/episodes/${ep1}/shots/order`, { method: 'POST', cookie: pd, body: { ids } });
  // 대사 음성이 있는 컷의 감정을 바꾸면 음성이 비워진다
  shots = (await detail()).episodes[0].shots;
  const voiced = shots.find((s) => s.audio);
  const bulk = await request(`/studio/ai/projects/${pid}/episodes/${ep1}/shots/bulk`, { method: 'PATCH', cookie: pd, body: { ids: [voiced.id, shots[0].id], emotion: '속삭임', transition: 'fade' } });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.changed, 2);
  assert.equal(bulk.data.audioReset, 1);
  shots = (await detail()).episodes[0].shots;
  assert.equal(shots.find((s) => s.id === voiced.id).audio, '');
  assert.equal(shots[0].transition, 'fade');
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${ep1}/shots/bulk`, { method: 'PATCH', cookie: pd, body: { ids: [shots[0].id] } })).status, 400);
  // 고른 컷만(이미 이미지가 있어도) 다시 만들기
  const chosen = shots.filter((s) => s.image).slice(0, 2).map((s) => s.id);
  const est = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'batch_shot_image', targetId: ep1, options: { shotIds: chosen } } });
  assert.equal(est.data.jobs, chosen.length);
  assert.equal((await run({ action: 'batch_shot_image', targetId: ep1, options: { shotIds: chosen } })).status, 201);
  await waitIdle();
});

test('pre-publish quality check finds issues and fixes the free ones', async () => {
  let shots = (await detail()).episodes[0].shots;
  // 음성이 컷보다 긴 경우를 만든다
  await testDb.run('UPDATE studio_shots SET audio=?, audio_seconds=?, seconds=? WHERE id=?', [shots[2].audio || '/uploads/00000000-0000-0000-0000-000000000000.mp3', 6.4, 3, shots[2].id]);
  await testDb.run('UPDATE studio_shots SET image=?, video=? WHERE id=?', ['', '', shots[3]?.id || shots[0].id]);
  const r = await request(`/studio/ai/projects/${pid}/check`, { cookie: pd });
  assert.equal(r.status, 200);
  const codes = r.data.issues.map((i) => i.code);
  assert.ok(codes.includes('voice_long'), codes.join(','));
  assert.ok(codes.includes('no_media'));
  assert.ok(codes.includes('no_poster'));
  assert.ok(r.data.summary.error >= 1);
  const long = r.data.issues.find((i) => i.code === 'voice_long');
  assert.equal(long.fix.kind, 'edit');
  const fix = await request(`/studio/ai/projects/${pid}/check/fix`, { method: 'POST', cookie: pd, body: { code: 'extend_shot', targetId: long.shotId } });
  assert.equal(fix.data.seconds, 7);
  shots = (await detail()).episodes[0].shots;
  assert.equal(Number(shots.find((s) => s.id === long.shotId).seconds), 7);
  const again = await request(`/studio/ai/projects/${pid}/check`, { cookie: pd });
  assert.ok(!again.data.issues.some((i) => i.code === 'voice_long'));
  const viewer = await login('viewer');
  assert.equal((await request(`/studio/ai/projects/${pid}/check`, { cookie: viewer })).status, 403);
});

test('admin: capability matrix data, weights and new policy settings', async () => {
  const ai = (await request('/admin/ai', { cookie: admin })).data;
  assert.ok(ai.families.some((f) => f.id === 'claude'));
  assert.ok(ai.models.every((m) => m.family === 'mock'));
  assert.ok(ai.models.some((m) => m.stats && m.stats.jobs > 0));
  assert.equal(typeof ai.assistant.today, 'number');
  const bad = await settings({ ai_weight_speed: 101 });
  assert.equal(bad.status, 400);
  assert.equal((await settings({ ai_weight_cost: 0, ai_weight_speed: 60, ai_weight_reliability: 80 })).status, 200);
  // 가중치를 바꿔도 자동 선택은 동작
  const ex = await request('/studio/ai/models/explain', { method: 'POST', cookie: pd, body: { items: [{ capability: 'image', tier: 'standard' }] } });
  assert.ok(ex.data.image.length >= 2);
  await settings({ ai_weight_cost: 50, ai_weight_speed: 0, ai_weight_reliability: 0 });
});
