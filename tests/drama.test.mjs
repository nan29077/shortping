// 드라매직 벤치마킹 고도화(2026-09-25) 통합 테스트:
// 완성 대본 → 컷 나누기(인물·장소·소품·관계·상태) · 소품 · 스타일 잠금 · 인물 상태 이어 가기 · AI 결과 검수(라마) · 컷 리듬 진단
// · 내 자산 라이브러리 · 관계 · 사이 컷 · 대본 변형 · 협업(초대·역할·라마·승인·의견·활동) · 영상→대본 · 대량 제작
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareTestDb } from './_db.mjs';

const port = 5261,
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
async function waitIdle(id = pid, cookie = pd, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const d = await detail(id, cookie);
    if (d && !d.jobs.some((j) => ['queued', 'running'].includes(j.status))) return d;
    await sleep(200);
  }
  throw new Error('작업이 끝나지 않았어요\n' + output.slice(-2000));
}
const run = (body, cookie = pd, id = pid) => request(`/studio/ai/projects/${id}/run`, { method: 'POST', cookie, body: { requested: 'auto', tier: 'standard', ...body } });
const settings = (body) => request('/admin/settings', { method: 'PUT', cookie: admin, body });
async function newPd(tag) {
  const email = `${tag}-${runId}@drama.test`;
  const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'DramaTest!2026', name: '드라마 ' + tag } });
  await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role: 'pd', status: 'active', name: '드라마 ' + tag, phone: '' } });
  const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'DramaTest!2026' } })).cookie;
  await request('/studio/ai/terms', { method: 'POST', cookie, body: { agree: true, version: '2026-09' } });
  return { id: reg.data.user.id, email, cookie };
}
const SCRIPT = `1화
S#1. 카페 - 밤
(창밖으로 비가 내린다. 서윤이 젖은 우산을 접는다)
서윤: 늦었네. 편지는 가져왔어?
도현: (편지를 내밀며) 이걸로 끝내자.
S#2. 골목 - 밤
(비에 젖은 서윤이 편지를 펼친다)
서윤: 이게... 무슨 뜻이야!
2화
S#1. 사무실 - 낮
도현: 반지는 돌려줘.
서윤: 싫어. 아직 안 끝났어.`;

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
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: 'demo-pd', action: 'grant', lama: 20000, memo: '드라마 테스트' } });
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '편지', logline: '비 오는 밤, 한 통의 편지가 두 사람을 갈라놓는다', genre: '로맨스', tone: '애틋함', episode_count: 1, episode_seconds: 30 } });
  pid = created.data.id;
});
after(async () => {
  child?.kill();
  await sleep(300);
  await testDb?.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError|is not defined/.test(output), output.slice(-3000));
});

test('pasted script becomes episodes, shots, characters, locations, props, relations and states', async () => {
  assert.equal((await run({ action: 'parse_script' })).status, 400); // 대본 없음
  assert.equal((await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { script_text: SCRIPT } })).status, 200);
  const est = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'parse_script' } });
  assert.equal(est.status, 200, JSON.stringify(est.data));
  assert.ok(est.data.lama >= 1);
  assert.equal((await run({ action: 'parse_script' })).status, 201);
  const d = await waitIdle();
  assert.equal(d.project.episode_count, 2, '회차 수가 대본에 맞게 늘어남');
  assert.equal(d.episodes.length, 2);
  const names = d.characters.map((c) => c.name).sort();
  assert.deepEqual(names, ['도현', '서윤']);
  assert.ok(d.locations.some((l) => l.name === '카페'));
  assert.ok(d.props.some((x) => x.name === '편지'));
  assert.ok(d.props.some((x) => x.name === '반지'));
  const rel = JSON.parse(d.project.relations);
  assert.equal(rel.length, 1);
  const e1 = d.episodes[0];
  assert.ok(e1.shots.length >= 4);
  const letter = d.props.find((x) => x.name === '편지');
  assert.ok(e1.shots.some((s) => String(s.prop_ids).includes(letter.id)), '소품이 컷에 연결');
  const seoyun = d.characters.find((c) => c.name === '서윤');
  assert.ok(e1.shots.some((s) => s.states && JSON.parse(s.states)[seoyun.id]), '인물 상태가 컷에 기록');
  assert.ok(e1.shots.some((s) => s.location_id), '장소가 컷에 연결');
  assert.equal(e1.status, 'scripted');
  // 다시 나누면 이전 대본은 버전으로 남는다
  assert.equal((await run({ action: 'parse_script' })).status, 201);
  const d2 = await waitIdle();
  assert.equal(d2.characters.length, 2, '같은 이름 인물은 중복으로 생기지 않음');
  const versions = await request(`/studio/ai/projects/${pid}/episodes/${e1.id}/versions`, { cookie: pd });
  assert.ok(versions.data.some((v) => v.source === 'before_import'));
});

