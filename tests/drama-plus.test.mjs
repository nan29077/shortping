// AI 드라마 고도화 기능(2026-09-23) 통합 검증: 개발용 가짜 AI로 설정집 → 시즌 설계 → 대본(버전·구간 다시 쓰기·진단)
// → 한국어 묘사 자동 번역 → 장소·인물 참고 이미지 → 컷 이미지·부분 수정 → 음성(감정) → 영상 → 입 모양 → 효과음 → 배경음악
// → 합성(대기열·카드·배경음악) → 예고편 → 제목·소개 AI → 썸네일 A/B → 내보내기 → 연재형 회차 검수 → 알림까지 확인합니다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { prepareTestDb } from './_db.mjs';

const port = 5233,
  base = `http://127.0.0.1:${port}`,
  runId = randomUUID(),
  dataDir = path.resolve('data/tests', runId);
let child,
  output = '',
  testDb,
  admin,
  viewer,
  seller;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, { method = 'GET', body, cookie } = {}) {
  const isForm = body instanceof FormData;
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (role) => (await request('/auth/demo', { method: 'POST', body: { role } })).cookie;
async function newPd(tag) {
  const email = `${tag}-${runId}@plus.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'PlusTest!2026', name: '고도화 ' + tag } });
  await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role: 'pd', status: 'active', name: '고도화 ' + tag, phone: '' } });
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'PlusTest!2026' } })).cookie;
  await request('/studio/ai/terms', { method: 'POST', cookie, body: { agree: true, version: '2026-09' } });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: reg.data.user.id, action: 'grant', lama: 20000, memo: '고도화 검수' } });
  return { id: reg.data.user.id, cookie };
}
const detail = async (pid) => (await request('/studio/ai/projects/' + pid, { cookie: seller.cookie })).data;
async function waitJobs(pid, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = await detail(pid);
    if (!p.jobs.some((j) => ['queued', 'running'].includes(j.status)) && !p.episodes.some((e) => e.status === 'composing') && !['queued', 'rendering'].includes(p.project.trailer_status))
      return p;
    await sleep(250);
  }
  throw new Error('작업이 끝나지 않았어요\n' + output.slice(-3000));
}
const run = (pid, action, extra = {}) =>
  request(`/studio/ai/projects/${pid}/run`, { method: 'POST', cookie: seller.cookie, body: { action, requested: 'auto', tier: 'standard', ...extra } });
const ok = (r) => {
  assert.ok([200, 201, 202].includes(r.status), JSON.stringify(r.data));
  return r;
};

before(async () => {
  testDb = await prepareTestDb(runId, dataDir);
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: testDb.url, PORT: String(port), APP_ORIGIN: base, ENABLE_DEMO: 'true', DATA_DIR: dataDir, UPLOAD_DIR: path.join(dataDir, 'uploads'), AB_MIN_IMPRESSIONS: '3' },
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
  viewer = await login('viewer');
  seller = await newPd('maker');
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

let pid;
test('scenario tools: bible, season hooks, script with versions, range rewrite, diagnosis and Korean visual translation', async () => {
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: seller.cookie, body: { title: '고도화 검수', logline: '편지 한 장으로 두 사람의 비밀이 드러난다', genre: '로맨스', episode_count: 2, episode_seconds: 20 } });
  assert.equal(created.status, 201);
  pid = created.data.id;
  ok(await run(pid, 'plan', { requested: 'mock-writer' }));
  let p = await waitJobs(pid);
  assert.ok(p.characters.length >= 2);
  // 기획안이 한국어 외모와 영어 번역을 함께 채운다
  assert.match(p.characters[0].look, /[가-힣]/);
  assert.equal(p.characters[0].look_en_src, p.characters[0].look);
  ok(await run(pid, 'bible', { requested: 'mock-writer' }));
  ok(await run(pid, 'season', { requested: 'mock-writer' }));
  p = await waitJobs(pid);
  const bible = JSON.parse(p.project.bible);
  assert.ok(bible.world && bible.speech.length >= 1);
  assert.equal(JSON.parse(p.project.season).paywall_from >= 1, true);
  assert.ok(p.episodes.every((e) => e.hook && e.cliffhanger));
  // 설정집 직접 고치기
  ok(await request(`/studio/ai/projects/${pid}/bible`, { method: 'PUT', cookie: seller.cookie, body: { ...bible, taboos: '욕설 금지' } }));
  const ep = p.episodes[0];
  ok(await run(pid, 'script', { requested: 'mock-writer', targetId: ep.id }));
  p = await waitJobs(pid);
  let shots = p.episodes[0].shots;
  assert.ok(shots.length >= 3);
  assert.ok(shots.every((s) => s.visual_en && s.visual_en_src === s.visual));
  assert.ok(shots.some((s) => s.camera_move && s.emotion));
  assert.ok(shots.some((s) => s.sfx_prompt));
  // 톤 바꿔 다시 쓰기 → 이전 대본이 버전으로 남는다
  ok(await run(pid, 'script', { requested: 'mock-writer', targetId: ep.id, instruction: '더 코믹하게' }));
  p = await waitJobs(pid);
  let versions = (await request(`/studio/ai/projects/${pid}/episodes/${ep.id}/versions`, { cookie: seller.cookie })).data;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].shots.length, shots.length);
  // 구간 다시 쓰기(2~3번 컷)
  shots = p.episodes[0].shots;
  const count = shots.length;
  ok(await run(pid, 'rewrite_range', { requested: 'mock-writer', targetId: ep.id, instruction: '대사를 짧게', options: { shotIds: [shots[1].id, shots[2].id] } }));
  p = await waitJobs(pid);
  assert.equal(p.episodes[0].shots.length, count);
  assert.match(p.episodes[0].shots[1].scene, /다시 씀/);
  assert.equal(p.episodes[0].shots[0].id, shots[0].id);
  versions = (await request(`/studio/ai/projects/${pid}/episodes/${ep.id}/versions`, { cookie: seller.cookie })).data;
  assert.equal(versions.length, 2);
  // 되돌리기: 지금 상태도 버전으로 남긴 뒤 첫 버전으로
  ok(await request(`/studio/ai/projects/${pid}/episodes/${ep.id}/versions/${versions[1].id}/restore`, { method: 'POST', cookie: seller.cookie }));
  p = await detail(pid);
  assert.equal(p.episodes[0].shots.length, versions[1].shots.length);
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${ep.id}/versions`, { cookie: seller.cookie })).data.length, 3);
  // 대본 진단
  ok(await run(pid, 'diagnose', { requested: 'mock-writer', targetId: ep.id }));
  p = await waitJobs(pid);
  const diag = JSON.parse(p.episodes[0].diagnosis);
  assert.ok(diag.scores.hook > 0 && diag.fixes.length >= 1);
  // 한국어로 고친 화면 묘사는 저장하면 자동으로 영어 묘사가 준비된다(라마 차감 없음)
  const s0 = p.episodes[0].shots[0];
  const before = (await request('/lama', { cookie: seller.cookie })).data.wallet.total;
  ok(await request('/studio/ai/shots/' + s0.id, { method: 'PATCH', cookie: seller.cookie, body: { scene: s0.scene, visual: '비 오는 창가에서 주인공이 편지를 읽는다', dialogue: s0.dialogue, speaker_id: s0.speaker_id, camera: s0.camera, seconds: s0.seconds } }));
  p = await waitJobs(pid);
  const s0b = p.episodes[0].shots.find((s) => s.id === s0.id);
  assert.match(s0b.visual_en, /^EN:/);
  assert.equal(s0b.visual_en_src, s0b.visual);
  assert.equal((await request('/lama', { cookie: seller.cookie })).data.wallet.total, before);
  // 원작 각색: 원고를 붙여 넣고 각색
  ok(await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: seller.cookie, body: { source_text: '원작 원고 '.repeat(20) } }));
  ok(await run(pid, 'adapt', { requested: 'mock-writer' }));
  await waitJobs(pid);
});

