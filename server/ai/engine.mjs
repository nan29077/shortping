import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadSettings } from '../settings.mjs';
import { LAMA_WON, captureLama, holdLama, releaseLama } from '../lama.mjs';
import { probeMedia } from '../media.mjs';
import { adapters, unitOf, PRICE_REQUIRED } from './providers.mjs';
import { mockAdapter } from './mock.mjs';
import { decrypt } from './secret.mjs';
import { download, VendorError } from './http.mjs';
import { blockedTerm } from './prompts.mjs';
import { familyOf } from './model-guide.mjs';

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
// 공급사 오류 원문에는 키 일부·내부 주소가 섞일 수 있어, PD에게는 정리된 문구만 보여 줍니다.
// 원문은 ai_jobs.error_detail(관리자 전용)에 남깁니다.
export function publicError(err) {
  const raw = String(err?.message || '알 수 없는 오류');
  if (err instanceof VendorError) {
    if (/^AI 공급사 오류\(|^AI 공급사에 연결하지 못했어요|^AI 공급사 응답을 읽지 못했어요/.test(raw))
      return err.status === 401
        ? 'AI 공급사 인증에 실패했어요. 관리자에게 문의해 주세요.'
        : 'AI 공급사에서 일시적인 문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
  }
  return raw
    .replace(/\b(sk|pk|rk|key|api[_-]?key)[-_][A-Za-z0-9*._-]{6,}/gi, '[비공개]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [비공개]')
    .replace(/https?:\/\/\S+/gi, '[주소]')
    .slice(0, 300);
}
// 공급사 쪽 문제로 볼 수 있는 실패만 장애 차단기에 셉니다(형식 오류·파일 없음 같은 내부 오류 제외).
const vendorFault = (err) => err instanceof VendorError && (err.status === 401 || err.retryable !== false);
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
  if (capability === 'music') return Math.max(1, Number(input.seconds || 30));
  if (capability === 'sfx') return Math.max(1, Number(input.seconds || 4));
  if (capability === 'lipsync') return Math.max(1, Number(input.seconds || 5));
  return 1;
}
export const lamaFor = (model, settings, units) => Math.max(1, Math.ceil(units * lamaPerUnit(model, settings) - 1e-9));
export const costWonFor = (model, settings, units) => Math.round(units * Number(model.cost_usd || 0) * settings.usd_krw_rate);

