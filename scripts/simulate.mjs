// 숏핑 통합 시뮬레이션: 여러 PD가 동시에 AI 제작·취소·한도·정리 기능을 쓰는 상황을 흉내 내고
// 끝난 뒤 라마 장부·지갑·작업 상태·파일이 서로 맞는지 전수 확인합니다.
// 실행: npm run simulate  (임시 데이터는 data/sim-* 폴더에 만들어지며 운영 데이터는 건드리지 않습니다)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const port = 3150,
  base = `http://127.0.0.1:${port}`,
  dataDir = path.resolve('data/sim-' + randomUUID());
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(url, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const db = () => {
  const d = new DatabaseSync(path.join(dataDir, 'shortping.sqlite'));
  d.exec('PRAGMA busy_timeout=5000');
  return d;
};
const q = (sql, p = []) => {
  const d = db();
  try {
    return d.prepare(sql).all(...p);
  } finally {
    d.close();
  }
};

const child = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', PORT: String(port), APP_ORIGIN: base, ENABLE_DEMO: 'true', DATA_DIR: dataDir, UPLOAD_DIR: path.join(dataDir, 'uploads') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {}
    if (i > 150) throw new Error('server did not start\n' + log);
    await sleep(200);
  }
  const admin = (await request('/auth/demo', { method: 'POST', body: { role: 'admin' } })).cookie;

  // ── 1) PD 6명 준비 ─────────────────────────────────────────
  const pds = [];
  for (let i = 0; i < 6; i++) {
    const email = `sim${i}-${randomUUID().slice(0, 6)}@sim.test`;
    const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'SimTest!2026', name: '시뮬 PD ' + i } });
    await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role: 'pd', status: 'active', name: '시뮬 PD ' + i, phone: '' } });
    const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'SimTest!2026' } })).cookie;
    await request('/studio/ai/terms', { method: 'POST', cookie, body: { agree: true, version: '2026-09' } });
    await request('/lama', { cookie });
    const pid = (await request('/studio/ai/projects', { method: 'POST', cookie, body: { title: '시뮬 ' + i, logline: '동시에 여러 작업을 돌려 본다', genre: '로맨스', episode_count: 2, episode_seconds: 20 } })).data.id;
    pds.push({ id: reg.data.user.id, cookie, pid });
  }
  check('PD 6명·프로젝트 6개 생성', pds.length === 6);

  // ── 2) 한도 규칙: PD0 하루 0, PD1 월 0, PD2 하루 5 ─────────────
  await request(`/admin/ai/limits/${pds[0].id}`, { method: 'PUT', cookie: admin, body: { daily_lama: 0, monthly_lama: null, blocked: false } });
  await request(`/admin/ai/limits/${pds[1].id}`, { method: 'PUT', cookie: admin, body: { daily_lama: null, monthly_lama: 0, blocked: false } });
  await request(`/admin/ai/limits/${pds[2].id}`, { method: 'PUT', cookie: admin, body: { daily_lama: 5, monthly_lama: null, blocked: false } });
  const run = (pd, body) => request(`/studio/ai/projects/${pd.pid}/run`, { method: 'POST', cookie: pd.cookie, body });
  const r0 = await run(pds[0], { action: 'plan', requested: 'mock-writer' });
  const r1 = await run(pds[1], { action: 'plan', requested: 'mock-writer' });
  check('개인 하루 한도 0 → 작업 차단', r0.status === 429, r0.data?.error);
  check('개인 월 한도 0 → 작업 차단', r1.status === 429, r1.data?.error);

  // ── 3) 동시 폭주: PD2~5가 기획안을 동시에 여러 번(멱등키 섞어서) ──────
  const burst = [];
  const sharedKey = randomUUID();
  for (const pd of pds.slice(2)) for (let k = 0; k < 4; k++) burst.push(run(pd, { action: 'plan', requested: 'mock-writer', idempotencyKey: pd === pds[3] ? sharedKey : undefined }));
  const burstRes = await Promise.all(burst);
  const statuses = burstRes.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  check('동시 요청 16건 모두 정상 응답(500 없음)', !burstRes.some((r) => r.status >= 500), JSON.stringify(statuses));
  const pd3Jobs = new Set(burstRes.slice(4, 8).map((r) => r.data?.jobs?.[0]?.id));
  check('같은 멱등키 4번 동시 요청 → 작업 1개', pd3Jobs.size === 1);

  // ── 4) 취소와 완료가 겹치는 상황 ─────────────────────────────
  for (const pd of pds.slice(3)) {
    const r = await run(pd, { action: 'poster', requested: 'mock-image' });
    const id = r.data?.jobs?.[0]?.id;
    if (id) await request(`/studio/ai/jobs/${id}/cancel`, { method: 'POST', cookie: pd.cookie });
  }
  // 모든 작업이 끝날 때까지 대기
  for (let i = 0; i < 300; i++) {
    const left = q("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued','running')")[0].n;
    if (!left) break;
    await sleep(200);
  }
  const stuck = q("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued','running')")[0].n;
  check('멈춘 작업 없음(대기·실행 0건)', stuck === 0, `남은 작업 ${stuck}`);

  // ── 5) 장부 대조: 지갑 = 장부 누적, 예약 라마 0, 작업별 차감 합 = 장부 사용 ─────
  let ledgerOk = true,
    heldOk = true,
    spendOk = true;
  for (const pd of pds) {
    const w = q('SELECT paid_balance,bonus_balance,held_paid,held_bonus FROM lama_wallets WHERE user_id=?', [pd.id])[0];
    const l = q('SELECT COALESCE(SUM(paid_delta),0) AS p, COALESCE(SUM(bonus_delta),0) AS b, COALESCE(SUM(held_delta),0) AS h FROM lama_ledger WHERE user_id=?', [pd.id])[0];
    if (Number(w.paid_balance) !== Number(l.p) || Number(w.bonus_balance) !== Number(l.b)) ledgerOk = false;
    if (Number(w.held_paid) + Number(w.held_bonus) !== 0 || Number(l.h) !== 0) heldOk = false;
    const charged = q("SELECT COALESCE(SUM(charged_lama),0) AS n FROM ai_jobs WHERE user_id=? AND status='succeeded'", [pd.id])[0].n;
    const spent = 300 - (Number(w.paid_balance) + Number(w.bonus_balance));
    if (Number(charged) !== spent) spendOk = false;
  }
  check('지갑 잔액 = 장부 누적(6명 전원)', ledgerOk);
  check('예약(held) 라마가 남지 않음', heldOk);
  check('성공 작업 차감 합계 = 실제 줄어든 라마', spendOk);
  const canceled = q("SELECT COUNT(*) AS n FROM ai_jobs WHERE status='canceled'")[0].n;
  const orphanResults = q("SELECT COUNT(*) AS n FROM media_files m WHERE m.url IN (SELECT json_extract(output,'$.url') FROM ai_jobs WHERE status='canceled')")[0].n;
  check('취소된 작업의 결과 파일이 남지 않음', Number(orphanResults) === 0, `취소 ${canceled}건`);

  // ── 6) 관리자 오류 표시: 실패 작업을 만들고 PD·관리자 화면 비교 ─────────
  const prov = await request('/admin/ai/providers', { method: 'POST', cookie: admin, body: { name: '시뮬 고장 공급사', kind: 'openai_compatible', base_url: 'https://127.0.0.1:9/v1', api_key: 'sk-sim-secret-123456', country: 'KR' } });
  if (prov.status === 201 || prov.status === 200) {
    const pvId = prov.data.id;
    const m = await request('/admin/ai/models', { method: 'POST', cookie: admin, body: { provider_id: pvId, capability: 'text', model_id: 'broken', label: '시뮬 고장 작가', tier: 'standard', cost_usd: 0.001, price_lama: 1, tags: ['story'], max_seconds: 10, image_input: false, priority: 10, notes: '' } });
    const r = await run(pds[4], { action: 'plan', requested: m.data?.id });
    for (let i = 0; i < 200; i++) {
      if (!q("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued','running')")[0].n) break;
      await sleep(200);
    }
    const pdView = (await request('/studio/ai/projects/' + pds[4].pid, { cookie: pds[4].cookie })).data.jobs.find((j) => j.status === 'failed');
    const adminView = (await request('/admin/ai', { cookie: admin })).data.jobs.find((j) => j.id === pdView?.id);
    check('실패 작업 생성', r.status === 201 && !!pdView, r.data?.error || '');
    check('PD 화면: 정리된 문구만(키·주소 없음)', pdView && !/sk-|127\.0\.0\.1|https?:/.test(pdView.error) && !('error_detail' in pdView), pdView?.error);
    check('관리자 화면: 정리 문구 + 원문 함께', adminView && adminView.error === pdView.error && !!adminView.error_detail, adminView?.error_detail?.slice(0, 80));
    const w = q('SELECT held_paid+held_bonus AS h FROM lama_wallets WHERE user_id=?', [pds[4].id])[0];
    check('실패 작업 라마 전액 반환', Number(w.h) === 0);
  } else check('고장 공급사 등록', false, JSON.stringify(prov.data));

  // ── 7) 저장 공간 정리: 기본 91일 → 기간 변경 → 정리 ─────────────────
  const st = (await request('/admin/storage', { cookie: admin })).data;
  check('보관 기간 기본값 91일', st.retention_days === 91);
  const uploads = path.join(dataDir, 'uploads');
  const files = { old: randomUUID() + '.jpg', mid: randomUUID() + '.jpg', usedOld: randomUUID() + '.jpg' };
  for (const f of Object.values(files)) writeFileSync(path.join(uploads, f), 'x'.repeat(4096));
  const d = db();
  const ago = (n) => new Date(Date.now() - n * 86400000).toISOString();
  d.prepare('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)').run('/uploads/' + files.old, pds[5].id, 'image/jpeg', ago(100));
  d.prepare('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)').run('/uploads/' + files.mid, pds[5].id, 'image/jpeg', ago(40));
  d.prepare('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)').run('/uploads/' + files.usedOld, pds[5].id, 'image/jpeg', ago(300));
  d.prepare('UPDATE channels SET banner=? WHERE id=(SELECT id FROM channels LIMIT 1)').run('/uploads/' + files.usedOld);
  d.close();
  let c = await request('/admin/storage/cleanup', { method: 'POST', cookie: admin });
  check('91일: 100일 된 미사용 파일만 삭제', !existsSync(path.join(uploads, files.old)) && existsSync(path.join(uploads, files.mid)) && existsSync(path.join(uploads, files.usedOld)), `삭제 ${c.data?.deleted}개`);
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { media_retention_days: 30 } });
  c = await request('/admin/storage/cleanup', { method: 'POST', cookie: admin });
  check('30일로 바꾸면 40일 된 파일도 삭제, 배너로 쓰는 파일은 유지', !existsSync(path.join(uploads, files.mid)) && existsSync(path.join(uploads, files.usedOld)), `삭제 ${c.data?.deleted}개`);
  const bad = await request('/admin/settings', { method: 'PUT', cookie: admin, body: { media_retention_days: 3 } });
  check('3일처럼 너무 짧은 기간은 거절', bad.status === 400);
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { media_retention_days: 0 } });
  const off = await request('/admin/storage/cleanup', { method: 'POST', cookie: admin });
  check('0(끔)이면 정리 실행 거절', off.status === 400);
  // 강한 점검: AI 결과물(포스터·인물 이미지)을 실제로 만든 뒤, 모든 파일을 400일 전 파일로 바꾸고 정리해도
  // 쓰이는 파일은 하나도 지워지지 않아야 합니다.
  await run(pds[5], { action: 'plan', requested: 'mock-writer' });
  for (let i = 0; i < 200 && q("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued','running')")[0].n; i++) await sleep(200);
  const proj5 = (await request('/studio/ai/projects/' + pds[5].pid, { cookie: pds[5].cookie })).data;
  for (const ch of proj5.characters) await run(pds[5], { action: 'character_image', targetId: ch.id, requested: 'mock-image' });
  await run(pds[5], { action: 'poster', requested: 'mock-image' });
  for (let i = 0; i < 300 && q("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued','running')")[0].n; i++) await sleep(200);
  const d2 = db();
  d2.prepare('UPDATE media_files SET created_at=?').run(ago(400));
  d2.close();
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { media_retention_days: 30 } });
  const beforeCount = q('SELECT COUNT(*) AS n FROM media_files')[0].n;
  const sweepAll = await request('/admin/storage/cleanup', { method: 'POST', cookie: admin });
  await request('/admin/settings', { method: 'PUT', cookie: admin, body: { media_retention_days: 0 } });
  check('400일 된 파일로 바꾼 뒤 정리해도 쓰이는 파일은 유지', sweepAll.status === 200, `정리 전 ${beforeCount}개 → 삭제 ${sweepAll.data?.deleted}개`);
  // 사용 중인 모든 파일이 실제로 남아 있는지(작품 포스터·AI 결과 등)
  const referenced = q("SELECT url FROM studio_assets UNION SELECT poster FROM studio_projects WHERE poster<>'' UNION SELECT image FROM studio_characters WHERE image<>'' UNION SELECT image FROM studio_shots WHERE image<>''");
  const missing = referenced.filter((r) => r.url?.startsWith('/uploads/') && (!existsSync(path.join(uploads, path.basename(r.url))) || !q('SELECT 1 FROM media_files WHERE url=?', [r.url]).length));
  check('사용 중인 AI 결과 파일은 하나도 지워지지 않음', missing.length === 0, `확인 ${referenced.length}개`);

  // ── 8) 기존 핵심 기능 회귀: 시청자 핑 충전·회차 열기·재생 ─────────────
  const viewer = (await request('/auth/demo', { method: 'POST', body: { role: 'viewer' } })).cookie;
  const charge = await request('/pings/charge', { method: 'POST', cookie: viewer, body: { productId: 'ping-10k', idempotencyKey: randomUUID() } });
  const unlock = await request('/pings/unlock', { method: 'POST', cookie: viewer, body: { dramaId: 'midnight', episode: 5, idempotencyKey: randomUUID() } });
  const play = await fetch(`${base}/api/play/midnight/5`, { headers: { cookie: viewer, range: 'bytes=0-99' } });
  check('시청자 핑 충전', charge.status === 200, `잔액 ${charge.data?.wallet?.total}`);
  check('회차 열기(핑 차감)', unlock.status === 200, `남은 핑 ${unlock.data?.wallet?.total}`);
  check('열린 회차 재생', play.status === 206 || play.status === 200);
  const settle = q("SELECT COUNT(*) AS n FROM settlement_entries WHERE order_id=?", [unlock.data?.id])[0].n;
  check('회차 열기 매출이 정산 장부에 기록', Number(settle) === 1);
  // ── 9) AI 드라마 고도화 전 과정: PD 2명이 동시에 '빠른 제작'(설정집·시즌·영상·입 모양·효과음·배경음악 포함)
  //       → 작품 내보내기 · 검수 → 승인 알림 → 연재 새 회차(예약 공개 · 회차 검수) → 앱 토큰으로 영상 열기 ─────
  const makers = [];
  for (let i = 0; i < 2; i++) {
    const email = `simq${i}-${randomUUID().slice(0, 6)}@sim.test`;
    const reg = await request('/auth/register', { method: 'POST', body: { email, password: 'SimTest!2026', name: '빠른 PD ' + i } });
    await request('/admin/members/' + reg.data.user.id, { method: 'PATCH', cookie: admin, body: { role: 'pd', status: 'active', name: '빠른 PD ' + i, phone: '' } });
    const cookie = (await request('/auth/login', { method: 'POST', body: { email, password: 'SimTest!2026' } })).cookie;
    await request('/studio/ai/terms', { method: 'POST', cookie, body: { agree: true, version: '2026-09' } });
    await request('/lama', { cookie });
    await request('/admin/lama/adjust', { method: 'POST', cookie: admin, body: { userId: reg.data.user.id, action: 'grant', lama: 30000, memo: '시뮬 빠른 제작' } });
    const pid = (await request('/studio/ai/projects', { method: 'POST', cookie, body: { title: '빠른 제작 ' + i, logline: '비 오는 밤 편지 한 장이 두 사람의 과거를 깨운다', genre: '로맨스', episode_count: 2, episode_seconds: 20 } })).data.id;
    makers.push({ id: reg.data.user.id, email, cookie, pid });
  }
  const pick = (id) => ({ requested: id, tier: 'standard' });
  const choices = { text: pick('mock-writer'), image: pick('mock-image'), tts: pick('mock-voice'), video: pick('mock-video-fast'), music: pick('mock-music'), sfx: pick('mock-sfx'), lipsync: pick('mock-lipsync') };
  const quick = { choices, includeBible: true, includeVideo: true, includeLipsync: true, includeSfx: true, includeMusic: true, musicMood: '잔잔한 피아노' };
  const starts = await Promise.all(makers.map((m) => request(`/studio/ai/projects/${m.pid}/autopilot`, { method: 'POST', cookie: m.cookie, body: quick })));
  check('빠른 제작 2건 동시 시작', starts.every((r) => r.status === 201), starts.map((r) => r.status + ' ' + (r.data?.error || '')).join(' / '));
  const waitAuto = async (m, limit = 240000) => {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      const d = (await request('/studio/ai/projects/' + m.pid, { cookie: m.cookie })).data;
      if (d?.autopilot && d.autopilot.status !== 'running' && !d.jobs.some((j) => ['queued', 'running'].includes(j.status)) && !d.episodes.some((e) => e.status === 'composing')) return d;
      await sleep(500);
    }
    return (await request('/studio/ai/projects/' + m.pid, { cookie: m.cookie })).data;
  };
  const done = await Promise.all(makers.map((m) => waitAuto(m)));
  for (const [i, d] of done.entries()) {
    const shots = d.episodes.flatMap((e) => e.shots);
    check(`빠른 제작 ${i}: 끝까지 완료`, d.autopilot?.status === 'done', d.autopilot?.message);
    check(`빠른 제작 ${i}: 설정집 · 시즌 설계`, !!d.project.bible && !!d.project.season && d.episodes.every((e) => e.hook));
    check(`빠른 제작 ${i}: 모든 컷 이미지 · 영상, 대사 음성`, shots.length > 0 && shots.every((x) => x.image && x.video) && shots.filter((x) => x.dialogue).every((x) => x.audio), `컷 ${shots.length}개`);
    check(`빠른 제작 ${i}: 입 모양 · 효과음 · 배경음악`, shots.some((x) => x.lipsync) && shots.some((x) => x.sfx) && !!d.project.bgm, `입 모양 ${shots.filter((x) => x.lipsync).length} · 효과음 ${shots.filter((x) => x.sfx).length}`);
    check(`빠른 제작 ${i}: 두 회차 모두 합성`, d.episodes.every((e) => e.status === 'composed' && e.video && Number(e.duration) > 0), d.episodes.map((e) => e.status + ' ' + e.duration + '초').join(', '));
  }
  // 한 명은 작품으로 내보내 검수 → 승인, 알림 확인
  const m0 = makers[0];
  const ex = await request(`/studio/ai/projects/${m0.pid}/export`, { method: 'POST', cookie: m0.cookie, body: { tagline: '비 오는 밤의 편지', hashtags: ['로맨스', '비밀'], free_episodes: 1, submit: true } });
  check('작품 내보내기 · 검수 신청', ex.status === 200 && ex.data.submitted, JSON.stringify(ex.data));
  const dramaId = ex.data?.dramaId;
  const approve = await request(`/admin/dramas/${dramaId}/review`, { method: 'POST', cookie: admin, body: { status: 'published', note: '' } });
  check('관리자 작품 승인', approve.status === 200, approve.data?.error);
  const notes = (await request('/notifications', { cookie: m0.cookie })).data;
  check('PD에게 승인 · 합성 · 빠른 제작 완료 알림', ['drama_review', 'compose', 'autopilot'].every((k) => notes?.list?.some((n) => n.kind === k)), notes?.list?.map((n) => n.kind).join(','));
  const visible = async () => (await request('/dramas/' + dramaId)).data;
  check('시청자에게 2화까지 공개', Number((await visible())?.episodes?.length ?? (await visible())?.episode_count) === 2);
  // 연재: 3화 추가 → 빠른 제작으로 채우기 → 예약 공개로 회차 검수 신청
  await request('/studio/ai/projects/' + m0.pid, { method: 'PATCH', cookie: m0.cookie, body: { episode_count: 3 } });
  const again = await request(`/studio/ai/projects/${m0.pid}/autopilot`, { method: 'POST', cookie: m0.cookie, body: quick });
  check('연재 3화 빠른 제작 시작', again.status === 201, again.data?.error);
  const d3 = await waitAuto(m0);
  check('3화까지 합성 완료', d3.episodes.length === 3 && d3.episodes.every((e) => e.status === 'composed'), d3.autopilot?.message);
  const later = new Date(Date.now() + 3600000).toISOString();
  const serial = await request(`/studio/ai/projects/${m0.pid}/export`, { method: 'POST', cookie: m0.cookie, body: { tagline: '비 오는 밤의 편지', publish_at: later, submit: true } });
  check('새 회차만 회차 검수로 신청', serial.status === 200 && serial.data.serial && serial.data.numbers.join() === '3', JSON.stringify(serial.data));
  check('검수 전에는 시청자에게 2화만', Number((await visible())?.episodes?.length ?? 0) === 2);
  const queue = (await request('/admin/episodes/review', { cookie: admin })).data || [];
  const ep3 = queue.find((x) => x.drama_id === dramaId && Number(x.number) === 3);
  const ok3 = ep3 ? await request(`/admin/episodes/${ep3.id}/review`, { method: 'POST', cookie: admin, body: { status: 'approved' } }) : { status: 0 };
  check('회차 승인 → 예약 대기', ok3.status === 200 && ok3.data.status === 'scheduled', JSON.stringify(ok3.data));
  const now3 = await request(`/studio/dramas/${dramaId}/episodes/3/schedule`, { method: 'PATCH', cookie: m0.cookie, body: { publish_at: null } });
  check('예약을 지우면 바로 공개 → 시청자에게 3화', now3.status === 200 && Number((await visible())?.episodes?.length ?? 0) === 3);
  // 앱(토큰 로그인)으로 PD가 자기 회차 영상을 미디어 토큰으로 연다
  const appLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'app', Origin: 'capacitor://localhost' }, body: JSON.stringify({ email: m0.email, password: 'SimTest!2026' }) }).then((r) => r.json());
  const mtok = await fetch(base + '/api/auth/media-token', { headers: { Authorization: 'Bearer ' + appLogin.token } }).then((r) => r.json());
  const file = d3.episodes[0].video.split('/').pop();
  const media = await fetch(`${base}/api/studio/media/${file}?mt=${encodeURIComponent(mtok.token)}`, { headers: { range: 'bytes=0-99' } });
  const other = await fetch(`${base}/api/studio/media/${file}`, { headers: { cookie: makers[1].cookie, range: 'bytes=0-99' } });
  check('앱: 토큰 로그인 → 미디어 토큰으로 내 영상 재생', !!appLogin.token && [200, 206].includes(media.status), String(media.status));
  check('다른 PD는 남의 스튜디오 영상을 못 연다', other.status === 404, String(other.status));
  // 빠른 제작 PD들의 라마 장부도 맞는지
  let qOk = true;
  for (const m of makers) {
    const w = q('SELECT paid_balance,bonus_balance,held_paid,held_bonus FROM lama_wallets WHERE user_id=?', [m.id])[0];
    const l = q('SELECT COALESCE(SUM(paid_delta),0) AS p, COALESCE(SUM(bonus_delta),0) AS b, COALESCE(SUM(held_delta),0) AS h FROM lama_ledger WHERE user_id=?', [m.id])[0];
    if (Number(w.paid_balance) !== Number(l.p) || Number(w.bonus_balance) !== Number(l.b) || Number(w.held_paid) + Number(w.held_bonus) !== 0 || Number(l.h) !== 0) qOk = false;
  }
  check('빠른 제작 PD 지갑 = 장부, 예약 라마 0', qOk);

  const errors = (log.match(/TypeError|ReferenceError|UnhandledPromiseRejection|SQLITE_ERROR/g) || []).length;
  check('서버 로그에 코드 오류 없음', errors === 0, errors ? log.slice(-600) : '');
} catch (e) {
  check('시뮬레이션 실행', false, e.stack);
} finally {
  child.kill();
  const fail = results.filter((r) => !r.ok);
  console.log(`\n총 ${results.length}개 점검 · 통과 ${results.length - fail.length} · 실패 ${fail.length}`);
  try {
    writeFileSync(path.join(dataDir, 'result.json'), JSON.stringify(results, null, 2));
    console.log('결과 파일: ' + path.join(dataDir, 'result.json'));
  } catch {}
  process.exit(fail.length ? 1 : 0);
}
