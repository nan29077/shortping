import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, ChevronDown, MessageSquare, ChevronLeft, ChevronRight, Film, Plus, ShieldCheck, ImageIcon, Lock, Mic, Music, PlayCircle, Sparkles, Upload, Volume2, Wand2 } from 'lucide-react';
import { api, ApiError, parseJson, studioMedia, type StudioEpisode, type StudioShot } from '../../api';
import { Empty } from '../../App';
import { changedFields, useAutosave, useSyncedForm } from '../hooks';
import { JobBadge, Versions, isBusy } from '../parts';
import { CAMERA_MOVES, EMOTIONS, shotBase } from './ScriptTab';
import { DirectionPanel, EFFECTS, EffectPicker, LIGHTS, LightPanel, PresetSelect, TONES, presetValue } from './Direction';
import { CandidateTray, CandidateButtons } from './Candidates';
import { FramesPanel } from './Frames';
import { CompareToggle, RetouchPanel, upscaledOf } from './Retouch';
import type { ShotVerify } from '../../api';
import { EpisodeSwitcher, ModelSettings, NotReady, SaveBadge, Section, hasModel, runningCount, type WS } from './shared';
import { asset } from '../../platform';
import MyMedia from './MyMedia';
import { VerifyBadge, verifyOf } from './DramaParts';
import NumberInput from '../../NumberInput';

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
  const [selId, setSelId] = useState(ws.focus && e.shots.some((s) => s.id === ws.focus) ? ws.focus : e.shots[0]?.id || '');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const index = Math.max(0, e.shots.findIndex((s) => s.id === selId));
  const shot = e.shots[index];
  const jobs = data.jobs;
  // AI 조수가 '지금 보는 컷'을 알 수 있게 알려 줍니다.
  const setFocus = ws.setFocus;
  useEffect(() => {
    setFocus(shot?.id || '');
    return () => setFocus('');
  }, [shot?.id, setFocus]);
  const lines = e.shots.filter((s) => s.dialogue.trim());
  const counts = {
    image: e.shots.filter((s) => s.image).length,
    audio: lines.filter((s) => s.audio).length,
    video: e.shots.filter((s) => s.video).length,
    lipsync: e.shots.filter((s) => s.lipsync).length,
    sfx: e.shots.filter((s) => s.sfx).length,
  };
  // 서버 일괄 작업과 같은 기준: 화면 묘사가 빈 컷은 이미지·영상을 만들지 않아요.
  const imageable = e.shots.filter((s) => !s.image && s.visual.trim()).length;
  const videoable = e.shots.filter((s) => !s.video && s.visual.trim()).length;
  const syncable = e.shots.filter((s) => s.video && s.audio && !s.lipsync).length;
  const sfxable = e.shots.filter((s) => s.sfx_prompt?.trim() && !s.sfx).length;
  const unverified = e.shots.filter((s) => s.image && !verifyOf(s)).length;
  const videoUnchecked = e.shots.filter((s) => (s.lipsync || s.video) && !String(s.video_verify || '').includes(`"video":"${s.lipsync || s.video}"`)).length;
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
        <button className="secondary compact" disabled={!imageable || running('shot_image') > 0} title={e.shots.length - counts.image > imageable ? '화면 묘사가 빈 컷은 빼고 만들어요' : ''} onClick={() => batch('빈 컷 이미지 모두', 'batch_shot_image', 'image')}>
          <ImageIcon size={13} /> 빈 이미지 {imageable}
          {running('shot_image') ? ` · 진행 ${running('shot_image')}` : ''}
        </button>
        <button className="secondary compact" disabled={counts.audio === lines.length || running('shot_tts') > 0} onClick={() => batch('대사 음성 모두', 'batch_shot_tts', 'tts')}>
          <Mic size={13} /> 빈 음성 {lines.length - counts.audio}
          {running('shot_tts') ? ` · 진행 ${running('shot_tts')}` : ''}
        </button>
        <button className="secondary compact" disabled={!videoable || running('shot_video') > 0} onClick={() => batch('빈 컷 영상 모두', 'batch_shot_video', 'video')}>
          <Film size={13} /> 빈 영상 {videoable}
          {running('shot_video') ? ` · 진행 ${running('shot_video')}` : ''}
        </button>
        <button
          className="secondary compact"
          title="이미지가 있는 컷을 AI가 한 번에 검수해요(라마 소액)"
          disabled={!unverified || running('verify_shot') > 0}
          onClick={() => ws.run(`${e.number}화 AI 검수 ${unverified}컷`, 'batch_verify_shot', 'text', { targetId: e.id })}
        >
          <ShieldCheck size={13} /> AI 검수 {unverified}
          {running('verify_shot') ? ` · 진행 ${running('verify_shot')}` : ''}
        </button>
        <button
          className="secondary compact"
          title="영상이 있는 컷을 AI가 한 번에 검수해요(라마 소액)"
          disabled={!videoUnchecked || running('verify_video') > 0}
          onClick={() => ws.run(`${e.number}화 영상 AI 검수 ${videoUnchecked}컷`, 'batch_verify_video', 'text', { targetId: e.id })}
        >
          <ShieldCheck size={13} /> 영상 검수 {videoUnchecked}
          {running('verify_video') ? ` · 진행 ${running('verify_video')}` : ''}
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
      <div className="ws-board-tools">
        <button type="button" className={'chip' + (picking ? ' active' : '')} aria-pressed={picking} onClick={() => (setPicking(!picking), setPicked([]))}>
          <CheckSquare size={12} /> {picking ? '여러 컷 고르기 끝' : '여러 컷 고르기'}
        </button>
        <small className="muted">{picking ? '컷을 눌러 고르세요.' : 'PC에서는 컷을 끌어 순서를 바꿀 수 있어요.'}</small>
      </div>
      <Timeline
        e={e}
        selected={shot?.id || ''}
        select={(id) => (picking ? setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]) : setSelId(id))}
        jobs={jobs}
        assets={data.assets}
        picked={picking ? picked : null}
        reorder={(ids) => void ws.act(() => api(`/studio/ai/projects/${data.project.id}/episodes/${e.id}/shots/order`, 'POST', { ids }), '컷 순서를 바꿨어요.')}
        resize={ws.can(['script', 'scene']) ? (id, seconds) => void ws.act(() => api(`/studio/ai/shots/${id}`, 'PATCH', { seconds }), `컷 길이를 ${seconds}초로 바꿨어요.`) : undefined}
      />
      {picking && picked.length > 0 && <BulkBar ws={ws} e={e} picked={picked} clear={() => setPicked([])} />}
      {shot && (
        <ShotDetail
          key={shot.id}
          ws={ws}
          s={shot}
          index={index}
          total={e.shots.length}
          next={e.shots[index + 1]}
          prev={index > 0 ? e.shots[index - 1] : undefined}
          go={(d) => setSelId(e.shots[Math.min(e.shots.length - 1, Math.max(0, index + d))].id)}
        />
      )}
    </section>
  );
}

