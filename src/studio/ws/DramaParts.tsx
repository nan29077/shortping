import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BookmarkPlus, Check, ClipboardPaste, Film, ImageIcon, Library, Lock, Package, Plus, ShieldAlert, ShieldCheck, Shuffle, Trash2, Upload } from 'lucide-react';
import { api, parseJson, type LibraryItem, type LibraryKind, type ShotVerify, type StudioCharacter, type StudioEpisode, type StudioProp, type StudioRelation, type StudioShot } from '../../api';
import { Modal } from '../../App';
import { changedFields, useAutosave, useSyncedForm } from '../hooks';
import { JobBadge, isBusy } from '../parts';
import { SaveBadge, Section, type WS } from './shared';
import { asset } from '../../platform';

// 드라매직 벤치마킹(2026-09-25): 완성 대본 붙여 넣기 · 소품 · 스타일 잠금

// ── 완성 대본 붙여 넣기 → 컷으로 나누기 ───────────────────────────
const SAMPLE = `1화
S#1. 카페 - 밤
(창밖으로 비가 내린다. 서윤이 젖은 우산을 접는다)
서윤: 늦었네. 편지는 가져왔어?
도현: (편지를 내밀며) 이걸로 끝내자.
S#2. 골목 - 밤
(비에 젖은 서윤이 편지를 펼친다)
서윤: 이게... 무슨 뜻이야?`;
export function ScriptImportSection({ ws }: { ws: WS }) {
  const p = ws.data.project;
  const server = { script_text: p.script_text || '' };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', v));
  const scripted = ws.data.episodes.filter((e) => e.shots.length).length;
  const fromVideo = /\d+화 자막/.test(p.source_text || '');
  const go = async () => {
    if (!(await save.flush())) return;
    if (
      scripted &&
      !(await ws.ask({
        title: '대본을 컷으로 나눌까요?',
        text: `대본에 나오는 회차의 컷이 새로 바뀌어요(지금 대본은 버전 기록에 남아 되돌릴 수 있어요). 대본이 있는 회차 ${scripted}개.`,
        ok: '컷으로 나누기',
      }))
    )
      return;
    ws.run('붙여 넣은 대본을 컷으로 나누기', 'parse_script', 'text');
  };
  return (
    <Section
      title="완성 대본 붙여 넣기"
      desc="직접 쓴 대본을 넣으면 회차 · 컷 · 인물 · 장소 · 소품 · 인물 관계까지 한 번에 나눠요. 대사는 그대로 두고 화면 묘사만 채워요."
      defaultOpen={!!p.script_text || fromVideo}
      badge={<SaveBadge state={save.state} error={save.error} dirty={save.dirty} />}
    >
      {fromVideo && (
        <div className="info-box reverse-box">
          <b>올린 영상의 자막 {p.source_text!.length.toLocaleString('ko-KR')}자를 가져왔어요.</b>
          <span>AI가 자막으로 장면 · 지문 · 화자를 채운 대본을 복원해요. 복원한 대본을 확인하고 고친 뒤 ‘컷으로 나누기’를 누르세요.</span>
          <div className="form-actions start">
            <button
              type="button"
              className={f.script_text.trim() ? 'secondary compact' : 'primary compact'}
              disabled={isBusy(ws.data.jobs, p.id, 'reverse_script')}
              onClick={async () => {
                if (f.script_text.trim() && !(await ws.ask({ title: '대본을 다시 복원할까요?', text: '지금 칸에 있는 대본이 새로 복원한 대본으로 바뀌어요.', ok: '다시 복원' }))) return;
                ws.run('영상 자막으로 대본 복원', 'reverse_script', 'text');
              }}
            >
              <Film size={14} /> {f.script_text.trim() ? '자막으로 다시 복원' : '자막으로 대본 복원'}
            </button>
            <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="reverse_script" />
          </div>
        </div>
      )}
      <label>
        대본 <small className="muted">{f.script_text.length.toLocaleString('ko-KR')} / 30,000자 · 1화 · S#1. 장소 - 밤 · 이름: 대사 · (지문) 형식을 알아봐요</small>
        <textarea value={f.script_text} rows={10} maxLength={30000} placeholder={SAMPLE} onChange={(e) => setF({ script_text: e.target.value })} />
      </label>
      <div className="form-actions start">
        <button className="primary" disabled={f.script_text.trim().length < 20 || isBusy(ws.data.jobs, p.id, 'parse_script')} onClick={() => void go()}>
          <ClipboardPaste size={15} /> 컷으로 나누기
        </button>
        {!f.script_text && (
          <button type="button" className="text-link" onClick={() => setF({ script_text: SAMPLE })}>
            예시 넣어 보기
          </button>
        )}
        <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="parse_script" onRetry={() => void go()} />
      </div>
    </Section>
  );
}