test('props CRUD, shot props/states, carry-forward states and style lock in the image prompt', async () => {
  let d = await detail();
  const created = await request(`/studio/ai/projects/${pid}/props`, { method: 'POST', cookie: pd, body: { name: '우산', look: '투명한 비닐 우산' } });
  assert.equal(created.status, 201);
  const other = await login('viewer');
  assert.equal((await request(`/studio/ai/projects/${pid}/props`, { method: 'POST', cookie: other, body: { name: 'x', look: '' } })).status, 403);
  assert.equal((await run({ action: 'prop_image', targetId: created.data.id })).status, 201);
  d = await waitIdle();
  const umbrella = d.props.find((x) => x.id === created.data.id);
  assert.ok(umbrella.image, '소품 이미지');
  const [a, b] = d.episodes[0].shots;
  const cast = d.characters;
  // 첫 컷에 상태·소품 지정 → 두 번째 컷 이미지 프롬프트에 상태가 이어진다
  const patch = await request(`/studio/ai/shots/${a.id}`, {
    method: 'PATCH',
    cookie: pd,
    body: { scene: a.scene, visual: a.visual, dialogue: a.dialogue, speaker_id: a.speaker_id, camera: a.camera, seconds: a.seconds, cast_ids: [cast[0].id], prop_ids: [umbrella.id], states: { [cast[0].id]: '빨간 코트, 젖은 머리' } },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  assert.ok(patch.data.updated_at);
  // 다른 프로젝트의 소품·인물은 못 씀
  assert.equal((await request(`/studio/ai/shots/${a.id}`, { method: 'PATCH', cookie: pd, body: { scene: a.scene, visual: a.visual, dialogue: a.dialogue, speaker_id: a.speaker_id, camera: a.camera, seconds: a.seconds, prop_ids: ['nope'] } })).status, 400);
  await request(`/studio/ai/shots/${b.id}`, { method: 'PATCH', cookie: pd, body: { scene: b.scene, visual: b.visual, dialogue: b.dialogue, speaker_id: b.speaker_id, camera: b.camera, seconds: b.seconds, cast_ids: [cast[0].id], states: {} } });
  // 스타일 잠금: 자기 이미지만
  assert.equal((await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { style_refs: ['/uploads/00000000-0000-0000-0000-000000000000.png'] } })).status, 403);
  assert.equal((await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { style_refs: [umbrella.image] } })).status, 200);
  assert.equal((await run({ action: 'shot_image', targetId: b.id })).status, 201);
  await waitIdle();
  const [job] = await testDb.all("SELECT input FROM ai_jobs WHERE kind='shot_image' AND target_id=? ORDER BY created_at DESC LIMIT 1", [b.id]);
  const input = JSON.parse(job.input);
  assert.match(input.prompt, /currently 빨간 코트, 젖은 머리/, '앞 컷 상태가 이어짐');
  assert.match(input.prompt, /style reference/);
  assert.ok(input.refImages.some((r) => r.path === umbrella.image), '스타일 참고 이미지가 참고로 들어감');
  // '기본'으로 되돌리면 이어지지 않음
  const c = d.episodes[0].shots[2];
  await request(`/studio/ai/shots/${b.id}`, { method: 'PATCH', cookie: pd, body: { scene: b.scene, visual: b.visual, dialogue: b.dialogue, speaker_id: b.speaker_id, camera: b.camera, seconds: b.seconds, cast_ids: [cast[0].id], states: { [cast[0].id]: '기본' } } });
  await request(`/studio/ai/shots/${c.id}`, { method: 'PATCH', cookie: pd, body: { scene: c.scene, visual: c.visual, dialogue: c.dialogue, speaker_id: c.speaker_id, camera: c.camera, seconds: c.seconds, cast_ids: [cast[0].id], states: {} } });
  assert.equal((await run({ action: 'shot_image', targetId: c.id })).status, 201);
  await waitIdle();
  const [job2] = await testDb.all("SELECT input FROM ai_jobs WHERE kind='shot_image' AND target_id=? ORDER BY created_at DESC LIMIT 1", [c.id]);
  assert.doesNotMatch(JSON.parse(job2.input).prompt, /currently/);
  // 소품 지우면 컷 연결도 풀림
  assert.equal((await request(`/studio/ai/projects/${pid}/props/${umbrella.id}`, { method: 'DELETE', cookie: pd })).status, 200);
  d = await detail();
  assert.ok(!d.episodes[0].shots.some((s) => String(s.prop_ids).includes(umbrella.id)));
});

test('AI verification is billed, needs an image, stores issues, and clears when the image changes', async () => {
  let d = await detail();
  const withImage = d.episodes[0].shots.find((s) => s.image);
  const noImage = d.episodes[0].shots.find((s) => !s.image);
  if (noImage) assert.equal((await run({ action: 'verify_shot', targetId: noImage.id })).status, 400);
  const before = (await request('/lama', { cookie: pd })).data.wallet.total;
  const est = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'verify_shot', targetId: withImage.id } });
  assert.ok(est.data.lama >= 1, '검수도 라마가 든다');
  assert.equal((await run({ action: 'verify_shot', targetId: withImage.id })).status, 201);
  d = await waitIdle();
  let s = d.episodes[0].shots.find((x) => x.id === withImage.id);
  const v = JSON.parse(s.verify);
  assert.equal(v.ok, true);
  assert.equal(v.image, s.image);
  assert.ok((await request('/lama', { cookie: pd })).data.wallet.total < before);
  const [job] = await testDb.all("SELECT input,billed FROM ai_jobs WHERE kind='verify_shot' ORDER BY created_at DESC LIMIT 1");
  assert.equal(Number(job.billed), 1);
  assert.equal(JSON.parse(job.input).refImages[0].path, s.image, '컷 이미지를 먼저 보냄');
  // 문제 있는 컷(가짜 AI: 묘사에 MOCK_BAD)
  await testDb.run('UPDATE studio_shots SET visual=? WHERE id=?', ['MOCK_BAD 장면', s.id]);
  assert.equal((await run({ action: 'verify_shot', targetId: s.id })).status, 201);
  d = await waitIdle();
  s = d.episodes[0].shots.find((x) => x.id === withImage.id);
  assert.equal(JSON.parse(s.verify).ok, false);
  const check = await request(`/studio/ai/projects/${pid}/check`, { cookie: pd });
  assert.ok(check.data.issues.some((i) => i.code === 'verify_fail' && i.shotId === s.id));
  // 이미지를 다시 만들면 검수 결과는 지워짐
  await testDb.run('UPDATE studio_shots SET visual=? WHERE id=?', ['비 오는 밤 골목', s.id]);
  assert.equal((await run({ action: 'shot_image', targetId: s.id })).status, 201);
  d = await waitIdle();
  assert.equal(d.episodes[0].shots.find((x) => x.id === s.id).verify, '');
  // 한 번에 검수: 이미지가 있고 아직 안 한 컷만
  const imgs = d.episodes[0].shots.filter((x) => x.image).length;
  const batch = await request(`/studio/ai/projects/${pid}/estimate`, { method: 'POST', cookie: pd, body: { action: 'batch_verify_shot', targetId: d.episodes[0].id } });
  assert.equal(batch.data.jobs, imgs);
  assert.equal((await run({ action: 'batch_verify_shot', targetId: d.episodes[0].id })).status, 201);
  await waitIdle();
  assert.equal((await run({ action: 'batch_verify_shot', targetId: d.episodes[0].id })).status, 400, '다 검수했으면 새로 할 컷 없음');
});