const MEDIA_KINDS = ['shot_image', 'shot_image_edit', 'shot_tts', 'shot_video', 'shot_lipsync', 'shot_sfx', 'shot_upscale', 'shot_upscale_video'];
// 타임라인: 컷 길이에 비례한 칸으로 한 회차를 한눈에 보여 줘요.
function Timeline({
  e,
  selected,
  select,
  jobs,
  assets,
  picked,
  reorder,
  resize,
}: {
  e: StudioEpisode;
  selected: string;
  select: (id: string) => void;
  jobs: WS['data']['jobs'];
  assets: WS['data']['assets'];
  picked: string[] | null;
  reorder: (ids: string[]) => void;
  resize?: (id: string, seconds: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState('');
  const [over, setOver] = useState('');
  // 컷 오른쪽 끝을 끌어 길이 바꾸기(2~10초). 끄는 동안 바뀐 초를 보여 주고, 놓으면 저장해요.
  const [sizing, setSizing] = useState<{ id: string; seconds: number } | null>(null);
  const startResize = (ev: React.PointerEvent, id: string, seconds: number) => {
    if (!resize) return;
    ev.preventDefault();
    ev.stopPropagation();
    const clip = (ev.currentTarget as HTMLElement).parentElement;
    const perSec = Math.max(12, (clip?.getBoundingClientRect().width || 64) / Math.max(1, seconds));
    const x0 = ev.clientX;
    let cur = seconds;
    setSizing({ id, seconds });
    const move = (m: PointerEvent) => {
      cur = Math.min(10, Math.max(2, Math.round(seconds + (m.clientX - x0) / perSec)));
      setSizing({ id, seconds: cur });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setSizing(null);
      if (cur !== seconds) resize(id, cur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const ids = e.shots.map((s) => s.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    reorder(ids);
  };
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  const total = e.shots.reduce((n, s) => n + Number(s.seconds), 0);
  return (
    <div className="ws-timeline" ref={ref} role="listbox" aria-label="컷 타임라인">
      {e.shots.map((s, i) => {
        const busy = jobs.some((j) => j.target_id === s.id && (j.status === 'queued' || j.status === 'running'));
        // 실패 표시는 이 컷의 결과물을 만드는 작업(이미지·음성·영상·입 모양·효과음)의 마지막 결과만 봐요.
        const failed = jobs.find((j) => j.target_id === s.id && MEDIA_KINDS.includes(j.kind))?.status === 'failed';
        const cands = assets.some((a) => a.target_id === s.id && a.batch);
        const secs = sizing?.id === s.id ? sizing.seconds : Number(s.seconds);
        return (
          <button
            key={s.id}
            role="option"
            aria-selected={picked ? picked.includes(s.id) : selected === s.id}
            className={
              'ws-clip' +
              ((picked ? picked.includes(s.id) : selected === s.id) ? ' active' : '') +
              (busy ? ' busy' : '') +
              (failed ? ' failed' : '') +
              (drag === s.id ? ' dragging' : '') +
              (over === s.id && drag && drag !== s.id ? ' drop-here' : '')
            }
            style={{ flexGrow: secs, minWidth: Math.max(64, (secs / Math.max(1, total)) * 900) }}
            onClick={() => select(s.id)}
            draggable={!picked && !sizing}
            onDragStart={(ev) => {
              setDrag(s.id);
              ev.dataTransfer.effectAllowed = 'move';
              ev.dataTransfer.setData('text/plain', s.id);
            }}
            onDragOver={(ev) => {
              if (!drag) return;
              ev.preventDefault();
              setOver(s.id);
            }}
            onDragLeave={() => setOver((o) => (o === s.id ? '' : o))}
            onDrop={(ev) => {
              ev.preventDefault();
              drop(s.id);
              setDrag('');
              setOver('');
            }}
            onDragEnd={() => {
              setDrag('');
              setOver('');
            }}
          >
            {picked && <i className={'ws-clip-pick' + (picked.includes(s.id) ? ' on' : '')} aria-hidden="true">{picked.includes(s.id) ? picked.indexOf(s.id) + 1 : ''}</i>}
            {s.image ? <img src={asset(s.image)} alt="" loading="lazy" /> : <span className="ws-clip-empty">이미지 없음</span>}
            <b>
              {i + 1} · {secs}초
            </b>
            {cands && <i className="ws-clip-cands" title="후보가 있어요" aria-label="후보 있음" />}
            {resize && !picked && (
              <span className="ws-clip-resize" role="presentation" title="끌어서 길이 바꾸기(2~10초)" onPointerDown={(ev) => startResize(ev, s.id, Number(s.seconds))} onClick={(ev) => ev.stopPropagation()} />
            )}
            <span className="ws-clip-flags">
              {s.video && <Film size={10} aria-label="영상" />}
              {s.audio && <Mic size={10} aria-label="음성" />}
              {s.lipsync && <Sparkles size={10} aria-label="입 모양" />}
              {s.sfx && <Volume2 size={10} aria-label="효과음" />}
              {verifyOf(s) && (verifyOf(s)!.ok ? <ShieldCheck size={10} aria-label="검수 통과" /> : <i className="clip-bad" aria-label="검수 문제" />)}
            </span>
            {i > 0 && s.transition && s.transition !== 'cut' && <i className="ws-clip-transition" title={TRANSITIONS.find((t) => t.id === s.transition)?.name} />}
          </button>
        );
      })}
    </div>
  );
}

function ShotDetail({ ws, s, index, total, next, prev, go }: { ws: WS; s: StudioShot; index: number; total: number; next?: StudioShot; prev?: StudioShot; go: (d: number) => void }) {
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
    prop_ids: String(s.prop_ids || '').split(',').filter(Boolean),
    states: parseJson<Record<string, string>>(s.states, {}),
    angle: s.angle || '',
    lens: s.lens || '',
    move_strength: s.move_strength || '',
    end_image: s.end_image || '',
    effect: s.effect || '',
    light: s.light || '',
    tone: s.tone || '',
    height: s.height || '',
    dof: s.dof || '',
    focal: Number(s.focal || 0),
  };
  const [f, setF] = useSyncedForm(server);
  // 협업: 다른 팀원이 먼저 고친 경우(409) — 최신 내용으로 바꾸거나 내 변경으로 덮어쓸 수 있게 알려요.
  const [conflict, setConflict] = useState(false);
  const after = useRef<'' | 'reset' | 'overwrite'>('');
  const save = useAutosave(
    f,
    server,
    async (v, base) => {
      const r = await api<{ audioReset: boolean }>(`/studio/ai/shots/${s.id}`, 'PATCH', { ...changedFields(v, base), base_updated_at: s.updated_at ?? null }).catch((e) => {
        if (e instanceof ApiError && e.code === 'edit_conflict') setConflict(true);
        // 고른 끝 장면 이미지를 쓸 수 없다는 오류일 때만 그 값을 되돌려 다른 수정은 계속 저장되게 해요.
        else if (v.end_image !== (s.end_image || '') && /이미지만 고를 수/.test((e as Error).message)) {
          setF((cur) => ({ ...cur, end_image: s.end_image || '' }));
          ws.notify('고른 끝 장면 이미지를 쓸 수 없어 되돌렸어요. 이 프로젝트에서 만든 이미지를 골라 주세요.');
        }
        throw e;
      });
      setConflict(false);
      if (r.audioReset && (s.audio || s.lipsync)) ws.notify(`${index + 1}번 컷 대사 · 목소리 설정이 바뀌어 음성을 다시 만들어야 해요.`);
      void ws.load();
    },
    { delay: 1200, enabled: f.seconds >= 2 && f.seconds <= 10 },
  );
  // 최신 내용을 불러온 뒤(수정 시각이 바뀐 뒤) 고른 처리를 이어서 해요.
  const serverRef = useRef(server);
  serverRef.current = server;
  useEffect(() => {
    if (!after.current) return;
    const mode = after.current;
    after.current = '';
    setConflict(false);
    if (mode === 'reset') setF(serverRef.current);
    else void save.flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.updated_at]);
  const resolve = (mode: 'reset' | 'overwrite') => {
    after.current = mode;
    void ws.load();
  };
  const [fixIssues, setFixIssues] = useState<ShotVerify['issues'] | null>(null);
  const [pro, setPro] = useShotMode();
  const player = useRef<HTMLVideoElement>(null);
  // 영상에서 장면 뽑기(무료): 미리보기 영상을 멈춘 순간을 이 컷 이미지 또는 다음 컷 시작 이미지로
  const grab = (to: 'self' | 'next') => {
    const at = Math.max(0, player.current?.currentTime || 0);
    void ws.act(
      () => api(`/studio/ai/shots/${s.id}/frame`, 'POST', { at, to }),
      to === 'self' ? `영상 ${at.toFixed(1)}초 장면을 이 컷 이미지로 바꿨어요. 이전 이미지는 버전 기록에 있어요.` : `영상 ${at.toFixed(1)}초 장면을 다음 컷의 시작 이미지로 넣었어요.`,
    );
  };
  const up = upscaledOf(s);
  // 앞 컷들에서 이어지는 인물 상태(이 컷에 적지 않으면 이 모습으로 그려요)
  const inherited = useMemo(() => {
    const ep = data.episodes.find((e) => e.id === s.episode_id);
    const out: Record<string, string> = {};
    for (const x of ep?.shots || []) {
      if (x.id === s.id) break;
      for (const [cid, v] of Object.entries(parseJson<Record<string, string>>(x.states, {}))) out[cid] = /^(기본|원래대로)$/.test(String(v).trim()) ? '' : String(v).trim();
    }
    return out;
  }, [data.episodes, s.episode_id, s.id]);
  // AI 작업 전에는 입력 중인 변경을 먼저 저장합니다(최신 내용으로 만들도록). 저장하지 못하면 이유를 알려요.
  const run = async (label: string, action: string, cap: 'text' | 'image' | 'tts' | 'video' | 'lipsync' | 'sfx' | 'upscale' | 'upscale_video', opts: { instruction?: string; options?: Record<string, unknown>; tier?: 'premium' } = {}) => {
    if (!(await save.flush()) && save.dirty) {
      ws.notify(save.blocked ? '길이를 2~10초로 적은 뒤 다시 눌러 주세요.' : `고친 내용을 저장하지 못해 실행하지 않았어요.${save.error ? ' ' + save.error : ''}`);
      return;
    }
    ws.run(`${index + 1}번 컷 ${label}`, action, cap, { targetId: s.id, ...opts });
  };
  // 역할별 읽기 전용: 대본 권한이 없으면 대사·화자는 잠그고, 장면 권한도 없으면 모든 칸을 잠가요(서버도 한 번 더 확인).
  const canEdit = ws.can(['script', 'scene']);
  const canScript = ws.can('script');
  const lockNote = !canEdit ? `${data.team?.role_name || ''} 역할은 보기만 할 수 있어요.` : !canScript ? '대사 · 화자는 작가 권한이 있어야 고칠 수 있어요.' : '';
  const speaker = data.characters.find((c) => c.id === f.speaker_id);
  const media = s.lipsync || s.video;
  const v = verifyOf(s);
  const noVisual = !f.visual.trim();
  const castNames = f.cast_ids.map((id) => data.characters.find((c) => c.id === id)?.name).filter(Boolean);
  const place = (data.locations || []).find((l) => l.id === f.location_id)?.name;
  const propNames = f.prop_ids.map((id) => (data.props || []).find((x) => x.id === id)?.name).filter(Boolean);
  const moveLabel = [f.camera, f.camera_move, f.angle].filter(Boolean).join(' · ');
  const linkLabel = [f.end_image || f.end_frame ? '끝 장면 지정' : '', index > 0 && f.transition !== 'cut' ? TRANSITIONS.find((t) => t.id === f.transition)?.name : '', f.effect ? EFFECTS.find((x) => x.id === f.effect)?.name : ''].filter(Boolean).join(' · ');
  const voiceLabel = [f.emotion || '', f.speed !== 1 ? `${f.speed.toFixed(1)}배` : '', f.sfx_prompt ? `효과음: ${f.sfx_prompt}` : ''].filter(Boolean).join(' · ');
  const imageLabel = [v ? `검수 ${v.ok ? '✓' : '문제'} ${Math.round(v.score)}` : '', up.image ? '화질 ✓' : '', f.seed_lock ? '시드 고정' : ''].filter(Boolean).join(' · ');
  // 5단계: 지금 영상을 검수한 결과(영상이 바뀌면 지난 결과는 쓰지 않아요)
  const videoCheck = (() => {
    const x = parseJson<{ ok: boolean; score: number; issues: { code: string; text: string; frame?: number }[]; summary?: string; video?: string } | null>(s.video_verify, null);
    return x && x.video === media ? x : null;
  })();
  const videoLabel = [s.lipsync ? '입 모양 ✓' : '', up.video ? '화질 ✓' : '', videoCheck ? (videoCheck.ok ? `검수 ✓ ${videoCheck.score}` : '검수 문제') : ''].filter(Boolean).join(' · ');
  // 주 버튼 3개: 이미지 · 음성 · 영상(PC는 미리보기 아래, 휴대폰은 컷 이동과 함께 위에 붙어 있어요)
  const primary = (
    <>
            <button className={s.image ? 'secondary' : 'primary'} disabled={isBusy(jobs, s.id, 'shot_image') || noVisual} title={noVisual ? '화면 묘사를 먼저 적어 주세요' : ''} onClick={() => void run('이미지', 'shot_image', 'image')}>
              <ImageIcon size={14} /> {s.image ? '이미지 다시' : '이미지'}
            </button>
            <button className={s.image && !s.audio && f.dialogue.trim() ? 'primary' : 'secondary'} disabled={!f.dialogue.trim() || isBusy(jobs, s.id, 'shot_tts')} title={!f.dialogue.trim() ? '대사가 있는 컷만 음성을 만들어요' : ''} onClick={() => void run('대사 음성', 'shot_tts', 'tts')}>
              <Mic size={14} /> {s.audio ? '음성 다시' : '음성'}
            </button>
            <button className={s.image && !s.video ? 'primary' : 'secondary'} disabled={isBusy(jobs, s.id, 'shot_video') || noVisual} title={noVisual ? '화면 묘사를 먼저 적어 주세요' : ''} onClick={() => void run(`영상 (${f.seconds}초)`, 'shot_video', 'video')}>
              <Film size={14} /> {s.video ? '영상 다시' : '영상'}
            </button>
          </>
  );
  return (
    <div className="ws-detail">
      <div className="ws-detail-top">
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
        <div className="shot-mode" role="radiogroup" aria-label="화면 모드">
          <button type="button" role="radio" aria-checked={!pro} className={!pro ? 'on' : ''} onClick={() => setPro(false)} title="자주 쓰는 것만 보여요">
            간단
          </button>
          <button type="button" role="radio" aria-checked={pro} className={pro ? 'on' : ''} onClick={() => setPro(true)} title="연출 · 컷 잇기 · 영상 고급까지 모두 보여요">
            전문
          </button>
        </div>
        {pro && (
          <button
            type="button"
            className="secondary compact"
            title="이 컷 뒤에 2~3초짜리 연결 컷(소품 클로즈업 · 장소 전경 · 표정)을 AI가 넣어요"
            disabled={isBusy(jobs, s.id, 'bridge_shot') || total >= 40}
            onClick={() => void run('뒤에 사이 컷 넣기', 'bridge_shot', 'text')}
          >
            <Plus size={13} /> 사이 컷
          </button>
        )}
        <JobBadge jobs={jobs} targetId={s.id} kind="bridge_shot" />
        {!!data.team?.members.length && (
          <button type="button" className="secondary compact" onClick={() => ws.comment({ type: 'shot', id: s.id, label: `${data.episodes.find((e) => e.id === s.episode_id)?.number ?? ''}화 ${index + 1}번 컷` })}>
            <MessageSquare size={13} /> 의견
          </button>
        )}
        <SaveBadge state={save.state} error={save.error} hint={save.blocked ? '길이를 2~10초로 적으면 저장돼요' : undefined} />
      </div>
      <div className="shot-primary mob">{primary}</div>
      </div>
      {conflict && (
        <div className="ws-conflict" role="alert">
          <span>다른 팀원이 이 컷을 먼저 고쳤어요. 어떻게 할까요?</span>
          <button type="button" className="secondary compact" onClick={() => resolve('reset')}>
            최신 내용 불러오기(내 변경 버림)
          </button>
          <button type="button" className="secondary compact" onClick={() => resolve('overwrite')}>
            내 변경으로 덮어쓰기
          </button>
        </div>
      )}
      <div className="shot-status" aria-label="이 컷 상태">
        <span className={s.image ? 'ok' : ''}>이미지 {s.image ? (v ? (v.ok ? `✓ ${Math.round(v.score)}` : '⚠') : '✓') : '—'}</span>
        {f.dialogue.trim() && <span className={s.audio ? 'ok' : ''}>음성 {s.audio ? '✓' : '—'}</span>}
        <span className={s.video ? 'ok' : ''}>영상 {s.video ? (s.lipsync ? '✓ 입 모양' : '✓') : '—'}</span>
        {s.sfx && <span className="ok">효과음 ✓</span>}
      </div>
      <div className="ws-detail-grid">
        <div className="ws-detail-media">
          <div className="ws-frame">
            {media ? (
              <video ref={player} key={media} controls preload="none" playsInline poster={asset(s.image) || undefined} src={studioMedia(media)} />
            ) : s.image ? (
              <img src={asset(s.image)} alt={`${index + 1}번 컷`} />
            ) : (
              <span>이미지 없음</span>
            )}
            {s.lipsync && <em className="ws-frame-tag">입 모양 맞춤</em>}
          </div>
          <div className="shot-primary desk">{primary}</div>
          <div className="shot-jobs">
            <JobBadge jobs={jobs} targetId={s.id} kind="shot_image" onRetry={() => void run('이미지', 'shot_image', 'image')} />
            <JobBadge jobs={jobs} targetId={s.id} kind="shot_tts" onRetry={() => void run('대사 음성', 'shot_tts', 'tts')} />
            <JobBadge jobs={jobs} targetId={s.id} kind="shot_video" onRetry={() => void run(`영상 (${f.seconds}초)`, 'shot_video', 'video')} />
          </div>
          <CandidateTray ws={ws} s={s} onVerify={() => void run('후보 AI 검수', 'verify_candidates', 'text')} />
          <Fold id="image" title="이미지 다듬기" summary={imageLabel || '후보 · 고급 · 검수 · 보정 · 화질'} icon={<Wand2 size={13} />} autoOpen={!!v && !v.ok}>
            <div className="ws-tools">
              {s.image && ws.choices.image.tier !== 'premium' && (
                <button className="secondary compact upgrade" title="마음에 드는 컷만 고급 품질로 다시 만들어요" disabled={isBusy(jobs, s.id, 'shot_image') || noVisual} onClick={() => void run('이미지 고급으로 다시', 'shot_image', 'image', { tier: 'premium' })}>
                  <Sparkles size={13} /> 고급으로 다시
                </button>
              )}
              <CandidateButtons kind="image" disabled={isBusy(jobs, s.id, 'shot_image') || noVisual} onRun={(n) => void run(`이미지 후보 ${n}장`, 'shot_image', 'image', { options: { count: n } })} />
              <Versions assets={data.assets} targetId={s.id} kind="image" current={s.image} onUse={ws.useAsset} />
              <CompareToggle ws={ws} s={s} />
            </div>
            {s.image && (
              <div className="ws-tools">
                <button className="secondary compact" title="얼굴 · 인물 수 · 글자 · 손 모양 · 구도를 AI가 확인해요(라마 소액)" disabled={isBusy(jobs, s.id, 'verify_shot') || !!v} onClick={() => void run('AI 검수', 'verify_shot', 'text')}>
                  <ShieldCheck size={13} /> AI 검수
                </button>
                <JobBadge jobs={jobs} targetId={s.id} kind="verify_shot" />
                <VerifyBadge s={s} onRedo={() => void run('이미지 다시', 'shot_image', 'image')} onFix={(issues) => setFixIssues(issues)} />
              </div>
            )}
            {s.image && hasModel(ws.models, 'upscale') && (
              <div className="ws-tools">
                {up.image ? (
                  <span className="verify-badge ok">화질 올림 ✓</span>
                ) : (
                  <button className="secondary compact" title="이 컷 이미지를 2배 선명하게 키워요(라마 차감)" disabled={isBusy(jobs, s.id, 'shot_upscale')} onClick={() => void run('이미지 화질 올리기', 'shot_upscale', 'upscale')}>
                    <Sparkles size={13} /> 이미지 화질 올리기
                  </button>
                )}
                <JobBadge jobs={jobs} targetId={s.id} kind="shot_upscale" />
              </div>
            )}
            <RetouchPanel ws={ws} s={s} run={(label, action, cap, opts) => run(label, action, cap, opts)} preset={fixIssues} clearPreset={() => setFixIssues(null)} />
            <label className="inline-check" title="같은 컷을 다시 만들 때 구도와 느낌이 크게 바뀌지 않게 해요">
              <input type="checkbox" checked={f.seed_lock} disabled={!canEdit} onChange={(ev) => setF({ ...f, seed_lock: ev.target.checked })} />
              <Lock size={12} /> 다시 만들어도 비슷한 그림 유지(시드 고정)
            </label>
          </Fold>
          {pro && (
            <Fold id="video" title="영상 고급" summary={videoLabel || '고급 · 후보 · 버전 · 입 모양 · 화질'} icon={<Film size={13} />}>
              <div className="ws-tools">
                {s.video && ws.choices.video.tier !== 'premium' && (
                  <button className="secondary compact upgrade" title="이 컷만 고급 품질 영상으로 다시 만들어요" disabled={isBusy(jobs, s.id, 'shot_video') || noVisual} onClick={() => void run(`영상 고급으로 다시 (${f.seconds}초)`, 'shot_video', 'video', { tier: 'premium' })}>
                    <Sparkles size={13} /> 고급으로 다시
                  </button>
                )}
                <CandidateButtons kind="video" disabled={isBusy(jobs, s.id, 'shot_video') || noVisual} onRun={(n) => void run(`영상 후보 ${n}개 (${f.seconds}초씩)`, 'shot_video', 'video', { options: { count: n } })} />
                <Versions assets={data.assets} targetId={s.id} kind="video" current={s.video} onUse={ws.useAsset} />
              </div>
              {media && (
                <div className="ws-tools">
                  <button
                    className="secondary compact"
                    title="영상의 처음 · 가운데 · 끝 장면을 AI가 보고 얼굴 · 옷 바뀜, 뭉개짐, 입 모양, 앞 컷과의 이어짐을 확인해요(라마 소액)"
                    disabled={isBusy(jobs, s.id, 'verify_video') || !!videoCheck}
                    onClick={() => void run('영상 AI 검수', 'verify_video', 'text')}
                  >
                    <ShieldCheck size={13} /> 영상 AI 검수
                  </button>
                  <JobBadge jobs={jobs} targetId={s.id} kind="verify_video" />
                  {videoCheck && (
                    <span className={'verify-badge ' + (videoCheck.ok ? 'ok' : 'bad')} title={videoCheck.summary || ''}>
                      {videoCheck.ok ? `영상 검수 ✓ ${videoCheck.score}` : `영상 문제: ${videoCheck.issues.map((x) => x.text).join(' · ')}`}
                    </span>
                  )}
                  {videoCheck && !videoCheck.ok && (
                    <button
                      className="secondary compact"
                      onClick={() =>
                        videoCheck.issues.some((x) => x.code === 'lipsync') && s.audio && hasModel(ws.models, 'lipsync')
                          ? void run('입 모양 맞추기', 'shot_lipsync', 'lipsync')
                          : videoCheck.issues.some((x) => ['drift', 'outfit', 'face'].includes(x.code))
                            ? void run(`움직임만 입혀 다시 (${f.seconds}초)`, 'shot_video', 'video', { options: { motionOnly: true } })
                            : void run(`영상 다시 (${f.seconds}초)`, 'shot_video', 'video')
                      }
                    >
                      <Wand2 size={13} /> 추천대로 다시
                    </button>
                  )}
                </div>
              )}
              <div className="ws-tools">
                <button
                  className="secondary compact"
                  title="지금 컷 이미지의 구도 · 얼굴 · 배경은 그대로 두고 숨 · 눈 깜빡임 · 머리카락만 살짝 움직여요"
                  disabled={!s.image || isBusy(jobs, s.id, 'shot_video')}
                  onClick={() => void run(`움직임만 입히기 (${f.seconds}초)`, 'shot_video', 'video', { options: { motionOnly: true } })}
                >
                  <Wand2 size={13} /> 움직임만 입히기(구도 그대로)
                </button>
              </div>
              {media && (
                <div className="ws-tools" aria-label="영상에서 장면 뽑기">
                  <small className="muted">미리보기 영상을 원하는 순간에 멈추고:</small>
                  <button className="secondary compact" disabled={!canEdit || ws.busy} onClick={() => grab('self')} title="멈춘 순간의 장면을 이 컷 이미지로 써요(무료)">
                    <ImageIcon size={13} /> 이 장면을 컷 이미지로
                  </button>
                  {next && (
                    <button className="secondary compact" disabled={!canEdit || ws.busy} onClick={() => grab('next')} title="멈춘 순간의 장면을 다음 컷의 시작 이미지로 써요(무료)">
                      <ChevronRight size={13} /> 다음 컷 시작으로
                    </button>
                  )}
                </div>
              )}
              {hasModel(ws.models, 'lipsync') ? (
                <div className="ws-tools">
                  <button className="secondary compact" disabled={!s.video || !s.audio || isBusy(jobs, s.id, 'shot_lipsync')} title={!s.video || !s.audio ? '영상과 대사 음성이 모두 있어야 해요' : ''} onClick={() => void run('입 모양 맞추기', 'shot_lipsync', 'lipsync')}>
                    <Sparkles size={13} /> {s.lipsync ? '입 모양 다시' : '입 모양 맞추기'}
                  </button>
                  <JobBadge jobs={jobs} targetId={s.id} kind="shot_lipsync" />
                </div>
              ) : (
                s.dialogue && <NotReady what="입 모양 맞추기" />
              )}
              {(s.video || s.lipsync) && hasModel(ws.models, 'upscale_video') && (
                <div className="ws-tools">
                  {up.video ? (
                    <span className="verify-badge ok">영상 화질 올림 ✓</span>
                  ) : (
                    <button
                      className="secondary compact"
                      title={`${s.lipsync ? '입 모양 맞춘 영상' : '컷 영상'}을 더 선명하게 키워요(라마 차감). 1080p로 합성할 때 효과가 커요.`}
                      disabled={isBusy(jobs, s.id, 'shot_upscale_video')}
                      onClick={() => void run('영상 화질 올리기', 'shot_upscale_video', 'upscale_video')}
                    >
                      <Sparkles size={13} /> 영상 화질 올리기
                    </button>
                  )}
                  <JobBadge jobs={jobs} targetId={s.id} kind="shot_upscale_video" />
                </div>
              )}
            </Fold>
          )}
          <Fold id="mymedia" title="내 소재로 채우기" summary="직접 찍은 사진 · 영상 · 녹음 올리기" icon={<Upload size={13} />}>
            <MyMedia ws={ws} s={s} index={index} />
          </Fold>
        </div>
        <fieldset className="ws-detail-fields" disabled={!canEdit}>
          {lockNote && <small className="ws-lock-note">{lockNote}</small>}
          <label>
            화면 묘사
            <textarea rows={3} maxLength={800} value={f.visual} placeholder="예: 비 오는 골목, 우산을 든 지우가 뒤돌아본다" onChange={(ev) => setF({ ...f, visual: ev.target.value })} />
          </label>
          <div className="ws-dialogue">
            <select aria-label="말하는 인물" disabled={!canScript} value={f.narration ? '__narr' : f.speaker_id || ''} onChange={(ev) => setF({ ...f, narration: ev.target.value === '__narr', speaker_id: ev.target.value && ev.target.value !== '__narr' ? ev.target.value : null })}>
              <option value="">(대사 없음)</option>
              {data.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="__narr">내레이션</option>
            </select>
            <input aria-label="대사" disabled={!canScript} value={f.dialogue} maxLength={300} placeholder="대사(없으면 비워 두세요)" onChange={(ev) => setF({ ...f, dialogue: ev.target.value })} />
          </div>
          <label className="ws-seconds-field">
            길이(초)
            <NumberInput
              min={2}
              max={10}
              value={f.seconds || ''}
              onChange={(ev) => setF({ ...f, seconds: Math.round(Number(ev.target.value)) })}
              onBlur={() => f.seconds && setF({ ...f, seconds: Math.min(10, Math.max(2, f.seconds)) })}
            />
          </label>
          {pro ? (
            <>
            <Fold id="direction" title="연출 · 카메라" summary={moveLabel || '샷 크기 · 움직임 · 앵글 · 화면 느낌'} icon={<Film size={13} />}>
              <DirectionPanel ws={ws} s={s} disabled={!canEdit} value={{ camera: f.camera, camera_move: f.camera_move, angle: f.angle, lens: f.lens, move_strength: f.move_strength, light: f.light, tone: f.tone }} set={(x) => setF({ ...f, ...x })} />
            </Fold>
            <Fold id="light" title="조명 · 시간과 색감" summary={[f.light, f.tone, f.height, f.focal ? `${f.focal}mm` : '', f.dof ? `f/${f.dof}` : ''].filter(Boolean).join(' · ') || '빛의 방향 · 시간대 · 색감 · 렌즈 숫자'} icon={<Sparkles size={13} />} autoOpen={!!(f.light || f.tone)}>
              <LightPanel disabled={!canEdit} value={{ light: f.light, tone: f.tone, height: f.height, dof: f.dof, focal: f.focal }} set={(x) => setF({ ...f, ...x })} />
            </Fold>
            </>
          ) : (
            <>
            <div className="ws-field">
              <span>
                연출 <small className="muted">{moveLabel || '자동'} · 자세히 고르려면 ‘전문’</small>
              </span>
              <PresetSelect disabled={!canEdit} onPick={(p) => setF({ ...f, ...presetValue(p) })} />
            </div>
            <Fold id="light-simple" title="조명 · 색감" summary={[f.light, f.tone].filter(Boolean).join(' · ') || '자동'} icon={<Sparkles size={13} />}>
              <LightPanel pro={false} disabled={!canEdit} value={{ light: f.light, tone: f.tone, height: f.height, dof: f.dof, focal: f.focal }} set={(x) => setF({ ...f, ...x })} />
            </Fold>
            </>
          )}
          <Fold id="cast" title="인물 · 장소 · 소품" summary={[castNames.join(', '), place, propNames.join(', ')].filter(Boolean).join(' · ') || '누가 · 어디서 · 무엇을'} icon={<Sparkles size={13} />} autoOpen={f.cast_ids.length > 0}>
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
            {f.cast_ids.length > 0 && (
              <div className="ws-field">
                <span>
                  인물 상태 <small className="muted">이 컷부터 달라지는 모습(비워 두면 앞 컷 모습을 이어 가요 · ‘기본’은 원래 모습)</small>
                </span>
                <div className="state-list">
                  {f.cast_ids.map((cid) => {
                    const c = data.characters.find((x) => x.id === cid);
                    if (!c) return null;
                    return (
                      <label key={cid} className="state-row">
                        <b>{c.name}</b>
                        <input value={f.states[cid] || ''} maxLength={120} placeholder={inherited[cid] ? `앞 컷에서 이어짐: ${inherited[cid]}` : '평소 모습'} onChange={(ev) => setF({ ...f, states: { ...f.states, [cid]: ev.target.value } })} />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
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
            {(data.props || []).length > 0 && (
              <div className="ws-field">
                <span>소품</span>
                <div className="chip-row">
                  {(data.props || []).map((x) => {
                    const on = f.prop_ids.includes(x.id);
                    return (
                      <button
                        type="button"
                        key={x.id}
                        className={'chip' + (on ? ' active' : '')}
                        aria-pressed={on}
                        onClick={() => (on ? setF({ ...f, prop_ids: f.prop_ids.filter((y) => y !== x.id) }) : f.prop_ids.length >= 6 ? ws.notify('소품은 컷마다 6개까지 고를 수 있어요.') : setF({ ...f, prop_ids: [...f.prop_ids, x.id] }))}
                      >
                        {x.image && <img src={asset(x.image)} alt="" />}
                        {x.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Fold>
          <Fold id="voice" title="목소리 · 소리" summary={voiceLabel || '감정 · 말 빠르기 · 자막 · 효과음'} icon={<Volume2 size={13} />} autoOpen={!!s.sfx || !!f.sfx_prompt}>
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
              <Versions assets={data.assets} targetId={s.id} kind="audio" current={s.audio} onUse={ws.useAsset} />
            </div>
            {s.audio && <audio key={s.audio} controls preload="none" src={studioMedia(s.audio)} />}
            <label className="inline-check">
              <input type="checkbox" checked={f.caption !== null} onChange={(ev) => setF({ ...f, caption: ev.target.checked ? f.dialogue : null })} />
              자막을 대사와 다르게 쓰기
            </label>
            {f.caption !== null && <input aria-label="자막" value={f.caption} maxLength={300} placeholder="비워 두면 자막 없이 나가요" onChange={(ev) => setF({ ...f, caption: ev.target.value })} />}
            <div className="ws-field">
              <span>효과음</span>
              {hasModel(ws.models, 'sfx') ? (
                <>
                  <div className="ws-edit-image">
                    <input aria-label="효과음 설명" value={f.sfx_prompt} maxLength={200} placeholder="예: 문이 쾅 닫히는 소리" onChange={(ev) => setF({ ...f, sfx_prompt: ev.target.value })} />
                    <button type="button" className="secondary compact" disabled={!f.sfx_prompt.trim() || isBusy(jobs, s.id, 'shot_sfx')} onClick={() => void run('효과음', 'shot_sfx', 'sfx', { options: { prompt: f.sfx_prompt.trim() } })}>
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
            </div>
          </Fold>
          {pro && (
            <Fold id="link" title="컷 잇기 · 효과" summary={linkLabel || '시작 · 끝 장면 · 전환 · 효과'} icon={<Film size={13} />} autoOpen={!!(f.end_image || f.end_frame || f.effect)}>
              <FramesPanel ws={ws} s={s} prev={prev} next={next} index={index} value={{ end_frame: f.end_frame, end_image: f.end_image }} set={(x) => setF({ ...f, ...x })} />
              <EffectPicker value={f.effect} set={(x) => setF({ ...f, effect: x })} />
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
            </Fold>
          )}
          {!pro && <small className="muted ws-mode-hint">연출 카드 · 끝 장면 · 전환 · 영상 고급 도구는 ‘전문’ 모드에서 보여요.</small>}
        </fieldset>
      </div>
    </div>
  );
}

// 컷 화면 모드(간단 · 전문) — 이 브라우저에 기억해요.
function useShotMode(): [boolean, (v: boolean) => void] {
  const [pro, set] = useState(() => {
    try {
      return localStorage.getItem('sp.shotMode') === 'pro';
    } catch {
      return false;
    }
  });
  return [
    pro,
    (v: boolean) => {
      set(v);
      try {
        localStorage.setItem('sp.shotMode', v ? 'pro' : 'simple');
      } catch {}
    },
  ];
}

// 접히는 그룹: 한 줄 요약 + 내용. 열고 닫은 상태는 이 브라우저에 기억하고, 처음에는 내용이 있을 때만 펼쳐요.
function Fold({ id, title, summary, icon, autoOpen = false, children }: { id: string; title: string; summary?: string; icon?: React.ReactNode; autoOpen?: boolean; children: React.ReactNode }) {
  const key = 'sp.fold.' + id;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) return v === '1' || autoOpen;
    } catch {}
    return autoOpen;
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? '0' : '1');
      } catch {}
      return !o;
    });
  return (
    <div className={'ws-fold' + (open ? ' open' : '')}>
      {/* 보기 전용(잠긴 칸 묶음) 안에서도 펼쳐 볼 수 있도록 button 대신 역할만 버튼인 요소를 써요. */}
      <div
        role="button"
        tabIndex={0}
        className="ws-fold-head"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <ChevronDown size={14} className="ws-fold-caret" />
        {icon}
        <strong>{title}</strong>
        {summary && <small>{summary}</small>}
      </div>
      {open && <div className="ws-fold-body">{children}</div>}
    </div>
  );
}

// 여러 컷 한 번에: 다시 만들기(이미지·음성·영상) · 감정·빠르기·카메라 움직임·전환 바꾸기 · 순서 옮기기
function BulkBar({ ws, e, picked, clear }: { ws: WS; e: StudioEpisode; picked: string[]; clear: () => void }) {
  const shots = e.shots.filter((s) => picked.includes(s.id));
  const withLines = shots.filter((s) => s.dialogue.trim()).length;
  const tooMany = picked.length > 20;
  const regen = (label: string, action: string, cap: 'image' | 'tts' | 'video') => {
    if (tooMany) return ws.notify('한 번에 20컷까지 다시 만들 수 있어요. 컷을 조금 줄여 주세요.');
    ws.run(`${e.number}화 고른 ${shots.length}컷 ${label}`, action, cap, { targetId: e.id, options: { shotIds: picked } });
  };
  const patch = (body: Record<string, unknown>, what: string) =>
    void ws.act(async () => {
      const r = await api<{ changed: number; audioReset: number }>(`/studio/ai/projects/${ws.data.project.id}/episodes/${e.id}/shots/bulk`, 'PATCH', { ids: picked, ...body });
      if (r.audioReset) ws.notify(`${r.audioReset}컷은 목소리 설정이 바뀌어 음성을 다시 만들어야 해요.`);
    }, `고른 컷의 ${what}을(를) 바꿨어요.`);
  const move = (d: -1 | 1) => {
    const ids = e.shots.map((s) => s.id);
    const order = d < 0 ? [...ids] : [...ids].reverse();
    for (let i = 1; i < order.length; i++) if (picked.includes(order[i]) && !picked.includes(order[i - 1])) [order[i - 1], order[i]] = [order[i], order[i - 1]];
    void ws.act(() => api(`/studio/ai/projects/${ws.data.project.id}/episodes/${e.id}/shots/order`, 'POST', { ids: d < 0 ? order : order.reverse() }), '고른 컷을 옮겼어요.');
  };
  return (
    <div className="bulk-bar" role="toolbar" aria-label="고른 컷 한 번에">
      <b>
        {shots.length}컷 골랐어요{tooMany ? ' · 다시 만들기는 20컷까지' : ''}
      </b>
      <div className="bulk-row">
        <button type="button" className="secondary compact" onClick={() => regen('이미지 다시', 'batch_shot_image', 'image')}>
          <ImageIcon size={13} /> 이미지 다시
        </button>
        <button type="button" className="secondary compact" disabled={!withLines} onClick={() => regen('음성 다시', 'batch_shot_tts', 'tts')}>
          <Mic size={13} /> 음성 다시 {withLines ? withLines : ''}
        </button>
        <button type="button" className="secondary compact" onClick={() => regen('영상 만들기', 'batch_shot_video', 'video')}>
          <Film size={13} /> 영상
        </button>
        <button type="button" className="secondary compact" aria-label="앞으로 옮기기" disabled={ws.busy} onClick={() => move(-1)}>
          <ChevronLeft size={13} /> 앞으로
        </button>
        <button type="button" className="secondary compact" aria-label="뒤로 옮기기" disabled={ws.busy} onClick={() => move(1)}>
          뒤로 <ChevronRight size={13} />
        </button>
      </div>
      <div className="bulk-row">
        <select aria-label="감정 한 번에" value="" disabled={ws.busy} onChange={(ev) => ev.target.value && patch({ emotion: ev.target.value === '_' ? '' : ev.target.value }, '감정')}>
          <option value="">감정 바꾸기…</option>
          {EMOTIONS.map((x) => (
            <option key={x || '_'} value={x || '_'}>
              {x || '기본'}
            </option>
          ))}
        </select>
        <PresetSelect disabled={ws.busy} onPick={(x) => patch({ ...presetValue(x) }, `연출(${x.name})`)} />
        <select aria-label="조명 한 번에" value="" disabled={ws.busy} onChange={(ev) => ev.target.value && patch({ light: ev.target.value === '_' ? '' : ev.target.value }, '조명')}>
          <option value="">조명…</option>
          <option value="_">자동</option>
          {LIGHTS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id}
            </option>
          ))}
        </select>
        <select aria-label="시간 · 색감 한 번에" value="" disabled={ws.busy} onChange={(ev) => ev.target.value && patch({ tone: ev.target.value === '_' ? '' : ev.target.value }, '시간 · 색감')}>
          <option value="">시간 · 색감…</option>
          <option value="_">자동</option>
          {TONES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id}
            </option>
          ))}
        </select>
        <select aria-label="카메라 움직임 한 번에" value="" disabled={ws.busy} onChange={(ev) => ev.target.value && patch({ camera_move: ev.target.value === '_' ? '' : ev.target.value }, '카메라 움직임')}>
          <option value="">카메라 움직임…</option>
          {CAMERA_MOVES.map((x) => (
            <option key={x || '_'} value={x || '_'}>
              {x || '자동'}
            </option>
          ))}
        </select>
        <select aria-label="효과 한 번에" value="" disabled={ws.busy} onChange={(ev) => ev.target.value && patch({ effect: ev.target.value === '_' ? '' : ev.target.value }, '효과')}>
          <option value="">효과 바꾸기…</option>
          {EFFECTS.map((x) => (
            <option key={x.id || '_'} value={x.id || '_'}>
              {x.name}
            </option>
          ))}
        </select>
        <select aria-label="전환 한 번에" value="" disabled={ws.busy} onChange={(ev) => ev.target.value && patch({ transition: ev.target.value }, '전환')}>
          <option value="">전환 바꾸기…</option>
          {TRANSITIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select aria-label="말 빠르기 한 번에" value="" disabled={ws.busy} onChange={(ev) => ev.target.value && patch({ speed: Number(ev.target.value) }, '말 빠르기')}>
          <option value="">말 빠르기…</option>
          {[0.8, 0.9, 1, 1.1, 1.2, 1.3].map((x) => (
            <option key={x} value={x}>
              {x.toFixed(1)}배
            </option>
          ))}
        </select>
        <button type="button" className="text-link" onClick={clear}>
          선택 해제
        </button>
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
  const save = useAutosave(f, server, async (v, base) => {
    await api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', changedFields(v, base));
    void ws.load();
  });
  const epServer = { bgm: e.bgm || '', bgm_volume: e.bgm_volume === undefined || e.bgm_volume === null ? -1 : Number(e.bgm_volume) };
  const [ef, setEf] = useSyncedForm(epServer);
  const epSave = useAutosave(ef, epServer, async (v, base) => {
    // 바뀐 음악 칸만 보내요(제목을 함께 보내면 다른 곳에서 고친 제목이 옛 값으로 돌아가요).
    await api(`/studio/ai/projects/${p.id}/episodes/${e.id}`, 'PATCH', changedFields(v, base));
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
