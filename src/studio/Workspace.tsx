import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Bot, Check, ChevronRight, Clapperboard, Cpu, Film, ListChecks, Loader2, Sparkles, Send, Wand2 } from 'lucide-react';
import { api, lama, type AiFamily, type AiModelOption, type StudioEpisode, type StudioFeatures, type StudioProjectDetail } from '../api';
import { Empty } from '../App';
import { useConfirm } from '../confirm';
import { loadChoices, loadMode, saveChoices, saveMode, useRunner, type Choices, type ModelMode } from './parts';
// 모델 센터 · 작업/비용 · AI 조수는 열 때만 불러와요(첫 화면을 가볍게).
const ModelHub = lazy(() => import('./ModelHub'));
const JobCenter = lazy(() => import('./JobCenter'));
const Assistant = lazy(() => import('./Assistant'));
import PreviewPlayer from './Preview';
import { TABS, type TabId, type WS } from './ws/shared';
import PlanTab from './ws/PlanTab';
import ScriptTab from './ws/ScriptTab';
import SceneTab from './ws/SceneTab';
import FinishTab from './ws/FinishTab';
import './ws/workspace.css';
import './ws/vibe.css';

const icons = { plan: Wand2, script: Clapperboard, scene: Film, finish: Send } as const;

// 탭별 진행 상태(화면에서만 계산)
function progressOf(d: StudioProjectDetail) {
  const shots = d.episodes.flatMap((e) => e.shots);
  const lines = shots.filter((s) => s.dialogue.trim());
  const planned = !!d.characters.length && d.episodes.some((e) => e.summary.trim());
  const castReady = !!d.characters.length && d.characters.every((c) => c.image);
  const scripted = d.episodes.filter((e) => e.shots.length).length;
  const media = shots.filter((s) => s.image || s.video || s.lipsync).length + lines.filter((s) => s.audio).length;
  const composed = d.episodes.filter((e) => e.video && e.status === 'composed').length;
  const submitted = !!d.drama && ['pending', 'published'].includes(d.drama.status);
  return {
    plan: { ok: planned && castReady, text: planned ? (castReady ? '' : `인물 기준 이미지 ${d.characters.filter((c) => c.image).length}/${d.characters.length}`) : '기획안 만들기' },
    script: { ok: !!d.episodes.length && scripted === d.episodes.length, text: `${scripted}/${d.episodes.length}화` },
    scene: { ok: !!shots.length && media === shots.length + lines.length, text: shots.length ? `${media}/${shots.length + lines.length}` : '' },
    finish: { ok: !!d.episodes.length && composed === d.episodes.length && submitted, text: `합성 ${composed}/${d.episodes.length}` },
  } as Record<TabId, { ok: boolean; text: string }>;
}
const nextText: Record<TabId, string> = {
  plan: '아이디어로 기획안을 만들고 인물 기준 이미지를 준비해요.',
  script: '회차별 대본(컷 · 대사)을 써요.',
  scene: '컷마다 이미지와 대사 음성을 채워요. 영상 · 효과음은 선택이에요.',
  finish: '회차를 합성하고 작품으로 내보내 검수를 신청해요.',
};