test('visual tools: locations, character reference sheet, multi-cast shots with references, image edit, voices with emotion, video, lip sync, sound effects and music', async () => {
  let p = await detail(pid);
  const loc = ok(await request(`/studio/ai/projects/${pid}/locations`, { method: 'POST', cookie: seller.cookie, body: { name: '옥상', look: '노을 지는 도심 옥상, 붉은 하늘' } })).data.id;
  ok(await run(pid, 'location_image', { targetId: loc, requested: 'mock-image' }));
  for (const c of p.characters) ok(await run(pid, 'character_image', { targetId: c.id, requested: 'mock-image' }));
  p = await waitJobs(pid);
  assert.ok(p.locations[0].image && p.locations[0].look_en);
  const hero = p.characters[0];
  ok(await run(pid, 'character_sheet', { targetId: hero.id, requested: 'mock-image', options: { poses: ['front', 'side', 'smile'] } }));
  p = await waitJobs(pid);
  const refs = JSON.parse(p.characters.find((c) => c.id === hero.id).refs);
  assert.deepEqual(refs.map((r) => r.pose).sort(), ['front', 'side', 'smile']);
  // 컷에 두 인물 + 장소 지정, 카메라 움직임·전환·시드 고정
  const s = p.episodes[0].shots[0];
  const second = p.characters[1];
  ok(
    await request('/studio/ai/shots/' + s.id, {
      method: 'PATCH',
      cookie: seller.cookie,
      body: { scene: s.scene, visual: s.visual, dialogue: '이제 다 말할게.', speaker_id: hero.id, cast_ids: [hero.id, second.id], location_id: loc, camera: '클로즈업', camera_move: '왼쪽으로 패닝', emotion: '슬픔', speed: 0.9, seed_lock: true, transition: 'fade', sfx_prompt: '천둥 소리', seconds: 4 },
    }),
  );
  ok(await run(pid, 'shot_image', { targetId: s.id, requested: 'mock-image' }));
  p = await waitJobs(pid);
  const [imgJob] = await testDb.all("SELECT input FROM ai_jobs WHERE kind='shot_image' AND target_id=? ORDER BY created_at DESC LIMIT 1", [s.id]);
  const imgInput = JSON.parse(imgJob.input);
  assert.ok(imgInput.refImages.length >= 3, '두 인물과 장소 참고 이미지가 함께 가야 한다');
  assert.ok(Number.isInteger(imgInput.seed));
  assert.match(imgInput.prompt, /Location:/);
  // 부분 수정(이미지 편집)
  const oldImage = p.episodes[0].shots[0].image;
  ok(await run(pid, 'shot_image_edit', { targetId: s.id, requested: 'mock-image', instruction: '배경을 밤으로' }));
  p = await waitJobs(pid);
  assert.notEqual(p.episodes[0].shots[0].image, oldImage);
  // 음성(감정·속도 전달) → 영상 → 입 모양 맞추기 → 효과음
  ok(await run(pid, 'shot_tts', { targetId: s.id, requested: 'mock-voice' }));
  p = await waitJobs(pid);
  const [ttsJob] = await testDb.all("SELECT input FROM ai_jobs WHERE kind='shot_tts' AND target_id=? ORDER BY created_at DESC LIMIT 1", [s.id]);
  assert.equal(JSON.parse(ttsJob.input).style, '슬픔');
  assert.equal(JSON.parse(ttsJob.input).speed, 0.9);
  // 영상이 없으면 입 모양을 맞출 수 없다
  assert.equal((await run(pid, 'shot_lipsync', { targetId: s.id })).status, 400);
  ok(await run(pid, 'shot_video', { targetId: s.id, requested: 'mock-video-fast' }));
  p = await waitJobs(pid);
  ok(await run(pid, 'shot_lipsync', { targetId: s.id }));
  ok(await run(pid, 'shot_sfx', { targetId: s.id }));
  p = await waitJobs(pid);
  const shot = p.episodes[0].shots[0];
  assert.ok(shot.lipsync.startsWith('/uploads/') && shot.sfx.startsWith('/uploads/'));
  // 대사를 바꾸면 음성과 입 모양 영상이 함께 지워진다
  const edited = ok(await request('/studio/ai/shots/' + s.id, { method: 'PATCH', cookie: seller.cookie, body: { scene: shot.scene, visual: shot.visual, dialogue: '다시 말할게.', speaker_id: hero.id, camera: shot.camera, seconds: 4 } })).data;
  assert.equal(edited.audioReset, true);
  p = await detail(pid);
  assert.equal(p.episodes[0].shots[0].lipsync, '');
  ok(await run(pid, 'shot_tts', { targetId: s.id, requested: 'mock-voice' }));
  // 배경음악(AI) · 직접 올린 음악
  ok(await run(pid, 'music', { targetId: pid, options: { mood: '잔잔한 피아노', seconds: 30 } }));
  p = await waitJobs(pid);
  assert.ok(p.project.bgm.startsWith('/uploads/'));
  assert.ok(p.assets.some((a) => a.kind === 'music'));
  const form = new FormData();
  form.set('file', new Blob([readFileSync(path.join(dataDir, 'uploads', path.basename(p.project.bgm)))], { type: 'audio/mpeg' }), 'my.mp3');
  const up = await request(`/studio/ai/projects/${pid}/music`, { method: 'POST', cookie: seller.cookie, body: form });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  // 목소리 라이브러리 · 미리듣기(한 번 만들면 재사용)
  const voices = (await request('/studio/ai/voices', { cookie: seller.cookie })).data;
  const mockVoice = voices.find((v) => v.model === 'mock-voice');
  assert.ok(mockVoice.voices.length >= 2);
  assert.equal((await request('/studio/ai/voices/preview', { method: 'POST', cookie: seller.cookie, body: { model: 'mock-voice', voice: 'mock-female' } })).status, 202);
  let sample = null;
  for (let i = 0; i < 60 && !sample; i++) {
    await sleep(250);
    const r = await request('/studio/ai/voices/preview', { method: 'POST', cookie: seller.cookie, body: { model: 'mock-voice', voice: 'mock-female' } });
    if (r.data.ready) sample = r.data.url;
  }
  assert.ok(sample);
  assert.equal((await fetch(`${base}/api/studio/ai/voices/sample/${sample.split('/').pop()}`, { headers: { cookie: seller.cookie } })).status, 200);
  await waitJobs(pid);
});

