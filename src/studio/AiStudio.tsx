import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Clapperboard,
  FileCheck2,
  Footprints,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, lama, type AiOverview } from '../api';
import { Empty, Modal, navigate } from '../App';
import Workspace from './Workspace';
import { TABS, hasModel, type TabId } from './ws/shared';
import { STYLES, TEMPLATES, type Template } from './presets';
import { effectiveChoices, OptionRow } from './parts';
import TemplateIcon from './TemplateIcon';
import { asset } from '../platform';

// 숏핑 스튜디오(AI 제작) 첫 화면: 이용 약관 동의 → 프로젝트 목록 → 작업 공간
const TERMS = [
  '숏핑 스튜디오로 만든 결과물(대본·이미지·음성·영상)의 저작권은 제작한 PD에게 있어요. 숏핑은 서비스 운영과 작품 홍보(미리보기, 광고 소재, 추천)에 필요한 범위에서 무상으로 이용할 수 있어요.',
  '작업에 따라 OpenAI·Google·Anthropic 등 해외 AI와 중국 AI 공급사(예: Kling, Hailuo, Wan, Seedance, DeepSeek)의 모델을 써요. 입력한 글과 이미지가 해당 공급사 서버(해외 포함)로 전송되어 처리돼요. 개인정보나 실존 인물의 사진·이름은 넣지 마세요.',
  'AI 기본법에 따라 스튜디오로 만든 작품에는 ‘AI 제작’ 표시가 붙고, 공개 전 관리자 검수를 거쳐요.',
  '실존 인물 흉내(딥페이크), 다른 작품의 캐릭터·설정 복제, 선정적·폭력적 내용, 미성년자 관련 부적절한 내용은 만들 수 없고, 발견 시 작품이 반려되거나 이용이 제한될 수 있어요.',
  '라마는 작업을 시작할 때 예상치만큼 예약되고, 끝나면 실제 사용량만 차감돼요. 실패한 작업은 전액 돌려드려요. AI 결과물의 품질은 모델에 따라 다를 수 있어요.',
];

const readStudioRoute = (): { id: string | null; tab: TabId } => {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  const tab = (TABS.some((t) => t.id === p[3]) ? p[3] : 'plan') as TabId;
  return p[0] === 'studio' && p[1] === 'ai' && p[2] ? { id: p[2], tab } : { id: null, tab: 'plan' };
};
// 빠른 제작: 프로젝트를 만들자마자 빠른 제작을 시작합니다(비어 있는 단계만, 정한 라마 안에서).
const quickDefault = { on: true, bible: true, video: false, lipsync: false, sfx: false, music: false, cap: '' };
const blank = {
  title: '',
  logline: '',
  genre: '로맨스',
  tone: '',
  episode_count: 1,
  episode_seconds: 30,
  style: STYLES[0].text,
  exclude_cn: false,
};

