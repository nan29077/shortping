import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Bot, Check, ChevronDown, Clapperboard, Footprints, Loader2, RefreshCw, Sparkles, Upload, Wand2, X } from 'lucide-react';
import { api, lama, type AiModelOption, type LamaWallet } from '../api';
import { navigate } from '../App';
import { STYLES, TEMPLATES, type Template } from './presets';
import TemplateIcon from './TemplateIcon';
import { asset } from '../platform';
import NumberInput from '../NumberInput';
import './ws/editor.css';
import './home.css';

// 힉스필드 · 폴로 벤치마킹 2단계(2026-09-30): AI 드라마 제작 첫 화면.
// 화면 한가운데 아이디어 입력창 하나. 아래 칩으로 장르 · 회차 · 길이 · 스타일 · 분위기를 정하고,
// ‘첫 컷 미리 보기’로 기획을 기다리지 않고 대표 컷 하나를 먼저 봐요(이미지 1장 라마). 마음에 들면 그 톤으로 프로젝트를 만들어요.

export type StartForm = {
  title: string;
  logline: string;
  genre: string;
  tone: string;
  episode_count: number;
  episode_seconds: number;
  style: string;
  exclude_cn: boolean;
};
export type FirstShot = { url: string; lama: number; model?: string; seed: number };

type Est = { lama: number; model: string; wallet: LamaWallet };

// 작은 칩 + 아래로 열리는 판(컷 에디터의 칩과 같은 생김새)
function Chip({ icon, label, value, children, on, disabled }: { icon?: ReactNode; label: string; value: string; children: ReactNode | ((close: () => void) => ReactNode); on?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className={'se-chipwrap' + (open ? ' open' : '')} ref={ref}>
      <button type="button" className={'se-chip' + (on ? ' on' : '')} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(!open)}>
        {icon}
        <span>
          <small>{label}</small>
          <b>{value}</b>
        </span>
        <ChevronDown size={12} className="se-chip-caret" />
      </button>
      {open && (
        <div className="se-pop" role="dialog" aria-label={label}>
          <div className="se-pop-head">
            <strong>{label}</strong>
            <button type="button" className="icon-button" aria-label="닫기" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <div className="se-pop-body">{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>
        </div>
      )}
    </div>
  );
}

