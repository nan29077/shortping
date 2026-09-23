import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Film, ImageIcon, Lock, Mic, Music, PlayCircle, Sparkles, Upload, Volume2, Wand2 } from 'lucide-react';
import { api, parseJson, studioMedia, type StudioEpisode, type StudioShot } from '../../api';
import { Empty } from '../../App';
import { useAutosave, useSyncedForm } from '../hooks';
import { JobBadge, Versions, isBusy } from '../parts';
import { CAMERAS, CAMERA_MOVES, EMOTIONS, shotBase } from './ScriptTab';
import { EpisodeSwitcher, ModelSettings, NotReady, SaveBadge, Section, hasModel, runningCount, type WS } from './shared';
import { asset } from '../../platform';

const TRANSITIONS = [
  { id: 'cut', name: '바로 전환' },
  { id: 'fade', name: '겹쳐 전환' },
  { id: 'dip', name: '검은 화면 거쳐' },
  { id: 'flash', name: '번쩍(플래시)' },
];
const SFX_CHIPS = ['문이 쾅 닫히는 소리', '빗소리', '심장 박동', '휴대폰 진동', '발소리', '유리 깨지는 소리', '카페 소음', '천둥'];
const MUSIC_MOODS = ['설레는 로맨스', '긴장감 있는 스릴러', '슬프고 잔잔한', '밝고 경쾌한', '웅장한 반전', '미스터리'];
type SubStyle = { position: 'bottom' | 'middle' | 'top'; size: 's' | 'm' | 'l' | 'xl'; background: 'none' | 'box' | 'shadow'; names: boolean };
const defaultSub: SubStyle = { position: 'bottom', size: 'm', background: 'shadow', names: false };

export default function SceneTab({ ws }: { ws: WS }) {
  const e = ws.episode;
  if (!e) return <Empty title="먼저 기획안을 만들어 주세요" text="기획 · 설정 탭에서 회차 구성을 만들면 장면을 편집할 수 있어요." action={() => ws.goTab('plan')} label="기획으로 이동" />;
  return (
    <>
      <EpisodeSwitcher ws={ws} />
      <EpisodeScenes key={e.id} ws={ws} e={e} />
      <BgmSection ws={ws} e={e} />
      <SubtitleSection ws={ws} />
    </>
  );
}