export default function AiStudio({
  notify,
  goLama,
}: {
  notify: (s: string) => void;
  goLama: () => void;
}) {
  const [data, setData] = useState<AiOverview | null>(null),
    [error, setError] = useState(''),
    [route, setRoute] = useState(readStudioRoute),
    [creating, setCreating] = useState(false),
    [agree, setAgree] = useState(false),
    [busy, setBusy] = useState(false),
    [removing, setRemoving] = useState<string | null>(null),
    [wizard, setWizard] = useState<1 | 2>(1),
    [templateGenre, setTemplateGenre] = useState('전체'),
    [templateQuery, setTemplateQuery] = useState(''),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [sort, setSort] = useState('recent'),
    [form, setForm] = useState(blank),
    [quick, setQuick] = useState(quickDefault);
  const pick = (t: Template | null) => {
    setForm(
      t
        ? {
            title: t.title,
            logline: t.logline,
            genre: t.genre,
            tone: t.tone,
            episode_count: t.episode_count,
            episode_seconds: t.episode_seconds,
            style: t.style,
            exclude_cn: false,
          }
        : blank,
    );
    setWizard(2);
  };
  const startCreate = () => {
    setWizard(1);
    setTemplateGenre('전체');
    setTemplateQuery('');
    setCreating(true);
  };
  // 작업 공간 주소: #/studio/ai/<프로젝트>/<탭> (새로고침 · 뒤로 가기 · 알림 링크로 바로 열림)
  useEffect(() => {
    const on = () => setRoute(readStudioRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const open = route.id;
  const setOpen = (id: string | null) => navigate(id ? 'studio/ai/' + id : 'studio/ai');
  const load = useCallback(async () => {
    try {
      await api('/lama'); // 첫 방문 체험 라마 지급
      setData(await api<AiOverview>('/studio/ai/overview'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return (
      <Empty
        title="숏핑 스튜디오를 불러오지 못했어요"
        text={error}
        action={() => void load()}
        label="다시 시도"
      />
    );
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  if (open)
    return (
      <Workspace
        projectId={open}
        models={data.models}
        families={data.families || []}
        features={data.features}
        genres={data.genres}
        notify={notify}
        goLama={goLama}
        tab={route.tab}
        setTab={(t) => navigate(`studio/ai/${open}/${t}`, { replace: true })}
        back={() => {
          setOpen(null);
          void load();
        }}
      />
    );
  if (!data.agreed_at)
    return (
      <section className="management-panel studio-terms">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">SHORTPING STUDIO</span>
            <h3>숏핑 스튜디오 이용 약관</h3>
            <p>AI로 숏폼 드라마를 만들기 전에 아래 내용을 확인해 주세요.</p>
            <button className="text-link" onClick={() => navigate('studio/production-guide')}>
              <BookOpen size={15} /> 먼저 제작 가이드 둘러보기
            </button>
          </div>
          <ShieldCheck size={24} className="lime" />
        </div>
        <ol className="terms-list">
          {TERMS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
        <label className="check-row">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>위 내용을 확인했고 동의합니다.</span>
        </label>
        <button
          className="primary full"
          disabled={!agree || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/studio/ai/terms', 'POST', { agree: true, version: data.terms_version });
              await load();
              notify('숏핑 스튜디오를 시작할 수 있어요. 체험 라마를 드렸어요.');
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          동의하고 시작하기
        </button>
      </section>
    );
  const projects = data.projects
    .filter(
      (p) =>
        (!query.trim() ||
          [p.title, p.logline, p.genre]
            .join(' ')
            .toLowerCase()
            .includes(query.trim().toLowerCase())) &&
        (filter === 'all' ||
          (filter === 'exported' ? p.status === 'exported' : p.status !== 'exported')),
    )
    .sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title, 'ko')
        : b.updated_at.localeCompare(a.updated_at),
    );
  return (
    <>
      <div className="studio-hero">
        <div>
          <span className="eyebrow">SHORTPING STUDIO</span>
          <h2>AI로 숏폼 드라마 만들기</h2>
          <p>
            아이디어 한 줄 → 기획 → 캐릭터 → 대본 → 스토리보드·음성 → 영상 → 합성 → 검수 신청까지 한
            곳에서.
          </p>
        </div>
        <div className="studio-hero-side">
          <button className="wallet-chip lama-chip" onClick={goLama}>
            <Sparkles size={14} /> {lama(data.wallet.total)}
          </button>
          <button className="primary" disabled={!data.enabled} onClick={startCreate}>
            <Plus size={16} /> 새 프로젝트
          </button>
        </div>
      </div>
      <div className="creator-start-grid">
        <button
          onClick={() => {
            setForm({
              ...blank,
              title: '나의 첫 숏폼',
              logline: '우연히 발견한 편지 한 장으로 평범한 하루가 완전히 달라진다.',
            });
            setWizard(2);
            setCreating(true);
          }}
          disabled={!data.enabled}
        >
          <span className="creator-card-icon">
            <Sparkles />
          </span>
          <strong>처음이라면, 30초 한 편</strong>
          <p>
            1화 프로젝트로 제작 순서를 익혀요.
            <br />
            설정은 언제든 바꿀 수 있어요.
          </p>
          <span>
            쉬운 시작 <ArrowRight size={15} />
          </span>
        </button>
        <button onClick={() => navigate('studio/contents')}>
          <span className="creator-card-icon">
            <Upload />
          </span>
          <strong>완성된 영상 등록하기</strong>
          <p>
            직접 만든 MP4와 자막을 올리고
            <br />
            회차별로 정리해요.
          </p>
          <span>
            내 작품 · 회차 <ArrowRight size={15} />
          </span>
        </button>
        <button onClick={() => navigate('studio/production-guide')}>
          <span className="creator-card-icon">
            <BookOpen />
          </span>
          <strong>제작 가이드 확인</strong>
          <p>
            대본 예시부터 첫 공개까지,
            <br />
            필요한 내용을 검색해 보세요.
          </p>
          <span>
            매뉴얼 읽기 <ArrowRight size={15} />
          </span>
        </button>
      </div>
      {!data.enabled && (
        <div className="info-box">AI 제작이 잠시 중단된 상태예요. 관리자에게 문의해 주세요.</div>
      )}
      {!data.models.length && (
        <div className="info-box">
          아직 연결된 AI 모델이 없어요. 관리자가 AI 연결 관리에서 모델을 연결하면 사용할 수 있어요.
        </div>
      )}
      <ol className="flow-steps">
        {['기획', '캐릭터', '대본', '스토리보드·음성', '영상', '합성·포스터', '검수 신청'].map(
          (s, i) => (
            <li key={s}>
              <b>{i + 1}</b>
              {s}
            </li>
          ),
        )}
      </ol>
      <div className="creator-project-toolbar">
        <h3>
          내 프로젝트 <small>{data.projects.length}</small>
        </h3>
        <label className="creator-search">
          <Search size={16} />
          <input
            aria-label="프로젝트 검색"
            placeholder="제목·장르·아이디어 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="프로젝트 상태"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">모든 프로젝트</option>
          <option value="working">제작 중</option>
          <option value="exported">내보낸 프로젝트</option>
        </select>
        <select aria-label="프로젝트 정렬" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="recent">최근 수정순</option>
          <option value="title">제목순</option>
        </select>
      </div>
      {projects.length ? (
        <div className="project-grid">
          {projects.map((p) => (
            <article key={p.id} className="project-card">
              <button className="project-open" onClick={() => setOpen(p.id)}>
                <div className="project-poster">
                  {p.poster ? <img src={asset(p.poster)} alt="" /> : <Clapperboard size={34} />}
                </div>
                <div>
                  <span className={'status-chip ' + (p.status === 'exported' ? '' : 'neutral')}>
                    {p.status === 'exported'
                      ? '내보냄'
                      : p.status === 'producing'
                        ? '제작 중'
                        : '기획'}
                  </span>
                  {(p.autopilot || '').includes('"status":"running"') && (
                    <span className="status-chip">
                      <Bot size={11} /> 빠른 제작 중
                    </span>
                  )}
                  <strong>{p.title}</strong>
                  <small>
                    {p.genre} · {p.episode_count}화 · 합성 {p.composed}/{p.episode_total} ·{' '}
                    {lama(p.spent || 0)} 사용
                  </small>
                  <small>{p.logline}</small>
                  <small>
                    최근 수정 {new Date(p.updated_at).toLocaleDateString('ko-KR')} · 클릭해서 이어
                    만들기
                  </small>
                </div>
              </button>
              <button
                className="icon-button"
                aria-label={p.title + ' 삭제'}
                onClick={() => setRemoving(p.id)}
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : data.projects.length ? (
        <Empty
          title="조건에 맞는 프로젝트가 없어요"
          text="다른 검색어나 상태를 선택해 보세요."
          action={() => {
            setQuery('');
            setFilter('all');
          }}
          label="전체 프로젝트 보기"
        />
      ) : (
        <Empty
          title="첫 AI 숏폼 드라마를 만들어 보세요"
          text="아이디어 한 줄이면 충분해요."
          action={data.enabled ? startCreate : undefined}
          label="새 프로젝트"
        />
      )}
      {creating && (
        <Modal
          className={wizard === 1 ? 'template-picker-modal' : ''}
          title={wizard === 1 ? '어떤 드라마를 만들까요?' : '새 AI 제작 프로젝트'}
          close={() => !busy && setCreating(false)}
        >
          {wizard === 1 ? (
            <div className="template-wizard">
              <div className="template-intro">
                <span className="eyebrow">STORY STARTERS · {TEMPLATES.length}</span>
                <p className="muted">
                  마음이 가는 이야기에서 시작하세요.
                  <br />
                  제목·아이디어·스타일을 채워 드려요. 다음 단계에서 모두 바꿀 수 있어요.
                </p>
              </div>
              <label className="creator-search template-search">
                <Search size={16} />
                <input
                  aria-label="제작 템플릿 검색"
                  placeholder="첫사랑, 반전, 판타지…"
                  value={templateQuery}
                  onChange={(e) => setTemplateQuery(e.target.value)}
                />
              </label>
              <div className="template-filters" aria-label="템플릿 장르">
                {['전체', ...data.genres].map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={'chip' + (templateGenre === g ? ' active' : '')}
                    aria-pressed={templateGenre === g}
                    onClick={() => setTemplateGenre(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className="template-grid studio-template-grid">
                {TEMPLATES.filter(
                  (t) =>
                    (templateGenre === '전체' || t.genre === templateGenre) &&
                    [t.name, t.hint, t.logline].join(' ').includes(templateQuery.trim()),
                ).map((t) => (
                  <button key={t.id} className="template-card" onClick={() => pick(t)}>
                    <TemplateIcon id={t.id} genre={t.genre} />
                    <strong>{t.name}</strong>
                    <small>{t.hint}</small>
                    <span className="template-length">
                      {t.episode_count}화 · 회당 {t.episode_seconds}초
                    </span>
                  </button>
                ))}
                <button className="template-card blank" onClick={() => pick(null)}>
                  <TemplateIcon id="blank" />
                  <strong>직접 쓰기</strong>
                  <small>빈 프로젝트로 시작</small>
                </button>
              </div>
              {!TEMPLATES.some(
                (t) =>
                  (templateGenre === '전체' || t.genre === templateGenre) &&
                  [t.name, t.hint, t.logline].join(' ').includes(templateQuery.trim()),
              ) && (
                <div className="info-box">
                  맞는 템플릿이 없어요. 직접 쓰기로 시작하거나{' '}
                  <button
                    className="text-link"
                    onClick={() => {
                      setTemplateGenre('전체');
                      setTemplateQuery('');
                    }}
                  >
                    전체 템플릿 보기
                  </button>
                </div>
              )}
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await api<{ id: string }>('/studio/ai/projects', 'POST', form);
                  setCreating(false);
                  let message = '프로젝트를 만들었어요. 기획 · 설정부터 차례로 만들어 보세요.';
                  if (quick.on) {
                    try {
                      await api(`/studio/ai/projects/${r.id}/autopilot`, 'POST', {
                        choices: effectiveChoices(),
                        includeBible: quick.bible,
                        includeVideo: quick.video,
                        includeLipsync: quick.video && quick.lipsync,
                        includeSfx: quick.sfx,
                        includeMusic: quick.music,
                        musicMood: form.tone,
                        ...(quick.cap ? { cap: Number(quick.cap) } : {}),
                      });
                      message = '빠른 제작을 시작했어요. 화면을 닫아도 계속 만들고, 끝나면 알려 드려요.';
                    } catch (err) {
                      message = `프로젝트는 만들었지만 빠른 제작을 시작하지 못했어요: ${(err as Error).message}`;
                    }
                  }
                  setOpen(r.id);
                  notify(message);
                } catch (err) {
                  notify((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <button type="button" className="text-link" onClick={() => setWizard(1)}>
                <ArrowLeft size={14} /> 템플릿 다시 고르기
              </button>
              <label>
                가제
                <input
                  value={form.title}
                  maxLength={70}
                  required
                  placeholder="예: 자정의 계약"
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </label>
              <label>
                한 줄 아이디어
                <textarea
                  value={form.logline}
                  maxLength={300}
                  minLength={5}
                  required
                  rows={3}
                  placeholder="예: 계약 결혼한 두 사람이 서로의 비밀을 하나씩 알게 된다"
                  onChange={(e) => setForm({ ...form, logline: e.target.value })}
                />
              </label>
              <div className="form-columns">
                <label>
                  장르
                  <select
                    value={form.genre}
                    onChange={(e) => setForm({ ...form, genre: e.target.value })}
                  >
                    {data.genres.map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </select>
                </label>
                <label>
                  분위기
                  <input
                    value={form.tone}
                    maxLength={100}
                    placeholder="설렘, 긴장감…"
                    onChange={(e) => setForm({ ...form, tone: e.target.value })}
                  />
                </label>
              </div>
              <div className="form-columns">
                <label>
                  회차 수
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={form.episode_count}
                    onChange={(e) => setForm({ ...form, episode_count: Number(e.target.value) })}
                  />
                </label>
                <label>
                  회당 길이(초)
                  <input
                    type="number"
                    min={20}
                    max={180}
                    value={form.episode_seconds}
                    onChange={(e) => setForm({ ...form, episode_seconds: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="field-label">영상 스타일</div>
              <div className="chip-row">
                {STYLES.map((st) => (
                  <button
                    type="button"
                    key={st.id}
                    className={'chip' + (form.style === st.text ? ' active' : '')}
                    onClick={() => setForm({ ...form, style: st.text })}
                  >
                    {st.name}
                  </button>
                ))}
              </div>
              <div className="opt-list">
                <OptionRow checked={form.exclude_cn} onChange={(v) => setForm({ ...form, exclude_cn: v })} title="중국 AI 모델 쓰지 않기" desc="Kling · Hailuo · Wan 같은 중국 모델을 이 프로젝트에서 빼요." />
              </div>
              <div className="mode-choice" role="radiogroup" aria-label="제작 방식">
                <button type="button" role="radio" aria-checked={quick.on} className={quick.on ? 'active' : ''} onClick={() => setQuick({ ...quick, on: true })}>
                  <Bot size={16} />
                  <span>
                    <b>빠른 제작</b> 만들자마자 기획부터 합성까지 AI가 한 번에
                  </span>
                </button>
                <button type="button" role="radio" aria-checked={!quick.on} className={!quick.on ? 'active' : ''} onClick={() => setQuick({ ...quick, on: false })}>
                  <Footprints size={16} />
                  <span>
                    <b>단계별 제작</b> 컷 하나하나 직접 고르고 고치며
                  </span>
                </button>
              </div>
              {quick.on ? (
                <div className="quick-options">
                  <div className="opt-list">
                    <OptionRow checked={quick.bible} onChange={(v) => setQuick({ ...quick, bible: v })} title="설정집 · 시즌 설계 먼저" desc="회차끼리 이야기가 잘 이어져요." />
                    <OptionRow
                      checked={quick.video}
                      onChange={(v) => setQuick({ ...quick, video: v, lipsync: v && quick.lipsync })}
                      title="컷 영상까지 만들기"
                      desc="비용이 커요. 끄면 이미지에 카메라 움직임을 넣은 화면으로 무료 합성해요."
                    />
                    {hasModel(data.models, 'lipsync') && (
                      <OptionRow checked={quick.lipsync} disabled={!quick.video} onChange={(v) => setQuick({ ...quick, lipsync: v })} title="대사 컷 입 모양 맞추기" desc="컷 영상을 만들 때만 쓸 수 있어요." />
                    )}
                    {hasModel(data.models, 'sfx') && <OptionRow checked={quick.sfx} onChange={(v) => setQuick({ ...quick, sfx: v })} title="효과음 넣기" desc="문 닫히는 소리처럼 장면에 맞는 소리를 더해요." />}
                    {hasModel(data.models, 'music') && <OptionRow checked={quick.music} onChange={(v) => setQuick({ ...quick, music: v })} title="배경음악 만들기" desc="작품 분위기에 맞는 음악을 만들어 깔아요." />}
                  </div>
                  {!hasModel(data.models, 'music') && <small className="muted">배경음악 · 효과음 · 입 모양 맞추기는 관리자가 모델을 준비하면 고를 수 있어요.</small>}
                  <label>
                    최대 사용 라마 <small className="muted">비우면 예상치의 1.3배 · 보유 {lama(data.wallet.total)}</small>
                    <input type="number" min={1} value={quick.cap} placeholder="자동" onChange={(e) => setQuick({ ...quick, cap: e.target.value.replace(/\D/g, '') })} />
                  </label>
                  <div className="info-box">
                    <FileCheck2 size={18} />
                    정한 라마를 넘으면 스스로 멈추고, 실패한 작업은 라마를 돌려드려요. 진행 중에도 언제든 멈추거나 직접 고칠 수 있어요.
                  </div>
                </div>
              ) : (
                <div className="info-box">
                  <FileCheck2 size={18} />
                  프로젝트를 만드는 데는 라마가 들지 않아요. 기획 · 대본 · 장면 · 완성 순서로 직접 만들어요.
                </div>
              )}
              <button className="primary full" disabled={busy}>
                {busy ? '만드는 중…' : quick.on ? '만들고 빠른 제작 시작' : '프로젝트 만들기'}
              </button>
            </form>
          )}
        </Modal>
      )}
      {removing && (
        <Modal title="프로젝트 삭제" close={() => !busy && setRemoving(null)}>
          <p className="muted">
            프로젝트와 제작 기록이 지워져요. 이미 내보낸 작품은 그대로 남아요.
          </p>
          <div className="form-actions">
            <button className="secondary" onClick={() => setRemoving(null)}>
              취소
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/studio/ai/projects/' + removing, 'DELETE');
                  setRemoving(null);
                  await load();
                  notify('프로젝트를 삭제했어요.');
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              삭제
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
