import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AtSign,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Film,
  ImageIcon,
  Images,
  Layers,
  Lock,
  MessageSquare,
  Mic,
  Minus,
  Plus,
  ShieldCheck,
  Sparkles,
  Sun,
  Upload,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';
import { api, ApiError, capabilityLabel, parseJson, studioMedia, unitLabel, type ShotVerify, type StudioShot } from '../../api';
import { changedFields, useAutosave, useSyncedForm } from '../hooks';
import { JobBadge, Versions, isBusy, type ChoiceKey } from '../parts';
import { EMOTIONS, shotBase } from './ScriptTab';
import { DirectionPanel, EFFECTS, EffectPicker, LightPanel, PRESETS, presetValue } from './Direction';
import { CandidateTray } from './Candidates';
import { FramesPanel } from './Frames';
import { CompareToggle, RetouchPanel, upscaledOf } from './Retouch';
import { NotReady, SaveBadge, hasModel, type RunOpts, type WS } from './shared';
import { asset } from '../../platform';
import MyMedia from './MyMedia';
import { VerifyBadge, verifyOf } from './DramaParts';
import './editor.css';

// 컷 에디터(2026-09-30, 힉스필드 · 폴로 벤치마킹 1단계)
// 화면 한가운데 프롬프트 창 하나, 그 위에 연출 프리셋 칩(참조 · 카메라 · 조명 · 효과), 아래에 설정 칩(모델 · 품질 · 길이 · 후보)과
// 예상 라마가 보이는 만들기 버튼. 결과는 아래 갤러리에 쌓이고, 세부 도구는 서랍(Fold)에 그대로 있어요.

export const TRANSITIONS = [
  { id: 'cut', name: '바로 전환' },
  { id: 'fade', name: '겹쳐 전환' },
  { id: 'dip', name: '검은 화면 거쳐' },
  { id: 'flash', name: '번쩍(플래시)' },
];
const SFX_CHIPS = ['문이 쾅 닫히는 소리', '빗소리', '심장 박동', '휴대폰 진동', '발소리', '유리 깨지는 소리', '카페 소음', '천둥'];
const tierShort: Record<string, string> = { draft: '초안', standard: '표준', premium: '고급' };
type Target = 'image' | 'video' | 'tts';
const TARGET: Record<Target, { name: string; action: string; icon: ReactNode; counts: number[] }> = {
  image: { name: '이미지', action: 'shot_image', icon: <ImageIcon size={14} />, counts: [1, 2, 3, 4] },
  video: { name: '영상', action: 'shot_video', icon: <Film size={14} />, counts: [1, 2] },
  tts: { name: '음성', action: 'shot_tts', icon: <Mic size={14} />, counts: [1] },
};

// 컷 화면 모드(간단 · 전문) — 이 브라우저에 기억해요.
export function useShotMode(): [boolean, (v: boolean) => void] {
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
export function Fold({ id, title, summary, icon, autoOpen = false, children }: { id: string; title: string; summary?: string; icon?: ReactNode; autoOpen?: boolean; children: ReactNode }) {
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

// 프리셋 · 설정 칩: 누르면 바로 아래(휴대폰은 아래에서 올라오는 시트)에 고르는 판이 열려요.
function Chip({
  icon,
  label,
  value,
  on,
  disabled,
  wide,
  panelTitle,
  children,
  className = '',
}: {
  icon?: ReactNode;
  label: string;
  value?: string;
  on?: boolean;
  disabled?: boolean;
  wide?: boolean;
  panelTitle?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // 판 안에서 전체 화면 창(끝 장면 고르기 · 확인 창)이 열려 있으면 그 창이 먼저 닫히도록 둬요.
    const nested = () => !!ref.current?.querySelector('.ws-overlay, .modal-backdrop');
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !nested()) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !nested() && !document.querySelector('.modal-backdrop') && setOpen(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    // 열리면 판 안 첫 조작 요소로, 닫히면 칩 버튼으로 초점을 옮겨요(키보드 · 화면 읽기 프로그램).
    const first = pop.current?.querySelector<HTMLElement>('.se-pop-body button, .se-pop-body input, .se-pop-body select, .se-pop-body textarea, .se-pop-body [tabindex]');
    (first || pop.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
      if (ref.current?.contains(document.activeElement) || document.activeElement === document.body) btn.current?.focus({ preventScroll: true });
    };
  }, [open]);
  const body = open ? (typeof children === 'function' ? children(() => setOpen(false)) : children) : null;
  return (
    <div className={'se-chipwrap' + (open ? ' open' : '') + (className ? ' ' + className : '')} ref={ref}>
      <button ref={btn} type="button" className={'se-chip' + (on ? ' on' : '')} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(!open)}>
        {icon}
        <span>
          <small>{label}</small>
          {value !== undefined && <b>{value}</b>}
        </span>
        <ChevronDown size={12} className="se-chip-caret" />
      </button>
      {open && <div className="se-pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div ref={pop} className={'se-pop' + (wide ? ' wide' : '')} role="dialog" aria-label={panelTitle || label}>
          <div className="se-pop-head">
            <strong>{panelTitle || label}</strong>
            <button type="button" className="icon-button" aria-label="닫기" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <div className="se-pop-body">{body}</div>
        </div>
      )}
    </div>
  );
}

