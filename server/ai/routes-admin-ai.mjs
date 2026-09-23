import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../settings.mjs';
import { encrypt, decrypt, hintOf } from './secret.mjs';
import { adapterOf, lamaPerUnit, TAGS } from './engine.mjs';
import { kindCatalog, presets, unitOf, capabilityLabel } from './providers.mjs';

// 슈퍼관리자: AI 공급사·모델 등록(중국 모델 포함), 키 암호화 저장, 연결 테스트, 가격·자동 선택 규칙,
// 작업 모니터(취소·환불), PD별 한도.
const KST = 9 * 3600000;
const monthStart = () => {
  const d = new Date(Date.now() + KST);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - KST).toISOString();
};
export const MOCK_MODELS = [
  ['mock-writer', 'text', '가짜 작가 (개발용)', 'standard', 1, 'korean,story'],
  ['mock-image', 'image', '가짜 이미지 (개발용)', 'draft', 3, 'cheap,character,poster'],
  ['mock-image-hq', 'image', '가짜 이미지 HQ (개발용)', 'premium', 8, 'character,consistency,poster'],
  ['mock-video-fast', 'video', '가짜 영상 빠름 (개발용)', 'draft', 5, 'cheap,scene,action'],
  ['mock-video-cinema', 'video', '가짜 영상 시네마 (개발용)', 'premium', 20, 'dialogue,closeup,cinematic,lipsync'],
  ['mock-voice', 'tts', '가짜 음성 (개발용)', 'standard', 20, 'korean'],
  ['mock-stt', 'stt', '가짜 자막 인식 (개발용)', 'standard', 10, 'korean'],
  ['mock-music', 'music', '가짜 배경음악 (개발용)', 'standard', 0.2, 'emotion'],
  ['mock-sfx', 'sfx', '가짜 효과음 (개발용)', 'standard', 0.5, 'scene'],
  ['mock-lipsync', 'lipsync', '가짜 입 모양 (개발용)', 'standard', 1, 'lipsync,dialogue'],
];
export async function seedMock(db) {
  const stamp = new Date().toISOString();
  await db.run(
    "INSERT INTO ai_providers (id,name,kind,base_url,country,active,status,sort_order,created_at,updated_at) VALUES ('mock','개발용 가짜 AI','mock','','KR',1,'ok',99,?,?) ON CONFLICT(id) DO NOTHING",
    [stamp, stamp],
  );
  for (const [id, capability, label, tier, price, tags] of MOCK_MODELS)
    await db.run(
      'INSERT INTO ai_models (id,provider_id,capability,model_id,label,tier,unit,cost_usd,price_lama,tags,max_seconds,image_input,active,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,1,1,50,?,?) ON CONFLICT(id) DO NOTHING',
      [id, 'mock', capability, id, label, tier, unitOf[capability], price, tags, capability === 'music' ? 180 : capability === 'lipsync' || capability === 'sfx' ? 30 : 10, stamp, stamp],
    );
}