export function createAiEngine({ db, uploadDir, demo }) {
  const handlers = new Map();
  const workerId = randomUUID();
  // PostgreSQL에서는 작업 행을 잠가 취소·완료·실패가 겹쳐도 라마 예약이 두 번 처리되지 않게 합니다.
  const forUpdate = () => (db.engine === 'postgresql' ? ' FOR UPDATE' : '');
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
    // 배경음악·효과음·입 모양 맞추기는 최고관리자가 라마 가격을 정한 모델만 씁니다.
    (!PRICE_REQUIRED.includes(r.capability) || Number(r.price_lama) > 0) &&
    (r.kind === 'mock' ? demo : !!r.api_key_enc) &&
    !!adapterOf(r.kind);
  // 모델별 최근 14일 실적(성공률·평균 소요 시간). 자동 선택 가중치와 PD 화면의 모델 카드에 씁니다(1분 캐시).
  let statsCache = { at: 0, map: new Map() };
  async function modelStats({ fresh = false } = {}) {
    if (!fresh && Date.now() - statsCache.at < 60000) return statsCache.map;
    const rows = await db.all(
      "SELECT model_ref,status,started_at,finished_at FROM ai_jobs WHERE created_at>=? AND status IN ('succeeded','failed') ORDER BY created_at DESC LIMIT 3000",
      [new Date(Date.now() - 14 * 86400000).toISOString()],
    );
    const map = new Map();
    for (const r of rows) {
      const m = map.get(r.model_ref) || { jobs: 0, ok: 0, secs: 0, timed: 0 };
      m.jobs++;
      if (r.status === 'succeeded') {
        m.ok++;
        const d = (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000;
        if (d > 0 && d < 3600) (m.secs += d), m.timed++;
      }
      map.set(r.model_ref, m);
    }
    const out = new Map([...map].map(([k, m]) => [k, { jobs: m.jobs, success: m.jobs ? m.ok / m.jobs : null, seconds: m.timed ? Math.round(m.secs / m.timed) : null }]));
    statsCache = { at: Date.now(), map: out };
    return out;
  }
  // 자동 선택 점수: 품질 등급 일치 > 장면 특성 태그 > 관리자 우선순위 > 가격(초안 등급은 저렴할수록 가산)
  // 관리자 가중치(비용·속도·안정성)로 조정합니다. 기본값(비용 50·속도 0·안정성 0)은 예전 방식과 같습니다.
  function scoreParts(r, { tier, tags, seconds, needImage }, settings, stats) {
    const parts = [];
    const add = (n, why) => parts.push({ n, why });
    const ti = TIERS.indexOf(tier || 'standard');
    const mi = TIERS.indexOf(r.tier);
    add(ti === mi ? 40 : Math.abs(ti - mi) === 1 ? 15 : 0, ti === mi ? 'tier' : '');
    const mt = String(r.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
    const hit = (tags || []).filter((t) => mt.includes(t));
    add(hit.length * 10, hit.length ? 'tags:' + hit.join(',') : '');
    add(Number(r.priority || 0) * 0.3, Number(r.priority || 0) >= 70 ? 'priority' : '');
    if (r.provider_status === 'ok') add(5, '');
    if (r.provider_status === 'error') add(-60, 'error');
    if (seconds && r.capability === 'video' && Number(r.max_seconds) < seconds) add(-25, 'short');
    if (needImage && Number(r.image_input) === 1) add(8, 'image_input');
    const price = lamaPerUnit(r, settings);
    const wc = Number(settings.ai_weight_cost ?? 50) / 50;
    add(-(tier === 'draft' ? price * 2 : price * 0.2) * wc, '');
    const st = stats?.get(r.id);
    const ws = Number(settings.ai_weight_speed || 0);
    if (ws > 0 && st?.seconds) add(-Math.min(60, st.seconds / 10) * (ws / 50), st.seconds <= 30 ? 'fast' : '');
    const wr = Number(settings.ai_weight_reliability || 0);
    if (wr > 0 && st?.jobs >= 5 && st.success != null) add((st.success - 0.8) * 50 * (wr / 50), st.success >= 0.95 ? 'reliable' : '');
    return parts;
  }
  const score = (r, opts, settings, stats) => scoreParts(r, opts, settings, stats).reduce((n, p) => n + p.n, 0);
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
  async function candidates({ capability, requested = 'auto', tier, tags, seconds, needImage, excludeCn = false, exclude = [] }, settings) {
    const spend = await providerSpend();
    const stats = await modelStats();
    const every = (await modelRows()).filter((r) => r.capability === capability && usable(r));
    // 다른 모델로 다시 시도할 때: 실패한 모델은 빼되, 남는 모델이 없으면 그대로 둡니다.
    const all = requested === 'auto' && exclude.length && every.some((r) => !exclude.includes(r.id)) ? every.filter((r) => !exclude.includes(r.id)) : every;
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
      .map((r) => ({ r, s: score(r, { tier, tags, seconds, needImage }, settings, stats) }))
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
    const stats = await modelStats();
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
        kind: r.kind,
        family: familyOf(r),
        image_input: Number(r.image_input) === 1,
        stats: stats.get(r.id) || null,
      }));
  }
  // 왜 이 모델인가: 자동 선택 순위 상위 모델과 이유(PD 화면의 '왜 이 모델?' 안내)
  const WHY = {
    tier: (o) => `${{ draft: '초안', standard: '표준', premium: '고급' }[o.tier] || '표준'} 품질 등급에 맞아요`,
    priority: () => '숏핑이 이 작업에 우선 추천하는 모델이에요',
    image_input: () => '참고 이미지(인물·장면)를 받아 얼굴·구도를 이어 가요',
    fast: () => '최근 처리 속도가 빨라요',
    reliable: () => '최근 성공률이 높아요',
  };
  const TAG_KO = { dialogue: '대사', closeup: '클로즈업', action: '액션', landscape: '풍경', cinematic: '영화 같은 화면', character: '인물', consistency: '인물 일관성', lipsync: '입 모양', poster: '포스터', korean: '한국어', story: '이야기 구성', emotion: '감정 표현', fast: '빠름', cheap: '저렴', scene: '장면' };
  async function explain(opts) {
    const settings = await loadSettings(db);
    const stats = await modelStats();
    const list = await candidates({ ...opts, requested: 'auto' }, settings);
    const units = opts.units ?? unitsFor(opts.capability, opts.input || {});
    const cheapest = Math.min(...list.map((r) => lamaFor(r, settings, units)));
    return list.slice(0, 4).map((r, i) => {
      const why = [];
      for (const p of scoreParts(r, opts, settings, stats)) {
        if (!p.why || p.n <= 0) continue;
        if (p.why.startsWith('tags:')) why.push(p.why.slice(5).split(',').map((t) => TAG_KO[t] || t).join('·') + '에 강해요');
        else if (WHY[p.why]) why.push(WHY[p.why](opts));
      }
      const l = lamaFor(r, settings, units);
      if (l === cheapest && list.length > 1) why.push('후보 중 가장 저렴해요');
      const st = stats.get(r.id);
      return { id: r.id, label: r.label, provider: r.provider_name, tier: r.tier, lama: l, rank: i + 1, why: why.slice(0, 3), success: st?.jobs >= 3 ? st.success : null, seconds: st?.seconds ?? null };
    });
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
    // 한도 규칙
    // - PD 개인 한도: 값이 있으면 그 값이 그대로 상한입니다. 0이면 라마가 드는 작업을 할 수 없어요.
    //   비워 두면(null) 하루 한도는 공통 값을, 월 한도는 제한 없음을 따릅니다.
    // - 공통 하루 한도(ai_daily_limit_lama): 0이면 제한 없음(관리자 화면 안내와 같음).
    const personalDaily = limit?.daily_lama != null ? Number(limit.daily_lama) : null;
    const daily = personalDaily ?? Number(settings.ai_daily_limit_lama || 0);
    if ((personalDaily != null || daily > 0) && lama > 0 && (await used(kstDayStart())) + lama > daily)
      throw error(
        429,
        daily === 0
          ? '관리자가 이 계정의 하루 AI 제작 한도를 0라마로 정해 두어 지금은 만들 수 없어요. 관리자에게 문의해 주세요.'
          : `오늘 쓸 수 있는 AI 제작 한도(${daily.toLocaleString('ko-KR')}라마)를 넘어요. 내일 다시 이용하거나 관리자에게 한도 조정을 요청해 주세요.`,
        { code: 'daily_limit' },
      );
    const monthly = limit?.monthly_lama != null ? Number(limit.monthly_lama) : null;
    if (monthly != null && lama > 0 && (await used(kstMonthStart())) + lama > monthly)
      throw error(
        429,
        monthly === 0
          ? '관리자가 이 계정의 월 AI 제작 한도를 0라마로 정해 두어 지금은 만들 수 없어요. 관리자에게 문의해 주세요.'
          : `이번 달 AI 제작 한도(${monthly.toLocaleString('ko-KR')}라마)를 넘어요.`,
        { code: 'monthly_limit' },
      );
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
  async function enqueue({ userId, kind, capability, requested = 'auto', tier = 'standard', tags = [], input, units, target = {}, projectId = null, idempotencyKey, bill = true, excludeCn = false, exclude = [] }) {
    if (!handlers.has(kind)) throw error(500, 'unknown job kind ' + kind);
    const settings = await loadSettings(db);
    // 같은 PD의 동시 요청이 일일·월 한도를 함께 넘지 않도록 사용자 단위로 순서를 세웁니다.
    // (SQLite는 트랜잭션 자체가 한 번에 하나씩 실행되어 따로 잠글 필요가 없습니다.)
    if (db.engine === 'postgresql') {
      await db.get('SELECT id FROM users WHERE id=? FOR UPDATE', [userId]);
      if (Number(settings.ai_monthly_budget_won || 0) > 0) await db.get("SELECT pg_advisory_xact_lock(hashtext('shortping-ai-budget'))");
    }
    if (idempotencyKey) {
      const existing = await db.get('SELECT * FROM ai_jobs WHERE idempotency_key=?', [idempotencyKey]);
      if (existing) {
        if (existing.user_id !== userId) throw error(409, '중복 요청입니다.');
        return existing;
      }
    }
    // 글 작업의 프롬프트에는 숏핑이 넣은 지시문(예: "실존 인물 금지")이 섞여 있어, PD가 쓴 부분(userText)만 검사합니다.
    // 이미지·영상·음성 프롬프트는 PD가 쓴 묘사로 만들어지므로 프롬프트 전체를 검사합니다.
    const banned = blockedTerm([input.userText, capability === 'text' ? '' : input.prompt, input.text], settings.ai_blocked_terms);
    if (banned) throw error(400, `사용할 수 없는 표현이 포함돼 있어요: "${banned}"`, { code: 'blocked_term' });
    const list = await candidates({ capability, requested, tier, tags, seconds: input.seconds, needImage: !!(input.image || input.editImage || input.refImage || input.refImages?.length), excludeCn, exclude }, settings);
    const model = list[0];
    const u = units ?? unitsFor(capability, input);
    const lama = bill ? lamaFor(model, settings, u) : 0;
    const costWon = costWonFor(model, settings, u);
    await checkLimits(userId, lama, costWon, settings);
    const id = randomUUID();
    // 같은 멱등키가 동시에 들어오면 한쪽만 들어가고 다른 쪽은 기존 작업을 돌려받습니다.
    await db.run(
      'INSERT INTO ai_jobs (id,user_id,project_id,target_type,target_id,kind,capability,requested_model,model_ref,provider_id,vendor_model,tier,input,status,estimate_lama,cost_won,idempotency_key,billed,created_at,tried) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      [id, userId, projectId, target.type || '', target.id || '', kind, capability, requested || 'auto', model.id, model.provider_id, model.model_id, tier, JSON.stringify({ ...input, tags, _excludeCn: !!excludeCn }), 'queued', lama, costWon, idempotencyKey || null, bill ? 1 : 0, iso(), model.id],
    );
    if (!(await db.get('SELECT id FROM ai_jobs WHERE id=?', [id]))) {
      const existing = idempotencyKey && (await db.get('SELECT * FROM ai_jobs WHERE idempotency_key=?', [idempotencyKey]));
      if (!existing || existing.user_id !== userId) throw error(409, '중복 요청입니다.');
      return existing;
    }
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
    const load = async (ref) => {
      const file = path.join(uploadDir, path.basename(ref.path));
      return { buffer: await readFile(file), mime: ref.mime, ext: path.extname(file).slice(1) };
    };
    for (const field of ['image', 'refImage', 'audio', 'video', 'endImage', 'editImage']) if (input[field]?.path) out[field] = await load(input[field]);
    if (Array.isArray(input.refImages)) out.refImages = await Promise.all(input.refImages.filter((r) => r?.path).map(load));
    return out;
  }
  const ctx = (m) => ({ provider: { base_url: m.base_url, kind: m.kind }, model: m, key: m.kind === 'mock' ? '' : decrypt(m.api_key_enc), secret: m.secret_enc ? decrypt(m.secret_enc) : '' });
  const pollDelay = (capability, kind) => (kind === 'mock' ? 300 : capability === 'video' ? 8000 : 3000);
  const extFor = (mime) => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav' })[mime];
  // 결과 파일의 주인: 관리자가 PD의 프로젝트·작품에서 대신 실행해도 파일은 그 PD 것으로 기록해야
  // PD가 미리보기·포스터 지정 등에 그대로 쓸 수 있습니다.
  async function resultOwner(job) {
    if (job.project_id) {
      const p = await db.get('SELECT owner_id FROM studio_projects WHERE id=?', [job.project_id]);
      if (p?.owner_id) return p.owner_id;
    }
    if (['drama', 'drama_episode'].includes(job.target_type) && job.target_id) {
      const d = await db.get('SELECT owner_id FROM dramas WHERE id=?', [String(job.target_id).split('#')[0]]);
      if (d?.owner_id) return d.owner_id;
    }
    return job.user_id;
  }
  async function materialize(job, result) {
    if (job.capability === 'text' || job.capability === 'stt') return result;
    let data = result.data;
    let mime = result.mime;
    if (!data && result.url) {
      data = await download(result.url, result.headers || {});
      mime = mime || { image: 'image/png', video: 'video/mp4', tts: 'audio/mpeg', music: 'audio/mpeg', sfx: 'audio/mpeg', lipsync: 'video/mp4' }[job.capability];
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
    const expected = { image: /^image\//, video: /^video\//, tts: /^audio\//, music: /^audio\//, sfx: /^(audio|video)\//, lipsync: /^video\// }[job.capability];
    if (!ext || !expected.test(mime)) throw Object.assign(new Error('예상과 다른 형식의 결과가 왔어요.'), { retryable: true });
    const filename = randomUUID() + ext;
    const full = path.join(uploadDir, filename);
    await writeFile(full, data);
    const url = '/uploads/' + filename;
    let meta;
    try {
      meta = await probeMedia(full);
      await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [url, await resultOwner(job), mime, iso()]);
      await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [
        url,
        Math.ceil(meta.duration || 0),
        meta.width || 0,
        meta.height || 0,
        meta.hasAudio ? 1 : 0,
      ]);
    } catch (e) {
      // 저장은 됐지만 검사·등록에 실패하면 어디에도 연결되지 않은 파일이 남지 않게 지웁니다.
      await db.run('DELETE FROM media_files WHERE url=?', [url]).catch(() => {});
      await rm(full, { force: true }).catch(() => {});
      throw e;
    }
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
    // 결과 반영에 실패하거나 그사이 작업이 취소되면, 방금 저장한 결과 파일은 어디에도 연결되지 않으므로 지웁니다.
    const discard = async () => {
      if (!media?.url) return;
      await db.run('DELETE FROM media_files WHERE url=?', [media.url]).catch(() => {});
      await rm(path.join(uploadDir, path.basename(media.url)), { force: true }).catch(() => {});
    };
    let applied;
    try {
      applied = await settleJob(job, model, handler, input, media, units, settings);
    } catch (e) {
      await discard();
      throw e;
    }
    if (!applied) return discard();
    await db.run("UPDATE ai_providers SET status='ok',last_error='',last_checked_at=?,fail_streak=0,cooldown_until=NULL WHERE id=?", [iso(), model.provider_id]);
  }
  async function settleJob(job, model, handler, input, media, units, settings) {
    return db.transaction(async () => {
      const fresh = await db.get('SELECT * FROM ai_jobs WHERE id=?' + forUpdate(), [job.id]);
      if (!fresh || fresh.status !== 'running') return false; // 취소·삭제된 작업
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
        "UPDATE ai_jobs SET status='succeeded',charged_lama=?,cost_won=?,output=?,error='',error_detail='',finished_at=?,hold_paid=0,hold_bonus=0 WHERE id=?",
        [used, costWonFor(model, settings, units), JSON.stringify(output || {}), iso(), fresh.id],
      );
      return true;
    });
  }
  async function fail(job, err, model) {
    const settings = await loadSettings(db);
    const detail = String(err?.message || '알 수 없는 오류').slice(0, 500);
    const message = publicError(err);
    // 공급사 장애 차단: 키 오류는 바로, 그 밖의 공급사 실패는 연속 횟수가 기준을 넘으면 잠시 자동 선택에서 뺍니다.
    if (model && model.kind !== 'mock' && !err?.modelGone && vendorFault(err)) {
      const p = await db.get('SELECT fail_streak FROM ai_providers WHERE id=?', [model.provider_id]);
      const streak = Number(p?.fail_streak || 0) + 1;
      const trip = err?.status === 401 || streak >= Number(settings.ai_breaker_failures || 5);
      await db.run(
        `UPDATE ai_providers SET fail_streak=?,last_error=?,last_checked_at=?${trip ? ",status='error',cooldown_until=?" : ''} WHERE id=?`,
        trip
          ? [streak, detail, iso(), new Date(Date.now() + Number(settings.ai_breaker_cooldown_min || 10) * 60000).toISOString(), model.provider_id]
          : [streak, detail, iso(), model.provider_id],
      );
    }
    await db.transaction(async () => {
      const fresh = await db.get('SELECT * FROM ai_jobs WHERE id=?' + forUpdate(), [job.id]);
      if (!fresh || !['running', 'queued'].includes(fresh.status)) return;
      const attempts = Number(fresh.attempts) + 1;
      // 자동 선택이면 요청 형식 오류(4xx)처럼 같은 모델로는 다시 해도 안 되는 경우에도 다른 모델을 한 번 더 시도합니다.
      const switchOnly = err?.retryable === false && fresh.requested_model === 'auto' && err?.status !== 401;
      const retryable = (err?.retryable !== false || switchOnly) && attempts < 3;
      if (retryable) {
        // 자동 선택이면 아직 안 써 본 다음 모델(예약한 라마 안에서)로, 직접 선택이면 같은 모델로 한 번 더 시도합니다.
        let target = null;
        if (fresh.requested_model === 'auto') {
          const input = JSON.parse(fresh.input || '{}');
          const tried = String(fresh.tried || '').split(',');
          try {
            const list = await candidates({ capability: fresh.capability, tier: fresh.tier, tags: input.tags, seconds: input.seconds, needImage: !!(input.image || input.editImage || input.refImage || input.refImages?.length), excludeCn: !!input._excludeCn }, settings);
            const units = unitsFor(fresh.capability, input);
            target = list.find((r) => !tried.includes(r.id) && (!Number(fresh.billed) || lamaFor(r, settings, units) <= Number(fresh.estimate_lama))) || null;
          } catch {}
        }
        if (!target && !err?.modelGone && !switchOnly) target = { id: fresh.model_ref, provider_id: fresh.provider_id, model_id: fresh.vendor_model };
        if (target) {
          const tried = [...new Set([...String(fresh.tried || '').split(','), target.id].filter(Boolean))].join(',');
          await db.run(
            "UPDATE ai_jobs SET status='queued',attempts=?,model_ref=?,provider_id=?,vendor_model=?,vendor_ref='',claimed_by=NULL,started_at=NULL,poll_failures=0,error=?,error_detail=?,tried=?,next_poll_at=? WHERE id=?",
            [attempts, target.id, target.provider_id, target.model_id, message, detail, tried, new Date(Date.now() + 1500 * attempts).toISOString(), fresh.id],
          );
          return;
        }
      }
      if (Number(fresh.hold_paid) + Number(fresh.hold_bonus) > 0)
        await releaseLama(db, { userId: fresh.user_id, jobId: fresh.id, holdPaid: Number(fresh.hold_paid), holdBonus: Number(fresh.hold_bonus), memo: '작업 실패 · 전액 반환' });
      await db.run(
        "UPDATE ai_jobs SET status='failed',attempts=?,error=?,error_detail=?,finished_at=?,hold_paid=0,hold_bonus=0,cost_won=0 WHERE id=?",
        [attempts, message, detail, iso(), fresh.id],
      );
      await handlers.get(fresh.kind)?.onFail?.({ job: fresh, message });
    });
  }
  async function deferPoll(job, err, model) {
    const fresh = await db.get('SELECT * FROM ai_jobs WHERE id=?', [job.id]);
    if (!fresh || fresh.status !== 'running' || !fresh.vendor_ref) return false;
    const failures = Number(fresh.poll_failures || 0) + 1;
    const started = new Date(fresh.started_at || Date.now()).getTime();
    const limit = fresh.capability === 'video' ? 30 * 60000 : 10 * 60000;
    if (failures > 8 || Date.now() - started > limit) return false;
    const wait = Math.min(60000, 3000 * 2 ** (failures - 1)) + pollDelay(fresh.capability, model?.kind || '');
    const r = await db.run(
      "UPDATE ai_jobs SET poll_failures=?,next_poll_at=?,claimed_by=NULL,error_detail=? WHERE id=? AND status='running'",
      [failures, new Date(Date.now() + wait).toISOString(), String(err?.message || '').slice(0, 500), fresh.id],
    );
    return Number(r?.rowCount ?? r?.changes ?? 1) > 0;
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
        await db.run('UPDATE ai_jobs SET vendor_ref=?,next_poll_at=?,claimed_by=NULL,poll_failures=0 WHERE id=?', [
          res.ref,
          new Date(Date.now() + pollDelay(job.capability, model.kind)).toISOString(),
          job.id,
        ]);
        return;
      }
      await finish(job, model, res.result);
    } catch (err) {
      // 결과 확인 중 일시 오류(연결 끊김·429·5xx)라면 공급사가 만들고 있는 작업을 버리지 않고
      // 잠시 뒤 다시 확인합니다. 새로 생성하면 원가가 두 번 들기 때문입니다.
      if (job.vendor_ref && err?.transient && (await deferPoll(job, err, model).catch(() => false))) return;
      try {
        await fail(job, err, model);
      } catch (inner) {
        // 실패 처리 자체가 실패하면 작업이 running으로 영구히 남지 않도록 최후 수단으로 닫습니다.
        console.error('ai fail handler', inner.message);
        // 예약한 라마부터 돌려준 뒤 작업을 닫습니다. 반환마저 실패하면 상태만이라도 닫습니다.
        await db
          .transaction(async () => {
            const fresh = await db.get('SELECT * FROM ai_jobs WHERE id=?' + forUpdate(), [job.id]);
            if (!fresh || !['running', 'queued'].includes(fresh.status)) return;
            if (Number(fresh.hold_paid) + Number(fresh.hold_bonus) > 0)
              await releaseLama(db, { userId: fresh.user_id, jobId: fresh.id, holdPaid: Number(fresh.hold_paid), holdBonus: Number(fresh.hold_bonus), memo: '작업 실패 · 전액 반환' });
            await db.run("UPDATE ai_jobs SET hold_paid=0,hold_bonus=0 WHERE id=?", [fresh.id]);
          })
          .catch((e) => console.error('ai release on fail', e.message));
        await db
          .run("UPDATE ai_jobs SET status='failed',claimed_by=NULL,error=?,error_detail=?,finished_at=? WHERE id=? AND status IN ('running','queued')", [
            publicError(err),
            String(inner.message || err?.message || '처리 실패').slice(0, 500),
            iso(),
            job.id,
          ])
          .catch(() => {});
      }
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
  let ticking = false;
  async function tick() {
    // 1.5초 타이머와 kick()이 겹쳐 실행되면 동시 작업 한도를 넘을 수 있어 한 번에 하나만 돌립니다.
    if (ticking) return;
    ticking = true;
    try {
      await tickOnce();
    } finally {
      ticking = false;
    }
  }
  async function tickOnce() {
    const settings = await loadSettings(db);
    const max = Math.max(1, Number(settings.ai_concurrency || 3));
    if (inflight.size >= max) return;
    const stamp = iso();
    // 공급사별 동시 작업 한도: 한도에 찬 공급사의 새 작업은 조회 단계에서 빼서, 다른 공급사 작업이 막히지 않게 합니다.
    const limits = new Map((await db.all('SELECT id,max_concurrency FROM ai_providers WHERE max_concurrency>0')).map((r) => [r.id, Number(r.max_concurrency)]));
    const running = new Map();
    if (limits.size)
      for (const r of await db.all("SELECT provider_id, COUNT(*) AS n FROM ai_jobs WHERE status='running' AND provider_id IS NOT NULL GROUP BY provider_id"))
        running.set(r.provider_id, Number(r.n));
    const full = [...limits.entries()].filter(([id, cap]) => (running.get(id) || 0) >= cap).map(([id]) => id);
    // 결과 확인할 차례인 작업(항상 확인)과 새로 시작할 작업을 따로 가져옵니다.
    const polls = await db.all(
      `SELECT * FROM ai_jobs WHERE claimed_by IS NULL AND status='running' AND vendor_ref<>'' AND (next_poll_at IS NULL OR next_poll_at<=?) ORDER BY next_poll_at LIMIT 50`,
      [stamp],
    );
    const queued = await db.all(
      `SELECT * FROM ai_jobs WHERE claimed_by IS NULL AND status='queued' AND (next_poll_at IS NULL OR next_poll_at<=?)` +
        (full.length ? ` AND (provider_id IS NULL OR provider_id NOT IN (${full.map(() => '?').join(',')}))` : '') +
        ' ORDER BY created_at LIMIT 50',
      [stamp, ...full],
    );
    for (const job of [...polls, ...queued]) {
      if (inflight.size >= max) break;
      if (job.status === 'queued' && limits.has(job.provider_id)) {
        if ((running.get(job.provider_id) || 0) >= limits.get(job.provider_id)) continue;
      }
      const claimed = await claim(job, job.status);
      if (!claimed) continue;
      if (job.status === 'queued' && claimed.provider_id) running.set(claimed.provider_id, (running.get(claimed.provider_id) || 0) + 1);
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
    // enqueue는 호출한 쪽 트랜잭션 안에서 실행되므로, 여기서 만든 타이머가 그 트랜잭션 컨텍스트
    // (AsyncLocalStorage)를 물려받지 않도록 분리합니다. 그렇지 않으면 엔진의 DB 작업이 남의
    // 트랜잭션에 섞여 들어갑니다.
    const schedule = () =>
      setTimeout(() => {
        kicking = false;
        void tick().catch((e) => console.error('ai tick', e.message));
      }, 50);
    if (db.detach) db.detach(schedule);
    else schedule();
  }
  async function start() {
    // 서버가 꺼질 때 공급사 호출 중이던 작업은 다시 대기열로, 결과 확인 중이던 작업은 계속 확인합니다.
    // 꺼져 있던 시간 때문에 바로 '너무 오래 걸림'으로 끝나지 않도록 시작 시각도 새로 잡습니다.
    await db.run("UPDATE ai_jobs SET status='queued',claimed_by=NULL,started_at=NULL WHERE status='running' AND vendor_ref=''");
    await db.run("UPDATE ai_jobs SET claimed_by=NULL,started_at=?,poll_failures=0 WHERE status='running'", [iso()]);
    timer = setInterval(() => void tick().catch((e) => console.error('ai tick', e.message)), 1500);
    timer.unref();
    kick();
  }
  async function cancel(jobId, actor, { force = false } = {}) {
    return db.transaction(async () => {
      const job = await db.get('SELECT * FROM ai_jobs WHERE id=?' + forUpdate(), [jobId]);
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
    explain,
    modelStats,
    start,
    stop: () => timer && clearInterval(timer),
    tick,
    drain,
    cancel,
    unitOf,
  };
}
