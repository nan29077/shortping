import { useState } from 'react';
import { BookOpen, ImageIcon, Layers, MapPin, Mic, Plus, ScrollText, Trash2, UserRound, Wand2 } from 'lucide-react';
import { api, parseJson, studioMedia, type StudioCharacter, type StudioEpisode, type StudioLocation } from '../../api';
import AutopilotPanel from '../Autopilot';
import { useAutosave, useSyncedForm, hasHangul } from '../hooks';
import { JobBadge, Versions, isBusy } from '../parts';
import { STYLES } from '../presets';
import { ModelSettings, NotReady, SaveBadge, Section, hasModel, runningCount, type WS } from './shared';
import VoicePicker from './VoicePicker';
import { asset } from '../../platform';

type Bible = {
  world: string;
  rules: string;
  relations: string;
  speech: { name: string; style: string }[];
  taboos: string;
  foreshadow: { hint: string; payoff: string; episode: number }[];
};
const emptyBible: Bible = { world: '', rules: '', relations: '', speech: [], taboos: '', foreshadow: [] };
type Season = { arc?: string; paywall_from?: number; paywall_reason?: string };
export const VOICE_STYLES = ['', '차분하게', '밝고 경쾌하게', '냉정하게', '다정하게', '긴장감 있게', '능청스럽게', '울먹이며', '화난 듯이'];
const POSES: { id: string; name: string }[] = [
  { id: 'front', name: '정면' },
  { id: 'side', name: '옆모습' },
  { id: 'full', name: '전신' },
  { id: 'smile', name: '웃는 표정' },
  { id: 'angry', name: '화난 표정' },
  { id: 'sad', name: '슬픈 표정' },
];

export default function PlanTab({ ws, genres }: { ws: WS; genres: string[] }) {
  const { data } = ws;
  return (
    <>
      <AutopilotPanel data={data} models={ws.models} notify={ws.notify} reload={ws.load} goLama={ws.goLama} compact />
      <StoryForm ws={ws} genres={genres} />
      <AdaptSection ws={ws} />
      <BibleSection ws={ws} />
      <SeasonSection ws={ws} />
      <Section
        title="인물"
        desc="기준 이미지를 만들면 모든 장면에서 같은 얼굴 · 의상을 유지하는 데 참고해요. 외모는 한국어로 써도 자동으로 영어로 바꿔 전달해요."
        badge={<em className="ws-count">{data.characters.length}/8</em>}
        actions={
          <button
            className="secondary compact"
            disabled={ws.busy || data.characters.length >= 8}
            onClick={() => void ws.act(() => api(`/studio/ai/projects/${data.project.id}/characters`, 'POST', { name: '새 인물', role: '조연' }), '인물을 추가했어요.')}
          >
            <Plus size={14} /> 인물 추가
          </button>
        }
      >
        <ModelSettings ws={ws} caps={['image', 'tts']} />
        {!data.characters.length && <p className="muted">위에서 AI 기획안을 만들면 인물이 자동으로 채워져요. 직접 추가해도 돼요.</p>}
        <div className="ws-cast">
          {data.characters.map((c) => (
            <CharacterCard key={c.id} ws={ws} c={c} />
          ))}
        </div>
      </Section>
      <LocationSection ws={ws} />
      <NarratorSection ws={ws} />
    </>
  );
}

