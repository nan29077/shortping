import { useEffect, useRef, useState } from 'react';
import { CheckSquare, ChevronLeft, ChevronRight, Film, ShieldCheck, ImageIcon, Mic, Music, PlayCircle, Sparkles, Upload, Volume2, Wand2 } from 'lucide-react';
import { api, parseJson, studioMedia, type StudioEpisode } from '../../api';
import { Empty } from '../../App';
import { changedFields, useAutosave, useSyncedForm } from '../hooks';
import { JobBadge, isBusy } from '../parts';
import { CAMERA_MOVES, EMOTIONS } from './ScriptTab';
import { EFFECTS, LIGHTS, PresetSelect, TONES, presetValue } from './Direction';
import { EpisodeSwitcher, ModelSettings, NotReady, SaveBadge, Section, hasModel, pct, runningCount, type WS } from './shared';
import { asset } from '../../platform';
import { verifyOf } from './DramaParts';
import ShotEditor, { TRANSITIONS } from './ShotEditor';
import ScriptTab from './ScriptTab';
import { ReadyChecklist } from './Readiness';
import { Clapperboard, Eye, FileText, Send, X } from 'lucide-react';

const MUSIC_MOODS = ['설레는 로맨스', '긴장감 있는 스릴러', '슬프고 잔잔한', '밝고 경쾌한', '웅장한 반전', '미스터리'];
type SubStyle = { position: 'bottom' | 'middle' | 'top'; size: 's' | 'm' | 'l' | 'xl'; background: 'none' | 'box' | 'shadow'; names: boolean };
const defaultSub: SubStyle = { position: 'bottom', size: 'm', background: 'shadow', names: false };

export default function SceneTab({ ws }: { ws: WS }) {
  const e = ws.episode;
  // 대본 서랍은 회차가 바뀌어도(서랍 안 회차 고르기 포함) 열린 채로 둬요 — 회차별로 다시 그려지는 아래 화면 밖에 둡니다.
  const [script, setScript] = useState(false);
  if (!e) return <Empty title="먼저 기획안을 만들어 주세요" text="기획 · 설정 탭에서 회차 구성을 만들면 장면을 편집할 수 있어요." action={() => ws.goTab('plan')} label="기획으로 이동" />;
  return (
    <>
      <EpisodeSwitcher ws={ws} />
      <EpisodeScenes key={e.id} ws={ws} e={e} openScript={() => setScript(true)} />
      {script && <ScriptDrawer ws={ws} close={() => setScript(false)} />}
      <BgmSection ws={ws} e={e} />
      <SubtitleSection ws={ws} />
    </>
  );
}

function EpisodeScenes({ ws, e, openScript }: { ws: WS; e: StudioEpisode; openScript: () => void }) {
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
  // 순서 자유(3단계): 대본이 없어도 여기서 바로 시작할 수 있어요 — AI 대본 · 빈 컷 · 대본 붙여 넣기
  if (!e.shots.length)
    return (
      <section className="management-panel ws-scenes">
        <div className="ws-script-head">
          <div>
            <h3>{e.number}화 장면 편집</h3>
            <p className="muted">아직 컷이 없어요. 어디서든 시작할 수 있어요.</p>
          </div>
        </div>
        <div className="ws-start-options">
          <button type="button" className="ws-start-card" disabled={!ws.can('script') || isBusy(jobs, e.id, 'script')} onClick={() => ws.run(`${e.number}화 대본`, 'script', 'text', { targetId: e.id })}>
            <Wand2 size={20} />
            <strong>AI로 대본 쓰기</strong>
            <small>{e.summary.trim() ? '이 회차 줄거리로 컷 · 대사를 한 번에 써요(라마).' : '줄거리가 없어도 아이디어로 써요(라마). 기획을 먼저 하면 더 좋아요.'}</small>
            <JobBadge jobs={jobs} targetId={e.id} kind="script" />
          </button>
          <button
            type="button"
            className="ws-start-card"
            disabled={!ws.can('script') || ws.busy}
            onClick={() =>
              void ws.act(
                () => api(`/studio/ai/projects/${data.project.id}/episodes/${e.id}/shots`, 'POST', { scene: '1', visual: '', dialogue: '', speaker_id: null, camera: '미디엄', seconds: 5 }),
                '빈 컷을 만들었어요. 장면을 적고 바로 만들어 보세요.',
              )
            }
          >
            <Film size={20} />
            <strong>빈 컷으로 바로 시작</strong>
            <small>폴로처럼 컷 하나부터. 프롬프트 창에 장면을 적고 이미지 · 영상을 만들어요(대본은 나중에).</small>
          </button>
          <button type="button" className="ws-start-card" onClick={() => ws.goTab('script')}>
            <FileText size={20} />
            <strong>대본 붙여 넣기 · 직접 쓰기</strong>
            <small>가진 대본이 있으면 붙여 넣어 컷으로 나눠요. 라마가 들지 않아요.</small>
          </button>
        </div>
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
        <div className="ws-head-actions">
          <button className="secondary compact" onClick={openScript} title="이 회차 대본을 옆 서랍에서 보고 고쳐요" data-script-opener="">
            <FileText size={14} /> 대본
          </button>
          <button className="secondary compact" disabled={!e.shots.some((s) => s.image || s.video)} title={!e.shots.some((s) => s.image || s.video) ? '이미지나 영상이 있는 컷이 생기면 볼 수 있어요' : ''} onClick={() => ws.preview(e)}>
            <PlayCircle size={14} /> 미리보기 (무료)
          </button>
        </div>
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
        <small className="muted">{picking ? '컷을 눌러 고르세요.' : <span className="desktop-only-hint">컷을 끌어 순서를 바꿀 수 있어요.</span>}</small>
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
        <ShotEditor
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
      <FinishBar ws={ws} e={e} />
    </section>
  );
}

