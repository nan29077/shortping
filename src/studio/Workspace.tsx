import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Clapperboard,
  Eye,
  Film,
  ImageIcon,
  Mic,
  PlayCircle,
  Plus,
  Send,
  Sparkles,
  Trash2,
  UserRound,
  Wand2,
} from 'lucide-react';
import {
  api,
  jobKindLabel,
  lama,
  studioMedia,
  won,
  type AiModelOption,
  type StudioCharacter,
  type StudioEpisode,
  type StudioProjectDetail,
  type StudioShot,
} from '../api';
import { Empty, Modal, navigate } from '../App';
import { JobBadge, ModelPicker, Versions, defaultChoices, isBusy, useRunner, type Choices } from './parts';
import AutopilotPanel from './Autopilot';
import PreviewPlayer from './Preview';
import ProgressBar, { StepMark, progressOf, type StepId } from './Progress';
import { REWRITE_CHIPS, STYLES, voiceSuggestions } from './presets';
import { EpisodeNavigator, StepCoach, WorkflowFooter } from './Coach';

const steps = [
  { id: 'plan', name: '기획', icon: Wand2 },
  { id: 'cast', name: '캐릭터', icon: UserRound },
  { id: 'script', name: '대본', icon: Clapperboard },
  { id: 'board', name: '스토리보드 · 음성', icon: ImageIcon },
  { id: 'video', name: '영상', icon: Film },
  { id: 'compose', name: '합성 · 포스터', icon: Sparkles },
  { id: 'export', name: '내보내기 · 검수', icon: Send },
] as const;
type Step = (typeof steps)[number]['id'];
const statusText: Record<string, string> = {
  outline: '줄거리',
  scripted: '대본 완성',
  composing: '합성 중',
  composed: '합성 완료',
  compose_failed: '합성 실패',
};