// ── 이야기(기본 기획) ──────────────────────────────────────────
function StoryForm({ ws, genres }: { ws: WS; genres: string[] }) {
  const p = ws.data.project;
  const server = {
    title: p.title,
    genre: p.genre,
    logline: p.logline,
    tone: p.tone,
    style: p.style,
    synopsis: p.synopsis,
    episode_seconds: Number(p.episode_seconds),
    exclude_cn: !!Number(p.exclude_cn),
  };
  const [f, setF] = useSyncedForm(server);
  const valid = f.title.trim().length >= 1 && f.logline.trim().length >= 5 && f.episode_seconds >= 20 && f.episode_seconds <= 180;
  const save = useAutosave(f, server, async (v) => {
    await api('/studio/ai/projects/' + p.id, 'PATCH', v);
    void ws.load();
  }, { enabled: valid });
  const planBusy = isBusy(ws.data.jobs, p.id, 'plan');
  const setCount = async (n: number) => {
    const cur = Number(p.episode_count);
    if (n === cur) return;
    if (n < cur) {
      const lost = ws.data.episodes.filter((e) => e.number > n);
      if (lost.some((e) => e.shots.length || e.exported_at)) {
        ws.notify(`${lost.filter((e) => e.shots.length || e.exported_at).map((e) => e.number + '화').join(', ')}에 대본이 있어 회차 수를 줄일 수 없어요.`);
        return;
      }
      if (lost.some((e) => e.summary.trim()) && !(await ws.ask({ title: '회차 수 줄이기', text: `${n + 1}화부터 ${cur}화까지의 제목과 줄거리가 지워져요. 줄일까요?`, ok: '줄이기', danger: true })))
        return;
    }
    if (!(await save.flush()) && save.dirty) return;
    await ws.act(() => api('/studio/ai/projects/' + p.id, 'PATCH', { ...f, episode_count: n }), `${n}화로 바꿨어요.`);
  };
  const plan = async () => {
    if (!(await save.flush())) {
      ws.notify(valid ? '기획을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.' : '제목과 한 줄 아이디어(5자 이상)를 먼저 채워 주세요.');
      return;
    }
    if (ws.data.characters.length && !(await ws.ask({ title: 'AI 기획안 다시 만들기', text: '인물과 회차 구성을 새로 만들어요. 기준 이미지가 있는 인물은 그대로 두고, 대본이 있는 회차는 제목 · 요약만 바뀌어요.', ok: '다시 만들기' })))
      return;
    ws.run('AI 기획안 만들기', 'plan', 'text');
  };
  return (
    <Section title="이야기" desc="한 줄 아이디어만 적어도 AI가 제목 · 줄거리 · 인물 · 회차 구성을 만들어요. 입력하면 자동으로 저장돼요." badge={<SaveBadge state={save.state} error={save.error} dirty={save.dirty} hint={!valid ? '제목과 한 줄 아이디어(5자 이상)를 채우면 저장돼요' : undefined} />}>
      <div className="form-columns">
        <label>
          제목
          <input value={f.title} maxLength={70} onChange={(e) => setF({ ...f, title: e.target.value })} />
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
        <input value={f.logline} maxLength={300} placeholder="예: 계약 결혼한 재벌 3세가 사실은 첫사랑이었다" onChange={(e) => setF({ ...f, logline: e.target.value })} />
      </label>
      <div className="form-columns">
        <label>
          분위기
          <input value={f.tone} maxLength={100} placeholder="예: 설렘, 긴장감, 유쾌함" onChange={(e) => setF({ ...f, tone: e.target.value })} />
        </label>
        <label>
          회차 수
          <select value={Number(p.episode_count)} disabled={ws.busy} onChange={(e) => void setCount(Number(e.target.value))}>
            {Array.from({ length: 60 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}화
              </option>
            ))}
          </select>
        </label>
        <label>
          회당 길이(초)
          <input type="number" min={20} max={180} value={f.episode_seconds} onChange={(e) => setF({ ...f, episode_seconds: Number(e.target.value) })} />
        </label>
      </div>
      <label>
        영상 스타일 <small className="muted">한국어로 써도 돼요</small>
        <input value={f.style} maxLength={400} placeholder="예: 따뜻한 조명의 한국 드라마, 35mm 필름 느낌" onChange={(e) => setF({ ...f, style: e.target.value })} />
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
        <input type="checkbox" checked={f.exclude_cn} onChange={(e) => setF({ ...f, exclude_cn: e.target.checked })} />이 프로젝트에서는 중국 AI 모델을 쓰지 않기
      </label>
      <ModelSettings ws={ws} caps={['text']} />
      <div className="form-actions start">
        <button className="primary" disabled={planBusy} onClick={() => void plan()}>
          <Wand2 size={15} /> {ws.data.characters.length ? 'AI 기획안 다시 만들기' : 'AI 기획안 만들기'}
        </button>
        <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="plan" onRetry={() => void plan()} />
      </div>
    </Section>
  );
}