test('new AI features stay closed until the super admin sets a lama price', async () => {
  await testDb.run("UPDATE ai_models SET price_lama=0 WHERE id='mock-music'");
  const r = await run(pid, 'music', { targetId: pid, options: { mood: '긴장감' } });
  assert.equal(r.status, 503);
  const models = (await request('/studio/ai/overview', { cookie: seller.cookie })).data.models;
  assert.equal(models.some((m) => m.capability === 'music'), false);
  // 관리자가 가격을 정하면 다시 열린다
  const m = (await request('/admin/ai', { cookie: admin })).data.models.find((x) => x.id === 'mock-music');
  ok(await request('/admin/ai/models/mock-music', { method: 'PATCH', cookie: admin, body: { capability: 'music', model_id: m.model_id, label: m.label, tier: m.tier, cost_usd: 0, price_lama: 0.3, tags: [], max_seconds: 180, image_input: false, active: true, priority: 50, notes: '' } }));
  assert.ok((await request('/studio/ai/overview', { cookie: seller.cookie })).data.models.some((x) => x.capability === 'music'));
});

test('compose v2 through the render queue with cards and music, trailer, metadata, thumbnail A/B and serial publishing', async () => {
  let p = await detail(pid);
  // 모든 컷에 스토리보드가 있어야 합성할 수 있다
  for (const e of p.episodes) if (!e.shots.length) ok(await run(pid, 'script', { requested: 'mock-writer', targetId: e.id }));
  p = await waitJobs(pid);
  for (const e of p.episodes) ok(await run(pid, 'batch_shot_image', { targetId: e.id, requested: 'mock-image' })).data;
  p = await waitJobs(pid);
  // 인트로 카드(이미지)와 엔딩 카드를 회차에 붙인다
  const card = p.episodes[0].shots[0].image;
  const ep1 = p.episodes[0];
  ok(await request(`/studio/ai/projects/${pid}/episodes/${ep1.id}`, { method: 'PATCH', cookie: seller.cookie, body: { title: ep1.title, summary: ep1.summary, intro_card: card, outro_card: card } }));
  ok(await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: seller.cookie, body: { subtitle_style: { position: 'middle', size: 'xl' }, bgm_volume: 0.3 } }));
  for (const e of p.episodes) assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${e.id}/compose`, { method: 'POST', cookie: seller.cookie })).status, 202);
  // 같은 회차를 합성 중에 또 누르면 409
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${ep1.id}/compose`, { method: 'POST', cookie: seller.cookie })).status, 409);
  p = await waitJobs(pid, 180000);
  assert.ok(p.episodes.every((e) => e.status === 'composed'), JSON.stringify(p.episodes.map((e) => [e.status, e.compose_error])));
  const status = (await request(`/studio/ai/projects/${pid}/episodes/${ep1.id}/compose`, { cookie: seller.cookie })).data;
  assert.equal(status.progress, 1);
  const vtt = await (await fetch(`${base}/api/studio/ai/episodes/${ep1.id}/subtitles`, { headers: { cookie: seller.cookie } })).text();
  assert.match(vtt, /line:50%/);
  // 인트로 2초 + 엔딩 2.5초가 더해진다
  const shotsTotal = p.episodes[0].shots.reduce((n, s) => n + Math.max(Number(s.seconds), s.audio_seconds ? Number(s.audio_seconds) + 0.35 : 0), 0);
  assert.ok(p.episodes[0].duration >= Math.round(shotsTotal + 3), `${p.episodes[0].duration} vs ${shotsTotal}`);
  assert.ok((await request('/notifications', { cookie: seller.cookie })).data.list.some((n) => n.kind === 'compose'));
  // 예고편
  ok(await request(`/studio/ai/projects/${pid}/trailer`, { method: 'POST', cookie: seller.cookie, body: {} }));
  p = await waitJobs(pid, 120000);
  assert.equal(p.project.trailer_status, 'done');
  // 제목·소개·해시태그 AI → 회차 제목 반영
  ok(await run(pid, 'metadata', { requested: 'mock-writer' }));
  p = await waitJobs(pid);
  const meta = JSON.parse(p.project.meta);
  assert.ok(meta.titles.length >= 2 && meta.hashtags.length >= 3);
  ok(await request(`/studio/ai/projects/${pid}/metadata/apply`, { method: 'POST', cookie: seller.cookie, body: { title: meta.titles[1], episodeTitles: true } }));
  p = await detail(pid);
  assert.equal(p.project.title, meta.titles[1]);
  // 제목을 바꿨으니 다시 합성해야 하는 건 아니다(합성 결과 그대로)
  // 썸네일 배경 후보 2장
  ok(await run(pid, 'thumb_bg', { requested: 'mock-image', options: { count: 2 } }));
  p = await waitJobs(pid);
  const thumbs = p.assets.filter((a) => a.kind === 'thumb_bg').map((a) => a.url);
  assert.equal(thumbs.length, 2);
  // 1화만 먼저 공개(작품 검수) — 2화는 나중에 연재로
  const exp = await request(`/studio/ai/projects/${pid}/export`, {
    method: 'POST',
    cookie: seller.cookie,
    body: { title: meta.titles[0], tagline: meta.tagline, synopsis: meta.synopsis, hashtags: meta.hashtags, episode_pings: 5, free_episodes: 1, image: thumbs[0], variants: [thumbs[1]], submit: true },
  });
  assert.equal(exp.status, 200, JSON.stringify(exp.data));
  const dramaId = exp.data.dramaId;
  assert.equal(exp.data.episodes, 2);
  ok(await request(`/admin/dramas/${dramaId}/review`, { method: 'POST', cookie: admin, body: { status: 'published' } }));
  assert.equal((await fetch(`${base}/api/dramas/${dramaId}/trailer`)).status, 200);
  const pub = (await request('/dramas/' + dramaId)).data;
  assert.equal(pub.hashtags, meta.hashtags.join(','));
  // 썸네일 A/B: 목록마다 후보가 나뉘어 보이고, 클릭을 센다
  const list = (await request('/dramas', { cookie: viewer })).data.find((d) => d.id === dramaId);
  assert.ok(list.thumb_id);
  await request(`/dramas/${dramaId}?t=${list.thumb_id}`, { cookie: viewer });
  const stats = (await request(`/studio/dramas/${dramaId}/thumbnails`, { cookie: seller.cookie })).data;
  assert.equal(stats.length, 2);
  assert.ok(stats.some((t) => t.clicks === 1));
  ok(await request(`/studio/dramas/${dramaId}/thumbnails/finish`, { method: 'POST', cookie: seller.cookie, body: {} }));
  assert.equal((await request('/dramas', { cookie: viewer })).data.find((d) => d.id === dramaId).thumb_id, undefined);

  // 연재: 공개 뒤 3화를 더 만들어 회차 단위 검수로 공개
  ok(await request('/studio/ai/projects/' + pid, { method: 'PATCH', cookie: seller.cookie, body: { episode_count: 3 } }));
  p = await detail(pid);
  const ep3 = p.episodes.find((e) => e.number === 3);
  ok(await run(pid, 'script', { requested: 'mock-writer', targetId: ep3.id }));
  p = await waitJobs(pid);
  ok(await run(pid, 'batch_shot_image', { targetId: ep3.id, requested: 'mock-image' }));
  p = await waitJobs(pid);
  ok(await request(`/studio/ai/projects/${pid}/episodes/${ep3.id}/compose`, { method: 'POST', cookie: seller.cookie }));
  p = await waitJobs(pid, 120000);
  const serial = await request(`/studio/ai/projects/${pid}/export`, { method: 'POST', cookie: seller.cookie, body: { tagline: '연재', submit: true } });
  assert.equal(serial.status, 200, JSON.stringify(serial.data));
  assert.equal(serial.data.serial, true);
  assert.deepEqual(serial.data.numbers, [3]);
  assert.equal((await request('/dramas/' + dramaId)).data.episodes.length, 2);
  const queue = (await request('/admin/episodes/review', { cookie: admin })).data.find((e) => e.drama_id === dramaId);
  assert.equal(queue.number, 3);
  ok(await request('/admin/episodes/' + queue.id + '/review', { method: 'POST', cookie: admin, body: { status: 'approved' } }));
  assert.equal((await request('/dramas/' + dramaId)).data.episodes.length, 3);
  assert.ok((await request('/notifications', { cookie: seller.cookie })).data.list.some((n) => n.kind === 'episode_review'));
});