test('rhythm diagnosis flags a slow hook, same-size runs and silent runs', async () => {
  const d = await detail();
  const e = d.episodes[0];
  // 첫 컷을 8초 · 대사 없음으로
  const a = e.shots[0];
  await testDb.run("UPDATE studio_shots SET seconds=8, dialogue='' WHERE id=?", [a.id]);
  await testDb.run("UPDATE studio_shots SET camera='클로즈업' WHERE episode_id=?", [e.id]);
  const r = await request(`/studio/ai/projects/${pid}/episodes/${e.id}/rhythm`, { cookie: pd });
  assert.equal(r.status, 200);
  const codes = r.data.items.map((x) => x.code);
  assert.ok(codes.includes('rhythm_hook'), codes.join(','));
  assert.ok(codes.includes('rhythm_same_size'));
  assert.ok(r.data.score < 100);
});

test('my asset library: save, import into another project, style and limits', async () => {
  const d = await detail();
  const c = d.characters[0];
  const saved = await request('/studio/ai/library', { method: 'POST', cookie: pd, body: { kind: 'character', projectId: pid, sourceId: c.id } });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  // 같은 이름으로 다시 저장하면 새로 고침
  const again = await request('/studio/ai/library', { method: 'POST', cookie: pd, body: { kind: 'character', projectId: pid, sourceId: c.id } });
  assert.equal(again.data.updated, true);
  const loc = d.locations[0];
  assert.equal((await request('/studio/ai/library', { method: 'POST', cookie: pd, body: { kind: 'location', projectId: pid, sourceId: loc.id } })).status, 201);
  assert.equal((await request('/studio/ai/library', { method: 'POST', cookie: pd, body: { kind: 'style', projectId: pid } })).status, 201);
  const list = (await request('/studio/ai/library', { cookie: pd })).data;
  assert.equal(list.length, 3);
  // 다른 사람은 내 라이브러리를 볼 수도, 가져갈 수도 없다
  const other = await newPd('lib-other');
  assert.equal((await request('/studio/ai/library', { cookie: other.cookie })).data.length, 0);
  // 새 프로젝트(시즌 2)로 가져오기
  const s2 = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '편지 시즌2', logline: '다시 만난 두 사람의 두 번째 이야기', genre: '로맨스', episode_count: 1, episode_seconds: 30 } })).data.id;
  for (const x of list) assert.equal((await request(`/studio/ai/projects/${s2}/library/import`, { method: 'POST', cookie: pd, body: { libraryId: x.id } })).status, 201);
  const d2 = await detail(s2);
  assert.equal(d2.characters[0].name, c.name);
  assert.equal(d2.characters[0].look, c.look);
  assert.equal(d2.locations[0].name, loc.name);
  assert.equal(d2.project.style_refs, d.project.style_refs);
  // 같은 인물을 또 가져오면 이름이 겹치지 않게
  await request(`/studio/ai/projects/${s2}/library/import`, { method: 'POST', cookie: pd, body: { libraryId: list.find((x) => x.kind === 'character').id } });
  assert.ok((await detail(s2)).characters.some((x) => x.name === `${c.name} (2)`));
  assert.equal((await request(`/studio/ai/projects/${s2}/library/import`, { method: 'POST', cookie: other.cookie, body: { libraryId: list[0].id } })).status, 404);
  assert.equal((await request(`/studio/ai/library/${list[0].id}`, { method: 'DELETE', cookie: other.cookie })).status, 404);
  assert.equal((await request(`/studio/ai/library/${list[0].id}`, { method: 'DELETE', cookie: pd })).status, 200);
  // 라이브러리 그림은 정리 대상이 아님
  const st = await request('/admin/storage', { cookie: admin });
  assert.equal(st.data.checked_places, 25);
});