// ── 원작 각색 ────────────────────────────────────────────────
function AdaptSection({ ws }: { ws: WS }) {
  const p = ws.data.project;
  const server = { source_text: p.source_text || '' };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', v));
  const go = async () => {
    if (!(await save.flush())) return;
    if (ws.data.characters.length && !(await ws.ask({ title: '원작으로 다시 각색하기', text: '제목 · 줄거리 · 인물 · 회차 구성이 원작 내용으로 바뀌어요. 기준 이미지가 있는 인물과 대본이 있는 회차의 대본은 그대로 남아요.', ok: '각색하기' })))
      return;
    ws.run('원작을 드라마로 각색하기', 'adapt', 'text');
  };
  return (
    <Section
      title="원작 각색"
      desc="직접 쓴 시놉시스 · 웹소설 원고를 붙여 넣으면 회차 구성과 인물을 뽑아 드라마로 각색해요. 본인에게 권리가 있는 글만 넣어 주세요."
      defaultOpen={!!p.source_text}
      badge={<SaveBadge state={save.state} error={save.error} dirty={save.dirty} />}
    >
      <label>
        원작 <small className="muted">{f.source_text.length.toLocaleString('ko-KR')} / 30,000자</small>
        <textarea value={f.source_text} rows={8} maxLength={30000} placeholder="시놉시스나 원고를 붙여 넣으세요 (50자 이상)" onChange={(e) => setF({ source_text: e.target.value })} />
      </label>
      <div className="form-actions start">
        <button className="primary" disabled={f.source_text.trim().length < 50 || isBusy(ws.data.jobs, p.id, 'adapt')} onClick={() => void go()}>
          <ScrollText size={15} /> AI로 각색하기
        </button>
        <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="adapt" onRetry={() => void go()} />
      </div>
    </Section>
  );
}

