import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadSettings } from '../settings.mjs';
import { LAMA_WON, captureLama, holdLama, releaseLama } from '../lama.mjs';
import { probeMedia } from '../media.mjs';
import { adapters, unitOf } from './providers.mjs';
import { mockAdapter } from './mock.mjs';
import { decrypt } from './secret.mjs';
import { download } from './http.mjs';
import { blockedTerm } from './prompts.mjs';

// AI 작업 엔진: 모델 고르기(자동/직접) → 라마 예약 → 대기열 → 공급사 호출·결과 확인 → 파일 저장 →
// 실제 사용량만 차감(나머지 반환) / 실패 시 다른 모델로 한 번 더 시도하거나 전액 반환.
const error = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const iso = () => new Date().toISOString();
const KST = 9 * 3600000;
const kstDayStart = () => {
  const d = new Date(Date.now() + KST);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - KST).toISOString();
};
const kstMonthStart = () => {
  const d = new Date(Date.now() + KST);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - KST).toISOString();
};
export const TAGS = ['dialogue', 'closeup', 'action', 'landscape', 'cinematic', 'character', 'consistency', 'lipsync', 'poster', 'korean', 'story', 'emotion', 'fast', 'cheap', 'scene'];
const TIERS = ['draft', 'standard', 'premium'];

export function adapterOf(kind) {
  if (kind === 'mock') return mockAdapter;
  return adapters[kind];
}
export function lamaPerUnit(model, settings) {
  const fixed = Number(model.price_lama || 0);
  if (fixed > 0) return fixed;
  return (Number(model.cost_usd || 0) * settings.usd_krw_rate * settings.ai_margin_rate) / 100 / LAMA_WON;
}
export function unitsFor(capability, input) {
  if (capability === 'text')
    return ((String(input.system || '').length + String(input.prompt || '').length) / 2 + (input.maxTokens || 4000) * 0.6) / 1000;
  if (capability === 'image') return Number(input.count || 1);
  if (capability === 'video') return Number(input.seconds || 5);
  if (capability === 'tts') return Math.max(0.1, String(input.text || '').length / 1000);
  if (capability === 'stt') return Math.max(0.1, Number(input.duration || 60) / 60);
  return 1;
}
export const lamaFor = (model, settings, units) => Math.max(1, Math.ceil(units * lamaPerUnit(model, settings) - 1e-9));
export const costWonFor = (model, settings, units) => Math.round(units * Number(model.cost_usd || 0) * settings.usd_krw_rate);