export default function Workspace({
  projectId,
  models,
  genres,
  notify,
  back,
  goLama,
}: {
  projectId: string;
  models: AiModelOption[];
  genres: string[];
  notify: (s: string) => void;
  back: () => void;
  goLama: () => void;
}) {
  const [data, setData] = useState<StudioProjectDetail | null>(null),
    [error, setError] = useState(''),
    [step, setStep] = useState<Step>('plan'),
    [choices, setChoices] = useState<Choices>(defaultChoices),
    [episodeId, setEpisodeId] = useState(''),
    [busy, setBusy] = useState(false),
    [guided, setGuided] = useState(true),
    [planDirty, setPlanDirty] = useState(false),
    [leaveTarget, setLeaveTarget] = useState<Step | 'back' | null>(null),
    [preview, setPreview] = useState<{ title: string; shots: StudioShot[] } | null>(null);
  const goStep = (target: Step) => {
    if (target === step) return;
    if (planDirty) setLeaveTarget(target);
    else setStep(target);
  };
  useEffect(() => {
    if (!planDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [planDirty]);
  const load = useCallback(async () => {
    try {
      const d = await api<StudioProjectDetail>('/studio/ai/projects/' + projectId);
      setData(d);
      setError('');
      setEpisodeId((cur) => cur || d.episodes[0]?.id || '');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  // 진행 중인 AI 작업이나 합성이 있으면 2초마다 새로 봅니다.
  const active = !!data && (data.jobs.some((j) => j.status === 'queued' || j.status === 'running') || data.episodes.some((e) => e.status === 'composing') || data.autopilot?.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [active, load]);
  const runner = useRunner({ projectId, notify, onRan: () => void load(), onNeedLama: goLama });
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (message) notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = (label: string, action: string, capability: keyof Choices, targetId?: string) =>
    void runner.ask(label, { action, targetId, requested: choices[capability].requested, tier: choices[capability].tier });
  const episode = data?.episodes.find((e) => e.id === episodeId) || data?.episodes[0];
  const useAsset = (id: string) => void act(() => api(`/studio/ai/assets/${id}/use`, 'POST'), '선택한 버전으로 바꿨어요.');
  if (error) return <Empty title="프로젝트를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const p = data.project;
  const availableModels = models.filter(m => !(Number(p.exclude_cn) && m.country === 'CN'));
  const jobs = data.jobs;
  const pickers = (caps: (keyof Choices)[]) => (
    <details className="creator-model-settings" open={guided ? undefined : true}>
      <summary>AI 모델 · 품질 설정 <small>기본은 자동 선택 · 필요할 때만 변경하세요</small></summary>
      <div className="picker-bar">
      {caps.map((c) => (
        <ModelPicker key={c} capability={c} models={availableModels} value={choices[c]} onChange={(v) => setChoices({ ...choices, [c]: v })} />
      ))}
      </div>
    </details>
  );
  const progress = progressOf(data);
  const names = Object.fromEntries(steps.map((x) => [x.id, x.name])) as Record<StepId, string>;
  const previewButton = (e: StudioEpisode) => (
    <button className="secondary" disabled={!e.shots.some((s) => s.image || s.video)} onClick={() => setPreview({ title: `${e.number}화 · ${e.title}`, shots: e.shots })}>
      <PlayCircle size={15} /> {e.number}화 미리보기
    </button>
  );
  const rewrite = (s: StudioShot, index: number, instruction: string) =>
    void runner.ask(`${index + 1}번 컷 AI로 고치기`, { action: 'rewrite_shot', targetId: s.id, instruction, requested: choices.text.requested, tier: choices.text.tier });
  const episodeTabs = (
    <div className="member-tabs episode-tabs">
      {data.episodes.map((e) => (
        <button key={e.id} className={episode?.id === e.id ? 'active' : ''} onClick={() => setEpisodeId(e.id)}>
          {e.number}화<i>{statusText[e.status] || e.status}</i>
        </button>
      ))}
    </div>
  );
  return (
    <div className="ai-workspace">
      <div className="workspace-head">
        <button className="text-link" onClick={() => planDirty ? setLeaveTarget('back') : back()}>
          <ArrowLeft size={15} /> 프로젝트 목록
        </button>
        <div>
          <h2>{p.title}</h2>
          <p>
            {p.genre} · {p.episode_count}화 · 회당 {p.episode_seconds}초 · 사용 {lama(data.spent)}
          </p>
        </div>
        <button className="wallet-chip lama-chip" onClick={goLama}>
          <Sparkles size={14} /> {lama(data.wallet.total)}
        </button>
      </div>
      <ProgressBar list={progress} names={names} go={goStep} />
      <div className="workspace-mode"><label className="inline-check"><input type="checkbox" checked={guided} onChange={e => setGuided(e.target.checked)} /> 단계별 도움말 표시</label><span>AI 실행 전 예상 라마를 확인해요 · 입력은 각 영역의 저장 버튼으로 저장해요</span></div>
      <div className="step-tabs">
        {steps.map(({ id, name, icon: Icon }, i) => (
          <button key={id} className={step === id ? 'active' : ''} onClick={() => goStep(id)} aria-current={step === id ? 'step' : undefined}>
            <b>{i + 1}</b>
            <Icon size={15} />
            {name}
            <StepMark s={progress.find((x) => x.id === id)} />
          </button>
        ))}
      </div>
      {guided && <StepCoach step={step} />}
      <EpisodeNavigator data={data} selected={episode?.id || ''} select={(id, target) => { setEpisodeId(id); goStep(target); }} />
      {data.autopilot?.status === 'running' && step !== 'plan' && (
        <button className="autopilot-banner" onClick={() => setStep('plan')}>
          <Bot size={15} /> 자동 제작 진행 중 · {data.autopilot.message} <u>자세히</u>
        </button>
      )}

      {step === 'plan' && <AutopilotPanel data={data} models={availableModels} notify={notify} reload={load} goLama={goLama} compact={true} />}
      {step === 'plan' && (
        <PlanStep data={data} genres={genres} busy={busy} jobs={jobs} act={act} pickers={pickers(['text'])} onPlan={() => run('AI 기획안 만들기', 'plan', 'text')} onDirty={setPlanDirty} />
      )}

      {step === 'cast' && (
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h3>캐릭터</h3>
              <p>인물 기준 이미지를 먼저 만들면 스토리보드·영상에서 같은 얼굴과 의상을 유지하는 데 참고해요.</p>
            </div>
            <button
              className="secondary compact"
              disabled={busy || data.characters.length >= 8}
              onClick={() => void act(() => api(`/studio/ai/projects/${p.id}/characters`, 'POST', { name: '새 인물', role: '조연', description: '', look: '' }), '인물을 추가했어요.')}
            >
              <Plus size={15} /> 인물 추가
            </button>
          </div>
          {pickers(['image', 'tts'])}
          {!data.characters.length && <Empty title="아직 인물이 없어요" text="기획 단계에서 AI 기획안을 만들면 인물이 자동으로 채워져요." />}
          <div className="cast-grid">
            {data.characters.map((c) => (
              <CharacterCard
                key={c.id}
                c={c}
                projectId={p.id}
                models={availableModels}
                data={data}
                busy={busy}
                act={act}
                onImage={() => run(`${c.name} 기준 이미지 만들기`, 'character_image', 'image', c.id)}
                onSample={() => run(`${c.name} 목소리 미리듣기`, 'voice_sample', 'tts', c.id)}
                useAsset={useAsset}
              />
            ))}
          </div>
        </section>
      )}

      {step === 'script' && episode && (
        <section className="management-panel">
          {episodeTabs}
          <EpisodeHeader e={episode} projectId={p.id} act={act} busy={busy} />
          {pickers(['text'])}
          <div className="form-actions start">
            <button className="primary" disabled={isBusy(jobs, episode.id, 'script') || !data.characters.length} onClick={() => run(`${episode.number}화 대본 쓰기`, 'script', 'text', episode.id)}>
              <Wand2 size={15} /> {episode.shots.length ? 'AI로 대본 다시 쓰기' : 'AI로 대본 쓰기'}
            </button>
            <JobBadge jobs={jobs} targetId={episode.id} kind="script" />
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => api(`/studio/ai/projects/${p.id}/episodes/${episode.id}/shots`, 'POST', { scene: '', visual: 'New shot', dialogue: '', speaker_id: null, camera: '미디엄', seconds: 5 }),
                  '컷을 추가했어요.',
                )
              }
            >
              <Plus size={15} /> 컷 직접 추가
            </button>
          </div>
          {!data.characters.length && <p className="muted settings-note">대본을 쓰려면 기획 단계에서 인물을 먼저 만들어 주세요.</p>}
          <p className="muted settings-note">
            총 {episode.shots.reduce((n, s) => n + Number(s.seconds), 0)}초 / 목표 {p.episode_seconds}초 · 컷 {episode.shots.length}개
          </p>
          <div className="shot-list">
            {episode.shots.map((s, i) => (
              <ShotEditor
                key={s.id + s.dialogue + s.visual + s.scene}
                s={s}
                index={i}
                total={episode.shots.length}
                cast={data.characters}
                act={act}
                busy={busy}
                jobs={jobs}
                onRewrite={(instruction) => rewrite(s, i, instruction)}
              />
            ))}
          </div>
        </section>
      )}

      {step === 'board' && episode && (
        <section className="management-panel">
          {episodeTabs}
          {pickers(['image', 'tts'])}
          <div className="form-actions start">
            <button className="secondary" onClick={() => run(`${episode.number}화 빈 컷 스토리보드 모두 만들기`, 'batch_shot_image', 'image', episode.id)}>
              <ImageIcon size={15} /> 빈 컷 이미지 모두
            </button>
            <button className="secondary" onClick={() => run(`${episode.number}화 대사 음성 모두 만들기`, 'batch_shot_tts', 'tts', episode.id)}>
              <Mic size={15} /> 대사 음성 모두
            </button>
            {previewButton(episode)}
          </div>
          {!episode.shots.length && <Empty title="대본이 없어요" text="대본 단계에서 컷을 먼저 만들어 주세요." />}
          <div className="board-grid">
            {episode.shots.map((s, i) => {
              const speaker = data.characters.find((c) => c.id === s.speaker_id);
              return (
                <article key={s.id} className="board-card">
                  <div className="board-media">
                    {s.image ? <img src={s.image} alt={`${i + 1}번 컷 스토리보드`} /> : <span>이미지 없음</span>}
                    <b>#{i + 1}</b>
                  </div>
                  <p>{s.scene || s.visual}</p>
                  <div className="board-tools">
                    <button className="secondary compact" disabled={isBusy(jobs, s.id, 'shot_image')} onClick={() => run(`${i + 1}번 컷 이미지`, 'shot_image', 'image', s.id)}>
                      <ImageIcon size={13} /> {s.image ? '다시' : '이미지'}
                    </button>
                    <JobBadge jobs={jobs} targetId={s.id} kind="shot_image" />
                    <Versions assets={data.assets} targetId={s.id} kind="image" current={s.image} onUse={useAsset} />
                  </div>
                  {s.dialogue ? (
                    <div className="board-voice">
                      <small>
                        {speaker?.name || '화자 없음'}: “{s.dialogue}”
                      </small>
                      {s.audio && <audio controls preload="none" src={studioMedia(s.audio)} />}
                      <div className="board-tools">
                        <button className="secondary compact" disabled={isBusy(jobs, s.id, 'shot_tts')} onClick={() => run(`${i + 1}번 컷 대사 음성`, 'shot_tts', 'tts', s.id)}>
                          <Mic size={13} /> {s.audio ? '다시' : '음성'}
                        </button>
                        <JobBadge jobs={jobs} targetId={s.id} kind="shot_tts" />
                        <Versions assets={data.assets} targetId={s.id} kind="audio" current={s.audio} onUse={useAsset} />
                      </div>
                    </div>
                  ) : (
                    <small className="muted">대사 없음</small>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {step === 'video' && episode && (
        <section className="management-panel">
          {episodeTabs}
          {pickers(['video'])}
          <div className="info-box">
            <Sparkles size={18} />
            자동 선택은 대사가 있는 클로즈업은 입 모양·표정에 강한 모델, 액션은 움직임에 강한 모델, 초안 등급은 저렴한 모델을
            골라요. 스토리보드 이미지가 있으면 그 장면에서 시작하는 영상을 만들어요. 영상이 없는 컷은 합성할 때 스토리보드
            이미지로 대신 채워요.
          </div>
          <div className="form-actions start">
            <button className="secondary" onClick={() => run(`${episode.number}화 빈 컷 영상 모두 만들기`, 'batch_shot_video', 'video', episode.id)}>
              <Film size={15} /> 빈 컷 영상 모두
            </button>
            {previewButton(episode)}
          </div>
          <div className="board-grid">
            {episode.shots.map((s, i) => (
              <article key={s.id} className="board-card">
                <div className="board-media">
                  {s.video ? (
                    <video controls preload="none" playsInline poster={s.image || undefined} src={studioMedia(s.video)} />
                  ) : s.image ? (
                    <img src={s.image} alt="" />
                  ) : (
                    <span>이미지 없음</span>
                  )}
                  <b>
                    #{i + 1} · {s.seconds}초
                  </b>
                </div>
                <p>{s.visual}</p>
                <div className="board-tools">
                  <button className="secondary compact" disabled={isBusy(jobs, s.id, 'shot_video')} onClick={() => run(`${i + 1}번 컷 영상 (${s.seconds}초)`, 'shot_video', 'video', s.id)}>
                    <Film size={13} /> {s.video ? '다시' : '영상'}
                  </button>
                  <JobBadge jobs={jobs} targetId={s.id} kind="shot_video" />
                  <Versions assets={data.assets} targetId={s.id} kind="video" current={s.video} onUse={useAsset} />
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {step === 'compose' && (
        <ComposeStep data={data} busy={busy} act={act} jobs={jobs} onPreview={(e) => setPreview({ title: `${e.number}화 · ${e.title}`, shots: e.shots })} pickers={pickers(['image'])} onPoster={() => run('작품 포스터 만들기', 'poster', 'image')} useAsset={useAsset} />
      )}

      {step === 'export' && <ExportStep data={data} notify={notify} reload={load} />}
      {['script', 'board', 'video'].includes(step) && !episode && <Empty title="먼저 기획안을 만들어 주세요" text="기획 단계에서 회차 구성을 만들면 이 단계를 진행할 수 있어요." action={() => setStep('plan')} label="기획으로 이동" />}
      <WorkflowFooter step={step} go={goStep} />
      {leaveTarget && <Modal title="저장하지 않은 기획이 있어요" close={() => setLeaveTarget(null)}><p className="muted">수정한 기획을 유지하려면 돌아가서 기획 저장을 눌러 주세요.</p><div className="form-actions"><button className="primary" onClick={() => setLeaveTarget(null)}>돌아가서 저장하기</button><button className="secondary" onClick={() => { setPlanDirty(false); setLeaveTarget(null); if (leaveTarget === 'back') back(); else setStep(leaveTarget); }}>변경을 버리고 이동</button></div></Modal>}
      {runner.confirm}
      {preview && <PreviewPlayer title={preview.title} shots={preview.shots} cast={data.characters} close={() => setPreview(null)} />}
    </div>
  );
}

function PlanStep({
  data,
  genres,
  busy,
  jobs,
  act,
  pickers,
  onPlan,
  onDirty,
}: {
  data: StudioProjectDetail;
  genres: string[];
  busy: boolean;
  jobs: StudioProjectDetail['jobs'];
  act: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  pickers: React.ReactNode;
  onPlan: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const p = data.project;
  const saved = {
    title: p.title,
    logline: p.logline,
    genre: p.genre,
    tone: p.tone,
    style: p.style,
    synopsis: p.synopsis,
    episode_count: p.episode_count,
    episode_seconds: p.episode_seconds,
    exclude_cn: !!Number(p.exclude_cn),
  };
  const [f, setF] = useState(saved);
  const previousSaved = useRef(JSON.stringify(saved));
  const dirty = JSON.stringify(f) !== JSON.stringify(saved);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    const old = previousSaved.current;
    previousSaved.current = JSON.stringify(saved);
    setF(current => JSON.stringify(current) === old ? saved : current);
  }, [p.updated_at]);
  return (
    <>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>기획</h3>
            <p>한 줄 아이디어만 적어도 AI가 제목·줄거리·등장인물·회차 구성을 만들어요. 결과는 자유롭게 고칠 수 있어요.</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api('/studio/ai/projects/' + p.id, 'PATCH', f), '기획을 저장했어요.');
          }}
        >
          <div className="form-columns">
            <label>
              제목
              <input value={f.title} maxLength={70} required onChange={(e) => setF({ ...f, title: e.target.value })} />
            </label>
            <label>
              장르
              <select value={f.genre} onChange={(e) => setF({ ...f, genre: e.target.value })}>
                {genres.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            한 줄 아이디어
            <input value={f.logline} maxLength={300} minLength={5} required onChange={(e) => setF({ ...f, logline: e.target.value })} />
          </label>
          <div className="form-columns">
            <label>
              분위기
              <input value={f.tone} maxLength={100} placeholder="예: 설렘, 긴장감, 유쾌함" onChange={(e) => setF({ ...f, tone: e.target.value })} />
            </label>
            <label>
              회차 수
              <input type="number" min={1} max={60} value={f.episode_count} onChange={(e) => setF({ ...f, episode_count: Number(e.target.value) })} />
            </label>
            <label>
              회당 길이(초)
              <input type="number" min={20} max={180} value={f.episode_seconds} onChange={(e) => setF({ ...f, episode_seconds: Number(e.target.value) })} />
            </label>
          </div>
          <label>
            영상 스타일 (영어로 쓰면 영상 모델이 더 잘 알아들어요)
            <input value={f.style} maxLength={400} placeholder="cinematic Korean drama, soft warm lighting, 35mm" onChange={(e) => setF({ ...f, style: e.target.value })} />
          </label>
          <div className="chip-row" aria-label="스타일 빠르게 고르기">
            {STYLES.map((st) => (
              <button type="button" key={st.id} className={'chip' + (f.style === st.text ? ' active' : '')} onClick={() => setF({ ...f, style: st.text })}>
                {st.name}
              </button>
            ))}
          </div>
          <label>
            줄거리
            <textarea value={f.synopsis} maxLength={3000} rows={4} onChange={(e) => setF({ ...f, synopsis: e.target.value })} />
          </label>
          <label className="inline-check">
            <input type="checkbox" checked={f.exclude_cn} onChange={(e) => setF({ ...f, exclude_cn: e.target.checked })} />
            이 프로젝트에서는 중국 AI 모델을 쓰지 않기 (자동 선택·대체 모델에서도 빠져요)
          </label>
          <div className="form-actions start">
            <button className="secondary" disabled={busy}>
              {busy ? '저장 중…' : '기획 저장'}
            </button>
            <small role="status" className={dirty ? 'lime' : 'muted'}>{dirty ? '아직 저장하지 않은 변경이 있어요' : '저장된 기획이에요'}</small>
          </div>
        </form>
        {pickers}
        <div className="form-actions start">
          <button className="primary" disabled={busy || dirty || isBusy(jobs, p.id, 'plan')} onClick={onPlan} title={dirty ? '수정한 기획을 먼저 저장해 주세요' : undefined}>
            <Wand2 size={15} /> AI 기획안 만들기
          </button>
          <JobBadge jobs={jobs} targetId={p.id} kind="plan" />
        </div>
        <p className="muted settings-note">
          {dirty && '기획을 저장하면 새 내용으로 AI 기획안을 만들 수 있어요. '}
          기획안을 다시 만들면 이미지를 만든 인물은 그대로 두고, 대본이 있는 회차는 제목·요약만 바뀌어요.
        </p>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>회차 구성</h3>
          </div>
        </div>
        <div className="outline-list">
          {data.episodes.map((e) => (
            <EpisodeHeader key={e.id + e.title + e.summary} e={e} projectId={p.id} act={act} busy={busy} compact />
          ))}
        </div>
      </section>
    </>
  );
}

function EpisodeHeader({
  e,
  projectId,
  act,
  busy,
  compact = false,
}: {
  e: StudioEpisode;
  projectId: string;
  act: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  busy: boolean;
  compact?: boolean;
}) {
  const [f, setF] = useState({ title: e.title, summary: e.summary });
  const dirty = f.title !== e.title || f.summary !== e.summary;
  return (
    <div className={'episode-outline' + (compact ? ' compact' : '')}>
      <b>{e.number}화</b>
      <div>
        <input aria-label={`${e.number}화 제목`} value={f.title} maxLength={100} onChange={(ev) => setF({ ...f, title: ev.target.value })} />
        <textarea aria-label={`${e.number}화 줄거리`} value={f.summary} maxLength={800} rows={compact ? 2 : 3} placeholder="이 회차에서 일어나는 일과 마지막 반전" onChange={(ev) => setF({ ...f, summary: ev.target.value })} />
      </div>
      {dirty && (
        <button className="secondary compact" disabled={busy || !f.title.trim()} onClick={() => void act(() => api(`/studio/ai/projects/${projectId}/episodes/${e.id}`, 'PATCH', f), `${e.number}화를 저장했어요.`)}>
          저장
        </button>
      )}
    </div>
  );
}

function CharacterCard({
  c,
  projectId,
  models,
  data,
  busy,
  act,
  onImage,
  onSample,
  useAsset,
}: {
  c: StudioCharacter;
  projectId: string;
  models: AiModelOption[];
  data: StudioProjectDetail;
  busy: boolean;
  act: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  onImage: () => void;
  onSample: () => void;
  useAsset: (id: string) => void;
}) {
  const [f, setF] = useState({ name: c.name, role: c.role, description: c.description, look: c.look, voice_model: c.voice_model || 'auto', voice: c.voice || '' });
  const dirty = JSON.stringify(f) !== JSON.stringify({ name: c.name, role: c.role, description: c.description, look: c.look, voice_model: c.voice_model || 'auto', voice: c.voice || '' });
  const vm = models.find((m) => m.id === f.voice_model);
  const suggestions = vm ? voiceSuggestions(vm.provider, vm.label) : [...new Set(models.filter((m) => m.capability === 'tts').flatMap((m) => voiceSuggestions(m.provider, m.label)))];
  return (
    <article className="cast-card">
      <div className="cast-image">
        {c.image ? <img src={c.image} alt={c.name + ' 기준 이미지'} /> : <UserRound size={40} />}
      </div>
      <div className="cast-fields">
        <div className="form-columns">
          <label>
            이름
            <input value={f.name} maxLength={30} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label>
            역할
            <input value={f.role} maxLength={60} onChange={(e) => setF({ ...f, role: e.target.value })} />
          </label>
        </div>
        <label>
          성격 · 사연
          <textarea value={f.description} rows={2} maxLength={500} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <label>
          외모 (영어 권장 · 모든 장면에 반복해서 넣어 얼굴을 맞춰요)
          <textarea value={f.look} rows={2} maxLength={500} onChange={(e) => setF({ ...f, look: e.target.value })} />
        </label>
        <div className="form-columns">
          <label>
            목소리 모델
            <select value={f.voice_model} onChange={(e) => setF({ ...f, voice_model: e.target.value })}>
              <option value="auto">자동 선택</option>
              {models
                .filter((m) => m.capability === 'tts')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.provider}
                  </option>
                ))}
            </select>
          </label>
          <label>
            목소리 ID (공급사 음성 이름)
            <input value={f.voice} maxLength={80} list={'voices-' + c.id} placeholder={suggestions[0] ? '예: ' + suggestions.slice(0, 3).join(', ') : '예: alloy, Kore'} onChange={(e) => setF({ ...f, voice: e.target.value })} />
            <datalist id={'voices-' + c.id}>
              {suggestions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
        </div>
        <div className="voice-sample">
          <button className="secondary compact" disabled={isBusy(data.jobs, c.id, 'voice_sample') || dirty} onClick={onSample} title={dirty ? '먼저 저장해 주세요' : ''}>
            <Mic size={13} /> {c.voice_sample ? '목소리 다시 듣기' : '목소리 미리듣기'}
          </button>
          <JobBadge jobs={data.jobs} targetId={c.id} kind="voice_sample" />
          {c.voice_sample && <audio controls preload="none" src={studioMedia(c.voice_sample)} />}
        </div>
        <div className="board-tools">
          {dirty && (
            <button className="primary compact" disabled={busy} onClick={() => void act(() => api(`/studio/ai/projects/${projectId}/characters/${c.id}`, 'PATCH', f), `${f.name} 정보를 저장했어요.`)}>
              저장
            </button>
          )}
          <button className="secondary compact" disabled={isBusy(data.jobs, c.id, 'character_image') || dirty} onClick={onImage}>
            <ImageIcon size={13} /> {c.image ? '이미지 다시' : '기준 이미지'}
          </button>
          <JobBadge jobs={data.jobs} targetId={c.id} kind="character_image" />
          <Versions assets={data.assets} targetId={c.id} kind="image" current={c.image} onUse={useAsset} />
          <button className="secondary compact" aria-label={c.name + ' 삭제'} disabled={busy} onClick={() => void act(() => api(`/studio/ai/projects/${projectId}/characters/${c.id}`, 'DELETE'), '인물을 지웠어요.')}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}

function ShotEditor({
  s,
  index,
  total,
  cast,
  act,
  busy,
  jobs,
  onRewrite,
}: {
  s: StudioShot;
  index: number;
  total: number;
  cast: StudioCharacter[];
  act: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  busy: boolean;
  jobs: StudioProjectDetail['jobs'];
  onRewrite: (instruction: string) => void;
}) {
  const [ask, setAsk] = useState<string | null>(null);
  const [f, setF] = useState({ scene: s.scene, visual: s.visual, dialogue: s.dialogue, speaker_id: s.speaker_id, camera: s.camera, seconds: s.seconds });
  const dirty = JSON.stringify(f) !== JSON.stringify({ scene: s.scene, visual: s.visual, dialogue: s.dialogue, speaker_id: s.speaker_id, camera: s.camera, seconds: s.seconds });
  return (
    <article className="shot-row">
      <div className="shot-index">
        <b>#{index + 1}</b>
        <button aria-label="위로" disabled={busy || index === 0} onClick={() => void act(() => api(`/studio/ai/shots/${s.id}/move`, 'POST', { direction: 'up' }))}>
          <ArrowUp size={13} />
        </button>
        <button aria-label="아래로" disabled={busy || index === total - 1} onClick={() => void act(() => api(`/studio/ai/shots/${s.id}/move`, 'POST', { direction: 'down' }))}>
          <ArrowDown size={13} />
        </button>
      </div>
      <div className="shot-fields">
        <div className="form-columns">
          <label>
            장면
            <input value={f.scene} maxLength={200} onChange={(e) => setF({ ...f, scene: e.target.value })} />
          </label>
          <label className="narrow">
            카메라
            <input value={f.camera} maxLength={80} onChange={(e) => setF({ ...f, camera: e.target.value })} />
          </label>
          <label className="narrow">
            길이(초)
            <input type="number" min={2} max={10} value={f.seconds} onChange={(e) => setF({ ...f, seconds: Number(e.target.value) })} />
          </label>
        </div>
        <label>
          화면 묘사 (영상·이미지 모델에게 전달돼요)
          <textarea value={f.visual} rows={2} maxLength={800} onChange={(e) => setF({ ...f, visual: e.target.value })} />
        </label>
        <div className="form-columns">
          <label className="narrow">
            말하는 인물
            <select value={f.speaker_id || ''} onChange={(e) => setF({ ...f, speaker_id: e.target.value || null })}>
              <option value="">없음</option>
              {cast.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            대사
            <input value={f.dialogue} maxLength={300} onChange={(e) => setF({ ...f, dialogue: e.target.value })} />
          </label>
        </div>
        <div className="board-tools">
          {dirty && (
            <button className="primary compact" disabled={busy || !f.visual.trim()} onClick={() => void act(() => api(`/studio/ai/shots/${s.id}`, 'PATCH', f), `${index + 1}번 컷을 저장했어요.`)}>
              저장
            </button>
          )}
          <button className="secondary compact" disabled={dirty || isBusy(jobs, s.id, 'rewrite_shot')} title={dirty ? '먼저 저장해 주세요' : ''} onClick={() => setAsk(ask === null ? '' : null)}>
            <Sparkles size={13} /> AI로 고치기
          </button>
          <JobBadge jobs={jobs} targetId={s.id} kind="rewrite_shot" />
          {s.image && <small className="muted">이미지 ✓</small>}
          {s.audio && <small className="muted">음성 ✓</small>}
          {s.video && <small className="muted">영상 ✓</small>}
          <button className="secondary compact" aria-label={`${index + 1}번 컷 삭제`} disabled={busy} onClick={() => void act(() => api(`/studio/ai/shots/${s.id}`, 'DELETE'), '컷을 지웠어요.')}>
            <Trash2 size={13} />
          </button>
        </div>
        {ask !== null && (
          <form
            className="rewrite-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (ask.trim().length < 2) return;
              onRewrite(ask.trim());
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
              <input aria-label="고칠 방향" value={ask} maxLength={300} placeholder="어떻게 고칠까요? 예: 남주가 먼저 고백하게" onChange={(e) => setAsk(e.target.value)} autoFocus />
              <button className="primary compact" disabled={ask.trim().length < 2}>
                <Wand2 size={13} /> 고치기
              </button>
            </div>
            <small className="muted">장면·화면 묘사·대사를 이 컷만 다시 써요. 대사가 바뀌면 기존 음성은 다시 만들어야 해요.</small>
          </form>
        )}
      </div>
    </article>
  );
}

function ComposeStep({
  data,
  busy,
  act,
  jobs,
  pickers,
  onPoster,
  onPreview,
  useAsset,
}: {
  data: StudioProjectDetail;
  busy: boolean;
  act: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  jobs: StudioProjectDetail['jobs'];
  pickers: React.ReactNode;
  onPoster: () => void;
  onPreview: (e: StudioEpisode) => void;
  useAsset: (id: string) => void;
}) {
  const p = data.project;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const candidates = useMemo(
    () => [
      ...(p.poster ? [p.poster] : []),
      ...data.characters.map((c) => c.image).filter(Boolean),
      ...data.episodes.flatMap((e) => e.shots.map((s) => s.image)).filter(Boolean),
    ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 12),
    [data],
  );
  return (
    <>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>회차 합성</h3>
            <p>컷 영상(없으면 스토리보드 이미지)과 대사 음성을 이어 붙여 세로 MP4 한 편과 자막을 만들어요. 라마가 들지 않아요.</p>
          </div>
        </div>
        <div className="compose-list">
          {data.episodes.map((e) => {
            const ready = e.shots.length > 0 && e.shots.every((s) => s.video || s.image);
            const pending = e.shots.some((s) => ['shot_image', 'shot_tts', 'shot_video'].some((k) => isBusy(jobs, s.id, k)));
            return (
              <article key={e.id} className="compose-row">
                <div>
                  <strong>{e.title.startsWith(`${e.number}화`) ? e.title : `${e.number}화 · ${e.title}`}</strong>
                  <small>
                    컷 {e.shots.length}개 · 영상 {e.shots.filter((s) => s.video).length} · 음성 {e.shots.filter((s) => s.audio).length} ·{' '}
                    {statusText[e.status] || e.status}
                    {e.duration ? ` · ${e.duration}초` : ''}
                    {e.exported_at ? ' · 내보냄' : ''}
                  </small>
                  {errors[e.id] && <small className="danger">{errors[e.id]}</small>}
                </div>
                {e.video && e.status !== 'composing' && (
                  <video controls preload="none" playsInline src={studioMedia(e.video)}>
                    {e.subtitles && <track kind="subtitles" srcLang="ko" label="한국어" default src={`/api/studio/ai/episodes/${e.id}/subtitles`} />}
                  </video>
                )}
                <button className="secondary compact" aria-label={`${e.number}화 미리보기`} disabled={!e.shots.some((s) => s.image || s.video)} onClick={() => onPreview(e)}>
                  <Eye size={13} /> 미리보기
                </button>
                <button
                  className="primary compact"
                  disabled={busy || !ready || pending || e.status === 'composing'}
                  onClick={() =>
                    void act(async () => {
                      await api(`/studio/ai/projects/${p.id}/episodes/${e.id}/compose`, 'POST');
                      setErrors((x) => ({ ...x, [e.id]: '' }));
                    }, `${e.number}화 합성을 시작했어요.`)
                  }
                >
                  {e.status === 'composing' ? '합성 중…' : e.video ? '다시 합성' : '합성하기'}
                </button>
                {e.status === 'compose_failed' && (
                  <button
                    className="text-link"
                    onClick={async () => {
                      const r = await api<{ error: string }>(`/studio/ai/projects/${p.id}/episodes/${e.id}/compose`);
                      setErrors((x) => ({ ...x, [e.id]: r.error || '합성에 실패했어요.' }));
                    }}
                  >
                    실패 이유 보기
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>포스터 · 썸네일</h3>
            <p>AI로 포스터를 만들거나, 인물·스토리보드 이미지 중 하나를 골라 작품 포스터로 써요.</p>
          </div>
        </div>
        {pickers}
        <div className="form-actions start">
          <button className="primary" disabled={isBusy(jobs, p.id, 'poster')} onClick={onPoster}>
            <Sparkles size={15} /> AI 포스터 만들기
          </button>
          <JobBadge jobs={jobs} targetId={p.id} kind="poster" />
          <Versions assets={data.assets} targetId={p.id} kind="image" current={p.poster} onUse={useAsset} />
        </div>
        <div className="frame-picker poster-candidates">
          <div>
            {candidates.map((url) => (
              <button
                key={url}
                className={url === p.poster ? 'selected' : ''}
                disabled={busy}
                onClick={() => void act(() => api(`/studio/ai/projects/${p.id}/poster`, 'PUT', { image: url }), '포스터를 골랐어요.')}
              >
                <img src={url} alt="포스터 후보" />
              </button>
            ))}
          </div>
        </div>
        {!candidates.length && <p className="muted">아직 고를 이미지가 없어요.</p>}
      </section>
    </>
  );
}
function ExportStep({ data, notify, reload }: { data: StudioProjectDetail; notify: (s: string) => void; reload: () => Promise<void> }) {
  const p = data.project;
  const composed = data.episodes.filter((e) => e.video);
  const [f, setF] = useState({ tagline: p.logline.slice(0, 120), episode_pings: 0, free_episodes: 1, free: false });
  const [busy, setBusy] = useState(false);
  const locked = !!data.drama && !['draft', 'rejected'].includes(data.drama.status);
  const go = async (submit: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ submitted: boolean; episodes: number }>(`/studio/ai/projects/${p.id}/export`, 'POST', { ...f, submit });
      await reload();
      notify(r.submitted ? `${r.episodes}개 회차를 작품으로 내보내고 검수를 신청했어요.` : `${r.episodes}개 회차를 작품으로 내보냈어요. 내 작품에서 이어서 수정할 수 있어요.`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>작품으로 내보내기 · 검수 신청</h3>
          <p>
            합성한 회차가 작품의 회차로 등록되고 ‘AI 제작’ 표시가 붙어요. 직접 업로드한 작품과 같은 검수 절차를 거쳐
            공개돼요.
          </p>
        </div>
      </div>
      {data.drama && (
        <div className="info-box">
          연결된 작품: <b>{data.drama.title}</b> · 상태 {({ draft: '임시저장', pending: '심사 대기', published: '공개 중', rejected: '반려', hidden: '노출 중단' } as Record<string, string>)[data.drama.status] || data.drama.status}
          {data.drama.review_note && ` · 검토 의견: ${data.drama.review_note}`}
          <button className="text-link" onClick={() => navigate('studio/contents')}>
            내 작품에서 보기
          </button>
        </div>
      )}
      <p className="muted settings-note">
        내보낼 회차: {composed.length ? composed.map((e) => `${e.number}화`).join(', ') : '없음 (합성 단계에서 회차를 먼저 합성하세요)'}
        {' · '}포스터: {p.poster ? '선택됨' : '없으면 첫 인물 이미지를 써요'}
      </p>
      <label>
        한 줄 소개
        <input value={f.tagline} maxLength={120} minLength={2} onChange={(e) => setF({ ...f, tagline: e.target.value })} />
      </label>
      <div className="form-columns">
        <label>
          회차 가격 (핑 · 0이면 기본값)
          <input type="number" min={0} max={1000} value={f.episode_pings} disabled={f.free} onChange={(e) => setF({ ...f, episode_pings: Number(e.target.value) })} />
        </label>
        <label>
          무료 회차 수
          <input type="number" min={1} max={50} value={f.free_episodes} onChange={(e) => setF({ ...f, free_episodes: Number(e.target.value) })} />
        </label>
        <label className="inline-check">
          <input type="checkbox" checked={f.free} onChange={(e) => setF({ ...f, free: e.target.checked })} />전 회차 무료
        </label>
      </div>
      <div className="form-actions start">
        <button className="secondary" disabled={busy || locked || !composed.length || f.tagline.trim().length < 2} onClick={() => void go(false)}>
          작품으로 내보내기
        </button>
        <button className="primary" disabled={busy || locked || !composed.length || f.tagline.trim().length < 2} onClick={() => void go(true)}>
          <Send size={15} /> 내보내고 바로 검수 신청
        </button>
      </div>
      {locked && <p className="muted settings-note">심사 중이거나 공개된 작품은 다시 내보낼 수 없어요. 반려되면 고쳐서 다시 보낼 수 있어요.</p>}
      <div className="cost-breakdown">
        <h4>
          제작 비용 · 총 {lama(data.spent)} <small>≈ {won(data.spent * 10)}</small>
        </h4>
        {data.costs?.length ? (
          <table className="estimate-table">
            <tbody>
              {data.costs.map((c) => (
                <tr key={c.kind}>
                  <td>{jobKindLabel[c.kind] || c.kind}</td>
                  <td>
                    {c.jobs}건{c.failed ? ` · 실패 ${c.failed}(반환)` : ''}
                  </td>
                  <td>{lama(c.lama)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">아직 AI 작업 기록이 없어요.</p>
        )}
      </div>
    </section>
  );
}