// ── 설정집 ──────────────────────────────────────────────────
function BibleSection({ ws }: { ws: WS }) {
  const p = ws.data.project;
  const server = { ...emptyBible, ...parseJson<Partial<Bible>>(p.bible, {}) };
  const [f, setF] = useSyncedForm<Bible>(server);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${p.id}/bible`, 'PUT', v));
  const empty = !p.bible;
  const go = async () => {
    if (!(await save.flush())) return;
    if (!empty && !(await ws.ask({ title: '설정집 다시 만들기', text: '지금 설정집 내용이 AI가 만든 내용으로 바뀌어요.', ok: '다시 만들기' }))) return;
    ws.run('AI 설정집 만들기', 'bible', 'text');
  };
  return (
    <Section
      title="설정집"
      desc="세계관 · 인물 관계 · 말투 · 복선을 정리해 두면 모든 회차 대본이 이 설정을 지켜요."
      defaultOpen={!empty}
      badge={<SaveBadge state={save.state} error={save.error} dirty={save.dirty} />}
      actions={
        <>
          <button className="secondary compact" disabled={!ws.data.characters.length || isBusy(ws.data.jobs, p.id, 'bible')} onClick={() => void go()}>
            <BookOpen size={14} /> {empty ? 'AI로 만들기' : 'AI로 다시 만들기'}
          </button>
          <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="bible" onRetry={() => void go()} />
        </>
      }
    >
      {!ws.data.characters.length && <p className="muted">기획안(인물)을 먼저 만들면 AI로 설정집을 만들 수 있어요.</p>}
      <label>
        세계관 · 배경
        <textarea rows={3} maxLength={1500} value={f.world} onChange={(e) => setF({ ...f, world: e.target.value })} />
      </label>
      <label>
        꼭 지킬 설정 (직업 · 나이 · 관계의 사실)
        <textarea rows={3} maxLength={1500} value={f.rules} onChange={(e) => setF({ ...f, rules: e.target.value })} />
      </label>
      <label>
        인물 관계
        <textarea rows={3} maxLength={1500} value={f.relations} onChange={(e) => setF({ ...f, relations: e.target.value })} />
      </label>
      <div className="ws-list-edit">
        <strong>인물별 말투</strong>
        {f.speech.map((s, i) => (
          <div key={i} className="ws-row">
            <input aria-label="인물 이름" value={s.name} maxLength={30} placeholder="이름" onChange={(e) => setF({ ...f, speech: f.speech.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <input aria-label="말투" value={s.style} maxLength={200} placeholder="예: 반말, 끝에 '~거든' 입버릇" onChange={(e) => setF({ ...f, speech: f.speech.map((x, j) => (j === i ? { ...x, style: e.target.value } : x)) })} />
            <button type="button" className="icon-button" aria-label="말투 지우기" onClick={() => setF({ ...f, speech: f.speech.filter((_, j) => j !== i) })}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {f.speech.length < 10 && (
          <button type="button" className="text-link" onClick={() => setF({ ...f, speech: [...f.speech, { name: ws.data.characters.find((c) => !f.speech.some((s) => s.name === c.name))?.name || '', style: '' }] })}>
            <Plus size={13} /> 말투 추가
          </button>
        )}
      </div>
      <label>
        쓰면 안 되는 전개 · 표현
        <textarea rows={2} maxLength={800} value={f.taboos} onChange={(e) => setF({ ...f, taboos: e.target.value })} />
      </label>
      <div className="ws-list-edit">
        <strong>복선과 회수</strong>
        {f.foreshadow.map((s, i) => (
          <div key={i} className="ws-row">
            <input aria-label="복선" value={s.hint} maxLength={200} placeholder="복선" onChange={(e) => setF({ ...f, foreshadow: f.foreshadow.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)) })} />
            <input aria-label="회수 방법" value={s.payoff} maxLength={200} placeholder="어떻게 회수할지" onChange={(e) => setF({ ...f, foreshadow: f.foreshadow.map((x, j) => (j === i ? { ...x, payoff: e.target.value } : x)) })} />
            <select aria-label="회수 회차" value={s.episode} onChange={(e) => setF({ ...f, foreshadow: f.foreshadow.map((x, j) => (j === i ? { ...x, episode: Number(e.target.value) } : x)) })}>
              <option value={0}>회차 미정</option>
              {ws.data.episodes.map((e) => (
                <option key={e.id} value={e.number}>
                  {e.number}화
                </option>
              ))}
            </select>
            <button type="button" className="icon-button" aria-label="복선 지우기" onClick={() => setF({ ...f, foreshadow: f.foreshadow.filter((_, j) => j !== i) })}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {f.foreshadow.length < 20 && (
          <button type="button" className="text-link" onClick={() => setF({ ...f, foreshadow: [...f.foreshadow, { hint: '', payoff: '', episode: 0 }] })}>
            <Plus size={13} /> 복선 추가
          </button>
        )}
      </div>
    </Section>
  );
}

// ── 시즌 설계 · 회차 구성 ─────────────────────────────────────
function SeasonSection({ ws }: { ws: WS }) {
  const p = ws.data.project;
  const season = parseJson<Season>(p.season, {});
  const go = async () => {
    if (p.season && !(await ws.ask({ title: '시즌 다시 설계하기', text: '회차 제목 · 줄거리 · 훅 · 클리프행어가 새로 설계한 내용으로 바뀌어요(대본은 그대로).', ok: '다시 설계' }))) return;
    ws.run('AI 시즌 설계', 'season', 'text');
  };
  return (
    <Section
      title="시즌 설계 · 회차 구성"
      desc="회차마다 첫 3초 훅과 마지막 클리프행어를 정하고, 어느 회차부터 유료로 할지 정해요."
      actions={
        <>
          <button className="secondary compact" disabled={!ws.data.characters.length || isBusy(ws.data.jobs, p.id, 'season')} onClick={() => void go()}>
            <Layers size={14} /> {p.season ? 'AI로 다시 설계' : 'AI로 시즌 설계'}
          </button>
          <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="season" onRetry={() => void go()} />
        </>
      }
    >
      {season.arc && (
        <div className="info-box ws-arc">
          <b>전체 흐름</b> {season.arc}
        </div>
      )}
      <div className="form-columns">
        <label>
          유료 시작 회차 <small className="muted">작품으로 내보낼 때 무료 회차 수로 써요</small>
          <select
            value={season.paywall_from || ''}
            onChange={(e) => e.target.value && void ws.act(() => api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', { paywall_from: Number(e.target.value) }), '유료 시작 회차를 정했어요.')}
          >
            <option value="">정하지 않음</option>
            {ws.data.episodes.map((e) => (
              <option key={e.id} value={e.number}>
                {e.number}화부터 유료 (무료 {e.number - 1}화)
              </option>
            ))}
          </select>
        </label>
        {season.paywall_reason && <p className="muted ws-reason">AI 제안 이유: {season.paywall_reason}</p>}
      </div>
      <div className="ws-outline">
        {ws.data.episodes.map((e) => (
          <EpisodeOutline key={e.id} ws={ws} e={e} />
        ))}
      </div>
    </Section>
  );
}
export function EpisodeOutline({ ws, e, full = true }: { ws: WS; e: StudioEpisode; full?: boolean }) {
  const server = { title: e.title, summary: e.summary, hook: e.hook || '', cliffhanger: e.cliffhanger || '' };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${ws.data.project.id}/episodes/${e.id}`, 'PATCH', v), { enabled: !!f.title.trim() });
  return (
    <div className="ws-episode-outline">
      <b>{e.number}화</b>
      <div>
        <div className="ws-row">
          <input aria-label={`${e.number}화 제목`} value={f.title} maxLength={100} onChange={(ev) => setF({ ...f, title: ev.target.value })} />
          <SaveBadge state={save.state} error={save.error} />
        </div>
        <textarea aria-label={`${e.number}화 줄거리`} value={f.summary} maxLength={800} rows={2} placeholder="이 회차에서 일어나는 일" onChange={(ev) => setF({ ...f, summary: ev.target.value })} />
        {full && (
          <div className="form-columns">
            <label>
              첫 3초 훅
              <input value={f.hook} maxLength={200} placeholder="시작하자마자 눈을 붙잡을 장면" onChange={(ev) => setF({ ...f, hook: ev.target.value })} />
            </label>
            <label>
              클리프행어
              <input value={f.cliffhanger} maxLength={300} placeholder="다음 화가 궁금해지는 마지막 장면" onChange={(ev) => setF({ ...f, cliffhanger: ev.target.value })} />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 인물 카드 ────────────────────────────────────────────────
function CharacterCard({ ws, c }: { ws: WS; c: StudioCharacter }) {
  const pid = ws.data.project.id;
  const server = {
    name: c.name,
    role: c.role,
    description: c.description,
    look: c.look,
    outfit: c.outfit || '',
    voice_model: c.voice_model || 'auto',
    voice: c.voice || '',
    voice_style: c.voice_style || '',
  };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${pid}/characters/${c.id}`, 'PATCH', v), { enabled: !!f.name.trim() });
  const [voiceOpen, setVoiceOpen] = useState(false);
  const refs = parseJson<{ pose: string; url: string }[]>(c.refs, []);
  const jobs = ws.data.jobs;
  const sheetRunning = runningCount(jobs, (j) => j.kind === 'character_ref' && j.target_id === c.id);
  const runAfterSave = async (fn: () => void) => {
    if (!(await save.flush())) return;
    fn();
  };
  const translated = hasHangul(f.look) && c.look_en && c.look_en_src === f.look;
  const remove = async () => {
    if (!(await ws.ask({ title: `${c.name} 지우기`, text: '이 인물을 지우면 컷의 화자 · 등장 인물에서도 빠져요. 되돌릴 수 없어요.', ok: '지우기', danger: true }))) return;
    await ws.act(() => api(`/studio/ai/projects/${pid}/characters/${c.id}`, 'DELETE'), '인물을 지웠어요.');
  };
  return (
    <article className="ws-cast-card">
      <div className="ws-cast-media">
        {c.image ? <img src={asset(c.image)} alt={c.name + ' 기준 이미지'} /> : <UserRound size={40} />}
        <div className="ws-cast-tools">
          <button className="secondary compact" disabled={isBusy(jobs, c.id, 'character_image')} onClick={() => void runAfterSave(() => ws.run(`${f.name} 기준 이미지 만들기`, 'character_image', 'image', { targetId: c.id }))}>
            <ImageIcon size={13} /> {c.image ? '다시' : '기준 이미지'}
          </button>
          <JobBadge jobs={jobs} targetId={c.id} kind="character_image" />
          <Versions assets={ws.data.assets} targetId={c.id} kind="image" current={c.image} onUse={ws.useAsset} />
        </div>
        <div className="ws-refs">
          {refs.map((r) => (
            <a key={r.pose} href={asset(r.url)} target="_blank" rel="noreferrer" title={POSES.find((x) => x.id === r.pose)?.name || r.pose}>
              <img src={asset(r.url)} alt={`${c.name} ${POSES.find((x) => x.id === r.pose)?.name || r.pose}`} />
            </a>
          ))}
        </div>
        <button
          className="text-link"
          disabled={!c.image || sheetRunning > 0}
          title={!c.image ? '기준 이미지를 먼저 만들어 주세요' : ''}
          onClick={() => void runAfterSave(() => ws.run(`${f.name} 참고 이미지 세트(정면 · 옆 · 전신 · 표정)`, 'character_sheet', 'image', { targetId: c.id }))}
        >
          <Layers size={13} /> {sheetRunning ? `참고 이미지 만드는 중 (${sheetRunning})` : refs.length ? '참고 이미지 다시 만들기' : '참고 이미지 세트 만들기'}
        </button>
      </div>
      <div className="ws-cast-fields">
        <div className="ws-row">
          <SaveBadge state={save.state} error={save.error} />
          <button className="icon-button" aria-label={c.name + ' 지우기'} disabled={ws.busy} onClick={() => void remove()}>
            <Trash2 size={14} />
          </button>
        </div>
        <div className="form-columns">
          <label>
            이름
            <input value={f.name} maxLength={30} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label>
            역할
            <input value={f.role} maxLength={60} placeholder="예: 여주인공" onChange={(e) => setF({ ...f, role: e.target.value })} />
          </label>
        </div>
        <label>
          성격 · 사연
          <textarea value={f.description} rows={2} maxLength={500} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <label>
          외모 <small className="muted">{translated ? '영어로 바꿔 두었어요 ✓' : '나이 · 머리 · 얼굴 특징'}</small>
          <textarea value={f.look} rows={2} maxLength={500} placeholder="예: 20대 후반 여성, 어깨 길이 흑발, 날카로운 눈매" onChange={(e) => setF({ ...f, look: e.target.value })} />
        </label>
        <label>
          기본 의상
          <input value={f.outfit} maxLength={200} placeholder="예: 베이지 트렌치코트, 흰 셔츠" onChange={(e) => setF({ ...f, outfit: e.target.value })} />
        </label>
        <div className="ws-voice-summary">
          <span>
            <Mic size={13} /> 목소리 {f.voice ? <b>{f.voice}</b> : <i>자동</i>}
            {f.voice_style && <small> · {f.voice_style}</small>}
          </span>
          <button type="button" className="text-link" onClick={() => setVoiceOpen(!voiceOpen)}>
            {voiceOpen ? '접기' : '목소리 고르기'}
          </button>
        </div>
        {voiceOpen && (
          <>
            <VoicePicker model={f.voice_model} voice={f.voice} notify={ws.notify} onChange={(v) => setF({ ...f, voice_model: v.model, voice: v.voice })} />
            <label>
              기본 말투
              <select value={f.voice_style} onChange={(e) => setF({ ...f, voice_style: e.target.value })}>
                {VOICE_STYLES.map((v) => (
                  <option key={v} value={v}>
                    {v || '지정 안 함'}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="ws-row">
          <button className="secondary compact" disabled={isBusy(jobs, c.id, 'voice_sample')} onClick={() => void runAfterSave(() => ws.run(`${f.name} 목소리로 대사 들어 보기`, 'voice_sample', 'tts', { targetId: c.id }))}>
            <Mic size={13} /> 이 인물 목소리로 들어 보기
          </button>
          <JobBadge jobs={jobs} targetId={c.id} kind="voice_sample" />
          {c.voice_sample && <audio controls preload="none" src={studioMedia(c.voice_sample)} />}
        </div>
      </div>
    </article>
  );
}

// ── 장소 ────────────────────────────────────────────────────
function LocationSection({ ws }: { ws: WS }) {
  const list = ws.data.locations || [];
  const pid = ws.data.project.id;
  return (
    <Section
      title="장소"
      desc="자주 나오는 장소를 만들어 두고 컷에 지정하면 컷마다 같은 배경으로 그려요."
      defaultOpen={list.length > 0}
      badge={<em className="ws-count">{list.length}/12</em>}
      actions={
        <button className="secondary compact" disabled={ws.busy || list.length >= 12} onClick={() => void ws.act(() => api(`/studio/ai/projects/${pid}/locations`, 'POST', { name: '새 장소', look: '' }), '장소를 추가했어요.')}>
          <Plus size={14} /> 장소 추가
        </button>
      }
    >
      {!list.length && <p className="muted">예: 여주인공의 원룸, 회사 로비, 비 오는 골목</p>}
      <div className="ws-locations">
        {list.map((l) => (
          <LocationCard key={l.id} ws={ws} l={l} />
        ))}
      </div>
    </Section>
  );
}
function LocationCard({ ws, l }: { ws: WS; l: StudioLocation }) {
  const pid = ws.data.project.id;
  const server = { name: l.name, look: l.look };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${pid}/locations/${l.id}`, 'PATCH', v), { enabled: !!f.name.trim() });
  const used = ws.data.episodes.flatMap((e) => e.shots).filter((s) => s.location_id === l.id).length;
  return (
    <article className="ws-location">
      <div className="ws-location-media">{l.image ? <img src={asset(l.image)} alt={l.name} /> : <MapPin size={28} />}</div>
      <div>
        <div className="ws-row">
          <input aria-label="장소 이름" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <SaveBadge state={save.state} error={save.error} />
        </div>
        <textarea aria-label="장소 모습" rows={2} maxLength={500} value={f.look} placeholder="예: 창밖으로 한강이 보이는 좁은 원룸, 따뜻한 스탠드 조명" onChange={(e) => setF({ ...f, look: e.target.value })} />
        <div className="ws-row">
          <button
            className="secondary compact"
            disabled={isBusy(ws.data.jobs, l.id, 'location_image') || !f.look.trim()}
            onClick={async () => {
              if (!(await save.flush())) return;
              ws.run(`${f.name} 장소 이미지`, 'location_image', 'image', { targetId: l.id });
            }}
          >
            <ImageIcon size={13} /> {l.image ? '다시' : '장소 이미지'}
          </button>
          <JobBadge jobs={ws.data.jobs} targetId={l.id} kind="location_image" />
          <small className="muted">컷 {used}개에서 사용</small>
          <button
            className="icon-button"
            aria-label={`${l.name} 지우기`}
            onClick={async () => {
              if (used && !(await ws.ask({ title: '장소 지우기', text: `컷 ${used}개에서 이 장소 지정이 풀려요.`, ok: '지우기', danger: true }))) return;
              await ws.act(() => api(`/studio/ai/projects/${pid}/locations/${l.id}`, 'DELETE'), '장소를 지웠어요.');
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}

// ── 내레이터 ─────────────────────────────────────────────────
function NarratorSection({ ws }: { ws: WS }) {
  const p = ws.data.project;
  const server = { narrator_model: p.narrator_model || 'auto', narrator_voice: p.narrator_voice || '' };
  const [f, setF] = useSyncedForm(server);
  const save = useAutosave(f, server, (v) => api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', v));
  const narrated = ws.data.episodes.flatMap((e) => e.shots).filter((s) => Number(s.narration)).length;
  return (
    <Section title="내레이션 목소리" desc="장면 편집에서 ‘내레이션’으로 표시한 컷은 이 목소리로 읽어요." defaultOpen={narrated > 0} badge={<SaveBadge state={save.state} error={save.error} />}>
      {!hasModel(ws.models, 'tts') ? <NotReady what="음성" /> : <VoicePicker label="내레이터" model={f.narrator_model} voice={f.narrator_voice} notify={ws.notify} onChange={(v) => setF({ narrator_model: v.model, narrator_voice: v.voice })} />}
      <small className="muted">내레이션 컷 {narrated}개</small>
    </Section>
  );
}
