import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { runFfmpeg, probeMedia } from '../media.mjs';
import { parseJson, verifyPrompt, verifySchema } from './prompts.mjs';
import { loadSettings } from '../settings.mjs';

// 모델 품질 시험(6단계, 2026-09-30) — 최고 관리자 전용
// 같은 시험 문제(프롬프트 · 참고 얼굴)를 여러 모델에 똑같이 보내고(라마 차감 없음, 원가는 플랫폼 부담),
// 결과를 AI 검수로 자동 채점해 모델별 점수 · 인물 닮음 · 원가 · 걸린 시간을 한 표로 비교해요.
// 채점 점수는 품질 표본(ai_quality_samples, source=bench)으로 남아 자동 선택의 '품질' 가중치에 쓰여요.
const PRESETS = [
  { name: '비 오는 골목 클로즈업', capability: 'image', prompt: 'Close-up of a young Korean woman in a beige trench coat standing in a rainy neon-lit alley at night, wet hair, teary eyes, cinematic lighting, vertical 9:16, no text.' },
  { name: '카페 대화 투샷', capability: 'image', prompt: 'Two-shot of a Korean man and woman talking across a small cafe table by a window, warm afternoon light, natural hands holding coffee cups, vertical 9:16, no text.' },
  { name: '손과 소품 디테일', capability: 'image', prompt: 'Close-up of a woman\'s hands opening an old yellowed letter with a red wax seal, five natural fingers on each hand, soft window light, vertical 9:16, no text.' },
  { name: '천천히 다가가는 고백', capability: 'video', prompt: 'A Korean man confesses to a woman on a rooftop at golden hour, slow push-in toward his face, gentle wind in hair, vertical 9:16, natural motion, no text overlay.', seconds: 5 },
];