type Step = { title: string; hint?: string; button: string; go: () => void };
// 지금 탭에서 가장 먼저 할 일(없으면 다음 탭으로 안내)
function nextStep(
  d: StudioProjectDetail,
  e: StudioEpisode | undefined,
  tab: TabId,
  run: (label: string, action: string, cap: 'text' | 'image' | 'tts' | 'video', targetId?: string) => void,
  goTab: (t: TabId) => void,
  compose: (e: StudioEpisode) => void,
): Step | null {
  const busy = (kind: string) => d.jobs.some((j) => j.kind === kind && (j.status === 'queued' || j.status === 'running'));
  if (tab === 'plan') {
    if (!d.characters.length) return busy('plan') ? null : { title: '아이디어로 기획안 만들기', hint: '인물 · 회차 구성을 AI가 한 번에', button: '기획안 만들기', go: () => run('기획안 만들기', 'plan', 'text') };
    const noImg = d.characters.filter((c) => !c.image);
    if (noImg.length) return busy('character_image') ? null : { title: `${noImg[0].name} 기준 이미지 만들기`, hint: `인물 이미지 ${d.characters.length - noImg.length}/${d.characters.length} · 컷마다 같은 얼굴로 나와요`, button: '만들기', go: () => run(`${noImg[0].name} 기준 이미지`, 'character_image', 'image', noImg[0].id) };
    return { title: '기획이 준비됐어요', hint: '회차별 대본을 써 볼까요?', button: '대본으로', go: () => goTab('script') };
  }
  if (tab === 'script') {
    const empty = d.episodes.find((x) => !x.shots.length);
    if (empty) return busy('script') ? null : { title: `${empty.number}화 대본 쓰기`, hint: `대본 ${d.episodes.length - d.episodes.filter((x) => !x.shots.length).length}/${d.episodes.length}화`, button: '대본 쓰기', go: () => run(`${empty.number}화 대본`, 'script', 'text', empty.id) };
    return { title: '대본이 모두 준비됐어요', hint: '컷마다 이미지와 음성을 채워요', button: '장면 편집으로', go: () => goTab('scene') };
  }
  if (tab === 'scene' && e) {
    if (!e.shots.length) return { title: `${e.number}화 대본이 없어요`, button: '대본으로', go: () => goTab('script') };
    const noImg = e.shots.filter((s) => !s.image && !s.video && s.visual.trim()).length;
    if (noImg) return busy('shot_image') ? null : { title: `${e.number}화 빈 컷 이미지 ${noImg}개 만들기`, hint: '내 사진을 쓰려면 컷에서 ‘내 소재로 · 사진’', button: '한 번에 만들기', go: () => run(`${e.number}화 빈 컷 이미지 모두`, 'batch_shot_image', 'image', e.id) };
    const noVoice = e.shots.filter((s) => s.dialogue.trim() && !s.audio && !s.lipsync).length;
    if (noVoice) return busy('shot_tts') ? null : { title: `${e.number}화 대사 음성 ${noVoice}개 만들기`, hint: '직접 녹음하려면 컷에서 ‘목소리 녹음’', button: '한 번에 만들기', go: () => run(`${e.number}화 대사 음성 모두`, 'batch_shot_tts', 'tts', e.id) };
    const nextEp = d.episodes.find((x) => x.shots.some((s) => !s.image && !s.video) && x.id !== e.id);
    if (nextEp) return { title: `${e.number}화 장면 준비 완료`, hint: `${nextEp.number}화도 채워 볼까요?`, button: '완성으로', go: () => goTab('finish') };
    return { title: '장면이 모두 준비됐어요', hint: '영상은 선택이에요. 없으면 이미지에 카메라 움직임으로 합성해요', button: '완성 · 공개로', go: () => goTab('finish') };
  }
  if (tab === 'finish') {
    const ready = d.episodes.find((x) => x.shots.length && x.shots.every((s) => s.image || s.video || s.lipsync) && x.status !== 'composed' && x.status !== 'composing');
    if (ready) return { title: `${ready.number}화 합성하기`, hint: '합성은 라마가 들지 않아요', button: '합성', go: () => compose(ready) };
  }
  return null;
}