// ── 소품 ────────────────────────────────────────────────────
export function PropSection({ ws }: { ws: WS }) {
  const list = ws.data.props || [];
  const pid = ws.data.project.id;
  return (
    <Section
      title="소품"
      desc="편지 · 반지 · 휴대폰처럼 이야기에 중요한 물건을 만들어 두고 컷에 지정하면 컷마다 같은 모습으로 그려요."
      defaultOpen={list.length > 0}
      badge={<em className="ws-count">{list.length}/30</em>}
      actions={
        <>
          <LibraryButton ws={ws} kind="prop" />
          <button className="secondary compact" disabled={ws.busy || list.length >= 30} onClick={() => void ws.act(() => api(`/studio/ai/projects/${pid}/props`, 'POST', { name: '새 소품', look: '' }), '소품을 추가했어요.')}>
            <Plus size={14} /> 소품 추가
          </button>
        </>
      }
    >
      {!list.length && <p className="muted">예: 낡은 편지 봉투, 은색 커플링, 금이 간 휴대폰</p>}
      <div className="ws-locations">
        {list.map((x) => (
          <PropCard key={x.id} ws={ws} x={x} />
        ))}
      </div>
    </Section>
  );
}
function PropCard({ ws, x }: { ws: WS; x: StudioProp }) {
  const pid = ws.data.project.id;
  const server = { name: x.name, look: x.look, locked: !!Number(x.locked || 0) };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, (v, base) => api(`/studio/ai/projects/${pid}/props/${x.id}`, 'PATCH', changedFields(v, base)), { enabled: !!f.name.trim() });
  const used = ws.data.episodes.flatMap((e) => e.shots).filter((s) => String(s.prop_ids || '').split(',').includes(x.id)).length;
  return (
    <article className="ws-location">
      <div className="ws-location-media">{x.image ? <img src={asset(x.image)} alt={x.name} /> : <Package size={28} />}</div>
      <div>
        <div className="ws-row">
          <input aria-label="소품 이름" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <SaveBadge state={save.state} error={save.error} />
        </div>
        <textarea aria-label="소품 모습" rows={2} maxLength={500} value={f.look} placeholder="예: 누렇게 바랜 편지 봉투, 빨간 밀랍 봉인" onChange={(e) => setF({ ...f, look: e.target.value })} />
        <label className="inline-check lock-check" title="컷마다 소품 이미지와 똑같은 모양으로 그리고, AI 검수에서도 확인해요">
          <input type="checkbox" checked={f.locked} onChange={(e) => setF({ ...f, locked: e.target.checked })} />
          <Lock size={12} /> 모양 고정(모든 컷에서 똑같이)
        </label>
        <div className="ws-row">
          <button
            className="secondary compact"
            disabled={isBusy(ws.data.jobs, x.id, 'prop_image') || !f.look.trim()}
            onClick={async () => {
              if (!(await save.flush())) return;
              ws.run(`${f.name} 소품 이미지`, 'prop_image', 'image', { targetId: x.id });
            }}
          >
            <ImageIcon size={13} /> {x.image ? '다시' : '소품 이미지'}
          </button>
          <JobBadge jobs={ws.data.jobs} targetId={x.id} kind="prop_image" />
          <small className="muted">컷 {used}개에서 사용</small>
          <SaveToLibrary ws={ws} kind="prop" sourceId={x.id} />
          <button
            className="icon-button"
            aria-label={`${x.name} 지우기`}
            onClick={async () => {
              if (used && !(await ws.ask({ title: '소품 지우기', text: `컷 ${used}개에서 이 소품 지정이 풀려요.`, ok: '지우기', danger: true }))) return;
              await ws.act(() => api(`/studio/ai/projects/${pid}/props/${x.id}`, 'DELETE'), '소품을 지웠어요.');
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}

// ── 스타일 잠금 ─────────────────────────────────────────────────
// 작품의 대표 그림 1~3장을 골라 두면 모든 컷 이미지 · 장소 이미지를 그 색감과 화풍에 맞춰 그려요.
export function StyleLockSection({ ws }: { ws: WS }) {
  const { data } = ws;
  const p = data.project;
  const chosen = parseJson<string[]>(p.style_refs, []);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const pool = useMemo(() => {
    const list: { url: string; label: string }[] = [];
    const add = (url: string | undefined, label: string) => url && /^\/uploads\//.test(url) && !list.some((x) => x.url === url) && list.push({ url, label });
    chosen.forEach((u) => add(u, '고른 그림'));
    add(p.poster, '포스터');
    data.episodes.forEach((e) => e.shots.forEach((s, i) => add(s.image, `${e.number}화 ${i + 1}번 컷`)));
    (data.locations || []).forEach((l) => add(l.image, l.name));
    data.assets.filter((a) => a.kind === 'image' || a.kind === 'style').forEach((a) => add(a.url, a.model_label || '이미지'));
    return list.slice(0, 30);
    // chosen은 매번 새 배열이라 원본 문자열(style_refs)을 기준으로 다시 계산해요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, p.poster, p.style_refs]);
  const save = async (next: string[], message: string) => {
    setBusy(true);
    try {
      await api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', { style_refs: next });
      await ws.load();
      ws.notify(message);
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (url: string) => {
    if (chosen.includes(url)) return void save(chosen.filter((u) => u !== url), '스타일 참고에서 뺐어요.');
    if (chosen.length >= 3) return ws.notify('스타일 참고는 3장까지 고를 수 있어요.');
    void save([...chosen, url], '스타일 참고로 잠갔어요. 이제 새로 만드는 컷이 이 느낌을 따라가요.');
  };
  const upload = async (f: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', f);
      const r = await api<{ url: string }>('/studio/upload', 'POST', form);
      if (chosen.length < 3) await api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', { style_refs: [...chosen, r.url] });
      await ws.load();
      ws.notify(chosen.length < 3 ? '올린 그림을 스타일 참고로 잠갔어요.' : '올렸어요. 스타일 참고는 3장까지라 다른 그림을 빼고 골라 주세요.');
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <Section
      title="스타일 잠금"
      desc="작품의 대표 그림을 1~3장 고르면 새로 만드는 컷 · 장소 이미지가 그 색감과 화풍을 따라가요. 회차가 바뀌어도 톤이 흔들리지 않아요."
      defaultOpen={chosen.length > 0}
      badge={chosen.length ? <em className="ws-count"><Lock size={11} /> {chosen.length}/3</em> : undefined}
      actions={
        <>
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <button className="secondary compact" disabled={busy} onClick={() => file.current?.click()}>
            <Upload size={13} /> 그림 올리기
          </button>
          <LibraryButton ws={ws} kind="style" />
          {(chosen.length > 0 || !!p.style) && <SaveToLibrary ws={ws} kind="style" label=" 저장" />}
        </>
      }
    >
      {!pool.length ? (
        <p className="muted">아직 고를 그림이 없어요. 컷 이미지나 포스터를 만들거나, 원하는 느낌의 그림을 올려 주세요.</p>
      ) : (
        <div className="style-pool" role="group" aria-label="스타일 참고 그림">
          {pool.map((x) => {
            const on = chosen.includes(x.url);
            return (
              <button key={x.url} type="button" className={'style-pick' + (on ? ' on' : '')} aria-pressed={on} disabled={busy} onClick={() => toggle(x.url)} title={x.label}>
                <img src={asset(x.url)} alt={x.label} loading="lazy" />
                {on && (
                  <i>
                    <Check size={12} />
                  </i>
                )}
                <small>{x.label}</small>
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ── 컷 리듬 진단(무료) ──────────────────────────────────────────
type Rhythm = { score: number; items: { level: 'warn' | 'info'; code: string; text: string; where?: string; shotId?: string }[]; shots: number; seconds: number };
export function RhythmPanel({ ws, e }: { ws: WS; e: StudioEpisode }) {
  const [r, setR] = useState<Rhythm | null>(null);
  const [open, setOpen] = useState(false);
  // 컷 순서 · 길이 · 대사 · 카메라가 바뀔 때만 다시 계산해요.
  const key = e.shots.map((s) => `${s.id}:${s.seconds}:${s.camera}:${s.dialogue ? 1 : 0}`).join('|') + (e.cliffhanger || '');
  useEffect(() => {
    if (!e.shots.length) return setR(null);
    let alive = true;
    const t = setTimeout(() => {
      api<Rhythm>(`/studio/ai/projects/${ws.data.project.id}/episodes/${e.id}/rhythm`).then(
        (x) => alive && setR(x),
        () => {},
      );
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, e.id, ws.data.project.id]);
  if (!r) return null;
  const tone = r.score >= 85 ? 'good' : r.score >= 60 ? 'mid' : 'low';
  return (
    <div className={'rhythm ' + tone}>
      <button type="button" className="rhythm-head" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!r.items.length}>
        <Activity size={14} />
        <b>컷 리듬 {r.score}점</b>
        <small>{r.items.length ? `살펴볼 곳 ${r.items.length}개` : '훅 · 샷 크기 · 속도 모두 좋아요'}</small>
      </button>
      {open && (
        <ul>
          {r.items.map((x, i) => (
            <li key={i} className={x.level}>
              {x.where && <b>{x.where.replace(/^\d+화 /, '')}</b>} {x.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── AI 결과 검수 표시 ───────────────────────────────────────────
export function verifyOf(s: StudioShot): ShotVerify | null {
  const v = parseJson<ShotVerify | null>(s.verify, null);
  return v && v.image === s.image ? v : null;
}
// onFix: 문제를 부분 수정으로 고치기(문제 설명과 위치를 넘겨 붓을 미리 칠해요)
export function VerifyBadge({ s, onRedo, onFix }: { s: StudioShot; onRedo?: () => void; onFix?: (issues: ShotVerify['issues']) => void }) {
  const [open, setOpen] = useState(false);
  const v = verifyOf(s);
  if (!v) return null;
  const faces = v.faces || [];
  const lowFace = faces.filter((f) => Number(f.match) < 70);
  const faceText = faces.length ? ` · 인물 닮음 ${faces.map((f) => `${f.name} ${Math.round(Number(f.match))}`).join(', ')}` : '';
  if (v.ok && !lowFace.length)
    return (
      <span className="verify-badge ok" title={`AI 검수 ${v.score}점${faceText}`}>
        <ShieldCheck size={12} /> 검수 통과 {v.score}
      </span>
    );
  const issues = v.issues.length ? v.issues : lowFace.length ? lowFace.map((f) => ({ code: 'face', text: `${f.name} 얼굴이 기준과 달라 보여요(${Math.round(Number(f.match))}점)` })) : [{ code: 'other', text: '다시 만드는 것이 좋아요' }];
  return (
    <span className="verify-wrap">
      <button type="button" className="verify-badge bad" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ShieldAlert size={12} /> {lowFace.length && v.ok ? '인물이 달라 보여요' : `검수 문제 ${issues.length}`}
      </button>
      {open && (
        <span className="verify-pop" role="note">
          {issues.map((x, i) => (
            <span key={i}>· {x.text}</span>
          ))}
          {faces.length > 0 && <span className="muted">인물 닮음: {faces.map((f) => `${f.name} ${Math.round(Number(f.match))}점`).join(' · ')}</span>}
          {onFix && (
            <button type="button" className="text-link" onClick={() => (setOpen(false), onFix(issues))}>
              문제 부분만 고치기
            </button>
          )}
          {onRedo && (
            <button type="button" className="text-link" onClick={onRedo}>
              이미지 다시 만들기
            </button>
          )}
        </span>
      )}
    </span>
  );
}

// ── 내 자산 라이브러리 ──────────────────────────────────────────
const KIND_NAME: Record<LibraryKind, string> = { character: '인물', location: '장소', prop: '소품', style: '스타일' };
// 라이브러리에 저장 버튼(카드마다)
export function SaveToLibrary({ ws, kind, sourceId, label }: { ws: WS; kind: LibraryKind; sourceId?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  // 라이브러리 저장은 프로젝트 주인만(팀원에게는 버튼을 보이지 않아요. 서버도 한 번 더 확인해요).
  if (ws.data.team && ws.data.team.role !== 'owner') return null;
  return (
    <button
      type="button"
      className={label ? 'secondary compact' : 'icon-button'}
      aria-label={`${KIND_NAME[kind]}을(를) 내 라이브러리에 저장`}
      title="내 라이브러리에 저장(다른 프로젝트에서 불러오기)"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ updated?: boolean }>('/studio/ai/library', 'POST', { kind, projectId: ws.data.project.id, sourceId });
          ws.notify(r.updated ? '라이브러리의 같은 이름 항목을 새로 고쳤어요.' : '내 라이브러리에 저장했어요. 다른 프로젝트에서 불러올 수 있어요.');
        } catch (e) {
          ws.notify((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <BookmarkPlus size={13} />
      {label}
    </button>
  );
}
export function LibraryButton({ ws, kind }: { ws: WS; kind: LibraryKind }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary compact" onClick={() => setOpen(true)}>
        <Library size={13} /> 라이브러리에서
      </button>
      {open && <LibraryModal ws={ws} kind={kind} close={() => setOpen(false)} />}
    </>
  );
}
function LibraryModal({ ws, kind, close }: { ws: WS; kind: LibraryKind; close: () => void }) {
  const [tab, setTab] = useState<LibraryKind>(kind);
  const [list, setList] = useState<LibraryItem[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = () =>
    api<LibraryItem[]>('/studio/ai/library').then(
      (x) => setList(x),
      (e) => ws.notify((e as Error).message),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const items = (list || []).filter((x) => x.kind === tab);
  const use = async (x: LibraryItem) => {
    if (x.kind === 'style' && !(await ws.ask({ title: '스타일 가져오기', text: '이 프로젝트의 스타일 문구와 스타일 참고 그림이 라이브러리 것으로 바뀌어요.', ok: '가져오기' }))) return;
    setBusy(x.id);
    try {
      const r = await api<{ dropped?: number }>(`/studio/ai/projects/${ws.data.project.id}/library/import`, 'POST', { libraryId: x.id });
      await ws.load();
      ws.notify(`${KIND_NAME[x.kind]} ‘${x.name}’을(를) 가져왔어요.${r.dropped ? ` 이 프로젝트 주인의 파일이 아닌 그림 ${r.dropped}장은 빼고 가져왔어요.` : ''}`);
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const remove = async (x: LibraryItem) => {
    if (!(await ws.ask({ title: '라이브러리에서 지울까요?', text: `‘${x.name}’을(를) 지워요. 이미 가져온 프로젝트에는 그대로 남아요.`, ok: '지우기', danger: true }))) return;
    try {
      await api(`/studio/ai/library/${x.id}`, 'DELETE');
      await load();
    } catch (e) {
      ws.notify((e as Error).message);
    }
  };
  return (
    <Modal title="내 자산 라이브러리" close={close}>
      <div className="lib">
        <div className="hub-seg small" role="tablist">
          {(Object.keys(KIND_NAME) as LibraryKind[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {KIND_NAME[k]} {(list || []).filter((x) => x.kind === k).length}
            </button>
          ))}
        </div>
        {!list ? (
          <p className="muted">불러오는 중…</p>
        ) : !items.length ? (
          <p className="muted lib-empty">저장한 {KIND_NAME[tab]}이(가) 없어요. 프로젝트의 {KIND_NAME[tab]} 카드에서 책갈피 버튼을 누르면 여기에 모여요.</p>
        ) : (
          <ul className="lib-list">
            {items.map((x) => (
              <li key={x.id}>
                <span className="lib-thumb">{x.image ? <img src={asset(x.image)} alt="" /> : <Package size={20} />}</span>
                <span className="lib-info">
                  <b>{x.name}</b>
                  <small>{String((x.data.look as string) || (x.data.style as string) || (x.data.description as string) || '').slice(0, 60)}</small>
                </span>
                <button type="button" className="primary compact" disabled={!!busy} onClick={() => void use(x)}>
                  {busy === x.id ? '가져오는 중…' : '가져오기'}
                </button>
                <button type="button" className="icon-button" aria-label={`${x.name} 지우기`} onClick={() => void remove(x)}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ── 인물 관계 ────────────────────────────────────────────────
const REL_KINDS = ['연인', '썸', '가족', '부부', '친구', '라이벌', '적', '비밀', '상하 관계', '기타'];
const REL_COLOR: Record<string, string> = { 연인: '#ff7aa8', 썸: '#ffb3cf', 가족: '#7ad0ff', 부부: '#ff7aa8', 친구: '#c4f562', 라이벌: '#ffb547', 적: '#ff6b6b', 비밀: '#b28cff', '상하 관계': '#9fb3c8', 기타: '#8a9a90' };
export function RelationsSection({ ws }: { ws: WS }) {
  const { data } = ws;
  const cast = data.characters;
  const p = data.project;
  const server = { relations: parseJson<StudioRelation[]>(p.relations, []) };
  const [f, setF] = useSyncedForm(server);
  const valid = f.relations.every((r) => r.a && r.b && r.a !== r.b && r.kind);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', v), { enabled: valid });
  const set = (i: number, patch: Partial<StudioRelation>) => setF({ relations: f.relations.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const add = () => {
    if (cast.length < 2) return ws.notify('인물이 2명 이상 있어야 관계를 만들 수 있어요.');
    setF({ relations: [...f.relations, { a: cast[0].id, b: cast[1].id, kind: '친구', note: '' }] });
  };
  return (
    <Section
      title="인물 관계"
      desc="누가 누구와 어떤 사이인지 정해 두면 대본 · 대사 톤에 반영돼요. 대본을 붙여 넣으면 자동으로 채워져요."
      defaultOpen={f.relations.length > 0}
      badge={<SaveBadge state={save.state} error={save.error} dirty={save.dirty} hint={!valid ? '두 인물을 서로 다르게 골라 주세요' : undefined} />}
      actions={
        <button className="secondary compact" disabled={f.relations.length >= 40} onClick={add}>
          <Plus size={14} /> 관계 추가
        </button>
      }
    >
      {cast.length >= 2 && f.relations.length > 0 && <RelationGraph cast={cast} relations={f.relations.filter((r) => r.a && r.b && r.a !== r.b)} />}
      {!f.relations.length && <p className="muted">예: 서윤 ↔ 도현 · 연인 · 3년 전 헤어짐</p>}
      <div className="rel-list">
        {f.relations.map((r, i) => (
          <div key={i} className="rel-row">
            <select aria-label="인물 1" value={r.a} onChange={(e) => set(i, { a: e.target.value })}>
              {cast.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span aria-hidden="true">↔</span>
            <select aria-label="인물 2" value={r.b} onChange={(e) => set(i, { b: e.target.value })}>
              {cast.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select aria-label="관계" value={r.kind} onChange={(e) => set(i, { kind: e.target.value })}>
              {[...REL_KINDS, ...(REL_KINDS.includes(r.kind) ? [] : [r.kind])].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input aria-label="메모" value={r.note} maxLength={120} placeholder="메모(예: 3년 전 헤어짐)" onChange={(e) => set(i, { note: e.target.value })} />
            <button type="button" className="icon-button" aria-label="관계 지우기" onClick={() => setF({ relations: f.relations.filter((_, k) => k !== i) })}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}
// 관계도: 인물을 원 위에 놓고 관계를 선으로(색 = 관계 종류)
function RelationGraph({ cast, relations }: { cast: StudioCharacter[]; relations: StudioRelation[] }) {
  const W = 320;
  const H = 220;
  const R = Math.min(W, H) / 2 - 34;
  const pos = new Map(cast.map((c, i) => [c.id, { x: W / 2 + R * Math.cos((2 * Math.PI * i) / cast.length - Math.PI / 2), y: H / 2 + R * Math.sin((2 * Math.PI * i) / cast.length - Math.PI / 2) }]));
  return (
    <svg className="rel-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="인물 관계도">
      {relations.map((r, i) => {
        const a = pos.get(r.a);
        const b = pos.get(r.b);
        if (!a || !b) return null;
        const color = REL_COLOR[r.kind] || '#8a9a90';
        return (
          <g key={i}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={2} strokeDasharray={r.kind === '비밀' ? '4 3' : undefined} />
            <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle" fontSize="10" fill={color}>
              {r.kind}
            </text>
          </g>
        );
      })}
      {cast.map((c) => {
        const q = pos.get(c.id)!;
        return (
          <g key={c.id}>
            <circle cx={q.x} cy={q.y} r={18} fill="#1b2025" stroke="#3f4d45" />
            <text x={q.x} y={q.y + 4} textAnchor="middle" fontSize="11" fill="#f3f3f1">
              {c.name.slice(0, 4)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── 대본 변형(같은 회차를 다른 방향으로) ─────────────────────────────
const ANGLES = ['결말 반전', '다른 인물 시점', '더 긴장감 있게', '더 코믹하게', '더 짧고 빠르게', '감정선 더 깊게'];
export function VariantsButton({ ws, e }: { ws: WS; e: StudioEpisode }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(['결말 반전']);
  const [custom, setCustom] = useState('');
  const busy = isBusy(ws.data.jobs, e.id, 'variants');
  const angles = [...picked, ...(custom.trim() ? [custom.trim()] : [])].slice(0, 3);
  return (
    <>
      <button className="secondary compact" disabled={!e.shots.length || busy} onClick={() => setOpen(true)} title="지금 대본은 그대로 두고 다른 방향의 대본을 버전으로 만들어요">
        <Shuffle size={14} /> 대본 변형
      </button>
      <JobBadge jobs={ws.data.jobs} targetId={e.id} kind="variants" />
      {open && (
        <Modal title={`${e.number}화 대본 변형`} close={() => setOpen(false)}>
          <p className="muted settings-note">지금 대본은 그대로 두고, 고른 방향마다 새 대본을 만들어 ‘버전 기록’에 넣어요. 마음에 드는 버전을 골라 ‘되돌리기’로 쓰면 돼요. 최대 3개.</p>
          <div className="chip-row">
            {ANGLES.map((a) => {
              const on = picked.includes(a);
              return (
                <button key={a} type="button" className={'chip' + (on ? ' active' : '')} aria-pressed={on} onClick={() => (on ? setPicked(picked.filter((x) => x !== a)) : angles.length >= 3 ? ws.notify('3개까지 고를 수 있어요.') : setPicked([...picked, a]))}>
                  {a}
                </button>
              );
            })}
          </div>
          <label>
            직접 적기(선택)
            <input value={custom} maxLength={60} placeholder="예: 악역의 입장에서" onChange={(ev) => setCustom(ev.target.value)} />
          </label>
          <button
            className="primary full"
            disabled={!angles.length}
            onClick={() => {
              setOpen(false);
              ws.run(`${e.number}화 대본 변형 ${angles.length}개`, 'variants', 'text', { targetId: e.id, options: { angles } });
            }}
          >
            <Shuffle size={15} /> 변형 {angles.length}개 만들기
          </button>
        </Modal>
      )}
    </>
  );
}