function EpisodeScenes({ ws, e }: { ws: WS; e: StudioEpisode }) {
  const { data } = ws;
  const [selId, setSelId] = useState(e.shots[0]?.id || '');
  const index = Math.max(0, e.shots.findIndex((s) => s.id === selId));
  const shot = e.shots[index];
  const jobs = data.jobs;
  const lines = e.shots.filter((s) => s.dialogue.trim());
  const counts = {
    image: e.shots.filter((s) => s.image).length,
    audio: lines.filter((s) => s.audio).length,
    video: e.shots.filter((s) => s.video).length,
    lipsync: e.shots.filter((s) => s.lipsync).length,
    sfx: e.shots.filter((s) => s.sfx).length,
  };
  const syncable = e.shots.filter((s) => s.video && s.audio && !s.lipsync).length;
  const sfxable = e.shots.filter((s) => s.sfx_prompt?.trim() && !s.sfx).length;
  const running = (kind: string) => runningCount(jobs, (j) => j.kind === kind && e.shots.some((s) => s.id === j.target_id));
  const batch = (label: string, action: string, cap: 'image' | 'tts' | 'video' | 'lipsync' | 'sfx') => ws.run(`${e.number}화 ${label}`, action, cap, { targetId: e.id });
  if (!e.shots.length)
    return (
      <section className="management-panel">
        <Empty title="대본이 없어요" text="대본 탭에서 컷을 먼저 만들어 주세요." action={() => ws.goTab('script')} label="대본으로 이동" />
      </section>
    );
  return (
    <section className="management-panel ws-scenes">
      <div className="ws-script-head">
        <div>
          <h3>{e.number}화 장면 편집</h3>
          <p className="muted">
            이미지 {counts.image}/{e.shots.length} · 음성 {counts.audio}/{lines.length} · 영상 {counts.video}
            {counts.lipsync ? ` · 입 모양 ${counts.lipsync}` : ''}
            {counts.sfx ? ` · 효과음 ${counts.sfx}` : ''}
          </p>
        </div>
        <button className="secondary compact" onClick={() => ws.preview(e)}>
          <PlayCircle size={14} /> 미리보기 (무료)
        </button>
      </div>
      <ModelSettings ws={ws} caps={['image', 'tts', 'video', 'lipsync', 'sfx']} />
      <div className="ws-batch" aria-label="비어 있는 컷 한 번에 채우기">
        <span>한 번에 채우기</span>
        <button className="secondary compact" disabled={counts.image === e.shots.length || running('shot_image') > 0} onClick={() => batch('빈 컷 이미지 모두', 'batch_shot_image', 'image')}>
          <ImageIcon size={13} /> 빈 이미지 {e.shots.length - counts.image}
          {running('shot_image') ? ` · 진행 ${running('shot_image')}` : ''}
        </button>
        <button className="secondary compact" disabled={counts.audio === lines.length || running('shot_tts') > 0} onClick={() => batch('대사 음성 모두', 'batch_shot_tts', 'tts')}>
          <Mic size={13} /> 빈 음성 {lines.length - counts.audio}
          {running('shot_tts') ? ` · 진행 ${running('shot_tts')}` : ''}
        </button>
        <button className="secondary compact" disabled={counts.video === e.shots.length || running('shot_video') > 0} onClick={() => batch('빈 컷 영상 모두', 'batch_shot_video', 'video')}>
          <Film size={13} /> 빈 영상 {e.shots.length - counts.video}
          {running('shot_video') ? ` · 진행 ${running('shot_video')}` : ''}
        </button>
        {hasModel(ws.models, 'lipsync') && (
          <button className="secondary compact" disabled={!syncable || running('shot_lipsync') > 0} onClick={() => batch('입 모양 모두 맞추기', 'batch_shot_lipsync', 'lipsync')}>
            <Sparkles size={13} /> 입 모양 {syncable}
          </button>
        )}
        {hasModel(ws.models, 'sfx') && (
          <button className="secondary compact" disabled={!sfxable || running('shot_sfx') > 0} onClick={() => batch('효과음 모두 만들기', 'batch_shot_sfx', 'sfx')}>
            <Volume2 size={13} /> 효과음 {sfxable}
          </button>
        )}
      </div>
      <Timeline e={e} selected={shot?.id || ''} select={setSelId} jobs={jobs} />
      {shot && (
        <ShotDetail
          key={shot.id}
          ws={ws}
          s={shot}
          index={index}
          total={e.shots.length}
          next={e.shots[index + 1]}
          go={(d) => setSelId(e.shots[Math.min(e.shots.length - 1, Math.max(0, index + d))].id)}
        />
      )}
    </section>
  );
}