test('relations: validated, deduplicated and used in script prompts', async () => {
  const d = await detail();
  const [a, b] = d.characters;
  assert.equal((await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { relations: [{ a: a.id, b: a.id, kind: '친구' }] } })).status, 400);
  assert.equal((await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { relations: [{ a: a.id, b: 'nope', kind: '친구' }] } })).status, 400);
  const ok = await request(`/studio/ai/projects/${pid}/settings`, { method: 'PATCH', cookie: pd, body: { relations: [{ a: a.id, b: b.id, kind: '라이벌', note: '회사 경쟁' }, { a: b.id, b: a.id, kind: '연인' }] } });
  assert.equal(ok.status, 200);
  const rel = JSON.parse((await detail()).project.relations);
  assert.equal(rel.length, 1, '같은 두 사람은 한 번만');
  assert.equal((await run({ action: 'script', targetId: d.episodes[1].id })).status, 201);
  await waitIdle();
  const [job] = await testDb.all("SELECT input FROM ai_jobs WHERE kind='script' ORDER BY created_at DESC LIMIT 1");
  assert.match(JSON.parse(job.input).prompt, /라이벌 \(회사 경쟁\)/);
});

test('bridge shot is inserted right after the chosen shot; variants become versions only', async () => {
  let d = await detail();
  const e = d.episodes[0];
  const count = e.shots.length;
  const target = e.shots[1];
  assert.equal((await run({ action: 'bridge_shot', targetId: target.id, instruction: '창밖 비 내리는 풍경' })).status, 201);
  d = await waitIdle();
  const shots = d.episodes[0].shots;
  assert.equal(shots.length, count + 1);
  assert.equal(shots[1].id, target.id);
  assert.equal(shots[2].scene, '전환', '바로 뒤에 들어감');
  assert.ok(Number(shots[2].seconds) <= 4);
  // 변형: 지금 대본은 그대로, 버전만 늘어남
  const before = shots.map((s) => s.id).join(',');
  assert.equal((await run({ action: 'variants', targetId: e.id })).status, 400, '방향이 없으면 안 됨');
  assert.equal((await run({ action: 'variants', targetId: e.id, options: { angles: ['결말 반전', '다른 인물 시점'] } })).status, 201);
  d = await waitIdle();
  assert.equal(d.episodes[0].shots.map((s) => s.id).join(','), before);
  const versions = (await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions`, { cookie: pd })).data;
  const variants = versions.filter((v) => v.source === 'variant');
  assert.equal(variants.length, 2);
  assert.match(variants.map((v) => v.note).join(' '), /결말 반전/);
  // 변형을 골라 쓰기(되돌리기)
  const pick = variants[0];
  assert.equal((await request(`/studio/ai/projects/${pid}/episodes/${e.id}/versions/${pick.id}/restore`, { method: 'POST', cookie: pd })).status, 200);
  d = await detail();
  assert.match(d.episodes[0].shots[0].visual, /\(/);
  // 실패한 변형도 다시 시도할 수 있게 방향을 기억
  const [job] = await testDb.all("SELECT id,input FROM ai_jobs WHERE kind='variants' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual(JSON.parse(job.input).context.angles, ['결말 반전', '다른 인물 시점']);
});

// ── 협업(팀 제작) ─────────────────────────────────────
test('collaboration: invites, roles, payer, approvals, comments, presence and activity', async () => {
  const cp = (await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '팀 작업', logline: '여럿이 함께 만드는 비 오는 밤의 이야기', genre: '로맨스', tone: '애틋함', episode_count: 1, episode_seconds: 30 } })).data.id;
  await request(`/studio/ai/projects/${cp}/settings`, { method: 'PATCH', cookie: pd, body: { script_text: SCRIPT } });
  assert.equal((await run({ action: 'parse_script' }, pd, cp)).status, 201);
  let d = await waitIdle(cp);
  assert.equal(d.team.role, 'owner');
  assert.equal(d.team.approval.active, false, '팀원이 없으면 승인 꺼짐');
  const writer = await newPd('writer');
  const editor = await newPd('editor');
  const reviewer = await newPd('reviewer');
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: writer.id, action: 'grant', lama: 5000, memo: '협업 테스트' } });
  await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: editor.id, action: 'grant', lama: 5000, memo: '협업 테스트' } });
  // 시청자 계정은 초대 불가 · 초대 전에는 프로젝트가 보이지 않음
  const viewerEmail = `viewer-${runId}@drama.test`;
  const vreg = await request('/auth/register', { method: 'POST', body: { email: viewerEmail, password: 'DramaTest!2026', name: '시청자' } });
  assert.equal(vreg.data.user.role, 'viewer');
  assert.equal((await request('/studio/ai/projects/' + cp, { cookie: writer.cookie })).status, 404);
  const inv = await request(`/studio/ai/projects/${cp}/invites`, { method: 'POST', cookie: pd, body: { emails: [writer.email, viewerEmail, reviewer.email], role: 'writer' } });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.equal(inv.data.results.find((r) => r.email === viewerEmail).ok, false, '시청자 거절');
  assert.equal(inv.data.results.filter((r) => r.ok).length, 2);
  // 팀원은 초대를 보낼 수 없음(소유자만)
  const mine = (await request('/studio/ai/invites', { cookie: writer.cookie })).data;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role_name, '작가');
  // 다른 사람의 이메일 초대는 받을 수 없음
  const stolen = await request(`/studio/ai/invites/${mine[0].token}/accept`, { method: 'POST', cookie: editor.cookie });
  assert.equal(stolen.status, 409);
  assert.equal((await request(`/studio/ai/invites/${mine[0].token}/accept`, { method: 'POST', cookie: writer.cookie })).status, 200);
  assert.equal((await request(`/studio/ai/projects/${cp}/invites`, { method: 'POST', cookie: writer.cookie, body: { link: true, role: 'writer' } })).status, 403);
  // 초대 링크: 편집·연출 · 소유자 지원 5라마
  const linkRes = await request(`/studio/ai/projects/${cp}/invites`, { method: 'POST', cookie: pd, body: { link: true, role: 'editor', pay_mode: 'sponsor', sponsor_limit: 5, max_uses: 2 } });
  const oldToken = linkRes.data.link.token;
  const reset = await request(`/studio/ai/projects/${cp}/invites/${linkRes.data.link.id}`, { method: 'PATCH', cookie: pd, body: { reset: true } });
  assert.notEqual(reset.data.token, oldToken);
  assert.equal((await request(`/studio/ai/invites/${oldToken}`, { cookie: editor.cookie })).status, 404, '바꾼 뒤 옛 링크는 막힘');
  const preview = await request(`/studio/ai/invites/${reset.data.token}`, { cookie: editor.cookie });
  assert.equal(preview.data.role_name, '편집·연출');
  assert.equal(preview.data.problem, '');
  assert.equal((await request(`/studio/ai/invites/${reset.data.token}`, { cookie: await login('viewer') })).status, 403, '시청자는 링크도 불가');
  assert.equal((await request(`/studio/ai/invites/${reset.data.token}/accept`, { method: 'POST', cookie: editor.cookie })).status, 200);
  // 검수자: 이메일 초대(작가 역할) → 소유자가 검수자로 바꿈
  const rinv = (await request('/studio/ai/invites', { cookie: reviewer.cookie })).data[0];
  assert.equal((await request(`/studio/ai/invites/${rinv.token}/accept`, { method: 'POST', cookie: reviewer.cookie })).status, 200);
  assert.equal((await request(`/studio/ai/projects/${cp}/members/${reviewer.id}`, { method: 'PATCH', cookie: pd, body: { role: 'reviewer' } })).status, 200);
  const team = (await request(`/studio/ai/projects/${cp}/team`, { cookie: pd })).data;
  assert.equal(team.members.length, 3);
  assert.equal(team.approval.active, true, '팀이 생기면 승인 자동 켜짐');
  const shared = (await request('/studio/ai/overview', { cookie: writer.cookie })).data.shared;
  assert.ok(shared.some((x) => x.id === cp && x.role === 'writer'));

  // 역할 권한
  d = await detail(cp, writer.cookie);
  assert.equal(d.team.role, 'writer');
  const shot = d.episodes[0].shots[0];
  const full = (x, extra) => ({ scene: x.scene, visual: x.visual, dialogue: x.dialogue, speaker_id: x.speaker_id, camera: x.camera, seconds: x.seconds, ...extra });
  assert.equal((await request(`/studio/ai/projects/${cp}`, { method: 'PATCH', cookie: writer.cookie, body: { tone: '더 애틋하게' } })).status, 200, '작가는 기획 수정 가능');
  assert.equal((await run({ action: 'shot_image', targetId: shot.id }, writer.cookie, cp)).status, 403, '작가는 이미지 생성 불가');
  assert.equal((await request(`/studio/ai/projects/${cp}/settings`, { method: 'PATCH', cookie: writer.cookie, body: { budget_lama: 1 } })).status, 403, '예산은 소유자만');
  assert.equal((await request(`/studio/ai/projects/${cp}`, { method: 'DELETE', cookie: writer.cookie })).status, 403, '삭제는 소유자만');
  assert.equal((await request(`/studio/ai/projects/${cp}/settings`, { method: 'PATCH', cookie: reviewer.cookie, body: { script_text: '1화' } })).status, 403, '검수자는 대본 수정 불가');
  assert.equal((await request(`/studio/ai/shots/${shot.id}`, { method: 'PATCH', cookie: editor.cookie, body: full(shot, { camera: '클로즈업' }) })).status, 200, '편집·연출은 컷 수정 가능');
  assert.equal((await request(`/studio/ai/shots/${shot.id}`, { method: 'PATCH', cookie: editor.cookie, body: full(shot, { camera: '클로즈업', dialogue: '바꾼 대사' }) })).status, 403, '편집·연출은 대사 수정 불가');
  assert.equal((await request(`/studio/ai/shots/${shot.id}`, { method: 'DELETE', cookie: editor.cookie })).status, 403, '편집·연출은 컷 삭제 불가(대본)');

  // 결제: 작가는 자기 라마, 편집·연출은 소유자 지원(한도 5라마)
  const est = await request(`/studio/ai/projects/${cp}/estimate`, { method: 'POST', cookie: editor.cookie, body: { action: 'shot_image', targetId: shot.id } });
  assert.equal(est.data.payer.mode, 'sponsor');
  assert.equal((await run({ action: 'diagnose', targetId: d.episodes[0].id }, writer.cookie, cp)).status, 201);
  const [wj] = await testDb.all("SELECT user_id,actor_id FROM ai_jobs WHERE project_id=? AND kind='diagnose' ORDER BY created_at DESC LIMIT 1", [cp]);
  assert.equal(wj.user_id, writer.id);
  assert.equal(wj.actor_id, writer.id);
  const talk = d.episodes[0].shots.find((x) => x.dialogue);
  const small = await run({ action: 'shot_tts', targetId: talk.id }, editor.cookie, cp);
  if (small.status === 201) {
    const [ej] = await testDb.all("SELECT user_id,actor_id FROM ai_jobs WHERE project_id=? AND kind='shot_tts' ORDER BY created_at DESC LIMIT 1", [cp]);
    assert.equal(ej.user_id, 'demo-pd', '지원: 소유자 라마');
    assert.equal(ej.actor_id, editor.id);
  } else assert.equal(small.data.code, 'sponsor_limit', JSON.stringify(small));
  await waitIdle(cp);
  const big = await run({ action: 'batch_shot_image', targetId: d.episodes[0].id }, editor.cookie, cp);
  assert.equal(big.status, 409, JSON.stringify(big.data));
  assert.equal(big.data.code, 'sponsor_limit');
  const own = await run({ action: 'batch_shot_image', targetId: d.episodes[0].id, payOwn: true }, editor.cookie, cp);
  assert.equal(own.status, 201, JSON.stringify(own.data));
  const jobIds = own.data.jobs.map((j) => j.id);
  const paid = await testDb.all(`SELECT DISTINCT user_id FROM ai_jobs WHERE id IN (${jobIds.map(() => '?').join(',')})`, jobIds);
  assert.deepEqual(paid.map((r) => r.user_id), [editor.id], '내 라마로');
  d = await waitIdle(cp);
  assert.ok(d.jobs.some((j) => j.actor_name === '드라마 editor'), '누가 실행했는지 보임');
  // 같은 소유자의 다른 프로젝트 파일은 그 프로젝트에 초대받지 않은 협업자에게 보이면 안 된다.
  const [privateAsset] = await testDb.all('SELECT a.url FROM studio_assets a JOIN studio_projects p ON p.id=a.project_id WHERE p.owner_id=? AND a.project_id<>? LIMIT 1', ['demo-pd', cp]);
  assert.ok(privateAsset?.url, '다른 비공개 프로젝트 파일 준비');
  const privateFile = privateAsset.url.split('/').pop();
  assert.equal((await fetch(`${base}/api/studio/media/${privateFile}`, { headers: { cookie: pd } })).status, 200);
  assert.equal((await fetch(`${base}/api/studio/media/${privateFile}`, { headers: { cookie: writer.cookie } })).status, 404, '참여하지 않은 프로젝트 파일 차단');

  // 소유자가 실행한 AI 조수 계획은 다른 역할의 팀원이 대신 되돌릴 수 없다.
  const foreignUndo = randomUUID();
  await testDb.run("INSERT INTO studio_chat (id,project_id,user_id,role,content,plan,status,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [foreignUndo, cp, 'demo-pd', 'assistant', '', '[]', 'applied', JSON.stringify({ results: [], undo: [], jobs: [] }), new Date().toISOString()]);
  assert.equal((await request(`/studio/ai/projects/${cp}/assistant/${foreignUndo}/undo`, { method: 'POST', cookie: editor.cookie })).status, 403);

  // 동시 편집: 다른 사람이 먼저 고치면 덮어쓰기 경고
  const conflictShot = d.episodes[0].shots[1];
  assert.equal((await request(`/studio/ai/shots/${conflictShot.id}`, { method: 'PATCH', cookie: editor.cookie, body: full(conflictShot, { camera: '와이드', base_updated_at: conflictShot.updated_at }) })).status, 200);
  const conflict = await request(`/studio/ai/shots/${conflictShot.id}`, { method: 'PATCH', cookie: writer.cookie, body: full(conflictShot, { dialogue: '다시', base_updated_at: conflictShot.updated_at }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'edit_conflict');

  // 지금 편집 중
  await request(`/studio/ai/projects/${cp}/presence`, { method: 'POST', cookie: writer.cookie, body: { target: 'script' } });
  const live = (await request(`/studio/ai/projects/${cp}/presence`, { method: 'POST', cookie: editor.cookie, body: { target: 'scene' } })).data;
  assert.ok(live.some((x) => x.name === '드라마 writer' && x.target === 'script'));

  // 댓글 · @멘션
  const c = await request(`/studio/ai/projects/${cp}/comments`, { method: 'POST', cookie: reviewer.cookie, body: { target_type: 'shot', target_id: shot.id, body: '@드라마 writer 이 대사 조금 짧게요' } });
  assert.equal(c.status, 201);
  assert.equal(c.data.mentioned, 1);
  const [note] = await testDb.all("SELECT title FROM notifications WHERE user_id=? AND kind='studio_mention'", [writer.id]);
  assert.ok(note);
  assert.equal((await request(`/studio/ai/projects/${cp}/comments/${c.data.id}`, { method: 'DELETE', cookie: writer.cookie })).status, 403, '남의 댓글은 못 지움');
  assert.equal((await request(`/studio/ai/projects/${cp}/comments/${c.data.id}`, { method: 'PATCH', cookie: writer.cookie, body: { resolved: true } })).status, 200);
  const list = (await request(`/studio/ai/projects/${cp}/comments?target_type=shot&target_id=${shot.id}`, { cookie: pd })).data;
  assert.equal(list[0].resolved, true);

  // 승인: 대본 요청(작가) → 승인(검수자). 작가는 승인 불가. 대본이 바뀌면 승인 초기화.
  const eid = d.episodes[0].id;
  const review = (who, body) => request(`/studio/ai/projects/${cp}/episodes/${eid}/review`, { method: 'POST', cookie: who, body });
  assert.equal((await review(writer.cookie, { stage: 'script', action: 'request' })).status, 200);
  assert.equal((await review(writer.cookie, { stage: 'script', action: 'approve' })).status, 403);
  assert.equal((await review(reviewer.cookie, { stage: 'script', action: 'changes' })).status, 400, '수정 요청은 한 줄 필요');
  assert.equal((await review(reviewer.cookie, { stage: 'script', action: 'approve' })).status, 200);
  assert.equal((await review(reviewer.cookie, { stage: 'final', action: 'approve' })).status, 400, '합성 전에는 합성본 승인 불가');
  d = await detail(cp);
  assert.equal(d.episodes[0].script_review, 'approved');
  assert.equal((await run({ action: 'bridge_shot', targetId: shot.id }, writer.cookie, cp)).status, 201);
  d = await waitIdle(cp);
  assert.equal(d.episodes[0].script_review, '', '대본이 바뀌면 다시 승인');
  // 승인 없는 회차는 내보내기 막힘(소유자 강행 가능)
  await testDb.run("UPDATE studio_episodes SET video='/uploads/none.mp4',status='composed' WHERE id=?", [eid]);
  await testDb.run("UPDATE studio_episodes SET video='/uploads/none.mp4',status='composed' WHERE project_id=?", [cp]);
  const exp = await request(`/studio/ai/projects/${cp}/export`, { method: 'POST', cookie: pd, body: { tagline: '비 오는 밤의 편지', image: '/images/channel-atelier.webp' } });
  assert.equal(exp.status, 409, JSON.stringify(exp.data));
  assert.equal(exp.data.code, 'approval_required');
  const forced = await request(`/studio/ai/projects/${cp}/export`, { method: 'POST', cookie: pd, body: { tagline: '비 오는 밤의 편지', image: '/images/channel-atelier.webp', forceApproval: true } });
  assert.notEqual(forced.data?.code, 'approval_required');
  assert.equal((await request(`/studio/ai/projects/${cp}/export`, { method: 'POST', cookie: editor.cookie, body: { tagline: '비 오는 밤의 편지' } })).status, 403, '내보내기는 소유자만');

  // 활동 기록
  const act = (await request(`/studio/ai/projects/${cp}/activity`, { cookie: reviewer.cookie })).data;
  const acts = act.map((a) => a.action);
  for (const k of ['join', 'invite', 'link', 'role', 'comment', 'review_request', 'review_approve', 'ai_run']) assert.ok(acts.includes(k), k);

  // 멤버 내보내기 · 스스로 나가기 · 기능 끄기
  assert.equal((await request(`/studio/ai/projects/${cp}/members/${reviewer.id}`, { method: 'DELETE', cookie: reviewer.cookie })).status, 200, '스스로 나가기');
  assert.equal((await request(`/studio/ai/projects/${cp}`, { cookie: reviewer.cookie })).status, 404);
  assert.equal((await request(`/studio/ai/projects/${cp}/members/${editor.id}`, { method: 'DELETE', cookie: writer.cookie })).status, 403, '작가는 다른 사람을 못 뺌');
  assert.equal((await settings({ studio_collab_enabled: 0 })).status, 200);
  assert.equal((await request(`/studio/ai/projects/${cp}`, { cookie: writer.cookie })).status, 404, '협업을 끄면 접근 불가');
  assert.equal((await request('/studio/ai/overview', { cookie: writer.cookie })).data.shared.length, 0);
  assert.equal((await settings({ studio_collab_enabled: 1 })).status, 200);
  assert.equal((await request(`/studio/ai/projects/${cp}`, { cookie: writer.cookie })).status, 200, '다시 켜면 그대로');
  const adminAi = (await request('/admin/ai', { cookie: admin })).data;
  assert.ok(adminAi.collab.members >= 2);
});

test('owner can duplicate a project with ids remapped', async () => {
  const src = await detail();
  const r = await request(`/studio/ai/projects/${pid}/duplicate`, { method: 'POST', cookie: pd });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const d = await detail(r.data.id);
  assert.match(d.project.title, /복사본$/);
  assert.equal(d.characters.length, src.characters.length);
  assert.equal(d.episodes.length, src.episodes.length);
  const ids = new Set(d.characters.map((c) => c.id));
  const shot = d.episodes.flatMap((e) => e.shots).find((s) => s.speaker_id);
  assert.ok(ids.has(shot.speaker_id), '화자가 새 인물 ID로');
  assert.ok(!src.characters.some((c) => c.id === shot.speaker_id));
  for (const rel of JSON.parse(d.project.relations || '[]')) assert.ok(ids.has(rel.a) && ids.has(rel.b));
  assert.equal(d.episodes.filter((e) => e.video).length, 0);
  assert.equal(d.jobs.length, 0);
  // 원본은 그대로
  assert.equal((await detail()).episodes[0].shots.length, src.episodes[0].shots.length);
});

test('video to script: subtitles of my uploaded episodes become a new project script', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const sources = (await request('/studio/ai/reverse/sources', { cookie: pd })).data;
  assert.ok(Array.isArray(sources));
  const [d] = await testDb.all("SELECT d.id FROM dramas d JOIN episodes e ON e.drama_id=d.id WHERE d.owner_id='demo-pd' AND e.video<>'' GROUP BY d.id LIMIT 1");
  assert.ok(d, '데모 PD 작품');
  await testDb.run("UPDATE episodes SET subtitles='' WHERE drama_id=? AND number IN (1,2)", [d.id]);
  const none = await request('/studio/ai/reverse', { method: 'POST', cookie: pd, body: { dramaId: d.id, numbers: [1] } });
  assert.equal(none.status, 400);
  assert.match(none.data.error, /자막이 없어요/);
  // 남의 작품은 불가
  const other = await newPd('reverse-other');
  assert.equal((await request('/studio/ai/reverse', { method: 'POST', cookie: other.cookie, body: { dramaId: d.id, numbers: [1] } })).status, 404);
  const file = randomUUID() + '.vtt';
  await mkdir(path.join(dataDir, 'uploads', 'subtitles'), { recursive: true });
  await writeFile(path.join(dataDir, 'uploads', 'subtitles', file), 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n이제 와서 무슨 말이야?\n\n2\n00:00:02.000 --> 00:00:04.000\n<i>나도 몰랐어. 정말이야.</i>\n\n3\n00:00:04.000 --> 00:00:06.000\n그 편지, 누가 보낸 거야?\n');
  await testDb.run('UPDATE episodes SET subtitles=? WHERE drama_id=? AND number=1', [file, d.id]);
  const created = await request('/studio/ai/reverse', { method: 'POST', cookie: pd, body: { dramaId: d.id, numbers: [1] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const rid = created.data.id;
  let r = await detail(rid);
  assert.match(r.project.source_text, /1화 자막/);
  assert.doesNotMatch(r.project.source_text, /-->|WEBVTT|<i>/, '시간·태그는 뺌');
  assert.equal(r.episodes.length, 1);
  assert.equal((await run({ action: 'reverse_script' }, pd, rid)).status, 201);
  r = await waitIdle(rid);
  assert.match(r.project.script_text, /민준: 이제 와서 무슨 말이야\?/);
  assert.equal((await run({ action: 'parse_script' }, pd, rid)).status, 201);
  r = await waitIdle(rid);
  assert.ok(r.episodes[0].shots.length >= 3);
  assert.ok(r.characters.some((c) => c.name === '민준'));
});

test('bulk production: autopilot only makes the chosen episode range and retries failed stages', async () => {
  const created = await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '대량 제작', logline: '세 번의 기회, 세 개의 거짓말이 이어지는 이야기', genre: '스릴러', episode_count: 3, episode_seconds: 20 } });
  const bid = created.data.id;
  const body = { from: 2, to: 2, retries: 1, choices: { text: { requested: 'auto', tier: 'standard' }, image: { requested: 'auto', tier: 'draft' }, tts: { requested: 'auto', tier: 'standard' } } };
  const all = (await request(`/studio/ai/projects/${bid}/autopilot/estimate`, { method: 'POST', cookie: pd, body: { ...body, from: undefined, to: undefined } })).data;
  const one = (await request(`/studio/ai/projects/${bid}/autopilot/estimate`, { method: 'POST', cookie: pd, body })).data;
  assert.equal(one.stages.find((s) => s.stage === 'script').count, 1, '범위 안 회차만 계산');
  assert.equal(all.stages.find((s) => s.stage === 'script').count, 3);
  assert.ok(one.total < all.total);
  assert.equal((await request(`/studio/ai/projects/${bid}/autopilot`, { method: 'POST', cookie: pd, body })).status, 201);
  let p;
  for (let i = 0; i < 600; i++) {
    p = await detail(bid);
    if (p.autopilot?.status !== 'running') break;
    await sleep(300);
  }
  assert.equal(p.autopilot.status, 'done', p.autopilot.message);
  const [e1, e2, e3] = p.episodes;
  assert.equal(e2.status, 'composed');
  assert.equal(e1.shots.length, 0, '범위 밖 회차는 그대로');
  assert.equal(e3.shots.length, 0);
  // 계속 실패하는 단계: 정한 횟수만큼 다시 시도한 뒤 멈춤
  const bad = await request('/studio/ai/projects', { method: 'POST', cookie: pd, body: { title: '실패 연습', logline: 'MOCK_FAIL 로 늘 실패하는 기획 테스트', genre: '스릴러', episode_count: 1, episode_seconds: 20 } });
  assert.equal((await request(`/studio/ai/projects/${bad.data.id}/autopilot`, { method: 'POST', cookie: pd, body: { ...body, from: undefined, to: undefined, retries: 2 } })).status, 201);
  for (let i = 0; i < 600; i++) {
    p = await detail(bad.data.id);
    if (p.autopilot?.status !== 'running' && !p.jobs.some((j) => ['queued', 'running'].includes(j.status))) break;
    await sleep(300);
  }
  assert.equal(p.autopilot.status, 'paused');
  assert.match(p.autopilot.message, /2번 다시 시도해도/);
  assert.equal(p.jobs.filter((j) => j.kind === 'plan').length, 3, '처음 1번 + 다시 시도 2번');
});

test('assistant can plan AI review and bridge shots', async () => {
  const d0 = await detail();
  const ep = d0.episodes[0];
  const msg = await request(`/studio/ai/projects/${pid}/assistant`, { method: 'POST', cookie: pd, body: { message: '1번 컷 검수하고 뒤에 사이 컷 넣어 줘', episodeId: ep.id } });
  assert.equal(msg.status, 201, JSON.stringify(msg.data));
  const d = await waitIdle();
  const bot = d.chat.find((m) => m.id === msg.data.id);
  assert.equal(bot.status, 'ready', JSON.stringify(bot));
  const v = bot.plan.find((a) => a.type === 'verify_shot');
  const b = bot.plan.find((a) => a.type === 'bridge_shot');
  assert.ok(v && b, JSON.stringify(bot.plan));
  assert.ok(b.ok && b.lama >= 1, JSON.stringify(b));
  assert.ok(v.ok || /이미지/.test(v.error || ''), JSON.stringify(v));
  const applied = await request(`/studio/ai/projects/${pid}/assistant/${bot.id}/apply`, { method: 'POST', cookie: pd, body: {} });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const after = await waitIdle();
  assert.equal(after.episodes[0].shots.length, ep.shots.length + 1, '사이 컷이 들어감');
});
