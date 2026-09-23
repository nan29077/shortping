import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, History, ListChecks, Plus, RotateCcw, Sparkles, Stethoscope, Trash2, Wand2, X } from 'lucide-react';
import { api, parseJson, type StudioEpisode, type StudioShot, type StudioVersion } from '../../api';
import { Empty, Modal } from '../../App';
import { useAutosave, useSyncedForm } from '../hooks';
import { JobBadge, isBusy } from '../parts';
import { REWRITE_CHIPS } from '../presets';
import { EpisodeOutline } from './PlanTab';
import { EpisodeSwitcher, ModelSettings, SaveBadge, Section, type WS } from './shared';

export const EMOTIONS = ['', '담담', '기쁨', '설렘', '슬픔', '분노', '두려움', '놀람', '속삭임', '비꼼'];
export const CAMERA_MOVES = ['', '고정', '천천히 다가가기', '천천히 멀어지기', '왼쪽으로 패닝', '오른쪽으로 패닝', '위로 틸트', '핸드헬드', '따라가기'];
export const CAMERAS = ['익스트림 클로즈업', '클로즈업', '바스트', '미디엄', '풀샷', '와이드', '투샷', '오버숄더', '하이앵글', '로우앵글', '시점샷'];
const SCRIPT_CHIPS = ['첫 3초를 더 강렬하게', '대사를 더 짧고 강렬하게', '설렘을 더', '긴장감을 더', '반전을 넣어서', '코믹하게'];
type Diagnosis = {
  scores: Record<'hook' | 'pacing' | 'dialogue' | 'cliffhanger' | 'consistency', number>;
  summary: string;
  fixes: { shot: number; problem: string; suggestion: string }[];
  risks: string[];
  at?: string;
};
const scoreName = { hook: '첫 3초', pacing: '전개 속도', dialogue: '대사', cliffhanger: '클리프행어', consistency: '설정 일관성' } as const;

export default function ScriptTab({ ws }: { ws: WS }) {
  const e = ws.episode;
  if (!e) return <Empty title="먼저 기획안을 만들어 주세요" text="기획 · 설정 탭에서 회차 구성을 만들면 대본을 쓸 수 있어요." action={() => ws.goTab('plan')} label="기획으로 이동" />;
  return (
    <>
      <EpisodeSwitcher ws={ws} />
      <EpisodeScript key={e.id} ws={ws} e={e} />
    </>
  );
}