export default function StartHero({
  form,
  setForm,
  genres,
  models,
  wallet,
  enabled,
  firstShot,
  setFirstShot,
  onContinue,
  onOpenTemplates,
  onReverse,
  notify,
  goLama,
  onSpent,
}: {
  form: StartForm;
  setForm: (f: StartForm) => void;
  genres: string[];
  models: AiModelOption[];
  wallet: LamaWallet;
  enabled: boolean;
  firstShot: FirstShot | null;
  setFirstShot: (f: FirstShot | null) => void;
  onContinue: (mode: 'quick' | 'steps') => void;
  onOpenTemplates: () => void;
  onReverse: () => void;
  notify: (s: string) => void;
  goLama: () => void;
  // 첫 컷을 만들고 나면 지갑 잔액을 새로 불러오게 해요
  onSpent?: () => void;
}) {
  const [genreFilter, setGenreFilter] = useState('전체');
  const [est, setEst] = useState<Est | null>(null);
  const [estError, setEstError] = useState('');
  const [tier, setTier] = useState<'draft' | 'standard' | 'premium'>('standard');
  // 만드는 중인 첫 컷은 이 탭에 기억해 두어, 잠깐 다른 화면에 갔다 와도 결과를 받아요.
  const JOB_KEY = 'shortping.firstShot.job';
  const [job, setJobState] = useState<{ id: string; lama: number; seed: number; model?: string } | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null');
    } catch {
      return null;
    }
  });
  const setJob = (j: { id: string; lama: number; seed: number; model?: string } | null) => {
    setJobState(j);
    try {
      if (j) sessionStorage.setItem(JOB_KEY, JSON.stringify(j));
      else sessionStorage.removeItem(JOB_KEY);
    } catch {}
  };
  const [error, setError] = useState('');
  const inflight = useRef(false); // 더블클릭 · Ctrl+Enter 연타로 두 번 결제되지 않게
  const formRef = useRef(form);
  formRef.current = form;
  const box = useRef<HTMLTextAreaElement>(null);
  const ready = form.logline.trim().length >= 5;
  const hasImage = models.some((m) => m.capability === 'image');
  const styleName = STYLES.find((s) => s.text === form.style)?.name || '직접 적음';

  // 예상 라마(라마 들지 않음): 아이디어 · 장르 · 스타일 · 품질이 바뀌면 잠깐 뒤 다시 계산
  useEffect(() => {
    if (!ready || !hasImage) {
      setEst(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api<Est>('/studio/ai/tools/first-shot/estimate', 'POST', { logline: form.logline.trim(), genre: form.genre, tone: form.tone, style: form.style, tier })
        .then((r) => alive && (setEst(r), setEstError('')))
        .catch((e) => alive && (setEst(null), setEstError((e as Error).message || '예상 라마를 계산하지 못했어요.')));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [form.logline, form.genre, form.tone, form.style, tier, ready, hasImage]);

  // 첫 컷 작업 상태 확인(1.5초마다)
  useEffect(() => {
    if (!job) return;
    let alive = true;
    let misses = 0;
    const tick = async () => {
      try {
        const j = await api<{ status: string; error?: string; output: { url?: string }; charged_lama: number; estimate_lama: number }>(`/studio/ai/tools/jobs/${job.id}`);
        if (!alive) return;
        misses = 0;
        if (j.status === 'succeeded' && j.output?.url) {
          setFirstShot({ url: j.output.url, lama: Number(j.charged_lama || j.estimate_lama), model: job.model, seed: job.seed });
          setJob(null);
          onSpent?.();
          return;
        }
        if (j.status === 'failed' || j.status === 'canceled') {
          setError(j.error || '첫 컷을 만들지 못했어요. 라마는 돌려드렸어요.');
          setJob(null);
          onSpent?.();
          return;
        }
      } catch (e) {
        if (!alive) return;
        // 잠깐 끊긴 연결은 몇 번 더 기다려요(작업은 서버에서 계속 돼요).
        if (++misses >= 6 || (e as { status?: number }).status === 404) {
          setError((e as Error).message);
          setJob(null);
          return;
        }
      }
      timer = setTimeout(tick, 1500);
    };
    let timer = setTimeout(tick, 1200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  // override: '다른 스타일로 다시 뽑기'처럼 방금 바꾼 값으로 바로 만들 때(상태 반영을 기다리지 않아요)
  const shoot = async (override: Partial<StartForm> = {}) => {
    const cur = { ...formRef.current, ...override };
    if (!enabled || !hasImage || inflight.current || job) return;
    if (cur.logline.trim().length < 5) {
      notify('아이디어를 다섯 글자 이상 적어 주세요.');
      box.current?.focus();
      return;
    }
    if (est && est.wallet.total < est.lama) {
      notify(`라마가 모자라요. 필요 ${lama(est.lama)} · 보유 ${lama(est.wallet.total)}`);
      goLama();
      return;
    }
    inflight.current = true;
    setError('');
    setFirstShot(null);
    const seed = Math.floor(Math.random() * 1000000) + 1;
    try {
      const r = await api<{ id: string; lama: number }>('/studio/ai/tools/first-shot', 'POST', { logline: cur.logline.trim(), genre: cur.genre, tone: cur.tone, style: cur.style, tier, seed });
      setJob({ ...r, seed, model: est?.model });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current = false;
    }
  };
  const applyTemplate = (t: Template) => {
    setForm({ ...form, title: t.title, logline: t.logline, genre: t.genre, tone: t.tone, episode_count: t.episode_count, episode_seconds: t.episode_seconds, style: t.style });
    setFirstShot(null);
    setError('');
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => box.current?.focus(), 350);
  };
  const running = !!job;
  const templates = TEMPLATES.filter((t) => genreFilter === '전체' || t.genre === genreFilter);
  const templateGenres = ['전체', ...genres.filter((g) => TEMPLATES.some((t) => t.genre === g))];
  return (
    <section className="ai-home" aria-label="새 드라마 시작">
      <div className="ai-hero">
        <span className="eyebrow">SHORTPING STUDIO</span>
        <h2>당신의 이야기를 숏폼 드라마로</h2>
        <p>아이디어 한 줄이면 시작해요. 첫 컷을 먼저 보여 드리고, 마음에 들면 그 톤으로 기획 · 대본 · 컷을 이어 만들어요.</p>
        <button type="button" className="wallet-chip lama-chip ai-hero-wallet" onClick={goLama}>
          <Sparkles size={14} /> 보유 {lama(wallet.total)}
        </button>
      </div>

      <div className={'ai-start' + (firstShot || running ? ' has-shot' : '')}>
        <div className="ai-start-main">
          <textarea
            ref={box}
            rows={3}
            maxLength={300}
            value={form.logline}
            disabled={!enabled}
            aria-label="한 줄 아이디어"
            placeholder="어떤 이야기를 만들까요? 예: 계약 결혼한 두 사람이 서로의 비밀을 하나씩 알게 된다"
            onChange={(e) => {
              setForm({ ...form, logline: e.target.value });
              if (firstShot) setFirstShot(null);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void shoot();
            }}
          />
          <p className="sr-only" aria-live="polite">{running ? '첫 컷을 만드는 중' : firstShot ? '첫 컷이 준비됐어요' : ''}</p>
          <div className="ai-start-bar">
            <div className="ai-start-chips">
              <Chip icon={<Clapperboard size={13} />} label="장르" value={form.genre} on>
                {(close) => (
                  <div className="chip-row">
                    {genres.map((g) => (
                      <button type="button" key={g} className={'chip' + (form.genre === g ? ' active' : '')} onClick={() => (setForm({ ...form, genre: g }), close())}>
                        {g}
                      </button>
                    ))}
                  </div>
                )}
              </Chip>
              <Chip label="분량" value={`${form.episode_count}화 · 회당 ${form.episode_seconds}초`}>
                <div className="form-columns">
                  <label>
                    회차 수
                    <NumberInput min={1} max={60} value={form.episode_count} onChange={(e) => setForm({ ...form, episode_count: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })} />
                  </label>
                  <label>
                    회당 길이(초)
                    <NumberInput min={20} max={180} step={5} value={form.episode_seconds} onChange={(e) => setForm({ ...form, episode_seconds: Math.min(180, Math.max(20, Number(e.target.value) || 20)) })} />
                  </label>
                </div>
                <div className="chip-row">
                  {[
                    ['맛보기', 1, 30],
                    ['짧은 시즌', 6, 45],
                    ['정규 시즌', 12, 60],
                  ].map(([n, c, s]) => (
                    <button type="button" key={n} className={'chip' + (form.episode_count === c && form.episode_seconds === s ? ' active' : '')} onClick={() => setForm({ ...form, episode_count: c as number, episode_seconds: s as number })}>
                      {n} · {c}화 · {s}초
                    </button>
                  ))}
                </div>
              </Chip>
              <Chip icon={<Wand2 size={13} />} label="영상 스타일" value={styleName} on={!!form.style}>
                {(close) => (
                  <div className="ai-styles">
                    {STYLES.map((st) => (
                      <button type="button" key={st.id} className={'se-model' + (form.style === st.text ? ' on' : '')} onClick={() => (setForm({ ...form, style: st.text }), close())}>
                        <b>{st.name}</b>
                        <small>{st.text}</small>
                      </button>
                    ))}
                  </div>
                )}
              </Chip>
              <Chip label="분위기" value={form.tone || '자동'} on={!!form.tone}>
                <label>
                  분위기 <small className="muted">예: 설렘, 긴장감, 따뜻한</small>
                  <input value={form.tone} maxLength={100} placeholder="비워 두면 장르에 맞게" onChange={(e) => setForm({ ...form, tone: e.target.value })} />
                </label>
                <div className="chip-row">
                  {['설렘', '긴장감', '따뜻한', '쓸쓸한', '유쾌한', '서늘한', '웅장한'].map((t) => (
                    <button type="button" key={t} className={'chip' + (form.tone === t ? ' active' : '')} onClick={() => setForm({ ...form, tone: form.tone === t ? '' : t })}>
                      {t}
                    </button>
                  ))}
                </div>
              </Chip>
              <Chip label="첫 컷 품질" value={{ draft: '초안', standard: '표준', premium: '고급' }[tier]}>
                {(close) => (
                  <div className="hub-seg small" role="radiogroup" aria-label="첫 컷 품질">
                    {(['draft', 'standard', 'premium'] as const).map((t) => (
                      <button key={t} type="button" role="radio" aria-checked={tier === t} className={tier === t ? 'active' : ''} onClick={() => (setTier(t), close())}>
                        {{ draft: '초안', standard: '표준', premium: '고급' }[t]}
                        <small>{t === 'draft' ? '싸고 빠르게' : t === 'premium' ? '가장 좋게' : '균형'}</small>
                      </button>
                    ))}
                  </div>
                )}
              </Chip>
            </div>
            <div className="ai-start-actions">
              <button type="button" className="secondary ai-shoot" disabled={!enabled || !hasImage || running || !ready} title={!hasImage ? '관리자가 이미지 모델을 연결하면 쓸 수 있어요' : !ready ? '아이디어를 먼저 적어 주세요' : 'Ctrl/⌘ + Enter'} onClick={() => void shoot()}>
                {running ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
                <span>
                  {running ? '첫 컷 만드는 중…' : firstShot ? '다시 뽑기' : '첫 컷 미리 보기'}
                  <small>{running ? '보통 30초 안에 나와요' : est ? `✦ ${lama(est.lama)}` : estError ? '예상 불가' : hasImage && ready ? '계산 중…' : '이미지 1장 라마'}</small>
                </span>
              </button>
              <button type="button" className="primary ai-go" disabled={!enabled || !ready} onClick={() => onContinue('quick')}>
                <Bot size={15} />
                <span>
                  만들기
                  <small>{firstShot ? '이 느낌으로 이어서' : '설정 확인 후 시작'}</small>
                </span>
              </button>
            </div>
          </div>
          {error && (
            <div className="ai-start-error" role="alert">
              {error}
              <button type="button" className="text-link" onClick={() => setError('')}>
                닫기
              </button>
            </div>
          )}
          {est && !running && !firstShot && <small className="ai-start-note muted">첫 컷은 {est.model}로 만들어요 · 예상치만큼 예약하고 끝나면 실제 사용량만 차감 · 실패하면 전액 환불</small>}
          {estError && !running && <small className="ai-start-note danger">첫 컷 예상 라마를 계산하지 못했어요: {estError}</small>}
        </div>
        {(firstShot || running) && (
          <div className="ai-shot">
            <div className="ai-shot-frame">
              {firstShot ? <img src={asset(firstShot.url)} alt="첫 컷 미리 보기" /> : <span className="ai-shot-loading"><Loader2 size={22} className="spin" /> 첫 컷을 그리는 중…</span>}
            </div>
            {firstShot && (
              <div className="ai-shot-side">
                <strong>이 느낌이면 될까요?</strong>
                <small className="muted">{lama(firstShot.lama)} 사용{firstShot.model ? ` · ${firstShot.model}` : ''}. 이어 만들면 이 컷이 포스터와 스타일 참고가 돼요.</small>
                <button type="button" className="primary" disabled={!enabled} onClick={() => onContinue('quick')}>
                  <Bot size={14} /> 이 느낌으로 빠른 제작
                </button>
                <button type="button" className="secondary" disabled={!enabled} onClick={() => onContinue('steps')}>
                  <Footprints size={14} /> 이 느낌으로 단계별 제작
                </button>
                <div className="ai-shot-tools">
                  <button type="button" className="chip" onClick={() => void shoot()}>
                    <RefreshCw size={12} /> 다시 뽑기
                  </button>
                  {STYLES.filter((s) => s.text !== form.style)
                    .slice(0, 3)
                    .map((s) => (
                      <button type="button" key={s.id} className="chip" title={`${s.name} 스타일로 다시 뽑아요`} onClick={() => (setForm({ ...form, style: s.text }), void shoot({ style: s.text }))}>
                        {s.name}로
                      </button>
                    ))}
                  <button type="button" className="chip" onClick={() => setFirstShot(null)}>
                    <X size={12} /> 버리기
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="ai-strip-head">
        <span className="eyebrow">STORY STARTERS · {TEMPLATES.length}</span>
        <div className="ai-strip-filters" role="group" aria-label="템플릿 장르">
          {templateGenres.map((g) => (
            <button key={g} type="button" className={'chip' + (genreFilter === g ? ' active' : '')} aria-pressed={genreFilter === g} onClick={() => setGenreFilter(g)}>
              {g}
            </button>
          ))}
        </div>
        <button type="button" className="text-link" onClick={onOpenTemplates}>
          전체 보기 <ArrowRight size={13} />
        </button>
      </div>
      <ul className="ai-strip">
        {templates.map((t) => (
          <li key={t.id}>
            <button type="button" className={'ai-card' + (form.logline === t.logline ? ' on' : '')} disabled={!enabled} onClick={() => applyTemplate(t)} title={t.logline}>
              <TemplateIcon id={t.id} genre={t.genre} />
              <strong>{t.name}</strong>
              <small>{t.hint}</small>
              <em>
                {t.genre} · {t.episode_count}화 · 회당 {t.episode_seconds}초
              </em>
              {form.logline === t.logline && <i className="ai-card-on" aria-label="적용됨"><Check size={12} /></i>}
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="ai-card util" onClick={onReverse} disabled={!enabled}>
            <span className="ai-card-icon"><Clapperboard size={20} /></span>
            <strong>영상에서 대본 뽑기</strong>
            <small>완성 영상의 자막으로 대본을 복원해 새 프로젝트로</small>
          </button>
        </li>
        <li>
          <button type="button" className="ai-card util" onClick={() => navigate('studio/contents')}>
            <span className="ai-card-icon"><Upload size={20} /></span>
            <strong>완성된 영상 등록</strong>
            <small>직접 만든 MP4와 자막을 올리고 회차별로 정리</small>
          </button>
        </li>
        <li>
          <button type="button" className="ai-card util" onClick={() => navigate('studio/production-guide')}>
            <span className="ai-card-icon"><BookOpen size={20} /></span>
            <strong>제작 가이드</strong>
            <small>대본 예시부터 첫 공개까지</small>
          </button>
        </li>
      </ul>
    </section>
  );
}
