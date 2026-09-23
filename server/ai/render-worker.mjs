import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { composeEpisode, composeTrailer } from './compose.mjs';
import { notify } from '../notify.mjs';

// 합성 대기열 처리기. 합성은 ffmpeg(별도 프로세스)가 무거운 일을 하지만, 여러 회차가 한꺼번에 몰려도
// 서버가 느려지지 않도록 대기열(studio_renders)에 넣고 정해진 개수만 동시에 처리합니다.
// - 기본: 웹 서버 안에서 처리
// - COMPOSE_WORKER=external: 웹 서버는 대기열에 넣기만 하고, `npm run worker` 프로세스가 처리
const iso = () => new Date().toISOString();
const parse = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
export function subtitleStyleOf(raw) {
  const s = parse(raw, {});
  return {
    position: ['bottom', 'middle', 'top'].includes(s.position) ? s.position : 'bottom',
    size: ['s', 'm', 'l', 'xl'].includes(s.size) ? s.size : 'l',
    background: ['none', 'box', 'shadow'].includes(s.background) ? s.background : 'box',
    names: s.names !== false,
  };
}
export function createRenderWorker({ db, uploadDir }) {
  const workerId = randomUUID();
  const subsDir = path.join(uploadDir, 'subtitles');
  const running = new Set();
  let timer = null;
  const concurrency = Math.max(1, Math.min(4, Number(process.env.COMPOSE_CONCURRENCY || 1)));

  async function renderEpisode(job, progress) {
    const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [job.project_id]);
    const e = await db.get('SELECT * FROM studio_episodes WHERE id=? AND project_id=?', [job.target_id, job.project_id]);
    if (!p || !e) throw new Error('프로젝트나 회차가 지워졌어요.');
    const shots = await db.all('SELECT * FROM studio_shots WHERE episode_id=? ORDER BY sort_order', [e.id]);
    const cast = await db.all('SELECT id,name FROM studio_characters WHERE project_id=?', [p.id]);
    const style = subtitleStyleOf(p.subtitle_style);
    const volume = Number(e.bgm_volume) >= 0 ? Number(e.bgm_volume) : Number(p.bgm_volume);
    let out = null;
    let sub = '';
    try {
      out = await composeEpisode({
        shots,
        uploadDir,
        nameOf: (id) => cast.find((c) => c.id === id)?.name || '',
        resolution: p.resolution,
        introCard: e.intro_card,
        outroCard: e.outro_card,
        bgm: e.bgm || p.bgm,
        bgmVolume: volume,
        subtitlePosition: style.position,
        subtitleNames: style.names,
        onProgress: progress,
      });
      sub = randomUUID() + '.vtt';
      await mkdir(subsDir, { recursive: true });
      await writeFile(path.join(subsDir, sub), out.vtt, 'utf8');
      const done = await db.transaction(async () => {
        const fresh = await db.get('SELECT status FROM studio_episodes WHERE id=?', [e.id]);
        if (!fresh || fresh.status !== 'composing') return false; // 그사이 프로젝트가 지워지는 등
        await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [out.url, p.owner_id, 'video/mp4', iso()]);
        await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [out.url, out.duration, out.width, out.height, out.hasAudio ? 1 : 0]);
        await db.run("UPDATE studio_episodes SET status='composed',video=?,duration=?,subtitles=?,compose_progress=1,compose_error='' WHERE id=?", [out.url, out.duration, sub, e.id]);
        await db.run(
          'INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [randomUUID(), p.owner_id, p.id, 'episode', e.id, 'video', out.url, null, '합성', iso()],
        );
        return true;
      });
      if (!done) throw new Error('합성하는 동안 회차가 바뀌었어요.');
      await notify(db, p.owner_id, { kind: 'compose', title: `${p.title} ${e.number}화 합성이 끝났어요`, body: `${out.duration}초 영상이 준비됐어요. 미리 보고 공개해 보세요.`, link: `studio/ai/${p.id}/finish` });
    } catch (err) {
      if (out?.url) {
        await db.run('DELETE FROM media_files WHERE url=?', [out.url]).catch(() => {});
        await rm(path.join(uploadDir, path.basename(out.url)), { force: true }).catch(() => {});
      }
      if (sub) await rm(path.join(subsDir, sub), { force: true }).catch(() => {});
      throw err;
    }
  }
  async function renderTrailer(job, progress) {
    const p = await db.get('SELECT * FROM studio_projects WHERE id=?', [job.project_id]);
    if (!p) throw new Error('프로젝트가 지워졌어요.');
    await db.run("UPDATE studio_projects SET trailer_status='rendering' WHERE id=?", [p.id]);
    const opts = parse(job.options, {});
    const all = await db.all('SELECT s.*, e.number AS episode_number FROM studio_shots s JOIN studio_episodes e ON e.id=s.episode_id WHERE e.project_id=? ORDER BY e.number, s.sort_order', [p.id]);
    const byId = new Map(all.map((s) => [s.id, s]));
    const shots = (opts.shotIds || []).map((id) => byId.get(id)).filter((s) => s && (s.video || s.image || s.lipsync));
    if (!shots.length) throw new Error('예고편에 넣을 컷이 없어요.');
    const cast = await db.all('SELECT id,name FROM studio_characters WHERE project_id=?', [p.id]);
    const out = await composeTrailer({
      shots,
      uploadDir,
      nameOf: (id) => cast.find((c) => c.id === id)?.name || '',
      titleCard: opts.titleCard || '',
      endCard: opts.endCard || '',
      bgm: opts.bgm || p.bgm,
      bgmVolume: 0.35,
      resolution: p.resolution,
      onProgress: progress,
    });
    await db.run('INSERT INTO media_files (url,owner_id,mime,created_at) VALUES (?,?,?,?)', [out.url, p.owner_id, 'video/mp4', iso()]);
    await db.run('INSERT INTO media_metadata (url,duration,width,height,has_audio) VALUES (?,?,?,?,?)', [out.url, out.duration, out.width, out.height, out.hasAudio ? 1 : 0]);
    await db.run("UPDATE studio_projects SET trailer=?,trailer_status='done',updated_at=? WHERE id=?", [out.url, iso(), p.id]);
    await db.run(
      'INSERT INTO studio_assets (id,owner_id,project_id,target_type,target_id,kind,url,job_id,model_label,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [randomUUID(), p.owner_id, p.id, 'trailer', p.id, 'video', out.url, null, '예고편', iso()],
    );
    await notify(db, p.owner_id, { kind: 'compose', title: `${p.title} 예고편이 완성됐어요`, body: `${out.duration}초 예고편을 작품에 붙일 수 있어요.`, link: `studio/ai/${p.id}/finish` });
  }
  async function run(job) {
    let last = 0;
    const progress = (v) => {
      // 진행률은 5%p마다만 기록합니다.
      if (v - last < 0.05 && v < 0.99) return;
      last = v;
      void db.run('UPDATE studio_renders SET progress=? WHERE id=?', [v, job.id]).catch(() => {});
      if (job.kind === 'episode') void db.run('UPDATE studio_episodes SET compose_progress=? WHERE id=?', [v, job.target_id]).catch(() => {});
    };
    try {
      if (job.kind === 'episode') await renderEpisode(job, progress);
      else await renderTrailer(job, progress);
      await db.run("UPDATE studio_renders SET status='done',progress=1,finished_at=? WHERE id=?", [iso(), job.id]);
    } catch (err) {
      const message = String(err?.message || err).slice(0, 300);
      console.error('render', job.kind, message, err?.detail || '');
      await db.run("UPDATE studio_renders SET status='failed',error=?,finished_at=? WHERE id=?", [message, iso(), job.id]).catch(() => {});
      const p = await db.get('SELECT id,title,owner_id FROM studio_projects WHERE id=?', [job.project_id]).catch(() => null);
      if (job.kind === 'episode') {
        await db.run("UPDATE studio_episodes SET status='compose_failed',compose_error=? WHERE id=? AND status='composing'", [message, job.target_id]).catch(() => {});
        const e = await db.get('SELECT number FROM studio_episodes WHERE id=?', [job.target_id]).catch(() => null);
        if (p && e) await notify(db, p.owner_id, { kind: 'compose_failed', title: `${p.title} ${e.number}화 합성에 실패했어요`, body: message, link: `studio/ai/${p.id}/finish` });
      } else {
        await db.run("UPDATE studio_projects SET trailer_status='failed' WHERE id=?", [job.project_id]).catch(() => {});
        if (p) await notify(db, p.owner_id, { kind: 'compose_failed', title: `${p.title} 예고편 만들기에 실패했어요`, body: message, link: `studio/ai/${p.id}/finish` });
      }
    }
  }
  async function tick() {
    if (running.size >= concurrency) return;
    const next = await db.all("SELECT * FROM studio_renders WHERE status='queued' AND claimed_by IS NULL ORDER BY created_at LIMIT ?", [concurrency - running.size]);
    for (const job of next) {
      const r = await db.run("UPDATE studio_renders SET status='running',claimed_by=?,started_at=? WHERE id=? AND status='queued' AND claimed_by IS NULL", [workerId, iso(), job.id]);
      if (Number(r?.rowCount ?? r?.changes ?? 0) === 0) continue;
      running.add(job.id);
      void run(job).finally(() => running.delete(job.id));
    }
  }
  return {
    // 회차 합성을 대기열에 넣습니다. 이미 합성 중이면 409.
    async queueEpisode(p, e) {
      return db.transaction(async () => {
        const r = await db.run(
          "UPDATE studio_episodes SET status='composing',compose_progress=0,compose_error='',compose_queued_at=? WHERE id=? AND status<>'composing'",
          [iso(), e.id],
        );
        if (Number(r?.rowCount ?? r?.changes ?? 0) === 0) throw Object.assign(new Error('이미 합성 중이에요.'), { status: 409 });
        const id = randomUUID();
        await db.run("INSERT INTO studio_renders (id,project_id,kind,target_id,status,created_at) VALUES (?,?,'episode',?,'queued',?)", [id, p.id, e.id, iso()]);
        return id;
      });
    },
    async queueTrailer(p, options) {
      return db.transaction(async () => {
        const r = await db.run("UPDATE studio_projects SET trailer_status='queued' WHERE id=? AND trailer_status NOT IN ('queued','rendering')", [p.id]);
        if (Number(r?.rowCount ?? r?.changes ?? 0) === 0) throw Object.assign(new Error('예고편을 이미 만들고 있어요.'), { status: 409 });
        const id = randomUUID();
        await db.run("INSERT INTO studio_renders (id,project_id,kind,target_id,options,status,created_at) VALUES (?,?,'trailer',?,?,'queued',?)", [id, p.id, p.id, JSON.stringify(options), iso()]);
        return id;
      });
    },
    // 서버가 합성 중에 꺼졌다면, 하던 합성을 처음부터 다시 대기열에 넣습니다.
    async recover() {
      await db.run("UPDATE studio_renders SET status='queued',claimed_by=NULL,progress=0 WHERE status='running'");
      await db.run("UPDATE studio_episodes SET compose_progress=0 WHERE status='composing'");
      // 예전 방식으로 멈춘 회차(대기열에 없음)는 실패로 표시해 다시 합성할 수 있게 합니다.
      await db.run(
        "UPDATE studio_episodes SET status='compose_failed',compose_error='서버가 다시 시작돼 합성을 멈췄어요. 다시 합성해 주세요.' WHERE status='composing' AND NOT EXISTS (SELECT 1 FROM studio_renders r WHERE r.target_id=studio_episodes.id AND r.status='queued')",
      );
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((e) => console.error('render tick', e.message)), 1000);
      timer.unref?.();
      void tick().catch(() => {});
    },
    stop: () => timer && clearInterval(timer),
    tick,
    // 테스트용: 대기열이 빌 때까지 처리
    async drain(timeout = 120000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        await tick();
        const left = await db.get("SELECT COUNT(*) AS n FROM studio_renders WHERE status IN ('queued','running')");
        if (!Number(left.n) && !running.size) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    },
  };
}