test('quick production: autopilot with setting bible, music and sound effects finishes and notifies', async () => {
  const pd2 = await newPd('quick');
  const saved = seller;
  seller = pd2;
  try {
    const created = await request('/studio/ai/projects', { method: 'POST', cookie: pd2.cookie, body: { title: '빠른 제작', logline: '하루 만에 인생이 바뀐 신입사원의 이야기', genre: '코미디', episode_count: 2, episode_seconds: 20 } });
    const qid = created.data.id;
    const body = { includeBible: true, includeMusic: true, includeSfx: true, includeVideo: false, musicMood: '경쾌한', choices: { text: { requested: 'mock-writer', tier: 'standard' }, image: { requested: 'mock-image', tier: 'draft' }, tts: { requested: 'mock-voice', tier: 'standard' } } };
    const est = (await request(`/studio/ai/projects/${qid}/autopilot/estimate`, { method: 'POST', cookie: pd2.cookie, body })).data;
    assert.ok(est.stages.some((s) => s.stage === 'bible'));
    assert.ok(est.stages.some((s) => s.stage === 'music'));
    assert.equal(est.unavailable.length, 0, JSON.stringify(est));
    assert.equal((await request(`/studio/ai/projects/${qid}/autopilot`, { method: 'POST', cookie: pd2.cookie, body })).status, 201);
    let p;
    for (let i = 0; i < 600; i++) {
      p = await detail(qid);
      if (p.autopilot?.status !== 'running') break;
      await sleep(300);
    }
    assert.equal(p.autopilot.status, 'done', p.autopilot.message);
    assert.ok(p.project.bible && p.project.season && p.project.bgm);
    assert.ok(p.episodes.every((e) => e.status === 'composed'));
    assert.ok(p.episodes.flatMap((e) => e.shots).filter((s) => s.sfx_prompt).every((s) => s.sfx));
    assert.ok((await request('/notifications', { cookie: pd2.cookie })).data.list.some((n) => n.kind === 'autopilot'));
    // 관리자는 PD 프로젝트에서 자동 제작을 시작할 수 없다(PD 라마 보호)
    assert.equal((await request(`/studio/ai/projects/${qid}/autopilot`, { method: 'POST', cookie: admin, body })).status, 403);
    const n = (await request('/notifications', { cookie: pd2.cookie })).data;
    ok(await request('/notifications/read', { method: 'POST', cookie: pd2.cookie, body: {} }));
    assert.equal((await request('/notifications', { cookie: pd2.cookie })).data.unread, 0);
    assert.ok(n.unread >= 1);
  } finally {
    seller = saved;
  }
});