export function benchRoutes({ app, db, fail, now, roles, engine, uploadDir }) {
  const audit = (actorId, action, targetId) => db.run('INSERT INTO audit_logs (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), actorId, action, targetId, now()]).catch(() => {});
  const imageRef = (url) => (url && url.startsWith('/uploads/') ? { path: url, mime: /\.png$/.test(url) ? 'image/png' : /\.webp$/.test(url) ? 'image/webp' : 'image/jpeg' } : undefined);
  // 처음 쓰면 기본 시험 문제를 넣어 둬요.
  async function seed(actorId) {
    const n = Number((await db.get('SELECT COUNT(*) AS n FROM ai_benchmarks'))?.n || 0);
    if (n) return;
    for (const x of PRESETS)
      await db.run('INSERT INTO ai_benchmarks (id,name,capability,prompt,ref_image,seconds,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [randomUUID(), x.name, x.capability, x.prompt, '', x.seconds || 5, actorId, now()]);
  }
  const benchSchema = z.object({
    name: z.string().trim().min(2).max(60),
    capability: z.enum(['image', 'video']),
    prompt: z.string().trim().min(10).max(800),
    // 인물 닮음을 재려면 기준 얼굴(이미 올린 /uploads 이미지)을 넣어요(비워도 됨).
    ref_image: z.string().regex(/^(|\/uploads\/[a-f0-9-]+\.(jpg|png|webp))$/).default(''),
    seconds: z.number().int().min(2).max(10).default(5),
  });

  // 시험 결과가 나오면 결과를 기록하고, 잠시 뒤(작업 확정 후) 자동 채점을 걸어요.
  engine.registerHandler('bench_run', {
    async onSuccess({ job, result }) {
      await db.run("UPDATE ai_benchmark_runs SET status='scoring',result_url=? WHERE job_id=?", [result.url || '', job.id]);
      // 이 코드는 작업 확정 트랜잭션 안에서 돌아요. 채점은 확정된 뒤, 트랜잭션에서 떼어 낸 타이머로 시작해요.
      const later = () => setTimeout(() => void scoreSafe(job.id), 300);
      if (db.detach) db.detach(later);
      else later();
      return { url: result.url };
    },
    onFail: async ({ job, message }) => {
      await db.run("UPDATE ai_benchmark_runs SET status='failed',error=?,finished_at=? WHERE job_id=?", [String(message || '실패').slice(0, 300), now(), job.id]);
    },
  });
  engine.registerHandler('bench_verify', {
    async onSuccess({ job, result }) {
      const v = parseJson(result.text, verifySchema);
      const run = await db.get('SELECT r.*, b.capability FROM ai_benchmark_runs r JOIN ai_benchmarks b ON b.id=r.benchmark_id WHERE r.verify_job_id=?', [job.id]);
      if (!run) return { skipped: true };
      const face = v.faces?.length ? Math.round(Math.min(...v.faces.map((f) => Number(f.match)))) : null;
      await db.run("UPDATE ai_benchmark_runs SET status='done',score=?,face=?,summary=?,finished_at=? WHERE id=?", [Math.round(v.score), face, (v.summary || (v.issues || []).map((x) => x.text).join(' · ')).slice(0, 300), now(), run.id]);
      await db.run('INSERT INTO ai_quality_samples (id,model_ref,kind,source,score,face,created_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), run.model_id, run.capability, 'bench', Math.round(v.score), face, now()]);
      // 채점용 장면은 확정된 뒤에 지워요(확정이 실패해 다시 시도하면 필요해요).
      const frame = JSON.parse(job.input || '{}').tempFrame;
      if (frame) {
        const later = () =>
          setTimeout(async () => {
            const j = await db.get('SELECT status FROM ai_jobs WHERE id=?', [job.id]).catch(() => null);
            if (!j || ['succeeded', 'failed', 'canceled'].includes(j.status)) await removeFrame(frame);
          }, 1500);
        if (db.detach) db.detach(later);
        else later();
      }
      return { score: Math.round(v.score) };
    },
    onFail: async ({ job, message }) => {
      await db.run("UPDATE ai_benchmark_runs SET status='unscored',error=?,finished_at=? WHERE verify_job_id=?", [('채점 실패: ' + String(message || '')).slice(0, 300), now(), job.id]);
      await removeFrame(JSON.parse(job.input || '{}').tempFrame);
    },
  });
  const removeFrame = async (url) => {
    if (!url || !/^\/uploads\/[a-f0-9-]+\.jpg$/.test(url)) return;
    await db.run('DELETE FROM media_files WHERE url=?', [url]).catch(() => {});
    await rm(path.join(uploadDir, path.basename(url)), { force: true }).catch(() => {});
  };
  // 채점 중 오류(장면 뽑기 실패 등)가 나도 '채점 중'에 멈추지 않게 '채점 못 함'으로 끝내요.
  async function scoreSafe(jobId) {
    try {
      await score(jobId);
    } catch (e) {
      console.error('bench score', e.message);
      await db.run("UPDATE ai_benchmark_runs SET status='unscored',error=?,finished_at=? WHERE job_id=? AND status='scoring'", [('채점 못 함: ' + e.message).slice(0, 300), now(), jobId]).catch(() => {});
    }
  }
  // 서버가 멈췄다 켜지는 등으로 오래 멈춘 시험은 정리해요(목록을 볼 때마다).
  async function sweep() {
    const old = new Date(Date.now() - 15 * 60000).toISOString();
    await db.run("UPDATE ai_benchmark_runs SET status='unscored',error='채점이 멈춰 정리했어요.',finished_at=? WHERE status='scoring' AND created_at<? AND (verify_job_id IS NULL OR verify_job_id IN (SELECT id FROM ai_jobs WHERE status IN ('failed','canceled','succeeded')))", [now(), old]);
    await db.run("UPDATE ai_benchmark_runs SET status='failed',error='시험 작업이 끝나지 못했어요.',finished_at=? WHERE status='running' AND job_id IN (SELECT id FROM ai_jobs WHERE status IN ('failed','canceled'))", [now()]);
  }
  async function score(jobId) {
    const job = await db.get('SELECT * FROM ai_jobs WHERE id=?', [jobId]);
    const run = await db.get('SELECT r.*, b.capability, b.prompt, b.ref_image FROM ai_benchmark_runs r JOIN ai_benchmarks b ON b.id=r.benchmark_id WHERE r.job_id=?', [jobId]);
    if (!job || !run) return;
    const seconds = job.started_at && job.finished_at ? Math.round((new Date(job.finished_at) - new Date(job.started_at)) / 100) / 10 : null;
    await db.run('UPDATE ai_benchmark_runs SET cost_won=?,seconds=? WHERE id=?', [Number(job.cost_won || 0), seconds, run.id]);
    if (!run.result_url) return db.run("UPDATE ai_benchmark_runs SET status='unscored',finished_at=? WHERE id=?", [now(), run.id]);
    // 영상은 가운데 장면 한 장을 뽑아 채점해요.
    let image = run.result_url;
    let tempFrame = '';
    if (run.capability === 'video') {
      const src = path.join(uploadDir, path.basename(run.result_url));
      const info = await probeMedia(src).catch(() => null);
      const id = randomUUID();
      await runFfmpeg(['-ss', String(Math.max(0, Number(info?.duration || 2) / 2)), '-i', src, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', '-y', path.join(uploadDir, id + '.jpg')], 60000).catch(async (e) => {
        await rm(path.join(uploadDir, id + '.jpg'), { force: true }).catch(() => {});
        throw e;
      });
      image = tempFrame = '/uploads/' + id + '.jpg';
      await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [image, job.user_id, 'image/jpeg', now()]);
    }
    const people = run.ref_image ? [{ id: 'ref', name: '기준 인물', image: run.ref_image }] : [];
    const v = await db.transaction(() =>
      engine.enqueue({
        userId: job.user_id,
        kind: 'bench_verify',
        capability: 'text',
        requested: 'auto',
        tier: 'standard',
        bill: false,
        target: { type: 'bench', id: run.id },
        input: {
          ...verifyPrompt({ shot: { visual: run.prompt }, people }),
          refImages: [image, ...people.map((c) => c.image)].map(imageRef).filter(Boolean),
          tempFrame,
          _requireImage: true,
          userText: '',
        },
      }),
    ).catch(async (e) => {
      await removeFrame(tempFrame);
      await db.run("UPDATE ai_benchmark_runs SET status='unscored',error=?,finished_at=? WHERE id=?", [('채점할 모델이 없어요: ' + e.message).slice(0, 300), now(), run.id]);
      return null;
    });
    if (v) await db.run('UPDATE ai_benchmark_runs SET verify_job_id=? WHERE id=?', [v.id, run.id]);
  }

  app.get('/api/admin/ai/bench', roles('admin'), async (req, res) => {
    await seed(req.user.id);
    await sweep();
    const benchmarks = await db.all('SELECT * FROM ai_benchmarks ORDER BY created_at');
    const runs = await db.all(
      'SELECT r.*, b.name AS bench_name, b.capability, m.label AS model_label FROM ai_benchmark_runs r JOIN ai_benchmarks b ON b.id=r.benchmark_id LEFT JOIN ai_models m ON m.id=r.model_id ORDER BY r.created_at DESC LIMIT 100',
    );
    const models = await db.all("SELECT m.id,m.label,m.capability,m.tier,m.active,p.name AS provider FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id WHERE m.capability IN ('image','video') ORDER BY m.capability, m.label");
    res.json({ benchmarks, runs, models });
  });
  app.post('/api/admin/ai/bench', roles('admin'), async (req, res) => {
    const b = benchSchema.parse(req.body);
    const id = randomUUID();
    await db.run('INSERT INTO ai_benchmarks (id,name,capability,prompt,ref_image,seconds,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [id, b.name, b.capability, b.prompt, b.ref_image, b.seconds, req.user.id, now()]);
    await audit(req.user.id, 'ai-bench:create', id);
    res.status(201).json({ id });
  });
  app.delete('/api/admin/ai/bench/:id', roles('admin'), async (req, res) => {
    if (await db.get("SELECT id FROM ai_benchmark_runs WHERE benchmark_id=? AND status IN ('queued','running','scoring') LIMIT 1", [req.params.id])) fail(409, '진행 중인 시험이 끝난 뒤 지워 주세요.');
    await db.run('DELETE FROM ai_benchmark_runs WHERE benchmark_id=?', [req.params.id]);
    await db.run('DELETE FROM ai_benchmarks WHERE id=?', [req.params.id]);
    await audit(req.user.id, 'ai-bench:delete', req.params.id);
    res.json({ ok: true });
  });
  // 시험 실행: 고른 모델마다 같은 문제를 보내요(라마 차감 없음 · 원가는 플랫폼 부담이라 한 번에 8개 모델까지).
  app.post('/api/admin/ai/bench/:id/run', roles('admin'), async (req, res) => {
    const b = z.object({ models: z.array(z.string().max(80)).min(1).max(8) }).parse(req.body);
    const bench = await db.get('SELECT * FROM ai_benchmarks WHERE id=?', [req.params.id]);
    if (!bench) fail(404, '시험 문제를 찾을 수 없어요.');
    const out = [];
    const skipped = [];
    for (const modelId of [...new Set(b.models)]) {
      const m = await db.get('SELECT * FROM ai_models WHERE id=?', [modelId]);
      if (!m || m.capability !== bench.capability) {
        skipped.push({ model: modelId, reason: '이 시험과 종류가 다른 모델이에요.' });
        continue;
      }
      const runId = randomUUID();
      try {
        const job = await db.transaction(async () => {
          const j = await engine.enqueue({
            userId: req.user.id,
            kind: 'bench_run',
            capability: bench.capability,
            requested: m.id,
            tier: m.tier,
            bill: false,
            target: { type: 'bench', id: runId },
            input: {
              prompt: bench.prompt,
              aspect: '9:16',
              ...(bench.capability === 'video' ? { seconds: Number(bench.seconds) || 5 } : {}),
              ...(bench.ref_image ? { refImages: [imageRef(bench.ref_image)].filter(Boolean) } : {}),
              userText: '',
            },
          });
          await db.run('INSERT INTO ai_benchmark_runs (id,benchmark_id,model_id,job_id,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)', [runId, bench.id, m.id, j.id, 'running', req.user.id, now()]);
          return j;
        });
        out.push({ run: runId, job: job.id, model: m.id });
      } catch (e) {
        skipped.push({ model: m.id, reason: e.message });
      }
    }
    await audit(req.user.id, 'ai-bench:run', bench.id);
    res.status(201).json({ runs: out, skipped });
  });

  // 품질 대시보드: 모델별 시험 성적 + 실제 사용 실적(최근 30일) + 실제 AI 검수 점수(최근 60일)
  app.get('/api/admin/ai/quality', roles('admin'), async (req, res) => {
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const since60 = new Date(Date.now() - 60 * 86400000).toISOString();
    const models = await db.all("SELECT m.id,m.label,m.capability,m.tier,m.active,p.name AS provider FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id WHERE m.capability IN ('image','video','tts','lipsync','upscale','upscale_video','text') ORDER BY m.capability, m.label");
    const bench = new Map(
      (
        await db.all(
          "SELECT model_id, COUNT(*) AS runs, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, AVG(score) AS score, AVG(face) AS face, AVG(cost_won) AS cost, AVG(seconds) AS seconds FROM ai_benchmark_runs GROUP BY model_id",
        )
      ).map((r) => [r.model_id, r]),
    );
    const usage = new Map(
      (
        await db.all(
          "SELECT model_ref, COUNT(*) AS jobs, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, AVG(CASE WHEN status='succeeded' THEN cost_won END) AS cost, SUM(charged_lama) AS lama FROM ai_jobs WHERE created_at>=? AND kind NOT IN ('bench_run','bench_verify','playground') AND model_ref IS NOT NULL GROUP BY model_ref",
          [since30],
        )
      ).map((r) => [r.model_ref, r]),
    );
    // 걸린 시간은 성공한 작업의 시작~끝(서버에서 계산)
    const times = new Map();
    for (const r of await db.all("SELECT model_ref, started_at, finished_at FROM ai_jobs WHERE created_at>=? AND status='succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL LIMIT 5000", [since30])) {
      const d = (new Date(r.finished_at) - new Date(r.started_at)) / 1000;
      if (!(d > 0 && d < 3600)) continue;
      const t = times.get(r.model_ref) || { n: 0, s: 0 };
      t.n++;
      t.s += d;
      times.set(r.model_ref, t);
    }
    const real = new Map(
      (await db.all("SELECT model_ref, COUNT(*) AS n, AVG(score) AS score, AVG(face) AS face FROM ai_quality_samples WHERE source='real' AND created_at>=? GROUP BY model_ref", [since60])).map((r) => [r.model_ref, r]),
    );
    const all = await engine.modelStats({ fresh: true });
    const num = (v, d = 0) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
    res.json({
      models: models.map((m) => {
        const b = bench.get(m.id);
        const u = usage.get(m.id);
        const t = times.get(m.id);
        const r = real.get(m.id);
        return {
          ...m,
          bench: b ? { runs: Number(b.runs), done: Number(b.done), failed: Number(b.failed), score: num(b.score), face: num(b.face), cost_won: num(b.cost), seconds: num(b.seconds, 1) } : null,
          usage: u ? { jobs: Number(u.jobs), success: Number(u.jobs) ? Math.round((Number(u.ok) / Number(u.jobs)) * 100) : null, failed: Number(u.failed), cost_won: num(u.cost), lama: Number(u.lama || 0), seconds: t ? Math.round(t.s / t.n) : null } : null,
          real: r ? { samples: Number(r.n), score: num(r.score), face: num(r.face) } : null,
          quality: all.get(m.id)?.quality ?? null,
          quality_samples: all.get(m.id)?.qualityN ?? 0,
        };
      }),
      weight: Number((await loadSettings(db)).ai_weight_quality || 0),
    });
  });
}