// 대본 서랍(3단계): 장면 편집을 떠나지 않고 이 회차 대본을 보고 고쳐요. PC는 오른쪽, 휴대폰은 전체 시트.
function ScriptDrawer({ ws, close }: { ws: WS; close: () => void }) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    // 열면 서랍 안으로 초점을 옮기고, Tab은 서랍 안에서만 돌아요. 닫으면 연 버튼으로 초점을 돌려줘요.
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('.ws-drawer-head button')?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop, .ws-overlay, .preview-overlay')) return;
      if (ev.key === 'Escape') return closeRef.current();
      if (ev.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
      if (!f.length) return;
      const first = f[0],
        last = f[f.length - 1];
      if (!box.current.contains(document.activeElement)) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = old;
      // 서랍 안에서 회차를 바꾸면 연 버튼이 새로 그려져요. 그때는 지금 화면의 '대본' 버튼으로 돌려줘요.
      if (prev?.isConnected) prev.focus();
      else document.querySelector<HTMLElement>('[data-script-opener]')?.focus();
    };
  }, []);
  return (
    <>
      <div className="ws-drawer-backdrop" onClick={close} />
      <aside ref={box} className="ws-drawer" role="dialog" aria-modal="true" aria-label="대본 서랍">
        <div className="ws-drawer-head">
          <strong>
            <FileText size={15} /> 대본 · {ws.episode?.number}화
          </strong>
          <small className="muted">고치면 장면 편집에 바로 반영돼요</small>
          <button type="button" className="icon-button" aria-label="대본 서랍 닫기" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="ws-drawer-body">
          <ScriptTab ws={ws} />
        </div>
      </aside>
    </>
  );
}

// 완성 바(3단계): 이 회차를 여기서 바로 합성 · 미리보기 · 검수 준비 확인. 자세한 건 완성 · 공개 탭.
function FinishBar({ ws, e }: { ws: WS; e: StudioEpisode }) {
  const p = ws.data.project;
  const [check, setCheck] = useState(false);
  const composing = e.status === 'composing';
  const missing = e.shots.findIndex((s) => !s.image && !s.video && !s.lipsync);
  const pending = e.shots.some((s) => ['shot_image', 'shot_tts', 'shot_video', 'shot_lipsync', 'shot_sfx', 'shot_image_edit'].some((k) => isBusy(ws.data.jobs, s.id, k)));
  const ready = e.shots.length > 0 && missing < 0 && !pending;
  const stale = !!e.video && e.status !== 'composed' && !composing;
  const why = missing >= 0 ? `${missing + 1}번 컷에 이미지가 없어요` : pending ? 'AI 작업이 끝나면 합성할 수 있어요' : '';
  const status = composing ? `합성 중 ${pct(e.compose_progress)}%` : e.status === 'compose_failed' ? '합성 실패' : stale ? '내용이 바뀌어 다시 합성 필요' : e.video ? `합성 완료${e.duration ? ` · ${e.duration}초` : ''}` : ready ? '합성 준비됨' : why || '컷을 채우는 중';
  return (
    <div className={'ws-finishbar' + (e.video && !stale ? ' done' : '')} aria-label="이 회차 완성">
      <div className="ws-finishbar-info">
        <Send size={14} />
        <span>
          <b>{e.number}화 완성</b>
          <small className={e.status === 'compose_failed' ? 'danger' : stale ? 'lime' : 'muted'}>{status}</small>
        </span>
      </div>
      <div className="ws-finishbar-actions">
        <button type="button" className="secondary compact" disabled={!e.shots.some((s) => s.image || s.video)} onClick={() => ws.preview(e)}>
          <Eye size={13} /> 미리보기
        </button>
        <button type="button" className={(e.video && !stale ? 'secondary' : 'primary') + ' compact'} disabled={ws.busy || !ready || composing} title={!ready ? why : ''} onClick={() => void ws.act(() => api(`/studio/ai/projects/${p.id}/episodes/${e.id}/compose`, 'POST'), `${e.number}화 합성을 시작했어요.`)}>
          <Clapperboard size={13} /> {composing ? '합성 중…' : e.video ? '다시 합성' : '합성하기'}
        </button>
        <button type="button" className="secondary compact" aria-expanded={check} onClick={() => setCheck(!check)}>
          <ShieldCheck size={13} /> 공개 전 확인
        </button>
        <button type="button" className="text-link" onClick={() => ws.goTab('finish')}>
          완성 · 공개 탭 <ChevronRight size={13} />
        </button>
      </div>
      {check && <ReadyChecklist ws={ws} />}
    </div>
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
  const firstScroll = useRef(true);
  useEffect(() => {
    // 처음 열릴 때는 화면을 움직이지 않아요(휴대폰에서 장면 편집으로 착지할 때 튀지 않게).
    if (firstScroll.current) {
      firstScroll.current = false;
      return;
    }
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
    return a ? `${a.model_label || 'AI 음악'} · ${new Date(a.created_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })}` : '음악';
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