export function createAiEngine({ db, uploadDir, demo }) {
  const handlers = new Map();
  const workerId = randomUUID();
  const inflight = new Set();
  let timer = null;

  const modelRows = () =>
    db.all(
      `SELECT m.*, p.kind, p.name AS provider_name, p.status AS provider_status, p.active AS provider_active,
       p.api_key_enc, p.secret_enc, p.base_url, p.country, p.max_concurrency, p.monthly_budget_won, p.fail_streak, p.cooldown_until
       FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id`,
    );
  const usable = (r) =>
    Number(r.active) === 1 &&
    Number(r.provider_active) === 1 &&
    (r.kind === 'mock' ? demo : !!r.api_key_enc) &&
    !!adapterOf(r.kind);
  // 자동 선택 점수: 품질 등급 일치 > 장면 특성 태그 > 관리자 우선순위 > 가격(초안 등급은 저렴할수록 가산)
  function score(r, { tier, tags, seconds, needImage }, settings) {
    let s = 0;
    const ti = TIERS.indexOf(tier || 'standard');
    const mi = TIERS.indexOf(r.tier);
    s += ti === mi ? 40 : Math.abs(ti - mi) === 1 ? 15 : 0;
    const mt = String(r.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
    s += (tags || []).filter((t) => mt.includes(t)).length * 10;
    s += Number(r.priority || 0) * 0.3;
    if (r.provider_status === 'ok') s += 5;
    if (r.provider_status === 'error') s -= 60;
    if (seconds && r.capability === 'video' && Number(r.max_seconds) < seconds) s -= 25;
    if (needImage && Number(r.image_input) === 1) s += 8;
    const price = lamaPerUnit(r, settings);
    s -= tier === 'draft' ? price * 2 : price * 0.2;
    return s;
  }
  // 공급사 이번 달 원가(공급사별 월 예산 확인용)
  async function providerSpend() {
    const rows = await db.all(
      "SELECT provider_id, COALESCE(SUM(cost_won),0) AS n FROM ai_jobs WHERE status IN ('succeeded','queued','running') AND created_at>=? GROUP BY provider_id",
      [kstMonthStart()],
    );
    return new Map(rows.map((r) => [r.provider_id, Number(r.n)]));
  }
  const cooling = (r) => r.cooldown_until && new Date(r.cooldown_until).getTime() > Date.now();
  // 정책으로 걸러진 이유(직접 선택 시 안내용)
  function blockedReason(r, { excludeCn }, settings, spend) {
    if (r.country === 'CN' && !Number(settings.ai_allow_cn)) return '관리자가 중국 AI 모델 사용을 꺼 두었어요.';
    if (r.country === 'CN' && excludeCn) return '이 프로젝트는 중국 AI 모델을 쓰지 않도록 설정돼 있어요.';
    if (Number(r.monthly_budget_won) > 0 && (spend.get(r.provider_id) || 0) >= Number(r.monthly_budget_won))
      return `${r.provider_name}의 이번 달 예산을 모두 썼어요.`;
    return '';
  }
  async function candidates({ capability, requested = 'auto', tier, tags, seconds, needImage, excludeCn = false }, settings) {
    const spend = await providerSpend();
    const all = (await modelRows()).filter((r) => r.capability === capability && usable(r));
    const allowed = all.filter((r) => !blockedReason(r, { excludeCn }, settings, spend));
    if (requested && requested !== 'auto') {
      const one = all.find((r) => r.id === requested);
      if (!one) throw error(400, '선택한 모델을 지금 쓸 수 없어요. 자동 선택을 이용하거나 다른 모델을 골라 주세요.');
      const reason = blockedReason(one, { excludeCn }, settings, spend);
      if (reason) throw error(400, reason + ' 다른 모델을 골라 주세요.', { code: 'model_blocked' });
      return [one];
    }
    // 장애로 잠시 제외된 공급사는 다른 선택지가 없을 때만 씁니다.
    const healthy = allowed.filter((r) => !cooling(r));
    const rows = healthy.length ? healthy : allowed;
    if (!rows.length) throw error(503, '이 작업에 쓸 수 있는 AI 모델이 아직 연결되지 않았어요. 관리자에게 문의해 주세요.', { code: 'no_model' });
    const ranked = rows
      .map((r) => ({ r, s: score(r, { tier, tags, seconds, needImage }, settings) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r);
    // 관리자 라우팅 규칙(작업·등급별 우선 모델 순서)이 있으면 그 순서를 먼저 따릅니다.
    const rule = await db.get('SELECT model_ids FROM ai_route_rules WHERE capability=? AND tier=? AND active=1', [capability, tier || 'standard']);
    if (rule?.model_ids) {
      const order = String(rule.model_ids).split(',').filter(Boolean);
      const pinned = order.map((id) => ranked.find((r) => r.id === id)).filter(Boolean);
      return [...pinned, ...ranked.filter((r) => !order.includes(r.id))];
    }
    return ranked;
  }
  // 금칙어 검사: 걸리면 안전 기록을 남기고 막습니다(트랜잭션 밖에서 호출).
  async function screen({ userId, kind, texts }) {
    const settings = await loadSettings(db);
    const banned = blockedTerm(texts, settings.ai_blocked_terms);
    if (!banned) return;
    const excerpt = texts.filter(Boolean).join(' / ').replace(/\s+/g, ' ').slice(0, 300);
    await db.run('INSERT INTO ai_safety_log (id,user_id,term,excerpt,kind,created_at) VALUES (?,?,?,?,?,?)', [randomUUID(), userId, banned, excerpt, kind || '', iso()]);
    throw error(400, `사용할 수 없는 표현이 포함돼 있어요: "${banned}"`, { code: 'blocked_term' });
  }
  async function listForPicker(capability, settings) {
    return (await modelRows())
      .filter((r) => (!capability || r.capability === capability) && usable(r) && (r.country !== 'CN' || Number(settings.ai_allow_cn)))
      .map((r) => ({
        id: r.id,
        capability: r.capability,
        label: r.label,
        provider: r.provider_name,
        country: r.country,
        tier: r.tier,
        unit: r.unit,
        lama_per_unit: Math.round(lamaPerUnit(r, settings) * 100) / 100,
        max_seconds: Number(r.max_seconds),
        tags: r.tags,
        cooling: !!cooling(r),
      }));
  }
  async function estimate(opts) {
    const settings = await loadSettings(db);
    const list = await candidates(opts, settings);
    const units = opts.units ?? unitsFor(opts.capability, opts.input || {});
    return { model: list[0], lama: lamaFor(list[0], settings, units), units, alternatives: list.length };
  }
  async function checkLimits(userId, lama, costWon, settings) {
    if (!Number(settings.ai_enabled)) throw error(503, 'AI 제작이 잠시 중단된 상태예요. 관리자에게 문의해 주세요.', { code: 'ai_disabled' });
    const limit = await db.get('SELECT * FROM ai_user_limits WHERE user_id=?', [userId]);
    if (limit && Number(limit.blocked)) throw error(403, 'AI 제작 이용이 제한된 계정이에요. 관리자에게 문의해 주세요.', { code: 'ai_blocked' });
    const used = async (since) =>
      Number(
        (
          await db.get(
            "SELECT COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_lama WHEN status IN ('queued','running') THEN estimate_lama ELSE 0 END),0) AS n FROM ai_jobs WHERE user_id=? AND billed=1 AND created_at>=?",
            [userId, since],
          )
        )?.n || 0,
      );
    const daily = limit?.daily_lama ?? settings.ai_daily_limit_lama;
    if (Number(daily) > 0 && (await used(kstDayStart())) + lama > Number(daily))
      throw error(429, `오늘 쓸 수 있는 AI 제작 한도(${Number(daily).toLocaleString('ko-KR')}라마)를 넘어요. 내일 다시 이용하거나 관리자에게 한도 조정을 요청해 주세요.`, { code: 'daily_limit' });
    if (limit?.monthly_lama != null && Number(limit.monthly_lama) > 0 && (await used(kstMonthStart())) + lama > Number(limit.monthly_lama))
      throw error(429, `이번 달 AI 제작 한도(${Number(limit.monthly_lama).toLocaleString('ko-KR')}라마)를 넘어요.`, { code: 'monthly_limit' });
    const budget = Number(settings.ai_monthly_budget_won || 0);
    if (budget > 0) {
      const spent = Number(
        (await db.get("SELECT COALESCE(SUM(cost_won),0) AS n FROM ai_jobs WHERE status IN ('succeeded','queued','running') AND created_at>=?", [kstMonthStart()]))?.n || 0,
      );
      if (spent + costWon > budget)
        throw error(503, '이번 달 플랫폼 AI 예산을 모두 사용했어요. 관리자에게 문의해 주세요.', { code: 'monthly_budget' });
    }
  }
  // 작업 등록. 호출한 쪽 트랜잭션 안에서 실행되어야 대상(컷·캐릭터 등) 상태 변경과 함께 묶입니다.
  async function enqueue({ userId, kind, capability, requested = 'auto', tier = 'standard', tags = [], input, units, target = {}, projectId = null, idempotencyKey, bill = true, excludeCn = false }) {
    if (!handlers.has(kind)) throw error(500, 'unknown job kind ' + kind);
    const settings = await loadSettings(db);
    if (idempotencyKey) {
      const existing = await db.get('SELECT * FROM ai_jobs WHERE idempotency_key=?', [idempotencyKey]);
      if (existing) {
        if (existing.user_id !== userId) throw error(409, '중복 요청입니다.');
        return existing;
      }
    }
    const banned = blockedTerm([input.userText, input.prompt, input.text], settings.ai_blocked_terms);
    if (banned) throw error(400, `사용할 수 없는 표현이 포함돼 있어요: "${banned}"`, { code: 'blocked_term' });
    const list = await candidates({ capability, requested, tier, tags, seconds: input.seconds, needImage: !!input.image, excludeCn }, settings);
    const model = list[0];
    const u = units ?? unitsFor(capability, input);
    const lama = bill ? lamaFor(model, settings, u) : 0;
    const costWon = costWonFor(model, settings, u);
    await checkLimits(userId, lama, costWon, settings);
    const id = randomUUID();
    await db.run(
      'INSERT INTO ai_jobs (id,user_id,project_id,target_type,target_id,kind,capability,requested_model,model_ref,provider_id,vendor_model,tier,input,status,estimate_lama,cost_won,idempotency_key,billed,created_at,tried) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, userId, projectId, target.type || '', target.id || '', kind, capability, requested || 'auto', model.id, model.provider_id, model.model_id, tier, JSON.stringify({ ...input, tags, _excludeCn: !!excludeCn }), 'queued', lama, costWon, idempotencyKey || null, bill ? 1 : 0, iso(), model.id],
    );
    if (lama > 0) {
      const hold = await holdLama(db, { userId, amount: lama, jobId: id, memo: `${model.label} · ${kind}` });
      await db.run('UPDATE ai_jobs SET hold_paid=?,hold_bonus=? WHERE id=?', [hold.holdPaid, hold.holdBonus, id]);
    }
    kick();
    return db.get('SELECT * FROM ai_jobs WHERE id=?', [id]);
  }

  // ── 실행 ──────────────────────────────────────────────
  async function loadModel(job) {
    const r = (await modelRows()).find((x) => x.id === job.model_ref);
    if (!r) throw Object.assign(new Error('모델이 삭제되었어요.'), { retryable: true, modelGone: true });
    return r;
  }
  async function hydrate(input) {
    const out = { ...input };
    for (const field of ['image', 'refImage', 'audio']) {
      if (input[field]?.path) {
        const file = path.join(uploadDir, path.basename(input[field].path));
        out[field] = { buffer: await readFile(file), mime: input[field].mime, ext: path.extname(file).slice(1) };
      }
    }
    return out;
  }
  const ctx = (m) => ({ provider: { base_url: m.base_url, kind: m.kind }, model: m, key: m.kind === 'mock' ? '' : decrypt(m.api_key_enc), secret: m.secret_enc ? decrypt(m.secret_enc) : '' });
  const pollDelay = (capability, kind) => (kind === 'mock' ? 300 : capability === 'video' ? 8000 : 3000);
  const extFor = (mime) => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav' })[mime];
  async function materialize(job, result) {
    if (job.capability === 'text' || job.capability === 'stt') return result;
    let data = result.data;
    let mime = result.mime;
    if (!data && result.url) {
      data = await download(result.url, result.headers || {});
      mime = mime || { image: 'image/png', video: 'video/mp4', tts: 'audio/mpeg' }[job.capability];
    }
    if (!data?.length) throw Object.assign(new Error('결과 파일이 비어 있어요.'), { retryable: true });
    // 파일 서명으로 실제 형식을 확인합니다.
    const head = data.subarray(0, 12);
    if (head.toString('hex', 0, 8) === '89504e470d0a1a0a') mime = 'image/png';
    else if (head[0] === 0xff && head[1] === 0xd8) mime = 'image/jpeg';
    else if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
    else if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') mime = 'audio/wav';
    else if (head.toString('ascii', 4, 8) === 'ftyp') mime = 'video/mp4';
    else if (head.toString('ascii', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) mime = 'audio/mpeg';
    const ext = extFor(mime);
    const expected = { image: /^image\//, video: /^video\//, tts: /^audio\// }[job.capability];
    if (!ext || !expected.test(mime)) throw Object.assign(new Error('예상과 다른 형식의 결과가 왔어요.'), { retryable: true });
    const filename = randomUUID() + ext;
    const full = path.join(uploadDir, filename);
    await writeFile(full, data);
    const meta = await probeMedia(full);
    const url = '/uploads/' + filename;
    await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [url, job.user_id, mime, iso()]);
    await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [
      url,
      Math.ceil(meta.duration || 0),
      meta.width || 0,
      meta.height || 0,
      meta.hasAudio ? 1 : 0,
    ]);
    return { url, mime, duration: meta.duration, width: meta.width, height: meta.height, size: (await stat(full)).size };
  }
  async function finish(job, model, result) {
    const settings = await loadSettings(db);
    const media = await materialize(job, result);
    const input = JSON.parse(job.input || '{}');
    let units = unitsFor(job.capability, input);
    if (job.capability === 'text' && result.usage && result.usage.input + result.usage.output > 0)
      units = (result.usage.input + result.usage.output) / 1000;
    const handler = handlers.get(job.kind);
    await db.transaction(async () => {
      const fresh = await db.get('SELECT * FROM ai_jobs WHERE id=?', [job.id]);
      if (fresh.status !== 'running') return; // 취소된 작업
      const output = await handler.onSuccess({ job: fresh, input, result: media, model });
      const charge = Number(fresh.billed) ? Math.min(Number(fresh.estimate_lama), lamaFor(model, settings, units)) : 0;
      let used = 0;
      if (Number(fresh.hold_paid) + Number(fresh.hold_bonus) > 0) {
        const c = await captureLama(db, {
          userId: fresh.user_id,
          jobId: fresh.id,
          holdPaid: Number(fresh.hold_paid),
          holdBonus: Number(fresh.hold_bonus),
          charge,
          memo: `${model.label} · ${fresh.kind}`,
        });
        used = c.used;
      }
      await db.run(
        "UPDATE ai_jobs SET status='succeeded',charged_lama=?,cost_won=?,output=?,error='',finished_at=?,hold_paid=0,hold_bonus=0 WHERE id=?",
        [used, costWonFor(model, settings, units), JSON.stringify(output || {}), iso(), fresh.id],
      );
    });
    await db.run("UPDATE ai_providers SET status='ok',last_error='',last_checked_at=?,fail_streak=0,cooldown_until=NULL WHERE id=?", [iso(), model.provider_id]);
  }
  async function fail(job, err, model) {
    const settings = await loadSettings(db);
    const message = String(err?.message || '알 수 없는 오류').slice(0, 500);
    // 공급사 장애 차단: 키 오류는 바로, 그 밖의 실패는 연속 횟수가 기준을 넘으면 잠시 자동 선택에서 뺍니다.
    if (model && model.kind !== 'mock' && !err?.modelGone) {
      const p = await db.get('SELECT fail_streak FROM ai_providers WHERE id=?', [model.provider_id]);
      const streak = Number(p?.fail_streak || 0) + 1;
      const trip = err?.status === 401 || streak >= Number(settings.ai_breaker_failures || 5);
      await db.run(
        `UPDATE ai_providers SET fail_streak=?,last_error=?,last_checked_at=?${trip ? ",status='error',cooldown_until=?" : ''} WHERE id=?`,
        trip
          ? [streak, message, iso(), new Date(Date.now() + Number(settings.ai_breaker_cooldown_min || 10) * 60000).toISOString(), model.provider_id]
          : [streak, message, iso(), model.provider_id],
      );
    }
    await db.transaction(async () => {
      const fresh = await db.get('SELECT * FROM ai_jobs WHERE id=?', [job.id]);
      if (!['running', 'queued'].includes(fresh.status)) return;
      const attempts = Number(fresh.attempts) + 1;
      const retryable = err?.retryable !== false && attempts < 3;
      if (retryable) {
        // 자동 선택이면 아직 안 써 본 다음 모델(예약한 라마 안에서)로, 직접 선택이면 같은 모델로 한 번 더 시도합니다.
        let target = null;
        if (fresh.requested_model === 'auto') {
          const input = JSON.parse(fresh.input || '{}');
          const tried = String(fresh.tried || '').split(',');
          try {
            const list = await candidates({ capability: fresh.capability, tier: fresh.tier, tags: input.tags, seconds: input.seconds, needImage: !!input.image, excludeCn: !!input._excludeCn }, settings);
            const units = unitsFor(fresh.capability, input);
            target = list.find((r) => !tried.includes(r.id) && (!Number(fresh.billed) || lamaFor(r, settings, units) <= Number(fresh.estimate_lama))) || null;
          } catch {}
        }
        if (!target && !err?.modelGone) target = { id: fresh.model_ref, provider_id: fresh.provider_id, model_id: fresh.vendor_model };
        if (target) {
          const tried = [...new Set([...String(fresh.tried || '').split(','), target.id].filter(Boolean))].join(',');
          await db.run(
            "UPDATE ai_jobs SET status='queued',attempts=?,model_ref=?,provider_id=?,vendor_model=?,vendor_ref='',claimed_by=NULL,error=?,tried=?,next_poll_at=? WHERE id=?",
            [attempts, target.id, target.provider_id, target.model_id, message, tried, new Date(Date.now() + 1500 * attempts).toISOString(), fresh.id],
          );
          return;
        }
      }
      if (Number(fresh.hold_paid) + Number(fresh.hold_bonus) > 0)
        await releaseLama(db, { userId: fresh.user_id, jobId: fresh.id, holdPaid: Number(fresh.hold_paid), holdBonus: Number(fresh.hold_bonus), memo: '작업 실패 · 전액 반환' });
      await db.run(
        "UPDATE ai_jobs SET status='failed',attempts=?,error=?,finished_at=?,hold_paid=0,hold_bonus=0,cost_won=0 WHERE id=?",
        [attempts, message, iso(), fresh.id],
      );
      await handlers.get(fresh.kind)?.onFail?.({ job: fresh, message });
    });
  }
  async function execute(job) {
    let model;
    try {
      model = await loadModel(job);
      const adapter = adapterOf(model.kind);
      const input = await hydrate(JSON.parse(job.input || '{}'));
      const c = ctx(model);
      const res = job.vendor_ref
        ? await adapter.poll({ ...c, capability: job.capability, ref: job.vendor_ref })
        : await adapter.run({ ...c, capability: job.capability, input });
      if (res.status === 'pending') {
        const started = new Date(job.started_at || Date.now()).getTime();
        const limit = job.capability === 'video' ? 30 * 60000 : 10 * 60000;
        if (Date.now() - started > limit) throw Object.assign(new Error('AI 공급사 응답이 너무 오래 걸려 작업을 중단했어요.'), { retryable: true });
        await db.run('UPDATE ai_jobs SET vendor_ref=?,next_poll_at=?,claimed_by=NULL WHERE id=?', [
          res.ref,
          new Date(Date.now() + pollDelay(job.capability, model.kind)).toISOString(),
          job.id,
        ]);
        return;
      }
      await finish(job, model, res.result);
    } catch (err) {
      await fail(job, err, model);
    }
  }
  async function claim(job, status) {
    const stamp = iso();
    await db.run(
      `UPDATE ai_jobs SET status='running',claimed_by=?,started_at=COALESCE(started_at,?) WHERE id=? AND status=? AND claimed_by IS NULL`,
      [workerId, stamp, job.id, status],
    );
    const row = await db.get('SELECT * FROM ai_jobs WHERE id=?', [job.id]);
    return row.claimed_by === workerId && row.status === 'running' ? row : null;
  }
  async function tick() {
    const settings = await loadSettings(db);
    const max = Math.max(1, Number(settings.ai_concurrency || 3));
    if (inflight.size >= max) return;
    const stamp = iso();
    const due = await db.all(
      `SELECT * FROM ai_jobs WHERE claimed_by IS NULL AND ((status='running' AND vendor_ref<>'' AND (next_poll_at IS NULL OR next_poll_at<=?)) OR (status='queued' AND (next_poll_at IS NULL OR next_poll_at<=?))) ORDER BY created_at LIMIT 50`,
      [stamp, stamp],
    );
    const limits = new Map((await db.all('SELECT id,max_concurrency FROM ai_providers WHERE max_concurrency>0')).map((r) => [r.id, Number(r.max_concurrency)]));
    for (const job of due) {
      if (inflight.size >= max) break;
      // 공급사별 동시 작업 한도: 새 작업만 막고(결과 확인 중인 작업은 계속 확인), 자리가 나면 다음 차례에 시작합니다.
      if (job.status === 'queued' && limits.has(job.provider_id)) {
        const running = Number((await db.get("SELECT COUNT(*) AS n FROM ai_jobs WHERE provider_id=? AND status='running'", [job.provider_id]))?.n || 0);
        if (running >= limits.get(job.provider_id)) continue;
      }
      const claimed = await claim(job, job.status);
      if (!claimed) continue;
      inflight.add(claimed.id);
      void execute(claimed)
        .catch(() => {})
        .finally(async () => {
          inflight.delete(claimed.id);
          // 결과 확인 대기 중인 작업은 다음 확인을 위해 잠금을 풉니다.
          await db.run("UPDATE ai_jobs SET claimed_by=NULL WHERE id=? AND claimed_by=? AND status='running' AND vendor_ref<>''", [claimed.id, workerId]).catch(() => {});
          kick();
        });
    }
  }
  let kicking = false;
  function kick() {
    if (kicking) return;
    kicking = true;
    setTimeout(() => {
      kicking = false;
      void tick().catch((e) => console.error('ai tick', e.message));
    }, 50);
  }
  async function start() {
    // 서버가 꺼질 때 공급사 호출 중이던 작업은 다시 대기열로, 결과 확인 중이던 작업은 계속 확인합니다.
    await db.run("UPDATE ai_jobs SET status='queued',claimed_by=NULL WHERE status='running' AND vendor_ref=''");
    await db.run("UPDATE ai_jobs SET claimed_by=NULL WHERE status='running'");
    timer = setInterval(() => void tick().catch((e) => console.error('ai tick', e.message)), 1500);
    timer.unref();
    kick();
  }
  async function cancel(jobId, actor, { force = false } = {}) {
    return db.transaction(async () => {
      const job = await db.get('SELECT * FROM ai_jobs WHERE id=?', [jobId]);
      if (!job) throw error(404, '작업을 찾을 수 없어요.');
      if (actor.role !== 'admin' && job.user_id !== actor.id) throw error(404, '작업을 찾을 수 없어요.');
      if (job.status === 'queued' || (force && job.status === 'running')) {
        if (Number(job.hold_paid) + Number(job.hold_bonus) > 0)
          await releaseLama(db, { userId: job.user_id, jobId: job.id, holdPaid: Number(job.hold_paid), holdBonus: Number(job.hold_bonus), memo: '작업 취소 · 전액 반환', });
        await db.run("UPDATE ai_jobs SET status='canceled',finished_at=?,hold_paid=0,hold_bonus=0,cost_won=0,error=? WHERE id=?", [iso(), force ? '관리자가 취소했어요.' : '취소했어요.', job.id]);
        await handlers.get(job.kind)?.onFail?.({ job, message: '취소됨' });
        return { ok: true };
      }
      throw error(409, job.status === 'running' ? '이미 AI가 만들고 있어 취소할 수 없어요.' : '이미 끝난 작업이에요.');
    });
  }
  // 테스트·시뮬레이션용: 대기열이 빌 때까지 처리합니다.
  async function drain(timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await tick();
      const left = await db.get("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued','running')");
      if (!Number(left.n) && !inflight.size) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
  return {
    registerHandler: (kind, handler) => handlers.set(kind, handler),
    enqueue,
    screen,
    estimate,
    candidates,
    listForPicker,
    start,
    stop: () => timer && clearInterval(timer),
    tick,
    drain,
    cancel,
    unitOf,
  };
}