function EpisodeScript({ ws, e }: { ws: WS; e: StudioEpisode }) {
  const { data } = ws;
  const pid = data.project.id;
  const [instruction, setInstruction] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<number[]>([]);
  const [rangeText, setRangeText] = useState('');
  const [versions, setVersions] = useState(false);
  const [rewriteFor, setRewriteFor] = useState<{ id: string; text: string } | null>(null);
  const diagnosis = parseJson<Diagnosis | null>(e.diagnosis, null);
  const total = e.shots.reduce((n, s) => n + Number(s.seconds), 0);
  const target = Number(data.project.episode_seconds);
  const scriptBusy = isBusy(data.jobs, e.id, 'script') || isBusy(data.jobs, e.id, 'rewrite_range');
  // 구간 선택: 고른 컷 사이는 자동으로 모두 포함(연속된 구간만 다시 쓸 수 있어요)
  const range = useMemo(() => {
    if (!sel.length) return [] as StudioShot[];
    const lo = Math.min(...sel),
      hi = Math.max(...sel);
    return e.shots.slice(lo, hi + 1);
  }, [sel, e.shots]);
  useEffect(() => {
    if (!selecting) setSel([]);
  }, [selecting]);
  const write = async () => {
    if (e.shots.length && !(await ws.ask({ title: `${e.number}화 대본 다시 쓰기`, text: '지금 대본은 버전 기록에 남고, 새 대본으로 바뀌어요. 만든 이미지 · 음성은 새 컷에 이어지지 않아요.', ok: '다시 쓰기' }))) return;
    ws.run(`${e.number}화 대본 ${e.shots.length ? '다시 ' : ''}쓰기`, 'script', 'text', { targetId: e.id, instruction: instruction.trim() || undefined });
  };
  return (
    <>
      <Section title={`${e.number}화 줄거리`} desc="회차 줄거리 · 훅 · 클리프행어가 대본의 뼈대가 돼요." defaultOpen={!e.shots.length}>
        <EpisodeOutline ws={ws} e={e} />
      </Section>
      <section className="management-panel ws-script">
        <div className="ws-script-head">
          <div>
            <h3>{e.number}화 대본</h3>
            <p className={Math.abs(total - target) > target * 0.25 && e.shots.length ? 'danger' : 'muted'}>
              컷 {e.shots.length}개 · 총 {total}초 / 목표 {target}초{e.script_version ? ` · 버전 ${e.script_version}` : ''}
            </p>
          </div>
          <div className="ws-row">
            <button className="secondary compact" onClick={() => setVersions(true)}>
              <History size={14} /> 버전 기록
            </button>
            <button className="secondary compact" disabled={!e.shots.length || isBusy(data.jobs, e.id, 'diagnose')} onClick={() => ws.run(`${e.number}화 대본 진단`, 'diagnose', 'text', { targetId: e.id })}>
              <Stethoscope size={14} /> 대본 진단
            </button>
            <JobBadge jobs={data.jobs} targetId={e.id} kind="diagnose" />
            <button className={'secondary compact' + (selecting ? ' active' : '')} disabled={!e.shots.length} onClick={() => setSelecting(!selecting)}>
              <ListChecks size={14} /> {selecting ? '구간 선택 끝내기' : '구간 골라 고치기'}
            </button>
          </div>
        </div>
        <ModelSettings ws={ws} caps={['text']} />
        <div className="ws-write">
          <input aria-label="대본 요청 사항" value={instruction} maxLength={300} placeholder="(선택) 요청 사항 · 예: 남주가 먼저 고백하게, 카페 장면으로 시작" onChange={(ev) => setInstruction(ev.target.value)} />
          <button className="primary" disabled={scriptBusy || !data.characters.length} onClick={() => void write()}>
            <Wand2 size={15} /> {e.shots.length ? 'AI로 다시 쓰기' : 'AI로 대본 쓰기'}
          </button>
          <JobBadge jobs={data.jobs} targetId={e.id} kind="script" onRetry={() => void write()} />
        </div>
        <div className="chip-row">
          {SCRIPT_CHIPS.map((c) => (
            <button type="button" key={c} className={'chip' + (instruction === c ? ' active' : '')} onClick={() => setInstruction(instruction === c ? '' : c)}>
              {c}
            </button>
          ))}
        </div>
        {!data.characters.length && <p className="muted">대본을 쓰려면 기획 · 설정 탭에서 인물을 먼저 만들어 주세요.</p>}
        {diagnosis && <DiagnosisView d={diagnosis} shots={e.shots} onFix={(id, text) => setRewriteFor({ id, text })} />}
        {selecting && (
          <div className="ws-range-bar" role="region" aria-label="구간 다시 쓰기">
            <strong>{range.length ? `${sel.length ? Math.min(...sel) + 1 : 0}~${Math.max(...sel) + 1}번 컷 (${range.length}개) 선택` : '다시 쓸 컷을 골라 주세요'}</strong>
            <div className="chip-row">
              {REWRITE_CHIPS.map((c) => (
                <button type="button" key={c} className={'chip' + (rangeText === c ? ' active' : '')} onClick={() => setRangeText(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="ws-write">
              <input aria-label="구간 고칠 방향" value={rangeText} maxLength={300} placeholder="어떻게 고칠까요? 예: 이 부분을 더 빠르게" onChange={(ev) => setRangeText(ev.target.value)} />
              <button
                className="primary compact"
                disabled={!range.length || range.length > 20 || rangeText.trim().length < 2 || scriptBusy}
                onClick={() => {
                  ws.run(`${range.length}개 컷 다시 쓰기`, 'rewrite_range', 'text', { targetId: e.id, instruction: rangeText.trim(), options: { shotIds: range.map((s) => s.id) } });
                  setSelecting(false);
                  setRangeText('');
                }}
              >
                <Sparkles size={13} /> 선택 구간 다시 쓰기
              </button>
            </div>
            {range.length > 20 && <small className="danger">한 번에 20컷까지 고칠 수 있어요.</small>}
            <JobBadge jobs={data.jobs} targetId={e.id} kind="rewrite_range" />
          </div>
        )}
        {!e.shots.length && !scriptBusy && <p className="muted ws-empty-script">아직 대본이 없어요. AI로 쓰거나 아래에서 컷을 직접 추가하세요.</p>}
        <ol className="ws-screenplay">
          {e.shots.map((s, i) => (
            <ShotLine
              key={s.id}
              ws={ws}
              s={s}
              index={i}
              total={e.shots.length}
              selecting={selecting}
              selected={range.some((x) => x.id === s.id)}
              toggle={() => setSel((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))}
              rewriteText={rewriteFor?.id === s.id ? rewriteFor.text : undefined}
              clearRewrite={() => setRewriteFor(null)}
            />
          ))}
        </ol>
        <div className="form-actions start">
          <button
            className="secondary"
            disabled={ws.busy || e.shots.length >= 40}
            onClick={() => void ws.act(() => api(`/studio/ai/projects/${pid}/episodes/${e.id}/shots`, 'POST', { scene: e.shots[e.shots.length - 1]?.scene || '', visual: '', dialogue: '', speaker_id: null, camera: '미디엄', seconds: 5 }), '컷을 추가했어요.')}
          >
            <Plus size={15} /> 컷 추가
          </button>
          {e.shots.length > 0 && (
            <button className="secondary" onClick={() => ws.goTab('scene')}>
              장면 편집으로 →
            </button>
          )}
        </div>
      </section>
      {versions && <VersionsModal ws={ws} e={e} close={() => setVersions(false)} />}
    </>
  );
}

function DiagnosisView({ d, shots, onFix }: { d: Diagnosis; shots: StudioShot[]; onFix: (shotId: string, text: string) => void }) {
  const [open, setOpen] = useState(true);
  const avg = Math.round(Object.values(d.scores).reduce((a, b) => a + Number(b), 0) / 5);
  return (
    <div className="ws-diagnosis">
      <button type="button" className="ws-diagnosis-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Stethoscope size={14} /> 대본 진단 <b className={avg >= 75 ? 'lime' : avg >= 55 ? '' : 'danger'}>{avg}점</b>
        {d.at && <small>{new Date(d.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>}
      </button>
      {open && (
        <>
          <div className="ws-scores">
            {(Object.keys(scoreName) as (keyof typeof scoreName)[]).map((k) => (
              <div key={k}>
                <span>{scoreName[k]}</span>
                <i>
                  <u style={{ width: `${Math.max(0, Math.min(100, Number(d.scores[k])))}%` }} />
                </i>
                <b>{Math.round(Number(d.scores[k]))}</b>
              </div>
            ))}
          </div>
          {d.summary && <p>{d.summary}</p>}
          {!!d.fixes.length && (
            <ul className="ws-fixes">
              {d.fixes.map((f, i) => {
                const shot = f.shot > 0 ? shots[f.shot - 1] : undefined;
                return (
                  <li key={i}>
                    <span>
                      {f.shot > 0 && <b>#{f.shot}</b>} {f.problem}
                      <small>→ {f.suggestion}</small>
                    </span>
                    {shot && (
                      <button type="button" className="text-link" onClick={() => onFix(shot.id, f.suggestion.slice(0, 300))}>
                        이 컷 AI로 고치기
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!!d.risks.length && (
            <div className="ws-risks">
              <b>검수 위험</b>
              {d.risks.map((r, i) => (
                <span key={i}>{r}</span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// 대본의 컷 한 줄(장면 · 화면 · 화자 · 대사). 입력하면 자동 저장돼요.
function ShotLine({
  ws,
  s,
  index,
  total,
  selecting,
  selected,
  toggle,
  rewriteText,
  clearRewrite,
}: {
  ws: WS;
  s: StudioShot;
  index: number;
  total: number;
  selecting: boolean;
  selected: boolean;
  toggle: () => void;
  rewriteText?: string;
  clearRewrite: () => void;
}) {
  const { data } = ws;
  const server = shotBase(s);
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(
    f,
    server,
    async (v) => {
      const r = await api<{ audioReset: boolean }>(`/studio/ai/shots/${s.id}`, 'PATCH', v);
      if (r.audioReset && (s.audio || s.lipsync)) {
        ws.notify(`${index + 1}번 컷 대사가 바뀌어 음성을 다시 만들어야 해요.`);
        void ws.load();
      }
    },
    { delay: 1200, enabled: f.seconds >= 2 && f.seconds <= 10 },
  );
  const [ask, setAsk] = useState<string | null>(null);
  useEffect(() => {
    if (rewriteText !== undefined) {
      setAsk(rewriteText);
      clearRewrite();
      document.getElementById('shot-' + s.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [rewriteText, clearRewrite, s.id]);
  const move = async (direction: 'up' | 'down') => {
    if (!(await save.flush()) && save.dirty) return;
    await ws.act(() => api(`/studio/ai/shots/${s.id}/move`, 'POST', { direction }));
  };
  const remove = async () => {
    const has = s.image || s.audio || s.video;
    if (has && !(await ws.ask({ title: `${index + 1}번 컷 지우기`, text: '이 컷의 이미지 · 음성 · 영상도 함께 빠져요. 대본 버전 기록에서 되돌릴 수 있어요.', ok: '지우기', danger: true }))) return;
    await ws.act(() => api(`/studio/ai/shots/${s.id}`, 'DELETE'), '컷을 지웠어요.');
  };
  const busyRewrite = isBusy(data.jobs, s.id, 'rewrite_shot');
  return (
    <li id={'shot-' + s.id} className={'ws-line' + (selected ? ' selected' : '') + (busyRewrite ? ' busy' : '')}>
      <div className="ws-line-index">
        {selecting ? (
          <label className="ws-line-check">
            <input type="checkbox" checked={selected} onChange={toggle} aria-label={`${index + 1}번 컷 고르기`} />
            <b>{index + 1}</b>
          </label>
        ) : (
          <b>{index + 1}</b>
        )}
        <button aria-label="위로" disabled={ws.busy || index === 0} onClick={() => void move('up')}>
          <ArrowUp size={12} />
        </button>
        <button aria-label="아래로" disabled={ws.busy || index === total - 1} onClick={() => void move('down')}>
          <ArrowDown size={12} />
        </button>
      </div>
      <div className="ws-line-body">
        <div className="ws-line-top">
          <input className="ws-scene" aria-label="장면(장소 · 시간)" value={f.scene} maxLength={200} placeholder="장면 · 예: 카페 - 밤" onChange={(e) => setF({ ...f, scene: e.target.value })} />
          <select aria-label="카메라" className="ws-mini" value={CAMERAS.includes(f.camera) ? f.camera : f.camera ? '__custom' : ''} onChange={(e) => setF({ ...f, camera: e.target.value === '__custom' ? f.camera : e.target.value })}>
            <option value="">카메라</option>
            {CAMERAS.map((c) => (
              <option key={c}>{c}</option>
            ))}
            {f.camera && !CAMERAS.includes(f.camera) && <option value="__custom">{f.camera}</option>}
          </select>
          <label className="ws-seconds">
            <input type="number" min={2} max={10} value={f.seconds} aria-label="길이(초)" onChange={(e) => setF({ ...f, seconds: Math.round(Number(e.target.value)) })} />초
          </label>
          <SaveBadge state={save.state} error={save.error} />
        </div>
        <textarea className="ws-visual" aria-label="화면 묘사" rows={2} maxLength={800} value={f.visual} placeholder="화면에 보이는 것 · 인물의 행동 (한국어로 써도 돼요)" onChange={(e) => setF({ ...f, visual: e.target.value })} />
        <div className="ws-dialogue">
          <select aria-label="말하는 인물" value={f.narration ? '__narr' : f.speaker_id || ''} onChange={(e) => setF({ ...f, narration: e.target.value === '__narr', speaker_id: e.target.value && e.target.value !== '__narr' ? e.target.value : null })}>
            <option value="">(대사 없음)</option>
            {data.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="__narr">내레이션</option>
          </select>
          <input aria-label="대사" value={f.dialogue} maxLength={300} placeholder={f.speaker_id || f.narration ? '대사' : '대사가 있으면 먼저 인물을 고르세요'} onChange={(e) => setF({ ...f, dialogue: e.target.value })} />
          <select aria-label="감정" className="ws-mini" value={f.emotion} onChange={(e) => setF({ ...f, emotion: e.target.value })}>
            {[...EMOTIONS, ...(f.emotion && !EMOTIONS.includes(f.emotion) ? [f.emotion] : [])].map((x) => (
              <option key={x} value={x}>
                {x || '감정'}
              </option>
            ))}
          </select>
        </div>
        <div className="ws-line-tools">
          <button className="text-link" disabled={busyRewrite} onClick={() => setAsk(ask === null ? '' : null)}>
            <Sparkles size={12} /> AI로 고치기
          </button>
          <JobBadge jobs={data.jobs} targetId={s.id} kind="rewrite_shot" />
          <span className="ws-media-dots" aria-label="만든 결과">
            <i className={s.image ? 'on' : ''} title="이미지">이미지</i>
            <i className={s.audio ? 'on' : ''} title="음성">음성</i>
            <i className={s.video ? 'on' : ''} title="영상">영상</i>
          </span>
          <button className="icon-button" aria-label={`${index + 1}번 컷 지우기`} disabled={ws.busy} onClick={() => void remove()}>
            <Trash2 size={13} />
          </button>
        </div>
        {ask !== null && (
          <form
            className="rewrite-box"
            onSubmit={async (ev) => {
              ev.preventDefault();
              if (ask.trim().length < 2) return;
              if (!(await save.flush()) && save.dirty) return;
              ws.run(`${index + 1}번 컷 AI로 고치기`, 'rewrite_shot', 'text', { targetId: s.id, instruction: ask.trim() });
              setAsk(null);
            }}
          >
            <div className="chip-row">
              {REWRITE_CHIPS.map((c) => (
                <button type="button" key={c} className={'chip' + (ask === c ? ' active' : '')} onClick={() => setAsk(c)}>
                  {c}
                </button>
              ))}
            </div>
            <div className="rewrite-input">
              <input aria-label="고칠 방향" value={ask} maxLength={300} placeholder="어떻게 고칠까요?" onChange={(e) => setAsk(e.target.value)} autoFocus />
              <button className="primary compact" disabled={ask.trim().length < 2}>
                <Wand2 size={13} /> 고치기
              </button>
              <button type="button" className="icon-button" aria-label="닫기" onClick={() => setAsk(null)}>
                <X size={13} />
              </button>
            </div>
          </form>
        )}
      </div>
    </li>
  );
}
// 컷 저장에 늘 함께 보내는 기본 값(서버는 빠진 칸을 빈 값으로 저장하므로 모두 보냄)
export const shotBase = (s: StudioShot) => ({
  scene: s.scene,
  visual: s.visual,
  dialogue: s.dialogue,
  speaker_id: s.speaker_id,
  camera: s.camera,
  seconds: Number(s.seconds),
  emotion: s.emotion || '',
  narration: !!Number(s.narration),
});

function VersionsModal({ ws, e, close }: { ws: WS; e: StudioEpisode; close: () => void }) {
  const [list, setList] = useState<StudioVersion[] | null>(null);
  const [open, setOpen] = useState<string>('');
  const pid = ws.data.project.id;
  useEffect(() => {
    api<StudioVersion[]>(`/studio/ai/projects/${pid}/episodes/${e.id}/versions`).then(setList, (err) => {
      ws.notify((err as Error).message);
      setList([]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, e.id]);
  const name = (id?: string | null) => ws.data.characters.find((c) => c.id === id)?.name || '';
  const sourceName: Record<string, string> = { before_ai: 'AI 수정 전', before_restore: '되돌리기 전', manual: '직접 저장' };
  return (
    <Modal title={`${e.number}화 대본 버전 기록`} close={close} className="wide">
      {!list ? (
        <p className="muted">불러오는 중…</p>
      ) : !list.length ? (
        <p className="muted">아직 버전 기록이 없어요. AI로 대본을 다시 쓰거나 고치면 그 전 대본이 자동으로 남아요.</p>
      ) : (
        <ul className="ws-versions">
          {list.map((v) => (
            <li key={v.id}>
              <div className="ws-row">
                <b>v{v.version}</b>
                <span>
                  {sourceName[v.source] || v.source}
                  {v.note && <small> · {v.note}</small>}
                </span>
                <small className="muted">
                  {new Date(v.created_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 컷 {v.shots.length}개
                </small>
                <button type="button" className="text-link" onClick={() => setOpen(open === v.id ? '' : v.id)}>
                  {open === v.id ? '접기' : '보기'}
                </button>
                <button
                  type="button"
                  className="secondary compact"
                  onClick={async () => {
                    if (!(await ws.ask({ title: `v${v.version}로 되돌리기`, text: '지금 대본은 새 버전으로 남기고, 이 버전의 대본으로 바꿔요.', ok: '되돌리기' }))) return;
                    if (await ws.act(() => api(`/studio/ai/projects/${pid}/episodes/${e.id}/versions/${v.id}/restore`, 'POST'), `v${v.version} 대본으로 되돌렸어요.`)) close();
                  }}
                >
                  <RotateCcw size={13} /> 되돌리기
                </button>
              </div>
              {open === v.id && (
                <ol className="ws-version-shots">
                  {v.shots.map((s, i) => (
                    <li key={i}>
                      <small>{s.scene}</small> {s.visual}
                      {s.dialogue && (
                        <em>
                          {' '}
                          {name(s.speaker_id) || (Number(s.narration) ? '내레이션' : '')}: “{s.dialogue}”
                        </em>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