// 타임라인: 컷 길이에 비례한 칸으로 한 회차를 한눈에 보여 줘요.
function Timeline({ e, selected, select, jobs }: { e: StudioEpisode; selected: string; select: (id: string) => void; jobs: WS['data']['jobs'] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  const total = e.shots.reduce((n, s) => n + Number(s.seconds), 0);
  return (
    <div className="ws-timeline" ref={ref} role="listbox" aria-label="컷 타임라인">
      {e.shots.map((s, i) => {
        const busy = jobs.some((j) => j.target_id === s.id && (j.status === 'queued' || j.status === 'running'));
        const failed = jobs.find((j) => j.target_id === s.id)?.status === 'failed';
        return (
          <button
            key={s.id}
            role="option"
            aria-selected={selected === s.id}
            className={'ws-clip' + (selected === s.id ? ' active' : '') + (busy ? ' busy' : '') + (failed ? ' failed' : '')}
            style={{ flexGrow: Number(s.seconds), minWidth: Math.max(64, (Number(s.seconds) / Math.max(1, total)) * 900) }}
            onClick={() => select(s.id)}
          >
            {s.image ? <img src={asset(s.image)} alt="" loading="lazy" /> : <span className="ws-clip-empty">이미지 없음</span>}
            <b>
              {i + 1} · {s.seconds}초
            </b>
            <span className="ws-clip-flags">
              {s.video && <Film size={10} aria-label="영상" />}
              {s.audio && <Mic size={10} aria-label="음성" />}
              {s.lipsync && <Sparkles size={10} aria-label="입 모양" />}
              {s.sfx && <Volume2 size={10} aria-label="효과음" />}
            </span>
            {i > 0 && s.transition && s.transition !== 'cut' && <i className="ws-clip-transition" title={TRANSITIONS.find((t) => t.id === s.transition)?.name} />}
          </button>
        );
      })}
    </div>
  );
}

function ShotDetail({ ws, s, index, total, next, go }: { ws: WS; s: StudioShot; index: number; total: number; next?: StudioShot; go: (d: number) => void }) {
  const { data } = ws;
  const jobs = data.jobs;
  const server = {
    ...shotBase(s),
    cast_ids: String(s.cast_ids || '').split(',').filter(Boolean),
    location_id: s.location_id || null,
    camera_move: s.camera_move || '',
    speed: Number(s.speed) || 1,
    seed_lock: !!Number(s.seed_lock),
    end_frame: !!Number(s.end_frame),
    transition: (s.transition || 'cut') as 'cut' | 'fade' | 'dip' | 'flash',
    sfx_prompt: s.sfx_prompt || '',
    sfx_volume: s.sfx_volume === undefined || s.sfx_volume === null ? 0.6 : Number(s.sfx_volume),
    caption: s.caption ?? null,
  };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(
    f,
    server,
    async (v) => {
      const r = await api<{ audioReset: boolean }>(`/studio/ai/shots/${s.id}`, 'PATCH', v);
      if (r.audioReset && (s.audio || s.lipsync)) ws.notify(`${index + 1}번 컷 대사 · 목소리 설정이 바뀌어 음성을 다시 만들어야 해요.`);
      void ws.load();
    },
    { delay: 1200 },
  );
  const [editText, setEditText] = useState('');
  // AI 작업 전에는 입력 중인 변경을 먼저 저장합니다(최신 내용으로 만들도록).
  const run = async (label: string, action: string, cap: 'image' | 'tts' | 'video' | 'lipsync' | 'sfx', opts: { instruction?: string; options?: Record<string, unknown> } = {}) => {
    if (!(await save.flush()) && save.dirty) return;
    ws.run(`${index + 1}번 컷 ${label}`, action, cap, { targetId: s.id, ...opts });
  };
  const speaker = data.characters.find((c) => c.id === f.speaker_id);
  const media = s.lipsync || s.video;
  return (
    <div className="ws-detail">
      <div className="ws-detail-nav">
        <button className="icon-button" aria-label="이전 컷" disabled={index === 0} onClick={() => go(-1)}>
          <ChevronLeft size={16} />
        </button>
        <strong>
          {index + 1}번 컷 <small>/ {total}</small>
        </strong>
        <button className="icon-button" aria-label="다음 컷" disabled={index === total - 1} onClick={() => go(1)}>
          <ChevronRight size={16} />
        </button>
        <SaveBadge state={save.state} error={save.error} />
      </div>
      <div className="ws-detail-grid">
        <div className="ws-detail-media">
          <div className="ws-frame">
            {media ? (
              <video key={media} controls preload="none" playsInline poster={asset(s.image) || undefined} src={studioMedia(media)} />
            ) : s.image ? (
              <img src={asset(s.image)} alt={`${index + 1}번 컷`} />
            ) : (
              <span>이미지 없음</span>
            )}
            {s.lipsync && <em className="ws-frame-tag">입 모양 맞춤</em>}
          </div>
          <div className="ws-tools">
            <button className="secondary compact" disabled={isBusy(jobs, s.id, 'shot_image') || !f.visual.trim()} onClick={() => void run('이미지', 'shot_image', 'image')}>
              <ImageIcon size={13} /> {s.image ? '이미지 다시' : '이미지'}
            </button>
            <JobBadge jobs={jobs} targetId={s.id} kind="shot_image" onRetry={() => void run('이미지', 'shot_image', 'image')} />
            <Versions assets={data.assets} targetId={s.id} kind="image" current={s.image} onUse={ws.useAsset} />
          </div>
          {s.image && (
            <form
              className="ws-edit-image"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (editText.trim().length < 2) return;
                void run('이미지 부분 고치기', 'shot_image_edit', 'image', { instruction: editText.trim() });
                setEditText('');
              }}
            >
              <input aria-label="이미지 고칠 내용" value={editText} maxLength={300} placeholder="이미지 고치기 · 예: 배경을 밤으로, 우산 들게" onChange={(ev) => setEditText(ev.target.value)} />
              <button className="secondary compact" disabled={editText.trim().length < 2 || isBusy(jobs, s.id, 'shot_image_edit')}>
                <Wand2 size={13} /> 고치기
              </button>
              <JobBadge jobs={jobs} targetId={s.id} kind="shot_image_edit" />
            </form>
          )}
          <label className="inline-check" title="같은 컷을 다시 만들 때 구도와 느낌이 크게 바뀌지 않게 해요">
            <input type="checkbox" checked={f.seed_lock} onChange={(ev) => setF({ ...f, seed_lock: ev.target.checked })} />
            <Lock size={12} /> 다시 만들어도 비슷한 그림 유지(시드 고정)
          </label>
          <div className="ws-tools">
            <button className="secondary compact" disabled={isBusy(jobs, s.id, 'shot_video') || !f.visual.trim()} onClick={() => void run(`영상 (${f.seconds}초)`, 'shot_video', 'video')}>
              <Film size={13} /> {s.video ? '영상 다시' : '영상 만들기'}
            </button>
            <JobBadge jobs={jobs} targetId={s.id} kind="shot_video" onRetry={() => void run(`영상 (${f.seconds}초)`, 'shot_video', 'video')} />
            <Versions assets={data.assets} targetId={s.id} kind="video" current={s.video} onUse={ws.useAsset} />
          </div>
          {hasModel(ws.models, 'lipsync') ? (
            <div className="ws-tools">
              <button
                className="secondary compact"
                disabled={!s.video || !s.audio || isBusy(jobs, s.id, 'shot_lipsync')}
                title={!s.video || !s.audio ? '영상과 대사 음성이 모두 있어야 해요' : ''}
                onClick={() => void run('입 모양 맞추기', 'shot_lipsync', 'lipsync')}
              >
                <Sparkles size={13} /> {s.lipsync ? '입 모양 다시' : '입 모양 맞추기'}
              </button>
              <JobBadge jobs={jobs} targetId={s.id} kind="shot_lipsync" />
            </div>
          ) : (
            s.dialogue && <NotReady what="입 모양 맞추기" />
          )}
        </div>
        <div className="ws-detail-fields">
          <label>
            화면 묘사
            <textarea rows={3} maxLength={800} value={f.visual} onChange={(ev) => setF({ ...f, visual: ev.target.value })} />
          </label>
          <div className="form-columns">
            <label>
              카메라
              <select value={f.camera} onChange={(ev) => setF({ ...f, camera: ev.target.value })}>
                <option value="">선택 안 함</option>
                {[...CAMERAS, ...(f.camera && !CAMERAS.includes(f.camera) ? [f.camera] : [])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              카메라 움직임
              <select value={f.camera_move} onChange={(ev) => setF({ ...f, camera_move: ev.target.value })}>
                {[...CAMERA_MOVES, ...(f.camera_move && !CAMERA_MOVES.includes(f.camera_move) ? [f.camera_move] : [])].map((c) => (
                  <option key={c} value={c}>
                    {c || '자동'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              길이(초)
              <input type="number" min={2} max={10} value={f.seconds} onChange={(ev) => setF({ ...f, seconds: Math.min(10, Math.max(2, Math.round(Number(ev.target.value) || 2))) })} />
            </label>
          </div>
          <div className="ws-field">
            <span>등장 인물</span>
            <div className="chip-row">
              {data.characters.map((c) => {
                const on = f.cast_ids.includes(c.id);
                return (
                  <button type="button" key={c.id} className={'chip' + (on ? ' active' : '')} aria-pressed={on} onClick={() => setF({ ...f, cast_ids: on ? f.cast_ids.filter((x) => x !== c.id) : [...f.cast_ids, c.id] })}>
                    {c.image && <img src={asset(c.image)} alt="" />}
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
          <label>
            장소
            <select value={f.location_id || ''} onChange={(ev) => setF({ ...f, location_id: ev.target.value || null })}>
              <option value="">지정 안 함</option>
              {(data.locations || []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {next && (
            <label className="inline-check" title="영상의 마지막 장면이 다음 컷 이미지로 끝나 자연스럽게 이어져요(지원하는 모델만)">
              <input type="checkbox" checked={f.end_frame} disabled={!next.image} onChange={(ev) => setF({ ...f, end_frame: ev.target.checked })} />
              영상이 다음 컷 이미지로 이어지게{!next.image ? ' (다음 컷 이미지가 필요해요)' : ''}
            </label>
          )}
          <fieldset className="ws-voice">
            <legend>
              <Mic size={13} /> 대사 · 목소리
            </legend>
            <div className="ws-dialogue">
              <select aria-label="말하는 인물" value={f.narration ? '__narr' : f.speaker_id || ''} onChange={(ev) => setF({ ...f, narration: ev.target.value === '__narr', speaker_id: ev.target.value && ev.target.value !== '__narr' ? ev.target.value : null })}>
                <option value="">(대사 없음)</option>
                {data.characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="__narr">내레이션</option>
              </select>
              <input aria-label="대사" value={f.dialogue} maxLength={300} onChange={(ev) => setF({ ...f, dialogue: ev.target.value })} />
            </div>
            <div className="form-columns">
              <label>
                감정
                <select value={f.emotion} onChange={(ev) => setF({ ...f, emotion: ev.target.value })}>
                  {[...EMOTIONS, ...(f.emotion && !EMOTIONS.includes(f.emotion) ? [f.emotion] : [])].map((x) => (
                    <option key={x} value={x}>
                      {x || (speaker?.voice_style ? `기본(${speaker.voice_style})` : '기본')}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                말 빠르기 <small className="muted">{f.speed.toFixed(1)}배</small>
                <input type="range" min={0.5} max={2} step={0.1} value={f.speed} onChange={(ev) => setF({ ...f, speed: Number(ev.target.value) })} />
              </label>
            </div>
            <div className="ws-tools">
              <button className="secondary compact" disabled={!f.dialogue.trim() || isBusy(jobs, s.id, 'shot_tts')} onClick={() => void run('대사 음성', 'shot_tts', 'tts')}>
                <Mic size={13} /> {s.audio ? '음성 다시' : '음성 만들기'}
              </button>
              <JobBadge jobs={jobs} targetId={s.id} kind="shot_tts" onRetry={() => void run('대사 음성', 'shot_tts', 'tts')} />
              <Versions assets={data.assets} targetId={s.id} kind="audio" current={s.audio} onUse={ws.useAsset} />
            </div>
            {s.audio && <audio key={s.audio} controls preload="none" src={studioMedia(s.audio)} />}
            <label className="inline-check">
              <input type="checkbox" checked={f.caption !== null} onChange={(ev) => setF({ ...f, caption: ev.target.checked ? f.dialogue : null })} />
              자막을 대사와 다르게 쓰기
            </label>
            {f.caption !== null && <input aria-label="자막" value={f.caption} maxLength={300} placeholder="비워 두면 자막 없이 나가요" onChange={(ev) => setF({ ...f, caption: ev.target.value })} />}
          </fieldset>
          <fieldset className="ws-voice">
            <legend>
              <Volume2 size={13} /> 효과음
            </legend>
            {hasModel(ws.models, 'sfx') ? (
              <>
                <div className="ws-edit-image">
                  <input aria-label="효과음 설명" value={f.sfx_prompt} maxLength={200} placeholder="예: 문이 쾅 닫히는 소리" onChange={(ev) => setF({ ...f, sfx_prompt: ev.target.value })} />
                  <button className="secondary compact" disabled={!f.sfx_prompt.trim() || isBusy(jobs, s.id, 'shot_sfx')} onClick={() => void run('효과음', 'shot_sfx', 'sfx', { options: { prompt: f.sfx_prompt.trim() } })}>
                    <Volume2 size={13} /> {s.sfx ? '다시' : '만들기'}
                  </button>
                  <JobBadge jobs={jobs} targetId={s.id} kind="shot_sfx" />
                </div>
                <div className="chip-row">
                  {SFX_CHIPS.map((c) => (
                    <button type="button" key={c} className={'chip' + (f.sfx_prompt === c ? ' active' : '')} onClick={() => setF({ ...f, sfx_prompt: c })}>
                      {c}
                    </button>
                  ))}
                </div>
                {s.sfx && <audio key={s.sfx} controls preload="none" src={studioMedia(s.sfx)} />}
              </>
            ) : (
              <NotReady what="효과음" />
            )}
            {(s.sfx || hasModel(ws.models, 'sfx')) && (
              <label>
                효과음 크기 <small className="muted">{Math.round(f.sfx_volume * 100)}%</small>
                <input type="range" min={0} max={1.5} step={0.05} value={f.sfx_volume} onChange={(ev) => setF({ ...f, sfx_volume: Number(ev.target.value) })} />
              </label>
            )}
          </fieldset>
          {index > 0 && (
            <label>
              앞 컷에서 넘어오는 방식
              <select value={f.transition} onChange={(ev) => setF({ ...f, transition: ev.target.value as typeof f.transition })}>
                {TRANSITIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 배경음악 ────────────────────────────────────────────────
function BgmSection({ ws, e }: { ws: WS; e: StudioEpisode }) {
  const p = ws.data.project;
  const music = ws.data.assets.filter((a) => a.kind === 'music');
  const [mood, setMood] = useState(p.tone || '');
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const server = { bgm: p.bgm || '', bgm_volume: p.bgm_volume === undefined || p.bgm_volume === null ? 0.35 : Number(p.bgm_volume) };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, async (v) => {
    await api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', v);
    void ws.load();
  });
  const epServer = { bgm: e.bgm || '', bgm_volume: e.bgm_volume === undefined || e.bgm_volume === null ? -1 : Number(e.bgm_volume) };
  const [ef, setEf] = useSyncedForm(epServer);
  const epSave = useAutosave(ef, epServer, async (v) => {
    await api(`/studio/ai/projects/${p.id}/episodes/${e.id}`, 'PATCH', { title: e.title, ...v });
    void ws.load();
  });
  const label = (url: string) => {
    const a = music.find((m) => m.url === url);
    return a ? `${a.model_label || 'AI 음악'} · ${new Date(a.created_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}` : '음악';
  };
  const upload = async (fl: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', fl);
      await api(`/studio/ai/projects/${p.id}/music`, 'POST', form);
      await ws.load();
      ws.notify('음악을 올렸어요.');
    } catch (err) {
      ws.notify((err as Error).message);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  };
  const musicRunning = runningCount(ws.data.jobs, (j) => j.kind === 'music');
  const options = [...new Set([...music.map((m) => m.url), f.bgm, ef.bgm].filter(Boolean))];
  return (
    <Section title="배경음악" desc="작품 전체에 깔 음악을 정하고, 필요하면 회차마다 다른 음악을 써요. 대사가 나올 때는 음악이 자동으로 작아져요." defaultOpen={!!p.bgm} badge={<SaveBadge state={save.state === 'idle' ? epSave.state : save.state} error={save.error || epSave.error} />}>
      <div className="form-columns">
        <label>
          작품 기본 음악
          <select value={f.bgm} onChange={(ev) => setF({ ...f, bgm: ev.target.value })}>
            <option value="">음악 없음</option>
            {options.map((u) => (
              <option key={u} value={u}>
                {label(u)}
              </option>
            ))}
          </select>
        </label>
        <label>
          음악 크기 <small className="muted">{Math.round(f.bgm_volume * 100)}%</small>
          <input type="range" min={0} max={1} step={0.05} value={f.bgm_volume} onChange={(ev) => setF({ ...f, bgm_volume: Number(ev.target.value) })} />
        </label>
      </div>
      {f.bgm && <audio key={f.bgm} controls preload="none" src={studioMedia(f.bgm)} />}
      <div className="form-columns">
        <label>
          {e.number}화 음악
          <select value={ef.bgm} onChange={(ev) => setEf({ ...ef, bgm: ev.target.value })}>
            <option value="">작품 기본 음악 사용</option>
            {options.map((u) => (
              <option key={u} value={u}>
                {label(u)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {e.number}화 음악 크기 <small className="muted">{ef.bgm_volume < 0 ? '작품 설정 따름' : Math.round(ef.bgm_volume * 100) + '%'}</small>
          <input type="range" min={-0.05} max={1} step={0.05} value={ef.bgm_volume} onChange={(ev) => setEf({ ...ef, bgm_volume: Number(ev.target.value) < 0 ? -1 : Number(ev.target.value) })} />
        </label>
      </div>
      <div className="ws-music-make">
        <strong>
          <Music size={14} /> 새 음악 만들기
        </strong>
        {hasModel(ws.models, 'music') ? (
          <>
            <div className="chip-row">
              {MUSIC_MOODS.map((m) => (
                <button type="button" key={m} className={'chip' + (mood === m ? ' active' : '')} onClick={() => setMood(m)}>
                  {m}
                </button>
              ))}
            </div>
            <div className="ws-edit-image">
              <input aria-label="음악 분위기" value={mood} maxLength={200} placeholder="분위기 · 예: 잔잔한 피아노, 점점 고조" onChange={(ev) => setMood(ev.target.value)} />
              <button className="secondary compact" disabled={musicRunning > 0} onClick={() => ws.run('작품 배경음악 만들기', 'music', 'music', { options: { mood, seconds: Math.min(180, Math.max(10, Number(p.episode_seconds))) } })}>
                <Music size={13} /> 작품 음악
              </button>
              <button className="secondary compact" disabled={musicRunning > 0} onClick={() => ws.run(`${e.number}화 배경음악 만들기`, 'music', 'music', { targetId: e.id, options: { mood, seconds: Math.min(180, Math.max(10, Number(p.episode_seconds))) } })}>
                <Music size={13} /> {e.number}화 음악
              </button>
              {musicRunning > 0 && <small className="job-badge running">음악 만드는 중</small>}
            </div>
            <ModelSettings ws={ws} caps={['music']} />
          </>
        ) : (
          <NotReady what="AI 배경음악" />
        )}
        <div className="ws-row">
          <input ref={file} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" hidden onChange={(ev) => ev.target.files?.[0] && void upload(ev.target.files[0])} />
          <button className="secondary compact" disabled={uploading} onClick={() => file.current?.click()}>
            <Upload size={13} /> {uploading ? '올리는 중…' : '내 음악 올리기 (MP3 · WAV)'}
          </button>
          <small className="muted">저작권이 있는 음악은 권리를 가진 경우에만 올려 주세요.</small>
        </div>
      </div>
    </Section>
  );
}

// ── 자막 모양 ────────────────────────────────────────────────
function SubtitleSection({ ws }: { ws: WS }) {
  const p = ws.data.project;
  const server: SubStyle = { ...defaultSub, ...parseJson<Partial<SubStyle>>(p.subtitle_style, {}) };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, async (v) => {
    await api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', { subtitle_style: v });
    void ws.load();
  });
  const sample = ws.data.episodes.flatMap((e) => e.shots).find((s) => s.image && s.dialogue);
  const opt = <K extends keyof SubStyle>(k: K, list: [SubStyle[K], string][]) => (
    <div className="chip-row">
      {list.map(([v, name]) => (
        <button type="button" key={String(v)} className={'chip' + (f[k] === v ? ' active' : '')} aria-pressed={f[k] === v} onClick={() => setF({ ...f, [k]: v })}>
          {name}
        </button>
      ))}
    </div>
  );
  return (
    <Section title="자막 모양" desc="완성 영상에 들어가는 자막의 위치 · 크기 · 배경을 정해요. 바꾸면 합성한 회차를 다시 합성해야 해요." defaultOpen={false} badge={<SaveBadge state={save.state} error={save.error} />}>
      <div className="ws-sub-grid">
        <div>
          <div className="ws-field">
            <span>위치</span>
            {opt('position', [
              ['top', '위'],
              ['middle', '가운데'],
              ['bottom', '아래'],
            ])}
          </div>
          <div className="ws-field">
            <span>크기</span>
            {opt('size', [
              ['s', '작게'],
              ['m', '보통'],
              ['l', '크게'],
              ['xl', '아주 크게'],
            ])}
          </div>
          <div className="ws-field">
            <span>배경</span>
            {opt('background', [
              ['shadow', '그림자'],
              ['box', '반투명 상자'],
              ['none', '없음'],
            ])}
          </div>
          <label className="inline-check">
            <input type="checkbox" checked={f.names} onChange={(ev) => setF({ ...f, names: ev.target.checked })} />
            자막 앞에 말하는 인물 이름 넣기
          </label>
        </div>
        <div className={`ws-sub-preview pos-${f.position} size-${f.size} bg-${f.background}`} aria-label="자막 미리보기">
          {sample?.image ? <img src={asset(sample.image)} alt="" /> : <span />}
          <p>
            {f.names && <b>{ws.data.characters.find((c) => c.id === sample?.speaker_id)?.name || '인물'}: </b>}
            {sample?.dialogue || '자막은 이렇게 보여요'}
          </p>
        </div>
      </div>
    </Section>
  );
}