export function adminAiRoutes({ app, db, fail, now, roles, engine }) {
  const audit = (actorId, action, targetId) =>
    db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), actorId, action, targetId, now()]);
  const providerView = (p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    base_url: p.base_url,
    region: p.region,
    country: p.country,
    active: Number(p.active),
    status: p.status,
    last_error: p.last_error,
    last_checked_at: p.last_checked_at,
    key_hint: p.key_hint,
    has_key: !!p.api_key_enc,
    has_secret: !!p.secret_enc,
    sort_order: Number(p.sort_order),
    max_concurrency: Number(p.max_concurrency || 0),
    monthly_budget_won: Number(p.monthly_budget_won || 0),
    fail_streak: Number(p.fail_streak || 0),
    cooldown_until: p.cooldown_until && new Date(p.cooldown_until).getTime() > Date.now() ? p.cooldown_until : null,
    month_cost: Number(p.month_cost || 0),
    has_list: !!adapterOf(p.kind)?.listModels,
  });

  app.get('/api/admin/ai', roles('admin'), async (req, res) => {
    const settings = await loadSettings(db);
    const since = monthStart();
    const models = await db.all('SELECT m.*, p.name AS provider_name, p.kind FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id ORDER BY m.capability, m.priority DESC, m.label');
    res.json({
      settings,
      catalog: kindCatalog,
      presets: presets.map((p) => ({ kind: p.kind, name: p.name, country: p.country, base_url: p.base_url, models: p.models.length, capabilities: [...new Set(p.models.map((x) => x.capability))] })),
      tags: TAGS,
      capabilities: capabilityLabel,
      providers: (
        await db.all(
          "SELECT p.*, (SELECT COALESCE(SUM(j.cost_won),0) FROM ai_jobs j WHERE j.provider_id=p.id AND j.status IN ('succeeded','queued','running') AND j.created_at>=?) AS month_cost FROM ai_providers p ORDER BY p.sort_order, p.created_at",
          [since],
        )
      ).map(providerView),
      routes: await db.all('SELECT * FROM ai_route_rules ORDER BY capability, tier'),
      models: models.map((m) => ({ ...m, lama_per_unit: Math.round(lamaPerUnit(m, settings) * 100) / 100 })),
      usage: {
        month: await db.get(
          "SELECT COUNT(*) AS jobs, COALESCE(SUM(CASE WHEN status='succeeded' THEN cost_won ELSE 0 END),0) AS cost_won, COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_lama ELSE 0 END),0) AS lama, COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed, COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END),0) AS active FROM ai_jobs WHERE created_at>=?",
          [since],
        ),
        byModel: await db.all(
          "SELECT j.model_ref, m.label, j.capability, COUNT(*) AS jobs, COALESCE(SUM(CASE WHEN j.status='succeeded' THEN j.cost_won ELSE 0 END),0) AS cost_won, COALESCE(SUM(CASE WHEN j.status='succeeded' THEN j.charged_lama ELSE 0 END),0) AS lama, COALESCE(SUM(CASE WHEN j.status='failed' THEN 1 ELSE 0 END),0) AS failed FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref WHERE j.created_at>=? GROUP BY j.model_ref, m.label, j.capability ORDER BY cost_won DESC",
          [since],
        ),
        byUser: await db.all(
          "SELECT j.user_id, u.name, u.email, COUNT(*) AS jobs, COALESCE(SUM(CASE WHEN j.status='succeeded' THEN j.charged_lama ELSE 0 END),0) AS lama, COALESCE(SUM(CASE WHEN j.status='succeeded' THEN j.cost_won ELSE 0 END),0) AS cost_won FROM ai_jobs j JOIN users u ON u.id=j.user_id WHERE j.created_at>=? GROUP BY j.user_id, u.name, u.email ORDER BY lama DESC LIMIT 30",
          [since],
        ),
      },
      jobs: await db.all(
        "SELECT j.id,j.user_id,j.kind,j.capability,j.status,j.requested_model,j.tier,j.estimate_lama,j.charged_lama,j.cost_won,j.error,j.error_detail,j.attempts,j.created_at,j.finished_at,j.billed,u.name AS user_name,m.label AS model_label,p.name AS provider_name FROM ai_jobs j JOIN users u ON u.id=j.user_id LEFT JOIN ai_models m ON m.id=j.model_ref LEFT JOIN ai_providers p ON p.id=j.provider_id ORDER BY j.created_at DESC LIMIT 150",
      ),
      limits: await db.all(
        "SELECT u.id,u.name,u.email,u.role,l.daily_lama,l.monthly_lama,COALESCE(l.blocked,0) AS blocked FROM users u LEFT JOIN ai_user_limits l ON l.user_id=u.id WHERE u.role IN ('pd','admin') ORDER BY u.name",
      ),
    });
  });

  const providerSchema = z.object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(Object.keys(kindCatalog)),
    base_url: z.string().trim().max(300).refine((v) => !v || /^https?:\/\//.test(v), 'http(s) 주소를 입력해 주세요.').default(''),
    region: z.string().trim().max(60).default(''),
    country: z.string().trim().max(10).default(''),
    active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(999).default(0),
    api_key: z.string().trim().max(2000).optional(),
    secret: z.string().trim().max(2000).optional(),
    clear_key: z.boolean().optional(),
    max_concurrency: z.number().int().min(0).max(100).default(0),
    monthly_budget_won: z.number().int().min(0).max(2000000000).default(0),
  });
  app.post('/api/admin/ai/providers', roles('admin'), async (req, res) => {
    const b = providerSchema.parse(req.body);
    const id = randomUUID();
    await db.run(
      'INSERT INTO ai_providers (id,name,kind,base_url,api_key_enc,key_hint,secret_enc,region,country,active,status,sort_order,max_concurrency,monthly_budget_won,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, b.name, b.kind, b.base_url || kindCatalog[b.kind].base || '', encrypt(b.api_key || ''), hintOf(b.api_key), encrypt(b.secret || ''), b.region, b.country, b.active ? 1 : 0, 'unknown', b.sort_order, b.max_concurrency, b.monthly_budget_won, now(), now()],
    );
    await audit(req.user.id, `ai-provider:created:${b.kind}`, id);
    res.status(201).json({ id });
  });
  app.patch('/api/admin/ai/providers/:id', roles('admin'), async (req, res) => {
    const b = providerSchema.parse(req.body);
    const p = await db.get('SELECT * FROM ai_providers WHERE id=?', [req.params.id]);
    if (!p) fail(404, '공급사를 찾을 수 없어요.');
    if (p.kind === 'mock') fail(400, '개발용 가짜 AI는 수정할 수 없어요.');
    // 키는 새로 입력했을 때만 바꿉니다. 빈 칸이면 기존 키 유지, clear_key면 삭제.
    const keyEnc = b.clear_key ? '' : b.api_key ? encrypt(b.api_key) : p.api_key_enc;
    const keyHint = b.clear_key ? '' : b.api_key ? hintOf(b.api_key) : p.key_hint;
    const secretEnc = b.clear_key ? '' : b.secret ? encrypt(b.secret) : p.secret_enc;
    await db.run(
      "UPDATE ai_providers SET name=?,kind=?,base_url=?,api_key_enc=?,key_hint=?,secret_enc=?,region=?,country=?,active=?,sort_order=?,max_concurrency=?,monthly_budget_won=?,status=CASE WHEN ?=1 THEN 'unknown' ELSE status END,updated_at=? WHERE id=?",
      [b.name, b.kind, b.base_url, keyEnc, keyHint, secretEnc, b.region, b.country, b.active ? 1 : 0, b.sort_order, b.max_concurrency, b.monthly_budget_won, b.api_key || b.clear_key ? 1 : 0, now(), p.id],
    );
    await audit(req.user.id, `ai-provider:updated${b.api_key ? ':key' : ''}${b.clear_key ? ':key-cleared' : ''}`, p.id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/ai/providers/:id', roles('admin'), async (req, res) => {
    const p = await db.get('SELECT * FROM ai_providers WHERE id=?', [req.params.id]);
    if (!p) fail(404, '공급사를 찾을 수 없어요.');
    if (p.kind === 'mock') fail(400, '개발용 가짜 AI는 삭제할 수 없어요.');
    const used = await db.get('SELECT id FROM ai_jobs WHERE provider_id=? LIMIT 1', [p.id]);
    if (used) {
      await db.run("UPDATE ai_providers SET active=0,api_key_enc='',secret_enc='',key_hint='',updated_at=? WHERE id=?", [now(), p.id]);
      await audit(req.user.id, 'ai-provider:deactivated', p.id);
      return res.json({ ok: true, deactivated: true });
    }
    await db.run('DELETE FROM ai_providers WHERE id=?', [p.id]);
    await audit(req.user.id, 'ai-provider:deleted', p.id);
    res.json({ ok: true, deleted: true });
  });
  app.post('/api/admin/ai/providers/:id/test', roles('admin'), async (req, res) => {
    const p = await db.get('SELECT * FROM ai_providers WHERE id=?', [req.params.id]);
    if (!p) fail(404, '공급사를 찾을 수 없어요.');
    const adapter = adapterOf(p.kind);
    if (p.kind !== 'mock' && !p.api_key_enc) fail(400, 'API 키를 먼저 입력해 주세요.');
    try {
      const message = await adapter.test({ provider: p, key: p.kind === 'mock' ? '' : decrypt(p.api_key_enc), secret: p.secret_enc ? decrypt(p.secret_enc) : '' });
      await db.run("UPDATE ai_providers SET status='ok',last_error='',last_checked_at=? WHERE id=?", [now(), p.id]);
      res.json({ ok: true, message });
    } catch (e) {
      await db.run("UPDATE ai_providers SET status='error',last_error=?,last_checked_at=? WHERE id=?", [String(e.message).slice(0, 500), now(), p.id]);
      res.json({ ok: false, message: e.message });
    }
  });
  // 장애 차단 해제
  app.post('/api/admin/ai/providers/:id/reset', roles('admin'), async (req, res) => {
    const p = await db.get('SELECT id FROM ai_providers WHERE id=?', [req.params.id]);
    if (!p) fail(404, '공급사를 찾을 수 없어요.');
    await db.run("UPDATE ai_providers SET fail_streak=0,cooldown_until=NULL,status='unknown',last_error='' WHERE id=?", [p.id]);
    await audit(req.user.id, 'ai-provider:reset', p.id);
    res.json({ ok: true });
  });
  // 공급사에 등록된 모델 목록 불러오기(추가할 모델 ID 고르기용)
  app.post('/api/admin/ai/providers/:id/discover', roles('admin'), async (req, res) => {
    const p = await db.get('SELECT * FROM ai_providers WHERE id=?', [req.params.id]);
    if (!p) fail(404, '공급사를 찾을 수 없어요.');
    const adapter = adapterOf(p.kind);
    if (!adapter?.listModels) fail(400, '이 공급사는 모델 목록 API가 없어요. 공급사 문서에서 모델 ID를 확인해 주세요.');
    if (!p.api_key_enc) fail(400, 'API 키를 먼저 입력해 주세요.');
    try {
      const ids = await adapter.listModels({ provider: p, key: decrypt(p.api_key_enc) });
      const known = new Set((await db.all('SELECT model_id FROM ai_models WHERE provider_id=?', [p.id])).map((r) => r.model_id));
      res.json({ models: [...new Set(ids)].sort().slice(0, 500).map((id) => ({ id, added: known.has(id) })) });
    } catch (e) {
      fail(502, '모델 목록을 불러오지 못했어요: ' + e.message);
    }
  });
  // 라우팅 규칙: 작업·품질 등급별로 먼저 쓸 모델 순서를 지정합니다.
  app.put('/api/admin/ai/routes', roles('admin'), async (req, res) => {
    const b = z
      .object({
        capability: z.enum(['text', 'image', 'video', 'tts', 'stt', 'music', 'sfx', 'lipsync']),
        tier: z.enum(['draft', 'standard', 'premium']),
        model_ids: z.array(z.string().min(1).max(80)).max(10),
        active: z.boolean().default(true),
      })
      .parse(req.body);
    for (const id of b.model_ids) {
      const m = await db.get('SELECT capability FROM ai_models WHERE id=?', [id]);
      if (!m || m.capability !== b.capability) fail(400, '규칙에 넣은 모델이 이 작업용 모델이 아니에요.');
    }
    if (!b.model_ids.length) await db.run('DELETE FROM ai_route_rules WHERE capability=? AND tier=?', [b.capability, b.tier]);
    else
      await db.run(
        'INSERT INTO ai_route_rules (id,capability,tier,model_ids,active,updated_at,updated_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(capability,tier) DO UPDATE SET model_ids=excluded.model_ids,active=excluded.active,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
        [randomUUID(), b.capability, b.tier, b.model_ids.join(','), b.active ? 1 : 0, now(), req.user.id],
      );
    await audit(req.user.id, `ai-route:${b.capability}:${b.tier}`, b.model_ids.join(','));
    res.json({ ok: true });
  });
  // 가격 일괄 조정: 자동 계산으로 되돌리거나, 현재 라마 가격에 배율을 곱해 고정 단가로 만듭니다.
  app.post('/api/admin/ai/models/bulk', roles('admin'), async (req, res) => {
    const b = z
      .object({ action: z.enum(['auto', 'multiply']), factor: z.number().min(0.1).max(10).default(1), capability: z.enum(['all', 'text', 'image', 'video', 'tts', 'stt', 'music', 'sfx', 'lipsync']).default('all') })
      .parse(req.body);
    const settings = await loadSettings(db);
    const rows = await db.all(
      "SELECT m.* FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id WHERE p.kind<>'mock'" + (b.capability === 'all' ? '' : ' AND m.capability=?'),
      b.capability === 'all' ? [] : [b.capability],
    );
    for (const m of rows) {
      const price = b.action === 'auto' ? 0 : Math.max(0.01, Math.round(lamaPerUnit(m, settings) * b.factor * 100) / 100);
      await db.run('UPDATE ai_models SET price_lama=?,updated_at=? WHERE id=?', [price, now(), m.id]);
    }
    await audit(req.user.id, `ai-model:bulk:${b.action}:${b.factor}`, b.capability);
    res.json({ ok: true, updated: rows.length });
  });
  // 분석: 최근 N일 일별 원가·라마 매출·작업, 모델별 성공률·평균 소요 시간
  app.get('/api/admin/ai/analytics', roles('admin'), async (req, res) => {
    const days = z.coerce.number().int().min(7).max(90).default(30).parse(req.query.days || 30);
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await db.all(
      'SELECT j.status,j.cost_won,j.charged_lama,j.capability,j.created_at,j.started_at,j.finished_at,j.model_ref,j.attempts,m.label,p.name AS provider_name,p.country FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref LEFT JOIN ai_providers p ON p.id=j.provider_id WHERE j.created_at>=?',
      [from],
    );
    const dayOf = (iso) => new Date(new Date(iso).getTime() + KST).toISOString().slice(0, 10);
    const series = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = dayOf(new Date(Date.now() - i * 86400000).toISOString());
      series.set(d, { day: d, jobs: 0, failed: 0, cost_won: 0, lama: 0 });
    }
    const models = new Map();
    for (const r of rows) {
      const day = series.get(dayOf(r.created_at));
      const ok = r.status === 'succeeded';
      if (day) {
        day.jobs++;
        if (r.status === 'failed') day.failed++;
        if (ok) {
          day.cost_won += Number(r.cost_won || 0);
          day.lama += Number(r.charged_lama || 0);
        }
      }
      const key = r.model_ref || 'gone';
      const m = models.get(key) || { model_ref: key, label: r.label || '삭제된 모델', provider: r.provider_name || '', country: r.country || '', capability: r.capability, jobs: 0, succeeded: 0, failed: 0, retries: 0, seconds: 0, timed: 0, cost_won: 0, lama: 0 };
      m.jobs++;
      m.retries += Number(r.attempts || 0);
      if (ok) {
        m.succeeded++;
        m.cost_won += Number(r.cost_won || 0);
        m.lama += Number(r.charged_lama || 0);
        if (r.started_at && r.finished_at) {
          m.seconds += (new Date(r.finished_at) - new Date(r.started_at)) / 1000;
          m.timed++;
        }
      }
      if (r.status === 'failed') m.failed++;
      models.set(key, m);
    }
    res.json({
      days,
      series: [...series.values()],
      models: [...models.values()]
        .map((m) => ({ ...m, success_rate: m.jobs ? Math.round((m.succeeded / Math.max(1, m.succeeded + m.failed)) * 1000) / 10 : 0, avg_seconds: m.timed ? Math.round((m.seconds / m.timed) * 10) / 10 : null }))
        .sort((a, b) => b.jobs - a.jobs),
    });
  });
  // 모든 PD의 스튜디오 프로젝트 현황
  app.get('/api/admin/ai/projects', roles('admin'), async (req, res) => {
    res.json(
      await db.all(
        `SELECT p.id,p.title,p.genre,p.status,p.episode_count,p.autopilot,p.exclude_cn,p.updated_at,p.drama_id,u.name AS owner_name,u.email AS owner_email,
         d.status AS drama_status,
         (SELECT COUNT(*) FROM studio_episodes e WHERE e.project_id=p.id AND e.video<>'') AS composed,
         (SELECT COUNT(*) FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=p.id) AS shots,
         (SELECT COALESCE(SUM(j.charged_lama),0) FROM ai_jobs j WHERE j.project_id=p.id AND j.status='succeeded') AS spent,
         (SELECT COALESCE(SUM(j.cost_won),0) FROM ai_jobs j WHERE j.project_id=p.id AND j.status='succeeded') AS cost_won,
         (SELECT COUNT(*) FROM ai_jobs j WHERE j.project_id=p.id AND j.status IN ('queued','running')) AS active
         FROM studio_projects p JOIN users u ON u.id=p.owner_id LEFT JOIN dramas d ON d.id=p.drama_id ORDER BY p.updated_at DESC LIMIT 300`,
      ),
    );
  });
  app.get('/api/admin/ai/safety', roles('admin'), async (req, res) => {
    res.json(
      await db.all('SELECT l.*, u.name AS user_name, u.email AS user_email FROM ai_safety_log l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 300'),
    );
  });
  // 프리셋: 공급사와 추천 모델을 한 번에 만듭니다(키는 이후 입력).
  app.post('/api/admin/ai/presets', roles('admin'), async (req, res) => {
    const b = z.object({ name: z.string().min(1) }).parse(req.body);
    const preset = presets.find((p) => p.name === b.name);
    if (!preset) fail(404, '프리셋을 찾을 수 없어요.');
    const id = randomUUID();
    const stamp = now();
    await db.transaction(async () => {
      await db.run(
        'INSERT INTO ai_providers (id,name,kind,base_url,country,active,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?,?)',
        [id, preset.name, preset.kind, preset.base_url, preset.country, 'unknown', 10, stamp, stamp],
      );
      for (const m of preset.models)
        await db.run(
          'INSERT INTO ai_models (id,provider_id,capability,model_id,label,tier,unit,cost_usd,price_lama,tags,max_seconds,image_input,active,priority,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,50,?,?,?)',
          [randomUUID(), id, m.capability, m.model_id, m.label, m.tier, unitOf[m.capability], m.cost_usd, m.tags, m.max_seconds || 10, m.image_input ? 1 : 0, m.active === 0 ? 0 : 1, '프리셋 기본값 · 모델 ID와 가격을 공급사 문서에서 확인하세요', stamp, stamp],
        );
    });
    await audit(req.user.id, `ai-provider:preset:${preset.kind}`, id);
    res.status(201).json({ id });
  });
  const modelSchema = z.object({
    provider_id: z.string().min(1),
    capability: z.enum(['text', 'image', 'video', 'tts', 'stt', 'music', 'sfx', 'lipsync']),
    model_id: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(60),
    tier: z.enum(['draft', 'standard', 'premium']),
    cost_usd: z.number().min(0).max(1000),
    price_lama: z.number().min(0).max(1000000).default(0),
    tags: z.array(z.enum(TAGS)).max(10).default([]),
    max_seconds: z.number().int().min(1).max(600).default(10),
    image_input: z.boolean().default(false),
    active: z.boolean().default(true),
    priority: z.number().int().min(0).max(100).default(50),
    notes: z.string().trim().max(300).default(''),
  });
  app.post('/api/admin/ai/models', roles('admin'), async (req, res) => {
    const b = modelSchema.parse(req.body);
    const p = await db.get('SELECT * FROM ai_providers WHERE id=?', [b.provider_id]);
    if (!p || p.kind === 'mock') fail(400, '모델을 추가할 공급사를 확인해 주세요.');
    if (!adapterOf(p.kind).capabilities.includes(b.capability)) fail(400, '이 공급사 종류는 해당 작업을 지원하지 않아요.');
    const id = randomUUID();
    await db.run(
      'INSERT INTO ai_models (id,provider_id,capability,model_id,label,tier,unit,cost_usd,price_lama,tags,max_seconds,image_input,active,priority,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, p.id, b.capability, b.model_id, b.label, b.tier, unitOf[b.capability], b.cost_usd, b.price_lama, b.tags.join(','), b.max_seconds, b.image_input ? 1 : 0, b.active ? 1 : 0, b.priority, b.notes, now(), now()],
    );
    await audit(req.user.id, `ai-model:created:${b.capability}`, id);
    res.status(201).json({ id });
  });
  app.patch('/api/admin/ai/models/:id', roles('admin'), async (req, res) => {
    const m = await db.get('SELECT m.*, p.kind FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id WHERE m.id=?', [req.params.id]);
    if (!m) fail(404, '모델을 찾을 수 없어요.');
    const b = modelSchema.parse({ ...req.body, provider_id: m.provider_id });
    // 개발용 가짜 모델은 가격·우선순위·사용 여부만 바꿀 수 있습니다.
    if (m.kind === 'mock') {
      await db.run('UPDATE ai_models SET price_lama=?,cost_usd=?,priority=?,active=?,tier=?,tags=?,updated_at=? WHERE id=?', [b.price_lama, b.cost_usd, b.priority, b.active ? 1 : 0, b.tier, b.tags.join(','), now(), m.id]);
    } else {
      if (!adapterOf(m.kind).capabilities.includes(b.capability)) fail(400, '이 공급사 종류는 해당 작업을 지원하지 않아요.');
      await db.run(
        'UPDATE ai_models SET capability=?,model_id=?,label=?,tier=?,unit=?,cost_usd=?,price_lama=?,tags=?,max_seconds=?,image_input=?,active=?,priority=?,notes=?,updated_at=? WHERE id=?',
        [b.capability, b.model_id, b.label, b.tier, unitOf[b.capability], b.cost_usd, b.price_lama, b.tags.join(','), b.max_seconds, b.image_input ? 1 : 0, b.active ? 1 : 0, b.priority, b.notes, now(), m.id],
      );
    }
    await audit(req.user.id, 'ai-model:updated', m.id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/ai/models/:id', roles('admin'), async (req, res) => {
    const m = await db.get('SELECT m.*, p.kind FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id WHERE m.id=?', [req.params.id]);
    if (!m) fail(404, '모델을 찾을 수 없어요.');
    if (m.kind === 'mock') fail(400, '개발용 가짜 모델은 끄기만 할 수 있어요.');
    const used = await db.get('SELECT id FROM ai_jobs WHERE model_ref=? LIMIT 1', [m.id]);
    if (used) {
      await db.run('UPDATE ai_models SET active=0,updated_at=? WHERE id=?', [now(), m.id]);
      return res.json({ ok: true, deactivated: true });
    }
    await db.run('DELETE FROM ai_models WHERE id=?', [m.id]);
    await audit(req.user.id, 'ai-model:deleted', m.id);
    res.json({ ok: true, deleted: true });
  });
  app.put('/api/admin/ai/limits/:id', roles('admin'), async (req, res) => {
    const b = z
      .object({
        daily_lama: z.number().int().min(0).max(100000000).nullable(),
        monthly_lama: z.number().int().min(0).max(1000000000).nullable(),
        blocked: z.boolean(),
      })
      .parse(req.body);
    if (!(await db.get('SELECT id FROM users WHERE id=?', [req.params.id]))) fail(404, '회원을 찾을 수 없어요.');
    if (b.daily_lama === null && b.monthly_lama === null && !b.blocked) await db.run('DELETE FROM ai_user_limits WHERE user_id=?', [req.params.id]);
    else
      await db.run(
        'INSERT INTO ai_user_limits (user_id,daily_lama,monthly_lama,blocked,updated_at,updated_by) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET daily_lama=excluded.daily_lama,monthly_lama=excluded.monthly_lama,blocked=excluded.blocked,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
        [req.params.id, b.daily_lama, b.monthly_lama, b.blocked ? 1 : 0, now(), req.user.id],
      );
    await audit(req.user.id, `ai-limit:${b.blocked ? 'blocked' : 'set'}`, req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/admin/ai/jobs/:id/cancel', roles('admin'), async (req, res) => {
    const result = await engine.cancel(req.params.id, req.user, { force: true });
    await audit(req.user.id, 'ai-job:canceled', req.params.id);
    res.json(result);
  });
  // 관리자 모델 시험: 라마를 쓰지 않고(플랫폼 비용으로) 짧은 결과를 만들어 봅니다.
  app.post('/api/admin/ai/models/:id/try', roles('admin'), async (req, res) => {
    const b = z.object({ prompt: z.string().trim().min(2).max(500) }).parse(req.body);
    const m = await db.get('SELECT * FROM ai_models WHERE id=?', [req.params.id]);
    if (!m) fail(404, '모델을 찾을 수 없어요.');
    const input =
      m.capability === 'text'
        ? { prompt: b.prompt, maxTokens: 400 }
        : m.capability === 'tts'
          ? { text: b.prompt }
          : m.capability === 'video'
            ? { prompt: b.prompt, seconds: Math.min(5, Number(m.max_seconds) || 5), aspect: '9:16' }
            : m.capability === 'stt'
              ? fail(400, '음성 인식 모델은 업로드 영상 자막 만들기에서 시험해 주세요.')
              : { prompt: b.prompt, aspect: '9:16' };
    const job = await db.transaction(() =>
      engine.enqueue({ userId: req.user.id, kind: 'playground', capability: m.capability, requested: m.id, tier: m.tier, input, bill: false }),
    );
    await audit(req.user.id, 'ai-model:try', m.id);
    res.status(201).json({ id: job.id });
  });
  app.get('/api/admin/ai/jobs/:id', roles('admin'), async (req, res) => {
    const job = await db.get('SELECT j.*, m.label AS model_label FROM ai_jobs j LEFT JOIN ai_models m ON m.id=j.model_ref WHERE j.id=?', [req.params.id]);
    if (!job) fail(404, '작업을 찾을 수 없어요.');
    res.json({ ...job, input: JSON.parse(job.input || '{}'), output: JSON.parse(job.output || '{}') });
  });
}