export default function Workspace({
  projectId,
  models,
  families = [],
  features,
  genres,
  notify,
  back,
  goLama,
  tab,
  setTab,
}: {
  projectId: string;
  models: AiModelOption[];
  families?: AiFamily[];
  features?: StudioFeatures;
  genres: string[];
  notify: (s: string) => void;
  back: () => void;
  goLama: () => void;
  tab: TabId;
  setTab: (t: TabId) => void;
}) {
  const [data, setData] = useState<StudioProjectDetail | null>(null),
    [error, setError] = useState(''),
    [choices, setChoices] = useState<Choices>(loadChoices),
    [episodeId, setEpisodeId] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<StudioEpisode | null>(null),
    [mode, setModeState] = useState<ModelMode>(loadMode),
    [panel, setPanel] = useState<'' | 'models' | 'jobs'>(''),
    [assistant, setAssistant] = useState(false),
    [focus, setFocus] = useState('');
  const setMode = useCallback((m: ModelMode) => {
    setModeState(m);
    saveMode(m);
  }, []);
  const [ask, confirmUi] = useConfirm();
  // 불러오는 중에 또 부르면(저장 직후 등) 끝난 뒤 한 번 더 불러 최신 값을 보장합니다.
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const load = useCallback((): Promise<void> => {
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const job = (async () => {
      try {
        do {
          again.current = false;
          const d = await api<StudioProjectDetail>('/studio/ai/projects/' + projectId);
          setData(d);
          setError('');
          setEpisodeId((cur) => (cur && d.episodes.some((e) => e.id === cur) ? cur : d.episodes[0]?.id || ''));
        } while (again.current);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = job;
    return job;
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  // 진행 중인 AI 작업 · 합성 · 예고편 · 빠른 제작이 있으면 2초마다(화면이 보일 때만) 새로 봅니다.
  const active =
    !!data &&
    (data.jobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      data.episodes.some((e) => e.status === 'composing') ||
      (data.renders || []).some((r) => r.status === 'queued' || r.status === 'running') ||
      ['queued', 'rendering'].includes(data.project.trailer_status || '') ||
      data.autopilot?.status === 'running' ||
      (data.chat || []).some((m) => m.status === 'thinking' || m.status === 'applying'));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 2000);
    return () => clearInterval(t);
  }, [active, load]);
  const runner = useRunner({ projectId, notify, onRan: () => void load(), onNeedLama: goLama });
  const act = useCallback(
    async (fn: () => Promise<unknown>, message?: string) => {
      setBusy(true);
      try {
        await fn();
        await load();
        if (message) notify(message);
        return true;
      } catch (e) {
        notify((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, notify],
  );
  const availableModels = useMemo(() => models.filter((m) => !(data && Number(data.project.exclude_cn) && m.country === 'CN')), [models, data]);
  const progress = useMemo(() => (data ? progressOf(data) : null), [data]);
  if (error && !data) return <Empty title="프로젝트를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!data || !progress)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const p = data.project;
  const episode = data.episodes.find((e) => e.id === episodeId) || data.episodes[0];
  const ws: WS = {
    data,
    load,
    notify,
    models: availableModels,
    families,
    features,
    mode,
    openModels: () => setPanel('models'),
    setFocus,
    focus,
    choices,
    setChoice: (k, c) =>
      setChoices((cur) => {
        const next = { ...cur, [k]: c };
        saveChoices(next);
        return next;
      }),
    // 자동 모드면 늘 '자동 선택', 직접 모드면 고른 모델. 버튼에서 품질·모델을 바로 지정할 수도 있어요(예: 고급으로 다시).
    run: (label, action, cap, { tier, requested, ...opts } = {}) =>
      void runner.ask(label, { action, ...opts, requested: requested ?? (mode === 'auto' ? 'auto' : choices[cap].requested), tier: tier ?? choices[cap].tier }),
    act,
    busy,
    useAsset: (id) => void act(() => api(`/studio/ai/assets/${id}/use`, 'POST'), '선택한 버전으로 바꿨어요.'),
    ask,
    episode,
    setEpisodeId,
    goTab: setTab,
    goLama,
    preview: (e) => setPreview(e),
  };
  const runningJobs = data.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const failedCount = data.jobs.filter((j) => j.status === 'failed' && j.kind !== 'translate').length;
  const next = TABS.find((t) => !progress[t.id].ok);
  // 하단 액션바: 지금 화면에서 바로 할 수 있는 다음 일 하나(누르면 라마 확인 후 실행)
  const bar = nextStep(data, episode, tab, (n, action, cap, targetId) => ws.run(n, action, cap, { targetId }), setTab, (e) =>
    void act(() => api(`/studio/ai/projects/${projectId}/episodes/${e.id}/compose`, 'POST'), `${e.number}화 합성을 시작했어요. 끝나면 알려 드려요.`),
  );
  const done = TABS.filter((t) => progress[t.id].ok).length;
  return (
    <div className={'ai-workspace ws' + (assistant ? ' with-asst' : '') + (bar ? ' has-bar' : '')}>
      <div className="workspace-head">
        <button className="text-link" onClick={back}>
          <ArrowLeft size={15} /> 프로젝트 목록
        </button>
        <div>
          <h2>{p.title}</h2>
          <p>
            {p.genre} · {p.episode_count}화 · 회당 {p.episode_seconds}초 · 사용 {lama(data.spent)}
            {error && <span className="danger"> · 새로고침 실패: {error}</span>}
          </p>
        </div>
        <div className="ws-head-tools">
          <button className={'ws-head-chip mode-' + mode} onClick={() => setPanel('models')} title="AI 모델 센터">
            <Cpu size={14} /> {mode === 'auto' ? '모델 자동' : '모델 직접'}
          </button>
          <button className={'ws-head-chip' + (failedCount ? ' warn' : '')} onClick={() => setPanel('jobs')} title="작업 · 비용">
            {runningJobs ? <Loader2 size={14} className="spin" /> : failedCount ? <AlertTriangle size={14} /> : <ListChecks size={14} />}
            {runningJobs ? `진행 ${runningJobs}` : failedCount ? `실패 ${failedCount}` : '작업'}
            {Number(p.budget_lama) > 0 && <small>{Math.round((Number(data.spent) / Number(p.budget_lama)) * 100)}%</small>}
          </button>
          <button className="wallet-chip lama-chip" onClick={goLama}>
            <Sparkles size={14} /> {lama(data.wallet.total)}
          </button>
        </div>
      </div>
      <nav className="ws-tabs" aria-label="작업 단계">
        {TABS.map((t, i) => {
          const Icon = icons[t.id];
          const s = progress[t.id];
          return (
            <button key={t.id} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              <b>{s.ok ? <Check size={12} /> : i + 1}</b>
              <span>
                <strong>
                  <Icon size={14} /> {t.name}
                </strong>
                <small>{s.text && !s.ok ? s.text : t.hint}</small>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="ws-progress">
        <div className="studio-progress-bar" role="progressbar" aria-label="제작 진행률" aria-valuenow={done * 25} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: done * 25 + '%' }} />
        </div>
        {next ? (
          next.id !== tab && (
            <button className="next-action" onClick={() => setTab(next.id)}>
              <span>다음 할 일 · {next.name}</span>
              <small>{nextText[next.id]}</small>
              <ChevronRight size={16} />
            </button>
          )
        ) : (
          <span className="next-action done">
            <Check size={15} /> 모든 단계를 마쳤어요.
          </span>
        )}
      </div>
      {data.autopilot?.status === 'running' && tab !== 'plan' && (
        <button className="autopilot-banner" onClick={() => setTab('plan')}>
          <Bot size={15} /> 빠른 제작 진행 중 · {data.autopilot.message} <u>자세히</u>
        </button>
      )}
      {tab === 'plan' && <PlanTab ws={ws} genres={genres} />}
      {tab === 'script' && <ScriptTab ws={ws} />}
      {tab === 'scene' && <SceneTab ws={ws} />}
      {tab === 'finish' && <FinishTab ws={ws} />}
      {bar && (
        <div className="ws-actionbar" role="region" aria-label="다음 할 일">
          <span>
            <small>이 화면에서 바로</small>
            <b>{bar.title}</b>
            {bar.hint && <em>{bar.hint}</em>}
          </span>
          <button type="button" className="primary" disabled={busy} onClick={bar.go}>
            {bar.button} <ChevronRight size={15} />
          </button>
        </div>
      )}
      {runner.confirm}
      <Suspense fallback={null}>
      {panel === 'models' && (
        <ModelHub
          models={availableModels}
          families={families}
          mode={mode}
          setMode={setMode}
          choices={choices}
          setChoice={ws.setChoice}
          projectId={projectId}
          close={() => setPanel('')}
        />
      )}
      {features?.assistant !== false &&
        (assistant ? (
          <Assistant ws={ws} focus={focus} close={() => setAssistant(false)} />
        ) : (
          <button type="button" className="asst-fab" onClick={() => setAssistant(true)} aria-label="AI 조수 열기">
            <Bot size={18} /> AI 조수
            {(data.chat || []).some((m) => m.status === 'ready') && <i className="asst-dot" aria-hidden="true" />}
          </button>
        ))}
      {panel === 'jobs' && <JobCenter data={data} models={availableModels} close={() => setPanel('')} reload={load} notify={notify} ask={ask} goLama={goLama} />}
      </Suspense>
      {confirmUi}
      {preview && (
        <PreviewPlayer
          title={`${preview.number}화 · ${preview.title}`}
          shots={data.episodes.find((e) => e.id === preview.id)?.shots || preview.shots}
          cast={data.characters}
          close={() => setPreview(null)}
        />
      )}
    </div>
  );
}
