import { z } from 'zod';
import { randomUUID } from 'node:crypto';

// 내 자산 라이브러리(2026-09-25, 드라매직 벤치마킹): 인물 · 장소 · 소품 · 스타일을 계정에 저장해 두고
// 다른 프로젝트(시즌 2 · 스핀오프)에서 그대로 불러와 같은 얼굴 · 같은 배경 · 같은 톤으로 이어 갑니다.
const KINDS = ['character', 'location', 'prop', 'style'];
const LIMIT = 200;
const parse = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

export function libraryRoutes({ app, db, fail, now, roles, project, charactersOf, locationsOf, propsOf, queueTranslate }) {
  const view = (r) => ({ id: r.id, kind: r.kind, name: r.name, image: r.image, data: parse(r.data, {}), created_at: r.created_at, updated_at: r.updated_at });
  app.get('/api/studio/ai/library', roles('pd', 'admin'), async (req, res) => {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    const rows = await db.all(`SELECT * FROM studio_library WHERE owner_id=?${kind ? ' AND kind=?' : ''} ORDER BY updated_at DESC LIMIT ${LIMIT}`, kind ? [req.user.id, kind] : [req.user.id]);
    res.json(rows.map(view));
  });
  // 프로젝트의 인물 · 장소 · 소품 · 스타일을 내 라이브러리에 저장(같은 이름이면 새로 고침)
  app.post('/api/studio/ai/library', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ kind: z.enum(KINDS), projectId: z.string().max(80), sourceId: z.string().max(80).optional(), name: z.string().trim().max(40).optional() }).parse(req.body);
    const p = await project(req, b.projectId, 'view');
    // 라이브러리는 내 계정 보관함이라, 내가 주인인 프로젝트에서만 저장할 수 있어요(팀원이 남의 그림을 가져가지 않도록).
    if (p.owner_id !== req.user.id) fail(403, '내가 만든 프로젝트의 인물 · 장소 · 소품 · 스타일만 라이브러리에 저장할 수 있어요.');
    let name = '';
    let image = '';
    let data = {};
    if (b.kind === 'character') {
      const c = (await charactersOf(p.id)).find((x) => x.id === b.sourceId);
      if (!c) fail(404, '인물을 찾을 수 없어요.');
      name = c.name;
      image = c.image;
      data = { role: c.role, description: c.description, look: c.look, look_en: c.look_en, look_en_src: c.look_en_src, outfit: c.outfit, voice_model: c.voice_model, voice: c.voice, voice_style: c.voice_style, refs: parse(c.refs, []), hair: c.hair || '', body: c.body || '', forbid: c.forbid || '', locked: Number(c.locked || 0) };
    } else if (b.kind === 'location' || b.kind === 'prop') {
      const row = (await (b.kind === 'location' ? locationsOf : propsOf)(p.id)).find((x) => x.id === b.sourceId);
      if (!row) fail(404, b.kind === 'location' ? '장소를 찾을 수 없어요.' : '소품을 찾을 수 없어요.');
      name = row.name;
      image = row.image;
      data = { look: row.look, look_en: row.look_en, look_en_src: row.look_en_src };
    } else {
      const refs = parse(p.style_refs, []);
      if (!refs.length && !String(p.style || '').trim()) fail(400, '저장할 스타일이 없어요. 스타일 문구나 참고 그림을 먼저 정해 주세요.');
      name = b.name || `${p.title} 스타일`;
      image = refs[0] || '';
      data = { style: p.style, style_refs: refs };
    }
    const count = Number((await db.get('SELECT COUNT(*) AS n FROM studio_library WHERE owner_id=?', [req.user.id]))?.n || 0);
    const same = await db.get('SELECT id FROM studio_library WHERE owner_id=? AND kind=? AND name=?', [req.user.id, b.kind, name]);
    if (same) {
      await db.run('UPDATE studio_library SET image=?,data=?,updated_at=? WHERE id=?', [image || '', JSON.stringify(data), now(), same.id]);
      return res.json({ id: same.id, updated: true });
    }
    if (count >= LIMIT) fail(400, `라이브러리에는 ${LIMIT}개까지 저장할 수 있어요. 안 쓰는 항목을 지워 주세요.`);
    const id = randomUUID();
    await db.run('INSERT INTO studio_library (id,owner_id,kind,name,image,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, req.user.id, b.kind, name, image || '', JSON.stringify(data), now(), now()]);
    res.status(201).json({ id });
  });
  app.patch('/api/studio/ai/library/:lid', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(40) }).parse(req.body);
    const r = await db.get('SELECT id FROM studio_library WHERE id=? AND owner_id=?', [req.params.lid, req.user.id]);
    if (!r) fail(404, '라이브러리 항목을 찾을 수 없어요.');
    await db.run('UPDATE studio_library SET name=?,updated_at=? WHERE id=?', [b.name, now(), r.id]);
    res.json({ ok: true });
  });
  app.delete('/api/studio/ai/library/:lid', roles('pd', 'admin'), async (req, res) => {
    const r = await db.get('SELECT id FROM studio_library WHERE id=? AND owner_id=?', [req.params.lid, req.user.id]);
    if (!r) fail(404, '라이브러리 항목을 찾을 수 없어요.');
    await db.run('DELETE FROM studio_library WHERE id=?', [r.id]);
    res.json({ ok: true });
  });
  // 라이브러리 → 프로젝트로 가져오기(복사본을 만들어 이 프로젝트에서 자유롭게 고칠 수 있어요)
  app.post('/api/studio/ai/projects/:id/library/import', roles('pd', 'admin'), async (req, res) => {
    const b = z.object({ libraryId: z.string().max(80) }).parse(req.body);
    const r = await db.get('SELECT * FROM studio_library WHERE id=? AND owner_id=?', [b.libraryId, req.user.id]);
    if (!r) fail(404, '라이브러리 항목을 찾을 수 없어요.');
    const p = await project(req, req.params.id, r.kind === 'style' ? 'scene' : r.kind === 'character' ? 'script' : 'scene');
    const d = parse(r.data, {});
    // 프로젝트 주인의 파일만 옮겨 와요(다른 계정의 그림이 섞이면 공개 · 정리 때 문제가 돼요). 쓸 수 없는 그림은 빼고 가져옵니다.
    let dropped = 0;
    const owned = async (url) => {
      if (!url) return '';
      const f = await db.get('SELECT owner_id FROM media_files WHERE url=?', [url]);
      if (f && f.owner_id === p.owner_id) return url;
      dropped++;
      return '';
    };
    r.image = await owned(r.image);
    if (Array.isArray(d.refs)) d.refs = (await Promise.all(d.refs.map(async (x) => (x && (await owned(x.url)) ? x : null)))).filter(Boolean);
    if (Array.isArray(d.style_refs)) d.style_refs = (await Promise.all(d.style_refs.map(owned))).filter(Boolean);
    const unique = (names, base) => {
      let n = base;
      for (let i = 2; names.includes(n); i++) n = `${base} (${i})`;
      return n.slice(0, 40);
    };
    const id = randomUUID();
    if (r.kind === 'character') {
      const cast = await charactersOf(p.id);
      if (cast.length >= 8) fail(400, '인물은 8명까지 만들 수 있어요.');
      await db.run(
        'INSERT INTO studio_characters (id,project_id,name,role,description,look,look_en,look_en_src,image,voice_model,voice,voice_style,outfit,refs,hair,body,forbid,locked,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, p.id, unique(cast.map((c) => c.name), r.name).slice(0, 30), d.role || '', d.description || '', d.look || '', d.look_en || '', d.look_en_src || '', r.image || '', d.voice_model || 'auto', d.voice || '', d.voice_style || '', d.outfit || '', JSON.stringify(d.refs || []), d.hair || '', d.body || '', d.forbid || '', Number(d.locked) ? 1 : 0, cast.length],
      );
    } else if (r.kind === 'location' || r.kind === 'prop') {
      const table = r.kind === 'location' ? 'studio_locations' : 'studio_props';
      const list = await (r.kind === 'location' ? locationsOf : propsOf)(p.id);
      if (list.length >= (r.kind === 'location' ? 12 : 30)) fail(400, r.kind === 'location' ? '장소는 12곳까지 만들 수 있어요.' : '소품은 30개까지 만들 수 있어요.');
      await db.run(`INSERT INTO ${table} (id,project_id,name,look,look_en,look_en_src,image,sort_order) VALUES (?,?,?,?,?,?,?,?)`, [
        id, p.id, unique(list.map((x) => x.name), r.name), d.look || '', d.look_en || '', d.look_en_src || '', r.image || '', list.length,
      ]);
      if (d.look && !d.look_en) await queueTranslate(p.id, p.owner_id, [{ id: `${r.kind}:${id}`, ko: d.look }]);
    } else {
      await db.run('UPDATE studio_projects SET style=?,style_refs=?,updated_at=? WHERE id=?', [d.style || p.style, JSON.stringify((d.style_refs || []).slice(0, 3)), now(), p.id]);
    }
    await db.run('UPDATE studio_projects SET updated_at=? WHERE id=?', [now(), p.id]);
    res.status(201).json({ id: r.kind === 'style' ? p.id : id, kind: r.kind, dropped });
  });
}
