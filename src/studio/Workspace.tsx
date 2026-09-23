import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bot, Check, ChevronRight, Clapperboard, Film, Sparkles, Send, Wand2 } from 'lucide-react';
import { api, lama, type AiModelOption, type StudioEpisode, type StudioProjectDetail } from '../api';
import { Empty } from '../App';
import { useConfirm } from '../confirm';
import { loadChoices, saveChoices, useRunner, type Choices } from './parts';
import PreviewPlayer from './Preview';
import { TABS, type TabId, type WS } from './ws/shared';
import PlanTab from './ws/PlanTab';
import ScriptTab from './ws/ScriptTab';
import SceneTab from './ws/SceneTab';
import FinishTab from './ws/FinishTab';
import './ws/workspace.css';

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

export default function Workspace({
  projectId,
  models,
  genres,
  notify,
  back,
  goLama,
  tab,
  setTab,
}: {
  projectId: string;
  models: AiModelOption[];
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
    [preview, setPreview] = useState<StudioEpisode | null>(null);
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
      data.autopilot?.status === 'running');
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
    choices,
    setChoice: (k, c) =>
      setChoices((cur) => {
        const next = { ...cur, [k]: c };
        saveChoices(next);
        return next;
      }),
    run: (label, action, cap, opts = {}) =>
      void runner.ask(label, { action, ...opts, requested: choices[cap].requested, tier: choices[cap].tier }),
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
  const next = TABS.find((t) => !progress[t.id].ok);
  const done = TABS.filter((t) => progress[t.id].ok).length;
  return (
    <div className="ai-workspace ws">
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
        <button className="wallet-chip lama-chip" onClick={goLama}>
          <Sparkles size={14} /> {lama(data.wallet.total)}
        </button>
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
      {runner.confirm}
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