// 예상 라마: 만들기 버튼에 미리 보여 줘요(라마 들지 않음). 조건이 바뀌면 잠깐 뒤에 다시 계산해요.
function useEstimate(projectId: string, body: Record<string, unknown> | null, deps: unknown[]) {
  const [est, setEst] = useState<{ lama: number; model: string } | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const key = JSON.stringify([body, ...deps]);
  useEffect(() => {
    if (!body) {
      setEst(null);
      setState('idle');
      return;
    }
    let alive = true;
    setState('loading');
    setEst(null); // 조건이 바뀌었으니 옛 금액을 보여 주지 않아요
    const t = setTimeout(() => {
      api<{ lama: number; model: string }>(`/studio/ai/projects/${projectId}/estimate`, 'POST', body)
        .then((r) => alive && (setEst({ lama: r.lama, model: r.model }), setState('idle')))
        .catch(() => alive && (setEst(null), setState('error')));
    }, 450);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId]);
  return { est, loading: state === 'loading', error: state === 'error' };
}

const fmtLama = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}라마`;

type Mention = { kind: 'cast' | 'place' | 'prop'; id: string; name: string; image?: string };

export default function ShotEditor({ ws, s, index, total, next, prev, go }: { ws: WS; s: StudioShot; index: number; total: number; next?: StudioShot; prev?: StudioShot; go: (d: number) => void }) {
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
  const mine = useRef<Record<string, unknown>>({});
  const save = useAutosave(
    f,
    server,
    async (v, base) => {
      const r = await api<{ audioReset: boolean }>(`/studio/ai/shots/${s.id}`, 'PATCH', { ...changedFields(v, base), base_updated_at: s.updated_at ?? null }).catch((e) => {
        if (e instanceof ApiError && e.code === 'edit_conflict') {
          // 덮어쓸 때는 내가 바꾼 칸만 보내요(팀원이 고친 다른 칸은 그대로 두도록).
          mine.current = changedFields(v, base);
          setConflict(true);
        }
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
    if (mode === 'reset') {
      setF(serverRef.current);
      return;
    }
    // 내 변경: 최신 내용 위에 내가 바꾼 칸만 얹어요. 자동 저장이 새 기준(최신 내용 · 수정 시각)과 비교해
    // 내가 바꾼 칸만 보내므로, 팀원이 고친 다른 칸은 되돌리지 않아요.
    const changes = mine.current;
    mine.current = {};
    setF({ ...serverRef.current, ...changes } as typeof serverRef.current);
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
  const run = async (label: string, action: string, cap: ChoiceKey, opts: Omit<RunOpts, 'targetId'> = {}) => {
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
  const place = (data.locations || []).find((l) => l.id === f.location_id);
  const moveLabel = [f.camera, f.camera_move, f.angle].filter(Boolean).join(' · ');
  const lightLabel = [f.light, f.tone].filter(Boolean).join(' · ');
  const fxLabel = [f.effect ? EFFECTS.find((x) => x.id === f.effect)?.name : '', index > 0 && f.transition !== 'cut' ? TRANSITIONS.find((t) => t.id === f.transition)?.name : ''].filter(Boolean).join(' · ');
  const imageLabel = [v ? `검수 ${v.ok ? '✓' : '문제'} ${Math.round(v.score)}` : '', up.image ? '화질 ✓' : ''].filter(Boolean).join(' · ');
  const videoCheck = (() => {
    const x = parseJson<{ ok: boolean; score: number; issues: { code: string; text: string; frame?: number }[]; summary?: string; video?: string } | null>(s.video_verify, null);
    return x && x.video === media ? x : null;
  })();
  const videoLabel = [s.lipsync ? '입 모양 ✓' : '', up.video ? '화질 ✓' : '', videoCheck ? (videoCheck.ok ? `검수 ✓ ${videoCheck.score}` : '검수 문제') : ''].filter(Boolean).join(' · ');
  const refCount = f.cast_ids.length + (f.location_id ? 1 : 0) + f.prop_ids.length + (f.end_image || f.end_frame ? 1 : 0);

  // ── 만들기(대상 · 모델 · 품질 · 후보 수) ──
  // 처음 열 때 다음에 할 일을 고릅니다: 이미지가 없으면 이미지, 이미지만 있으면 영상.
  const [target, setTarget] = useState<Target>(!s.image ? 'image' : !s.video ? 'video' : 'image');
  const [count, setCount] = useState(1);
  // 이 컷에서만 바꾸는 모델 · 품질(비우면 모델 센터 설정을 따라요)
  const [pick, setPick] = useState<Partial<Record<Target, { requested: string; tier: 'draft' | 'standard' | 'premium' }>>>({});
  const cap: ChoiceKey = target;
  const globalChoice = ws.choices[cap];
  const modelsFor = ws.models.filter((m) => m.capability === cap);
  const rawChoice = pick[target] || { requested: ws.mode === 'auto' ? 'auto' : globalChoice.requested, tier: globalChoice.tier };
  // 직접 고른 모델이 지금 쓸 수 없으면(삭제 · 중국 모델 제외 등) 자동으로 돌려요.
  const choice = rawChoice.requested !== 'auto' && !modelsFor.some((m) => m.id === rawChoice.requested) ? { ...rawChoice, requested: 'auto' } : rawChoice;
  const chosenModel = choice.requested !== 'auto' ? modelsFor.find((m) => m.id === choice.requested) : null;
  const targetReady = target === 'tts' ? !!f.dialogue.trim() : !noVisual;
  const targetBusy = isBusy(jobs, s.id, TARGET[target].action);
  const has = target === 'image' ? !!s.image : target === 'video' ? !!s.video : !!s.audio;
  const runBody = targetReady && hasModel(ws.models, cap) ? { action: TARGET[target].action, targetId: s.id, requested: choice.requested, tier: choice.tier, ...(count > 1 ? { options: { count } } : {}) } : null;
  const { est, loading: estLoading, error: estError } = useEstimate(data.project.id, runBody, [s.updated_at]);
  const pickOpts = { requested: choice.requested, tier: choice.tier };
  const generate = () => {
    const t = TARGET[target];
    const label = count > 1 ? `${t.name} 후보 ${count}${target === 'image' ? '장' : '개'}${target === 'video' ? ` (${f.seconds}초씩)` : ''}` : target === 'video' ? `영상 (${f.seconds}초)` : target === 'tts' ? '대사 음성' : '이미지';
    void run(label, t.action, cap, { ...pickOpts, ...(count > 1 ? { options: { count } } : {}), quickOk: true });
  };

  // ── @ 인물 · 장소 · 소품 불러오기 ──
  const box = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const mentionables: Mention[] = [
    ...data.characters.map((c) => ({ kind: 'cast' as const, id: c.id, name: c.name, image: c.image })),
    ...(data.locations || []).map((l) => ({ kind: 'place' as const, id: l.id, name: l.name, image: l.image })),
    ...(data.props || []).map((x) => ({ kind: 'prop' as const, id: x.id, name: x.name, image: x.image })),
  ];
  const mentionList = mention ? mentionables.filter((m) => !mention.q || m.name.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 8) : [];
  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    setMention(m ? { q: m[2], start: caret - m[2].length - 1 } : null);
  };
  const addRef = (m: Mention, cur = f) => {
    if (m.kind === 'cast') return cur.cast_ids.includes(m.id) ? cur : { ...cur, cast_ids: [...cur.cast_ids, m.id] };
    if (m.kind === 'place') return { ...cur, location_id: m.id };
    if (cur.prop_ids.includes(m.id)) return cur;
    if (cur.prop_ids.length >= 6) {
      ws.notify('소품은 컷마다 6개까지 고를 수 있어요.');
      return cur;
    }
    return { ...cur, prop_ids: [...cur.prop_ids, m.id] };
  };
  const pickMention = (m: Mention) => {
    if (!mention) return;
    const el = box.current;
    // '@이름'을 이름으로 바꾸고(AI에게는 이름만 전달), 참조에 넣어요. 바꾸는 범위는 '@' + 입력한 검색어까지만.
    const end = mention.start + 1 + mention.q.length;
    const text = f.visual.slice(0, mention.start) + m.name + ' ' + f.visual.slice(end);
    setF(addRef(m, { ...f, visual: text }));
    setMention(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = mention.start + m.name.length + 1;
      el.setSelectionRange(pos, pos);
    });
  };
  const removeRef = (m: Mention) =>
    setF(m.kind === 'cast' ? { ...f, cast_ids: f.cast_ids.filter((x) => x !== m.id) } : m.kind === 'place' ? { ...f, location_id: null } : { ...f, prop_ids: f.prop_ids.filter((x) => x !== m.id) });
  const refs: Mention[] = [
    ...f.cast_ids.map((id) => mentionables.find((m) => m.kind === 'cast' && m.id === id)).filter(Boolean),
    ...(place ? [mentionables.find((m) => m.kind === 'place' && m.id === place.id)] : []),
    ...f.prop_ids.map((id) => mentionables.find((m) => m.kind === 'prop' && m.id === id)),
  ].filter(Boolean) as Mention[];
  const insertAt = () => {
    const el = box.current;
    const caret = el?.selectionStart ?? f.visual.length;
    const needSpace = caret > 0 && !/\s$/.test(f.visual.slice(0, caret));
    const text = f.visual.slice(0, caret) + (needSpace ? ' @' : '@') + f.visual.slice(caret);
    setF({ ...f, visual: text });
    const pos = caret + (needSpace ? 2 : 1);
    setMention({ q: '', start: pos - 1 });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const kindName = { cast: '인물', place: '장소', prop: '소품' };
  return (
    <div className="ws-detail se">
      {/* 위: 컷 이동 · 모드 · 저장 상태 */}
      <div className="se-top">
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
            <button type="button" role="radio" aria-checked={pro} className={pro ? 'on' : ''} onClick={() => setPro(true)} title="연출 카드 · 컷 잇기 · 영상 고급까지 모두 보여요">
              전문
            </button>
          </div>
          {pro && (
            <button type="button" className="secondary compact" title="이 컷 뒤에 2~3초짜리 연결 컷(소품 클로즈업 · 장소 전경 · 표정)을 AI가 넣어요" disabled={isBusy(jobs, s.id, 'bridge_shot') || total >= 40} onClick={() => void run('뒤에 사이 컷 넣기', 'bridge_shot', 'text')}>
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

      {/* 무대: 지금 컷의 결과 */}
      <div className="se-stage ws-detail-media">
        <div className="ws-frame">
          {media ? (
            <video ref={player} key={media} controls preload="none" playsInline poster={asset(s.image) || undefined} src={studioMedia(media)} />
          ) : s.image ? (
            <img src={asset(s.image)} alt={`${index + 1}번 컷`} />
          ) : (
            <span>아직 이미지가 없어요 · 아래에 장면을 적고 만들기를 누르세요</span>
          )}
          {s.lipsync && <em className="ws-frame-tag">입 모양 맞춤</em>}
          <div className="shot-status se-status" aria-label="이 컷 상태">
            <span className={s.image ? 'ok' : ''}>이미지 {s.image ? (v ? (v.ok ? `✓ ${Math.round(v.score)}` : '⚠') : '✓') : '—'}</span>
            {f.dialogue.trim() && <span className={s.audio ? 'ok' : ''}>음성 {s.audio ? '✓' : '—'}</span>}
            <span className={s.video ? 'ok' : ''}>영상 {s.video ? (s.lipsync ? '✓ 입 모양' : '✓') : '—'}</span>
            {s.sfx && <span className="ok">효과음 ✓</span>}
          </div>
        </div>
        <div className="shot-jobs">
          <JobBadge jobs={jobs} targetId={s.id} kind="shot_image" onRetry={() => void run('이미지', 'shot_image', 'image', pick.image)} />
          <JobBadge jobs={jobs} targetId={s.id} kind="shot_tts" onRetry={() => void run('대사 음성', 'shot_tts', 'tts', pick.tts)} />
          <JobBadge jobs={jobs} targetId={s.id} kind="shot_video" onRetry={() => void run(`영상 (${f.seconds}초)`, 'shot_video', 'video', pick.video)} />
        </div>
      </div>

      {/* 프롬프트 창 */}
      <fieldset className="se-prompt ws-detail-fields" disabled={!canEdit}>
        {lockNote && <small className="ws-lock-note">{lockNote}</small>}
        <div className="se-presets" aria-label="연출 프리셋">
          <Chip icon={<Images size={14} />} label="참조" value={refCount ? `${refCount}개` : '자동'} on={refCount > 0} wide panelTitle="참조 · 인물 · 장소 · 소품 · 시작 · 끝 장면">
            <div className="ws-field">
              <span>등장 인물 <small className="muted">프롬프트에 @이름으로도 넣을 수 있어요</small></span>
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
                {!data.characters.length && <small className="muted">기획 탭에서 인물을 만들면 여기서 고를 수 있어요.</small>}
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
            <div className="form-columns">
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
            </div>
            {(data.props || []).length > 0 && (
              <div className="ws-field">
                <span>소품</span>
                <div className="chip-row">
                  {(data.props || []).map((x) => {
                    const on = f.prop_ids.includes(x.id);
                    return (
                      <button type="button" key={x.id} className={'chip' + (on ? ' active' : '')} aria-pressed={on} onClick={() => (on ? setF({ ...f, prop_ids: f.prop_ids.filter((y) => y !== x.id) }) : setF(addRef({ kind: 'prop', id: x.id, name: x.name })))}>
                        {x.image && <img src={asset(x.image)} alt="" />}
                        {x.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {pro && (
              <div className="ws-field se-frames">
                <span>시작 · 끝 장면 <small className="muted">앞 컷의 마지막 장면에서 이어가거나 끝 장면을 정해요</small></span>
                <FramesPanel ws={ws} s={s} prev={prev} next={next} index={index} value={{ end_frame: f.end_frame, end_image: f.end_image }} set={(x) => setF({ ...f, ...x })} />
              </div>
            )}
          </Chip>
          <Chip icon={<Camera size={14} />} label="카메라" value={moveLabel || '자동'} on={!!moveLabel} wide panelTitle={pro ? '연출 · 카메라' : '연출 세트'}>
            {pro ? (
              <DirectionPanel ws={ws} s={s} disabled={!canEdit} value={{ camera: f.camera, camera_move: f.camera_move, angle: f.angle, lens: f.lens, move_strength: f.move_strength, light: f.light, tone: f.tone }} set={(x) => setF({ ...f, ...x })} />
            ) : (
              <div className="se-simple-dir">
                <div className="chip-row" role="group" aria-label="연출 세트">
                  {[...PRESETS].sort((a, b) => Number(!!b.genre && data.project.genre.includes(b.genre)) - Number(!!a.genre && data.project.genre.includes(a.genre))).map((p) => {
                    const pv = presetValue(p);
                    const on = pv.camera === f.camera && pv.camera_move === f.camera_move && pv.angle === f.angle;
                    return (
                      <button type="button" key={p.id} className={'chip' + (on ? ' active' : '')} aria-pressed={on} title={p.hint} onClick={() => setF({ ...f, ...pv })}>
                        {p.genre && data.project.genre.includes(p.genre) ? '★ ' : ''}
                        {p.name}
                      </button>
                    );
                  })}
                </div>
                <small className="muted">
                  {moveLabel ? `지금: ${moveLabel}` : '비워 두면 AI가 장면에 맞게 골라요.'} 샷 크기 · 움직임 · 앵글을 하나씩 고르려면{' '}
                  <button type="button" className="text-link" onClick={() => setPro(true)}>
                    전문 모드
                  </button>
                  로 바꾸세요.
                </small>
                {moveLabel && (
                  <button type="button" className="secondary compact" onClick={() => setF({ ...f, camera: '', camera_move: '', angle: '', lens: '', move_strength: '' })}>
                    자동으로 되돌리기
                  </button>
                )}
              </div>
            )}
          </Chip>
          <Chip icon={<Sun size={14} />} label="조명 · 색감" value={lightLabel || '자동'} on={!!lightLabel} wide panelTitle="조명 · 시간과 색감">
            <LightPanel pro={pro} disabled={!canEdit} value={{ light: f.light, tone: f.tone, height: f.height, dof: f.dof, focal: f.focal }} set={(x) => setF({ ...f, ...x })} />
          </Chip>
          <Chip icon={<Sparkles size={14} />} label="효과 · 전환" value={fxLabel || '없음'} on={!!fxLabel} panelTitle="화면 효과 · 앞 컷에서 넘어오기">
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
          </Chip>
        </div>

        <div className="se-input">
          <textarea
            ref={box}
            rows={3}
            maxLength={800}
            value={f.visual}
            aria-label="화면 묘사"
            placeholder="장면을 묘사해 보세요. @를 눌러 등장인물 · 장소 · 소품을 넣을 수 있어요. 예: 비 오는 골목, 우산을 든 @지우 가 뒤돌아본다"
            onChange={(ev) => {
              setF({ ...f, visual: ev.target.value });
              detectMention(ev.target.value, ev.target.selectionStart ?? ev.target.value.length);
            }}
            onKeyDown={(ev) => {
              // 한글 조합 중 Enter는 글자 확정이라 건드리지 않아요.
              if (ev.nativeEvent.isComposing || ev.keyCode === 229) return;
              if (mention && ev.key === 'Escape') setMention(null);
              if (mention && ev.key === 'Enter' && mentionList[0]) {
                ev.preventDefault();
                pickMention(mentionList[0]);
              }
            }}
            onSelect={(ev) => {
              // 커서가 검색어 밖으로 움직이면 목록을 닫아요.
              if (mention) {
                const t = ev.currentTarget;
                detectMention(t.value, t.selectionStart ?? t.value.length);
              }
            }}
            onBlur={() => setTimeout(() => setMention(null), 150)}
          />
          {mention && (
            <div className="se-mention" role="listbox" aria-label="인물 · 장소 · 소품">
              {mentionList.length ? (
                mentionList.map((m) => (
                  <button type="button" role="option" aria-selected={false} key={m.kind + m.id} onMouseDown={(ev) => ev.preventDefault()} onClick={() => pickMention(m)}>
                    {m.image ? <img src={asset(m.image)} alt="" /> : <i className={'se-mention-dot ' + m.kind} />}
                    <b>{m.name}</b>
                    <small>{kindName[m.kind]}</small>
                  </button>
                ))
              ) : (
                <span className="muted">{mentionables.length ? '일치하는 이름이 없어요' : '기획 탭에서 인물 · 장소를 만들면 @로 넣을 수 있어요'}</span>
              )}
            </div>
          )}
          {refs.length > 0 && (
            <div className="se-refs" aria-label="이 컷의 참조">
              {refs.map((m) => (
                <span key={m.kind + m.id} className={'se-ref ' + m.kind}>
                  {m.image ? <img src={asset(m.image)} alt="" /> : <i className={'se-mention-dot ' + m.kind} />}
                  {m.name}
                  {canEdit && (
                    <button type="button" aria-label={m.name + ' 빼기'} onClick={() => removeRef(m)}>
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="se-dialogue">
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
          {(f.dialogue.trim() || f.speaker_id || f.narration) && (
            <>
              <select aria-label="감정" value={f.emotion} onChange={(ev) => setF({ ...f, emotion: ev.target.value })}>
                {[...EMOTIONS, ...(f.emotion && !EMOTIONS.includes(f.emotion) ? [f.emotion] : [])].map((x) => (
                  <option key={x} value={x}>
                    {x || (speaker?.voice_style ? `기본(${speaker.voice_style})` : '감정 기본')}
                  </option>
                ))}
              </select>
              <label className="se-speed" title="말 빠르기">
                <small>{f.speed.toFixed(1)}배</small>
                <input type="range" aria-label="말 빠르기" min={0.5} max={2} step={0.1} value={f.speed} onChange={(ev) => setF({ ...f, speed: Number(ev.target.value) })} />
              </label>
            </>
          )}
        </div>

        <div className="se-bar">
          <div className="se-bar-left">
            <button type="button" className="se-iconbtn" title="인물 · 장소 · 소품 넣기(@)" aria-label="인물 · 장소 · 소품 넣기" onClick={insertAt}>
              <AtSign size={15} />
            </button>
            <Chip
              icon={<Wand2 size={13} />}
              label={capabilityLabel[cap] || TARGET[target].name}
              value={chosenModel ? chosenModel.label : '자동'}
              disabled={!modelsFor.length}
              panelTitle={`${TARGET[target].name} 모델 · 품질 (이 컷만)`}
            >
              {(close) => (
                <div className="se-modelpick">
                  {choice.requested === 'auto' && (
                  <div className="hub-seg small" role="radiogroup" aria-label="품질">
                    {(['draft', 'standard', 'premium'] as const).map((t) => (
                      <button key={t} type="button" role="radio" aria-checked={choice.tier === t} className={choice.tier === t ? 'active' : ''} onClick={() => setPick({ ...pick, [target]: { ...choice, tier: t } })}>
                        {tierShort[t]}
                        <small>{t === 'draft' ? '싸고 빠르게' : t === 'premium' ? '가장 좋게' : '균형'}</small>
                      </button>
                    ))}
                  </div>
                  )}
                  {choice.requested !== 'auto' && <small className="muted">직접 고른 모델은 품질 등급과 상관없이 그 모델로 만들어요.</small>}
                  <div className="se-models" role="radiogroup" aria-label="모델">
                    <button type="button" role="radio" aria-checked={choice.requested === 'auto'} className={'se-model' + (choice.requested === 'auto' ? ' on' : '')} onClick={() => (setPick({ ...pick, [target]: { ...choice, requested: 'auto' } }), close())}>
                      <b>자동 선택</b>
                      <small>품질 등급 · 장면 태그 · 우선순위 · 가격 순으로 골라요</small>
                    </button>
                    {modelsFor.map((m) => (
                      <button type="button" role="radio" key={m.id} aria-checked={choice.requested === m.id} className={'se-model' + (choice.requested === m.id ? ' on' : '') + (m.cooling ? ' cool' : '')} onClick={() => (setPick({ ...pick, [target]: { ...choice, requested: m.id } }), close())}>
                        <b>
                          {m.label} <em>{tierShort[m.tier] || m.tier}</em>
                        </b>
                        <small>
                          {m.provider}
                          {m.country === 'CN' ? ' · 중국' : ''} · {fmtLama(m.lama_per_unit)}/{unitLabel[m.unit] || m.unit}
                          {m.cooling ? ' · 잠시 쉬는 중' : ''}
                        </small>
                      </button>
                    ))}
                  </div>
                  <small className="muted">여기서 고른 모델은 이 컷에서만 써요. 모든 컷의 기본값은 위 ‘AI 모델 · 품질’에서 바꿔요.</small>
                </div>
              )}
            </Chip>
            <div className="se-seconds" title="컷 길이(2~10초)">
              <button type="button" aria-label="1초 줄이기" disabled={f.seconds <= 2} onClick={() => setF({ ...f, seconds: Math.max(2, f.seconds - 1) })}>
                <Minus size={12} />
              </button>
              <b>{f.seconds || '-'}초</b>
              <button type="button" aria-label="1초 늘리기" disabled={f.seconds >= 10} onClick={() => setF({ ...f, seconds: Math.min(10, (f.seconds || 2) + 1) })}>
                <Plus size={12} />
              </button>
            </div>
            {TARGET[target].counts.length > 1 && (
              <div className="se-count" role="radiogroup" aria-label="후보 수" title="같은 설정으로 후보를 여러 개 만들어 골라요(개수만큼 라마)">
                <Layers size={12} />
                {TARGET[target].counts.map((n) => (
                  <button type="button" key={n} role="radio" aria-checked={count === n} className={count === n ? 'on' : ''} onClick={() => setCount(n)}>
                    {n}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className={'se-toggle' + (f.seed_lock ? ' on' : '')} aria-pressed={f.seed_lock} title="같은 컷을 다시 만들 때 구도와 느낌이 크게 바뀌지 않게 해요(시드 고정)" onClick={() => setF({ ...f, seed_lock: !f.seed_lock })}>
              <Lock size={12} /> 비슷하게
            </button>
          </div>
          <div className="se-bar-right">
            <div className="se-target" role="radiogroup" aria-label="만들 것">
              {(Object.keys(TARGET) as Target[]).map((t) => (
                <button type="button" key={t} role="radio" aria-checked={target === t} className={target === t ? 'on' : ''} disabled={!hasModel(ws.models, t)} onClick={() => (setTarget(t), setCount(1))} title={t === 'tts' && !f.dialogue.trim() ? '대사가 있는 컷만 음성을 만들어요' : ''}>
                  {TARGET[t].icon}
                  <span>{TARGET[t].name}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="primary se-go"
              disabled={!targetReady || targetBusy || ws.running || !hasModel(ws.models, cap) || !canEdit}
              title={!targetReady ? (target === 'tts' ? '대사를 먼저 적어 주세요' : '장면 묘사를 먼저 적어 주세요') : estError ? '예상 라마를 계산하지 못했어요. 눌러서 자세한 이유를 확인하세요.' : ''}
              onClick={generate}
            >
              <Sparkles size={15} />
              <span>
                {targetBusy ? '만드는 중…' : `${TARGET[target].name} ${has && count === 1 ? '다시 ' : ''}만들기`}
                <small>{targetBusy ? '' : ws.running ? '요청 중…' : estLoading && !est ? '계산 중…' : est ? `✦ ${fmtLama(est.lama)}` : estError ? '예상 불가' : runBody ? '✦ —' : ''}</small>
              </span>
            </button>
          </div>
        </div>
        {est && !targetBusy && (
          <small className="se-est muted">
            {est.model}
            {count > 1 ? ` · 후보 ${count}개 합계` : ''} · 예상치만큼 예약하고 끝나면 실제 사용량만 차감 · 실패하면 전액 환불
            {ws.quick ? ' · 확인 없이 바로 실행' : ''}
          </small>
        )}
      </fieldset>

      {/* 결과 갤러리 */}
      <div className="se-results">
        <CandidateTray ws={ws} s={s} onVerify={() => void run('후보 AI 검수', 'verify_candidates', 'text')} />
        <div className="ws-tools se-versions">
          <Versions assets={data.assets} targetId={s.id} kind="image" current={s.image} onUse={ws.useAsset} />
          <Versions assets={data.assets} targetId={s.id} kind="video" current={s.video} onUse={ws.useAsset} />
          <Versions assets={data.assets} targetId={s.id} kind="audio" current={s.audio} onUse={ws.useAsset} />
          <CompareToggle ws={ws} s={s} />
        </div>
        {s.audio && <audio key={s.audio} controls preload="none" src={studioMedia(s.audio)} />}
      </div>

      {/* 서랍: 세부 도구 */}
      <div className="se-drawers">
        <Fold id="image" title="이미지 다듬기" summary={imageLabel || '고급 · 검수 · 보정 · 화질'} icon={<Wand2 size={13} />} autoOpen={!!v && !v.ok}>
          <div className="ws-tools">
            {s.image && choice.tier !== 'premium' && (
              <button className="secondary compact upgrade" title="마음에 드는 컷만 고급 품질로 다시 만들어요" disabled={isBusy(jobs, s.id, 'shot_image') || noVisual} onClick={() => void run('이미지 고급으로 다시', 'shot_image', 'image', { requested: pick.image?.requested, tier: 'premium' })}>
                <Sparkles size={13} /> 고급으로 다시
              </button>
            )}
            {s.image && (
              <>
                <button className="secondary compact" title="얼굴 · 인물 수 · 글자 · 손 모양 · 구도를 AI가 확인해요(라마 소액)" disabled={isBusy(jobs, s.id, 'verify_shot') || !!v} onClick={() => void run('AI 검수', 'verify_shot', 'text')}>
                  <ShieldCheck size={13} /> AI 검수
                </button>
                <JobBadge jobs={jobs} targetId={s.id} kind="verify_shot" />
                <VerifyBadge s={s} onRedo={() => void run('이미지 다시', 'shot_image', 'image')} onFix={(issues) => setFixIssues(issues)} />
              </>
            )}
          </div>
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
        </Fold>
        {pro && (
          <Fold id="video" title="영상 고급" summary={videoLabel || '고급 · 검수 · 움직임만 · 입 모양 · 화질'} icon={<Film size={13} />}>
            <div className="ws-tools">
              {s.video && choice.tier !== 'premium' && (
                <button className="secondary compact upgrade" title="이 컷만 고급 품질 영상으로 다시 만들어요" disabled={isBusy(jobs, s.id, 'shot_video') || noVisual} onClick={() => void run(`영상 고급으로 다시 (${f.seconds}초)`, 'shot_video', 'video', { requested: pick.video?.requested, tier: 'premium' })}>
                  <Sparkles size={13} /> 고급으로 다시
                </button>
              )}
              <button className="secondary compact" title="지금 컷 이미지의 구도 · 얼굴 · 배경은 그대로 두고 숨 · 눈 깜빡임 · 머리카락만 살짝 움직여요" disabled={!s.image || isBusy(jobs, s.id, 'shot_video')} onClick={() => void run(`움직임만 입히기 (${f.seconds}초)`, 'shot_video', 'video', { options: { motionOnly: true } })}>
                <Wand2 size={13} /> 움직임만 입히기(구도 그대로)
              </button>
            </div>
            {media && (
              <div className="ws-tools">
                <button className="secondary compact" title="영상의 처음 · 가운데 · 끝 장면을 AI가 보고 얼굴 · 옷 바뀜, 뭉개짐, 입 모양, 앞 컷과의 이어짐을 확인해요(라마 소액)" disabled={isBusy(jobs, s.id, 'verify_video') || !!videoCheck} onClick={() => void run('영상 AI 검수', 'verify_video', 'text')}>
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
            {media && (
              <div className="ws-tools" aria-label="영상에서 장면 뽑기">
                <small className="muted">위 영상을 원하는 순간에 멈추고:</small>
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
                  <button className="secondary compact" title={`${s.lipsync ? '입 모양 맞춘 영상' : '컷 영상'}을 더 선명하게 키워요(라마 차감). 1080p로 합성할 때 효과가 커요.`} disabled={isBusy(jobs, s.id, 'shot_upscale_video')} onClick={() => void run('영상 화질 올리기', 'shot_upscale_video', 'upscale_video')}>
                    <Sparkles size={13} /> 영상 화질 올리기
                  </button>
                )}
                <JobBadge jobs={jobs} targetId={s.id} kind="shot_upscale_video" />
              </div>
            )}
          </Fold>
        )}
        <Fold id="voice" title="자막 · 효과음" summary={[f.caption !== null ? '자막 따로' : '', f.sfx_prompt ? `효과음: ${f.sfx_prompt}` : ''].filter(Boolean).join(' · ') || '자막 · 효과음 · 소리 크기'} icon={<Volume2 size={13} />} autoOpen={!!s.sfx || !!f.sfx_prompt}>
          <fieldset disabled={!canEdit} className="se-fieldset">
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
          </fieldset>
        </Fold>
        <Fold id="mymedia" title="내 소재로 채우기" summary="직접 찍은 사진 · 영상 · 녹음 올리기" icon={<Upload size={13} />}>
          <MyMedia ws={ws} s={s} index={index} />
        </Fold>
        {!pro && <small className="muted ws-mode-hint">카메라를 하나씩 고르기 · 시작 · 끝 장면 · 영상 고급 도구는 ‘전문’ 모드에서 보여요.</small>}
      </div>
    </div>
  );
}
