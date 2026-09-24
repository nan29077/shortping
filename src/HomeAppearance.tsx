import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  History,
  ImagePlus,
  LayoutList,
  Megaphone,
  Monitor,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  X,
} from 'lucide-react';
import {
  api,
  rotationSlot,
  defaultHomeAppearance,
  defaultHomeLayout,
  defaultHomeStyle,
  type CopyKey,
  type Drama,
  type HomeAppearance as Appearance,
  type HomeLayout,
  type HomeNotice,
  type HomeSectionId,
  type HomeStyle,
  type HomeTheme,
} from './api';
import { useConfirm } from './confirm';
import { asset } from './platform';
import './home-admin.css';

type SectionMeta = { id: HomeSectionId; name: string; title: string; subtitle: string };
type AdminLayout = Omit<HomeLayout, 'notice'> & { notice: Required<HomeNotice> };
type HistoryRow = { id: string; kind: 'appearance' | 'layout'; data: Record<string, unknown>; created_at: string; actor_name: string | null };
type Tab = 'margin' | 'layout' | 'notice' | 'history';

const emptyNotice: Required<HomeNotice> = { enabled: false, text: '', link: '', tone: 'lime', start: '', end: '' };
const toAdminLayout = (l?: Partial<HomeLayout> | null): AdminLayout => ({
  ...defaultHomeLayout,
  ...(l || {}),
  hero: { ...defaultHomeLayout.hero, ...(l?.hero || {}) },
  curated: { ...defaultHomeLayout.curated, ...(l?.curated || {}) },
  editorial: { ...defaultHomeLayout.editorial, ...(l?.editorial || {}) },
  sections: l?.sections?.length ? l.sections : defaultHomeLayout.sections,
  notice: { ...emptyNotice, ...(l?.notice || {}) } as Required<HomeNotice>,
});
const withStyle = (a: Appearance): Appearance => ({ ...a, style: { ...defaultHomeStyle, ...(a.style || {}), colors: { ...defaultHomeStyle.colors, ...(a.style?.colors || {}) } } });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROTATE_HOURS = 4;

// 카피 기본 색(빈 값일 때 실제 화면에 쓰이는 색) — 색 고르기 칸의 시작 색으로 보여 줍니다.
const COPY_DEFAULT: Record<CopyKey, string> = {
  eyebrow: '#dbe8de',
  headline: '#f3f3f1',
  highlight: '#c4f562',
  description: '#e1ebe4',
  caption: '#e0e9e2',
  copyright: '#c7d4cb',
};
const SWATCHES = ['#ffffff', '#f3f3f1', '#c4f562', '#b28cff', '#ffd66b', '#ff8fb1', '#7fd4ff', '#ff6b6b', '#111519'];
const COPY_FIELDS: { key: CopyKey; label: string; max: number; multiline?: boolean }[] = [
  { key: 'eyebrow', label: '영문 보조 문구', max: 60 },
  { key: 'headline', label: '메인 문구', max: 40 },
  { key: 'highlight', label: '강조 문구', max: 40 },
  { key: 'description', label: '설명', max: 160, multiline: true },
  { key: 'caption', label: '하단 한 줄', max: 80 },
  { key: 'copyright', label: '저작권 표기', max: 60 },
];
const FOCUS: { id: HomeStyle['focus']; name: string }[] = [
  { id: 'center', name: '가운데' },
  { id: 'top', name: '위' },
  { id: 'bottom', name: '아래' },
  { id: 'left', name: '왼쪽' },
  { id: 'right', name: '오른쪽' },
];
const TONES: { id: HomeNotice['tone']; name: string }[] = [
  { id: 'lime', name: '연두' },
  { id: 'violet', name: '보라' },
  { id: 'red', name: '빨강(긴급)' },
  { id: 'neutral', name: '무채색' },
];
const INTERVALS = [
  { v: 0, name: '기본(6.5초)' },
  { v: 4, name: '4초' },
  { v: 8, name: '8초' },
  { v: 12, name: '12초' },
  { v: -1, name: '자동 넘김 끄기' },
];
const kst = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
// datetime-local(한국 시각) ↔ ISO
const toLocal = (iso: string) => {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 9 * 3600000);
  return d.toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v + ':00+09:00').toISOString() : '');

export default function HomeAppearance({
  notify,
  onAppearance,
  onHomeLayout,
}: {
  notify: (message: string) => void;
  onAppearance: (appearance: Appearance) => void;
  onHomeLayout?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('margin');
  const [appearance, setAppearance] = useState<Appearance>(withStyle(defaultHomeAppearance));
  const [savedAppearance, setSavedAppearance] = useState<Appearance>(withStyle(defaultHomeAppearance));
  const [layout, setLayout] = useState<AdminLayout>(toAdminLayout(null));
  const [savedLayout, setSavedLayout] = useState<AdminLayout>(toAdminLayout(null));
  const [themes, setThemes] = useState<HomeTheme[]>([]);
  const [sections, setSections] = useState<SectionMeta[]>([]);
  const [dramas, setDramas] = useState<Drama[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ask, confirmUi] = useConfirm();

  async function load() {
    setLoading(true);
    try {
      const [result, list] = await Promise.all([
        api<{ appearance: Appearance; themes: HomeTheme[]; layout: HomeLayout; sections: SectionMeta[] }>('/admin/home-appearance'),
        api<Drama[]>('/dramas').catch(() => [] as Drama[]),
      ]);
      const a = withStyle(result.appearance);
      const l = toAdminLayout(result.layout);
      setAppearance(a);
      setSavedAppearance(a);
      setLayout(l);
      setSavedLayout(l);
      setThemes(result.themes);
      setSections(result.sections || []);
      setDramas(list.filter((d) => !d.status || d.status === 'published'));
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appearanceDirty = !same(appearance, savedAppearance);
  const layoutDirty = !same({ ...layout, notice: null }, { ...savedLayout, notice: null });
  const noticeDirty = !same(layout.notice, savedLayout.notice);
  // 저장하지 않은 변경이 있으면 창을 닫기 전에 묻습니다.
  useEffect(() => {
    if (!appearanceDirty && !layoutDirty && !noticeDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [appearanceDirty, layoutDirty, noticeDirty]);

  async function saveAppearance() {
    setBusy(true);
    try {
      const a = appearance;
      const result = await api<{ appearance: Appearance }>('/admin/home-appearance', 'PUT', {
        theme: a.theme,
        eyebrow: a.eyebrow,
        headline: a.headline,
        highlight: a.highlight,
        description: a.description,
        caption: a.caption,
        copyright: a.copyright,
        style: a.style,
      });
      const next = withStyle(result.appearance);
      setAppearance(next);
      setSavedAppearance(next);
      onAppearance(result.appearance);
      notify('PC 여백 디자인을 메인페이지에 적용했어요.');
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // 로테이션 스위치는 누르는 즉시 저장합니다(다른 편집 중인 내용은 그대로 두고 로테이션 설정만).
  async function applyRotation(patch: Partial<Pick<HomeStyle, 'rotate' | 'rotateCopy'>>) {
    setBusy(true);
    try {
      const s0 = savedAppearance;
      const style = { ...(s0.style || defaultHomeStyle), ...patch };
      const result = await api<{ appearance: Appearance }>('/admin/home-appearance', 'PUT', {
        theme: s0.theme,
        eyebrow: s0.eyebrow,
        headline: s0.headline,
        highlight: s0.highlight,
        description: s0.description,
        caption: s0.caption,
        copyright: s0.copyright,
        style,
      });
      const next = withStyle(result.appearance);
      // 서버가 로테이션 설정을 모르는 옛 버전이면(서버를 다시 켜지 않음) 저장되지 않으므로 알려 줍니다.
      if (patch.rotate !== undefined && !!next.style?.rotate !== patch.rotate) {
        notify('로테이션 설정이 저장되지 않았어요. 서버를 다시 켠 뒤(npm run dev) 다시 시도해 주세요.');
        return;
      }
      setSavedAppearance(next);
      setAppearance((a) => withStyle({ ...a, style: { ...(a.style || defaultHomeStyle), ...patch } }));
      onAppearance(result.appearance);
      notify(patch.rotate === undefined ? '문구 로테이션 설정을 적용했어요.' : patch.rotate ? '여백 로테이션을 켰어요. 4시간마다 테마가 바뀌어요.' : '여백 로테이션을 껐어요. 고른 테마가 적용돼요.');
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveLayout(message: string) {
    setBusy(true);
    try {
      const result = await api<{ layout: HomeLayout }>('/admin/home-layout', 'PUT', layout);
      const next = toAdminLayout(result.layout);
      setLayout(next);
      setSavedLayout(next);
      onHomeLayout?.();
      notify(message);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <div className="loading home-appearance-loading">
        <span className="spinner" /> 메인페이지 설정을 불러오고 있어요
      </div>
    );

  const tabs: { id: Tab; name: string; icon: typeof Monitor; dirty?: boolean }[] = [
    { id: 'margin', name: 'PC 여백 디자인', icon: Monitor, dirty: appearanceDirty },
    { id: 'layout', name: '메인 화면 구성', icon: LayoutList, dirty: layoutDirty },
    { id: 'notice', name: '공지 띠 배너', icon: Megaphone, dirty: noticeDirty },
    { id: 'history', name: '변경 기록', icon: History },
  ];
  return (
    <section className="home-appearance-panel">
      <div className="management-section-heading">
        <div>
          <span className="eyebrow lime">HOME EXPERIENCE</span>
          <h1>메인 화면 편성 · 디자인</h1>
          <p>PC 화면 양옆 여백의 분위기 · 카피와, 시청자가 처음 보는 메인 화면의 배너 · 섹션 순서 · 공지를 관리해요.</p>
        </div>
        <div className="home-admin-head-actions">
          <a className="secondary compact" href="#/home" target="_blank" rel="noreferrer">
            <Eye size={15} /> 메인페이지 새 창으로 보기
          </a>
          <button
            className="secondary compact"
            disabled={busy}
            onClick={async () => {
              if ((appearanceDirty || layoutDirty || noticeDirty) && !(await ask({ title: '다시 불러올까요?', text: '저장하지 않은 변경이 사라져요.', ok: '다시 불러오기', danger: true }))) return;
              void load();
            }}
          >
            <RefreshCw size={15} /> 다시 불러오기
          </button>
        </div>
      </div>
      <nav className="home-admin-tabs" role="tablist" aria-label="메인페이지 관리">
        {tabs.map(({ id, name, icon: Icon, dirty }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon size={15} /> {name}
            {dirty && <i className="home-admin-dirty" title="저장하지 않은 변경이 있어요" />}
          </button>
        ))}
      </nav>
      {tab === 'margin' && (
        <MarginTab
          appearance={appearance}
          setAppearance={setAppearance}
          saved={savedAppearance}
          themes={themes}
          busy={busy}
          dirty={appearanceDirty}
          save={() => void saveAppearance()}
          applyRotation={(p) => void applyRotation(p)}
          notify={notify}
        />
      )}
      {tab === 'layout' && (
        <LayoutTab
          layout={layout}
          setLayout={setLayout}
          sections={sections}
          dramas={dramas}
          busy={busy}
          dirty={layoutDirty}
          reset={() => setLayout({ ...savedLayout, notice: layout.notice })}
          save={() => void saveLayout('메인 화면 구성을 적용했어요.')}
        />
      )}
      {tab === 'notice' && (
        <NoticeTab
          notice={layout.notice}
          setNotice={(n) => setLayout((l) => ({ ...l, notice: n }))}
          busy={busy}
          dirty={noticeDirty}
          blocked={layoutDirty}
          save={() => void saveLayout(layout.notice.enabled ? '공지 띠를 적용했어요.' : '공지 띠 설정을 저장했어요.')}
        />
      )}
      {tab === 'history' && <HistoryTab notify={notify} ask={ask} onRestored={() => void load().then(() => onHomeLayout?.())} onAppearance={onAppearance} />}
      {confirmUi}
    </section>
  );
}

// ── PC 여백 디자인 ─────────────────────────────────────────────
function MarginTab({
  appearance,
  setAppearance,
  saved,
  themes,
  busy,
  dirty,
  save,
  applyRotation,
  notify,
}: {
  appearance: Appearance;
  setAppearance: React.Dispatch<React.SetStateAction<Appearance>>;
  saved: Appearance;
  themes: HomeTheme[];
  busy: boolean;
  dirty: boolean;
  save: () => void;
  applyRotation: (p: Partial<Pick<HomeStyle, 'rotate' | 'rotateCopy'>>) => void;
  notify: (s: string) => void;
}) {
  const style = appearance.style || defaultHomeStyle;
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const themeImage = themes.find((t) => t.id === appearance.theme)?.image || appearance.themeImage || appearance.image;
  // 여백 로테이션(4시간마다 5개 테마): 켜져 있으면 미리보기는 지금 차례 테마로 보여 줍니다.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  const slot = rotationSlot(ROTATE_HOURS, now);
  const current = style.rotate && themes.length ? themes[slot % themes.length] : null;
  const schedule = themes.length
    ? Array.from({ length: themes.length }, (_, i) => ({ at: (slot + i) * ROTATE_HOURS * 3600000 - 9 * 3600000, theme: themes[(slot + i) % themes.length] }))
    : [];
  // 지금 메인페이지에 실제로 적용 중인 여백(저장된 값 기준)
  const liveStyle = saved.style || defaultHomeStyle;
  const liveTheme = themes.find((t) => t.id === saved.theme);
  const liveRotating = !!liveStyle.rotate && themes.length > 0;
  const liveCurrent = liveRotating ? themes[slot % themes.length] : null;
  const liveNext = liveRotating ? themes[(slot + 1) % themes.length] : null;
  const slotStart = slot * ROTATE_HOURS * 3600000 - 9 * 3600000;
  const slotEnd = slotStart + ROTATE_HOURS * 3600000;
  const left = Math.max(0, slotEnd - now);
  const leftText = `${Math.floor(left / 3600000)}시간 ${Math.floor((left % 3600000) / 60000)}분`;
  const hm = (ms: number) => new Date(ms).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
  const liveImage = liveCurrent ? liveCurrent.image : liveStyle.image || liveTheme?.image || saved.image;
  const liveName = liveCurrent ? liveCurrent.name : liveStyle.image ? '직접 올린 사진' : liveTheme?.name || saved.theme;
  const bg = current ? current.image : style.image || themeImage;
  const shown = current && style.rotateCopy ? { ...appearance, eyebrow: current.eyebrow, headline: current.headline, highlight: current.highlight, description: current.description, caption: current.caption } : appearance;
  const setStyle = (patch: Partial<HomeStyle>) => setAppearance((a) => ({ ...a, style: { ...(a.style || defaultHomeStyle), ...patch } }));
  const setColor = (k: CopyKey, v: string) => setStyle({ colors: { ...style.colors, [k]: v } });
  const change = (key: CopyKey, value: string) => setAppearance((current) => ({ ...current, [key]: value }));
  const selectTheme = (theme: HomeTheme) =>
    setAppearance((a) => ({
      ...a,
      theme: theme.id,
      image: theme.image,
      eyebrow: theme.eyebrow,
      headline: theme.headline,
      highlight: theme.highlight,
      description: theme.description,
      caption: theme.caption,
      // 테마를 고르면 올린 사진 대신 테마 사진을 씁니다(글자 색 · 크기 설정은 그대로).
      style: { ...(a.style || defaultHomeStyle), image: '' },
    }));
  const upload = async (f: File) => {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return notify('JPG · PNG · WEBP 이미지만 올릴 수 있어요.');
    if (f.size > 15 * 1024 * 1024) return notify('15MB 이하 이미지만 올릴 수 있어요.');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', f);
      const r = await api<{ url: string; width?: number; height?: number }>('/studio/upload', 'POST', form);
      setStyle({ image: r.url });
      if (r.width && r.width < 1600) notify('사진 가로가 1600px보다 작아 큰 화면에서 흐려 보일 수 있어요. 1920px 이상을 권장해요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  };
  const tooShort = COPY_FIELDS.filter((f) => appearance[f.key].trim().length < 2);
  return (
    <>
      <div className="home-live" aria-live="polite">
        <img src={asset(liveImage)} alt={`${liveName} 여백`} />
        <div>
          <span className="home-live-label">지금 메인페이지에 적용 중</span>
          <strong>{liveName}</strong>
          {liveCurrent ? (
            <small>
              여백 로테이션 · {hm(slotStart)} ~ {hm(slotEnd)} · 다음 교체까지 {leftText} · 다음 차례 <b>{liveNext?.name}</b>
              {liveStyle.rotateCopy ? ' · 문구도 테마 문구로 표시' : ' · 문구는 카피 편집 내용'}
            </small>
          ) : (
            <small>{liveStyle.image ? '고정 · 직접 올린 사진' : '고정 테마'} · 로테이션 꺼짐</small>
          )}
        </div>
      </div>
      <div className={'home-rotate' + (liveStyle.rotate ? ' on' : '')}>
        <label className="home-switch">
          <input type="checkbox" role="switch" aria-checked={!!liveStyle.rotate} checked={!!liveStyle.rotate} disabled={busy} onChange={(e) => applyRotation({ rotate: e.target.checked })} />
          <i aria-hidden="true" />
          <span>
            <strong>여백 로테이션 {liveStyle.rotate ? '켜짐' : '꺼짐'}</strong>
            <small>
              {liveStyle.rotate
                ? `${ROTATE_HOURS}시간마다 5개 테마 사진이 차례로 바뀌어요(한국 시각 0 · 4 · 8 · 12 · 16 · 20시). 끄면 아래에서 고른 테마가 적용돼요.`
                : '켜면 5개 테마 사진이 4시간마다 돌아가며 적용돼요. 지금은 아래에서 고른 테마가 적용돼요.'}
              {' '}스위치를 누르면 바로 저장돼요.
            </small>
          </span>
        </label>
        {liveStyle.rotate && (
          <>
            <label className="inline-check">
              <input type="checkbox" checked={!!liveStyle.rotateCopy} disabled={busy} onChange={(e) => applyRotation({ rotateCopy: e.target.checked })} /> 문구도 그 테마 문구로 함께 바꾸기
              <small className="muted"> (끄면 아래 카피 편집 문구가 그대로 유지돼요)</small>
            </label>
            <ol className="home-rotate-schedule" aria-label="로테이션 순서">
              {schedule.map(({ at, theme }, i) => (
                <li key={at} className={i === 0 ? 'now' : ''}>
                  <img src={asset(theme.image)} alt="" />
                  <span>
                    <b>{theme.name}</b>
                    <small>{i === 0 ? `지금 ~ ${kst(new Date(at + ROTATE_HOURS * 3600000).toISOString()).split(' ').slice(-2).join(' ')}` : kst(new Date(at).toISOString())}</small>
                  </span>
                </li>
              ))}
            </ol>
            {liveStyle.image && <p className="settings-note">로테이션 중에는 직접 올린 사진 대신 5개 테마 사진이 쓰여요. 로테이션을 끄면 올린 사진이 다시 적용돼요.</p>}
          </>
        )}
      </div>
      <div className="home-theme-grid" role="radiogroup" aria-label="메인 여백 테마">
        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={appearance.theme === theme.id && !style.image}
            className={appearance.theme === theme.id && !style.image ? 'home-theme-card selected' : 'home-theme-card'}
            onClick={() => selectTheme(theme)}
          >
            <img src={asset(theme.image)} alt={`${theme.name} 여백 미리보기`} />
            <span>
              <strong>{theme.name}</strong>
              <small>{theme.mood}</small>
            </span>
            {appearance.theme === theme.id && !style.image && (
              <i aria-hidden="true">
                <Check size={14} />
              </i>
            )}
            {(liveCurrent ? liveCurrent.id === theme.id : !liveStyle.image && saved.theme === theme.id) && <em className="home-theme-live">지금 적용 중</em>}
            {liveRotating && appearance.theme === theme.id && !style.image && <em className="home-theme-picked">로테이션 끄면 적용</em>}
          </button>
        ))}
      </div>

      <div className="home-appearance-workspace">
        <div className="home-copy-editor">
          <div className="panel-heading">
            <div>
              <ImagePlus size={19} />
              <h2>배경 사진</h2>
            </div>
            <p>테마 사진을 쓰거나, 행사 · 신작 홍보용 사진을 직접 올릴 수 있어요. 가로 1920px 이상 사진을 권장해요.</p>
          </div>
          <div className="home-admin-row">
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <button type="button" className="secondary compact" disabled={uploading} onClick={() => file.current?.click()}>
              <ImagePlus size={14} /> {uploading ? '올리는 중…' : style.image ? '다른 사진 올리기' : '내 사진 올리기'}
            </button>
            {style.image && (
              <button type="button" className="text-link" onClick={() => setStyle({ image: '' })}>
                테마 사진으로 돌아가기
              </button>
            )}
          </div>
          <div className="home-admin-field">
            <span>사진 초점 (화면 크기가 달라도 이 부분이 보이게)</span>
            <div className="chip-row">
              {FOCUS.map((f) => (
                <button type="button" key={f.id} className={'chip' + (style.focus === f.id ? ' active' : '')} aria-pressed={style.focus === f.id} onClick={() => setStyle({ focus: f.id })}>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
          <label>
            사진 어둡게 <b className="home-admin-value">{style.shade}%</b>
            <input type="range" min={0} max={80} step={5} value={style.shade} onChange={(e) => setStyle({ shade: Number(e.target.value) })} />
          </label>

          <div className="panel-heading home-admin-subhead">
            <div>
              <Palette size={19} />
              <h2>카피 편집 · 글자 색</h2>
            </div>
            <p>문구 옆 색 칸을 눌러 색을 고르세요. ‘기본’을 누르면 원래 색으로 돌아가요.</p>
          </div>
          {COPY_FIELDS.map((f) => (
            <div key={f.key} className="home-copy-field">
              <label>
                {f.label}
                {f.multiline ? (
                  <textarea value={appearance[f.key]} rows={3} maxLength={f.max} onChange={(e) => change(f.key, e.target.value)} />
                ) : (
                  <input value={appearance[f.key]} maxLength={f.max} onChange={(e) => change(f.key, e.target.value)} />
                )}
              </label>
              <ColorField label={f.label} value={style.colors[f.key]} fallback={COPY_DEFAULT[f.key]} onChange={(v) => setColor(f.key, v)} />
            </div>
          ))}
          <div className="home-admin-field">
            <span>글자 크기</span>
            <div className="chip-row">
              {(
                [
                  ['s', '작게'],
                  ['m', '보통'],
                  ['l', '크게'],
                ] as [HomeStyle['size'], string][]
              ).map(([v, n]) => (
                <button type="button" key={v} className={'chip' + (style.size === v ? ' active' : '')} aria-pressed={style.size === v} onClick={() => setStyle({ size: v })}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label className="inline-check">
            <input type="checkbox" checked={style.shadow} onChange={(e) => setStyle({ shadow: e.target.checked })} /> 글자 그림자 (밝은 사진에서도 잘 읽혀요)
          </label>
          <label className="inline-check">
            <input type="checkbox" checked={style.box} onChange={(e) => setStyle({ box: e.target.checked })} /> 카피 뒤에 반투명 배경 상자 깔기
          </label>
          {!!tooShort.length && <p className="danger settings-note">{tooShort.map((f) => f.label).join(', ')}은(는) 2자 이상 입력해 주세요.</p>}
          <div className="home-admin-save">
            <button type="button" className="secondary" disabled={!dirty || busy} onClick={() => setAppearance(saved)}>
              <RotateCcw size={15} /> 되돌리기
            </button>
            <button className="primary" disabled={busy || !dirty || !!tooShort.length} onClick={save}>
              <Save size={17} /> {busy ? '적용 중…' : dirty ? '메인페이지에 적용' : '적용된 상태예요'}
            </button>
          </div>
        </div>

        <div className="home-appearance-preview">
          <div className="panel-heading">
            <div>
              <Eye size={19} />
              <h2>PC 여백 미리보기</h2>
            </div>
            {current && <small className="home-admin-pending">로테이션 · 지금 차례: {current.name}</small>}
            {dirty && <small className="home-admin-pending">아직 적용하지 않은 미리보기예요</small>}
          </div>
          <div className="home-preview-canvas" style={{ backgroundImage: `url(${asset(bg)})`, backgroundPosition: style.focus }}>
            <i className="home-preview-shade" style={{ opacity: style.shade / 100 }} />
            <div className={`home-preview-copy size-${style.size}${style.box ? ' boxed' : ''}${style.shadow ? '' : ' flat'}`}>
              <span style={{ color: style.colors.eyebrow || undefined }}>{shown.eyebrow}</span>
              <h3 style={{ color: style.colors.headline || undefined }}>
                {shown.headline}
                <em style={{ color: style.colors.highlight || undefined }}>{shown.highlight}</em>
              </h3>
              <p style={{ color: style.colors.description || undefined }}>{shown.description}</p>
            </div>
            <div className={'home-preview-foot' + (style.shadow ? '' : ' flat')}>
              <small style={{ color: style.colors.caption || undefined }}>● {shown.caption}</small>
              <small style={{ color: style.colors.copyright || undefined }}>{appearance.copyright}</small>
            </div>
            <div className="home-preview-app">숏핑 메인 콘텐츠</div>
          </div>
          <p className="settings-note">
            실제 PC 화면(가로 1200px 이상)에서는 왼쪽 여백에 카피가, 가운데에 콘텐츠가 보여요. 휴대폰 화면에서는 여백이 없어 이 설정이 보이지 않아요.
          </p>
        </div>
      </div>
    </>
  );
}

function ColorField({ label, value, fallback, onChange }: { label: string; value: string; fallback: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="home-color-field">
      <input type="color" aria-label={`${label} 색`} value={value || fallback} onChange={(e) => onChange(e.target.value)} />
      <input
        className="home-color-hex"
        aria-label={`${label} 색 코드`}
        value={text}
        placeholder="기본"
        maxLength={7}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toLowerCase());
          if (!v) onChange('');
        }}
      />
      <div className="home-swatches" aria-label={`${label} 추천 색`}>
        {SWATCHES.map((c) => (
          <button type="button" key={c} style={{ background: c }} className={value === c ? 'on' : ''} aria-label={`${label} ${c}`} onClick={() => onChange(c)} />
        ))}
      </div>
      <button type="button" className="text-link" disabled={!value} onClick={() => onChange('')}>
        기본
      </button>
    </div>
  );
}

// ── 작품 고르기(검색 · 순서 · 빼기) ─────────────────────────────
function DramaPicker({ ids, onChange, dramas, max, label }: { ids: string[]; onChange: (ids: string[]) => void; dramas: Drama[]; max: number; label: string }) {
  const [q, setQ] = useState('');
  const picked = ids.map((id) => dramas.find((d) => d.id === id) || ({ id, title: '(비공개 · 삭제된 작품)', image: '', genre: '' } as Drama));
  const found = useMemo(() => {
    const n = q.trim().toLowerCase();
    return dramas.filter((d) => !ids.includes(d.id) && (!n || `${d.title} ${d.genre}`.toLowerCase().includes(n))).slice(0, 8);
  }, [q, dramas, ids]);
  const move = (i: number, d: number) => {
    const next = [...ids];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="home-picker">
      <ol className="home-picked">
        {picked.map((d, i) => (
          <li key={d.id} className={dramas.some((x) => x.id === d.id) ? '' : 'missing'}>
            <b>{i + 1}</b>
            {d.image ? <img src={asset(d.image)} alt="" /> : <span className="home-picked-empty" />}
            <span>
              <strong>{d.title}</strong>
              <small>{d.genre}</small>
            </span>
            <button type="button" className="icon-button" aria-label={`${d.title} 위로`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={13} />
            </button>
            <button type="button" className="icon-button" aria-label={`${d.title} 아래로`} disabled={i === picked.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={13} />
            </button>
            <button type="button" className="icon-button" aria-label={`${d.title} 빼기`} onClick={() => onChange(ids.filter((x) => x !== d.id))}>
              <X size={13} />
            </button>
          </li>
        ))}
        {!picked.length && <li className="home-picked-none">아직 고른 작품이 없어요.</li>}
      </ol>
      {ids.length < max ? (
        <>
          <label className="home-picker-search">
            <Search size={14} />
            <input aria-label={`${label} 작품 검색`} value={q} placeholder="작품 제목 · 장르로 찾기" onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="home-picker-results">
            {found.map((d) => (
              <button type="button" key={d.id} onClick={() => onChange([...ids, d.id])}>
                <img src={asset(d.image)} alt="" />
                <span>
                  <strong>{d.title}</strong>
                  <small>{d.genre}</small>
                </span>
                <Plus size={14} />
              </button>
            ))}
            {!found.length && <small className="muted">맞는 공개 작품이 없어요.</small>}
          </div>
        </>
      ) : (
        <small className="muted">최대 {max}편까지 고를 수 있어요.</small>
      )}
    </div>
  );
}

// ── 메인 화면 구성 ─────────────────────────────────────────────
function LayoutTab({
  layout,
  setLayout,
  sections,
  dramas,
  busy,
  dirty,
  reset,
  save,
}: {
  layout: AdminLayout;
  setLayout: React.Dispatch<React.SetStateAction<AdminLayout>>;
  sections: SectionMeta[];
  dramas: Drama[];
  busy: boolean;
  dirty: boolean;
  reset: () => void;
  save: () => void;
}) {
  const meta = (id: HomeSectionId) => sections.find((s) => s.id === id);
  const setSection = (i: number, patch: Partial<AdminLayout['sections'][number]>) =>
    setLayout((l) => ({ ...l, sections: l.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const moveSection = (i: number, d: number) =>
    setLayout((l) => {
      const next = [...l.sections];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return { ...l, sections: next };
    });
  const manualEmpty = layout.hero.mode === 'manual' && !layout.hero.ids.some((id) => dramas.some((d) => d.id === id));
  const curatedOn = layout.sections.find((s) => s.id === 'curated')?.visible;
  return (
    <div className="home-layout-grid">
      <div className="home-copy-editor">
        <div className="panel-heading">
          <div>
            <Monitor size={19} />
            <h2>맨 위 추천 배너</h2>
          </div>
          <p>메인 화면 맨 위에 크게 보이는 작품이에요. ‘직접 편성’으로 원하는 작품과 순서를 정할 수 있어요.</p>
        </div>
        <div className="chip-row" role="radiogroup" aria-label="추천 배너 편성 방식">
          <button type="button" role="radio" aria-checked={layout.hero.mode === 'auto'} className={'chip' + (layout.hero.mode === 'auto' ? ' active' : '')} onClick={() => setLayout((l) => ({ ...l, hero: { ...l.hero, mode: 'auto' } }))}>
            자동 (조회수 상위 3편)
          </button>
          <button type="button" role="radio" aria-checked={layout.hero.mode === 'manual'} className={'chip' + (layout.hero.mode === 'manual' ? ' active' : '')} onClick={() => setLayout((l) => ({ ...l, hero: { ...l.hero, mode: 'manual' } }))}>
            직접 편성 (최대 5편)
          </button>
        </div>
        {layout.hero.mode === 'manual' && (
          <>
            <DramaPicker label="추천 배너" ids={layout.hero.ids} max={5} dramas={dramas} onChange={(ids) => setLayout((l) => ({ ...l, hero: { ...l.hero, ids } }))} />
            {manualEmpty && <p className="settings-note danger">고른 작품이 없으면 자동(조회수 상위 3편)으로 보여요.</p>}
          </>
        )}
        <div className="form-grid two">
          <label>
            배너 위 작은 문구
            <input value={layout.hero.kicker} maxLength={40} placeholder="오늘의 발견 · 숏핑 독점 공개" onChange={(e) => setLayout((l) => ({ ...l, hero: { ...l.hero, kicker: e.target.value } }))} />
          </label>
          <label>
            자동 넘김
            <select value={layout.hero.interval} onChange={(e) => setLayout((l) => ({ ...l, hero: { ...l.hero, interval: Number(e.target.value) } }))}>
              {INTERVALS.map((x) => (
                <option key={x.v} value={x.v}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="panel-heading home-admin-subhead">
          <div>
            <LayoutList size={19} />
            <h2>섹션 순서 · 보이기</h2>
          </div>
          <p>화살표로 순서를 바꾸고 눈 모양으로 숨길 수 있어요. 제목을 비워 두면 기본 제목이 보여요. 장르 · 탭을 고른 결과 목록은 항상 보여요.</p>
        </div>
        <ol className="home-sections">
          {layout.sections.map((s, i) => {
            const m = meta(s.id);
            const editableTitle = s.id !== 'editorial';
            return (
              <li key={s.id} className={s.visible ? '' : 'hidden-section'}>
                <div className="home-section-head">
                  <b>{i + 1}</b>
                  <strong>{m?.name || s.id}</strong>
                  <button type="button" className="icon-button" aria-label={`${m?.name} ${s.visible ? '숨기기' : '보이기'}`} aria-pressed={s.visible} onClick={() => setSection(i, { visible: !s.visible })}>
                    {s.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button type="button" className="icon-button" aria-label={`${m?.name} 위로`} disabled={i === 0} onClick={() => moveSection(i, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" className="icon-button" aria-label={`${m?.name} 아래로`} disabled={i === layout.sections.length - 1} onClick={() => moveSection(i, 1)}>
                    <ArrowDown size={14} />
                  </button>
                </div>
                {s.visible && editableTitle && (
                  <div className="form-grid two">
                    <input aria-label={`${m?.name} 제목`} value={s.title} maxLength={40} placeholder={m?.title || '제목'} onChange={(e) => setSection(i, { title: e.target.value })} />
                    <input aria-label={`${m?.name} 설명`} value={s.subtitle} maxLength={60} placeholder={m?.subtitle || '설명(선택)'} onChange={(e) => setSection(i, { subtitle: e.target.value })} />
                  </div>
                )}
                {s.visible && s.id === 'curated' && (
                  <DramaPicker label="에디터 추천" ids={layout.curated.ids} max={12} dramas={dramas} onChange={(ids) => setLayout((l) => ({ ...l, curated: { ids } }))} />
                )}
                {s.visible && s.id === 'editorial' && (
                  <div className="home-editorial-edit">
                    <input aria-label="하단 배너 영문 문구" value={layout.editorial.eyebrow} maxLength={40} placeholder="SHORT STORIES, BIG FEELINGS." onChange={(e) => setLayout((l) => ({ ...l, editorial: { ...l.editorial, eyebrow: e.target.value } }))} />
                    <textarea aria-label="하단 배너 제목" value={layout.editorial.title} rows={2} maxLength={60} placeholder={'당신의 다음 이야기는\n어떤 장르인가요?'} onChange={(e) => setLayout((l) => ({ ...l, editorial: { ...l.editorial, title: e.target.value } }))} />
                    <div className="form-grid two">
                      <input aria-label="하단 배너 버튼 글자" value={layout.editorial.button} maxLength={20} placeholder="나만의 드라마 찾기" onChange={(e) => setLayout((l) => ({ ...l, editorial: { ...l.editorial, button: e.target.value } }))} />
                      <input aria-label="하단 배너 버튼 링크" value={layout.editorial.link} maxLength={300} placeholder="explore 또는 https://…" onChange={(e) => setLayout((l) => ({ ...l, editorial: { ...l.editorial, link: e.target.value.trim() } }))} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {curatedOn && !layout.curated.ids.length && <p className="settings-note">에디터 추천에 작품을 고르지 않으면 메인에 보이지 않아요.</p>}
        <div className="home-admin-save">
          <button type="button" className="secondary" disabled={!dirty || busy} onClick={reset}>
            <RotateCcw size={15} /> 되돌리기
          </button>
          <button className="primary" disabled={busy || !dirty} onClick={save}>
            <Save size={17} /> {busy ? '적용 중…' : dirty ? '메인 화면에 적용' : '적용된 상태예요'}
          </button>
        </div>
      </div>
      <PhonePreview layout={layout} sections={sections} dramas={dramas} />
    </div>
  );
}

// 휴대폰 화면 순서 미리보기(실제 작품 포스터로)
function PhonePreview({ layout, sections, dramas }: { layout: AdminLayout; sections: SectionMeta[]; dramas: Drama[] }) {
  const heroes = layout.hero.mode === 'manual' ? layout.hero.ids.map((id) => dramas.find((d) => d.id === id)).filter((d): d is Drama => !!d) : [];
  const hero = heroes[0] || dramas[0];
  const posters = (list: Drama[]) => (
    <div className="phone-posters">
      {list.slice(0, 4).map((d) => (
        <img key={d.id} src={asset(d.image)} alt="" />
      ))}
    </div>
  );
  return (
    <div className="home-appearance-preview home-phone-wrap">
      <div className="panel-heading">
        <div>
          <Eye size={19} />
          <h2>메인 화면 순서 미리보기</h2>
        </div>
      </div>
      <div className="home-phone">
        {layout.notice.enabled && layout.notice.text && <div className={'home-notice tone-' + layout.notice.tone}>{layout.notice.text}</div>}
        {hero && (
          <div className="phone-hero" style={{ backgroundImage: `url(${asset(hero.image)})` }}>
            <small>{layout.hero.kicker || '오늘의 발견 · 숏핑 독점 공개'}</small>
            <b>{hero.title}</b>
            <span>{layout.hero.mode === 'manual' && heroes.length ? `직접 편성 ${heroes.length}편` : '자동 · 조회수 상위'}</span>
          </div>
        )}
        {layout.sections
          .filter((s) => s.visible)
          .map((s) => {
            const m = sections.find((x) => x.id === s.id);
            const title = s.title || m?.title || '';
            if (s.id === 'curated') {
              const picks = layout.curated.ids.map((id) => dramas.find((d) => d.id === id)).filter((d): d is Drama => !!d);
              return picks.length ? (
                <div key={s.id} className="phone-section">
                  <b>{title}</b>
                  {posters(picks)}
                </div>
              ) : null;
            }
            if (s.id === 'membership') return <div key={s.id} className="phone-banner">{title}</div>;
            if (s.id === 'editorial')
              return (
                <div key={s.id} className="phone-banner editorial">
                  {(layout.editorial.title || '당신의 다음 이야기는 어떤 장르인가요?').replace('\n', ' ')}
                </div>
              );
            const sample = s.id === 'newest' ? [...dramas].reverse() : s.id === 'binge' ? dramas.slice(4) : dramas;
            return (
              <div key={s.id} className="phone-section">
                <b>
                  {title}
                  {['continue', 'followed'].includes(s.id) && <small> (해당 회원만)</small>}
                </b>
                {s.id === 'channels' ? <div className="phone-channels" /> : posters(sample)}
              </div>
            );
          })}
      </div>
      <p className="settings-note">숨긴 섹션은 빠지고, 이어보기 · 구독 방송국 소식은 해당하는 회원에게만 보여요.</p>
    </div>
  );
}

// ── 공지 띠 배너 ───────────────────────────────────────────────
function NoticeTab({
  notice,
  setNotice,
  busy,
  dirty,
  blocked,
  save,
}: {
  notice: Required<HomeNotice>;
  setNotice: (n: Required<HomeNotice>) => void;
  busy: boolean;
  dirty: boolean;
  blocked: boolean;
  save: () => void;
}) {
  const now = Date.now();
  const status = !notice.enabled
    ? '꺼짐'
    : !notice.text.trim()
      ? '문구를 입력해 주세요'
      : notice.start && new Date(notice.start).getTime() > now
        ? `예약됨 · ${kst(notice.start)}부터`
        : notice.end && new Date(notice.end).getTime() <= now
          ? '게시 기간이 끝났어요'
          : `게시 중${notice.end ? ` · ${kst(notice.end)}까지` : ''}`;
  const badLink = !!notice.link && !/^(https:\/\/\S{3,}|[a-z][a-z0-9/_-]{0,120})$/.test(notice.link);
  const badRange = !!notice.start && !!notice.end && new Date(notice.start) >= new Date(notice.end);
  return (
    <div className="home-appearance-workspace">
      <div className="home-copy-editor">
        <div className="panel-heading">
          <div>
            <Megaphone size={19} />
            <h2>공지 띠 배너</h2>
          </div>
          <p>메인 화면 맨 위에 한 줄 공지를 띄워요. 점검 안내 · 이벤트 · 신작 소식에 쓰고, 기간을 정하면 자동으로 켜지고 꺼져요.</p>
        </div>
        <label className="inline-check">
          <input type="checkbox" checked={notice.enabled} onChange={(e) => setNotice({ ...notice, enabled: e.target.checked })} /> 공지 띠 켜기
        </label>
        <label>
          공지 문구
          <input value={notice.text} maxLength={80} placeholder="예: 추석 연휴 신작 3편 무료 공개!" onChange={(e) => setNotice({ ...notice, text: e.target.value })} />
        </label>
        <label>
          눌렀을 때 이동할 곳 <small className="muted">(선택) 앱 안 주소(membership, drama/작품ID, explore) 또는 https:// 주소</small>
          <input value={notice.link} maxLength={300} placeholder="membership" onChange={(e) => setNotice({ ...notice, link: e.target.value.trim() })} />
        </label>
        {badLink && <p className="danger settings-note">링크는 https:// 주소나 앱 안 주소만 쓸 수 있어요.</p>}
        <div className="home-admin-field">
          <span>색</span>
          <div className="chip-row">
            {TONES.map((t) => (
              <button type="button" key={t.id} className={'chip' + (notice.tone === t.id ? ' active' : '')} aria-pressed={notice.tone === t.id} onClick={() => setNotice({ ...notice, tone: t.id })}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
        <div className="form-grid two">
          <label>
            시작 (한국 시각, 비우면 바로)
            <input type="datetime-local" value={toLocal(notice.start)} onChange={(e) => setNotice({ ...notice, start: fromLocal(e.target.value) })} />
          </label>
          <label>
            종료 (비우면 끄기 전까지)
            <input type="datetime-local" value={toLocal(notice.end)} onChange={(e) => setNotice({ ...notice, end: fromLocal(e.target.value) })} />
          </label>
        </div>
        {badRange && <p className="danger settings-note">종료 시각은 시작 시각보다 뒤여야 해요.</p>}
        {blocked && <p className="settings-note">‘메인 화면 구성’에 저장하지 않은 변경이 있어요. 공지를 저장하면 그 변경도 함께 적용돼요.</p>}
        <div className="home-admin-save">
          <span className="home-notice-status">{status}</span>
          <button className="primary" disabled={busy || !dirty || badLink || badRange || (notice.enabled && !notice.text.trim())} onClick={save}>
            <Save size={17} /> {busy ? '저장 중…' : dirty ? '공지 저장' : '저장된 상태예요'}
          </button>
        </div>
      </div>
      <div className="home-appearance-preview">
        <div className="panel-heading">
          <div>
            <Eye size={19} />
            <h2>미리보기</h2>
          </div>
        </div>
        <div className="home-notice-preview">
          {notice.text ? (
            <div className={'home-notice tone-' + notice.tone}>
              <Megaphone size={15} />
              <span>{notice.text}</span>
            </div>
          ) : (
            <p className="muted">문구를 입력하면 여기에 보여요.</p>
          )}
          <div className="home-notice-fake">추천 · 인기 · 신작 · 완결</div>
          <div className="home-notice-fake hero">추천 배너</div>
        </div>
      </div>
    </div>
  );
}

// ── 변경 기록 · 되돌리기 ──────────────────────────────────────
function HistoryTab({
  notify,
  ask,
  onRestored,
  onAppearance,
}: {
  notify: (s: string) => void;
  ask: (a: { title: string; text: string; ok?: string; danger?: boolean }) => Promise<boolean>;
  onRestored: () => void;
  onAppearance: (a: Appearance) => void;
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = () =>
    api<HistoryRow[]>('/admin/home-history').then(setRows, (e) => {
      notify((e as Error).message);
      setRows([]);
    });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const summary = (r: HistoryRow) => {
    if (r.kind === 'appearance') {
      const d = r.data as Partial<Appearance> & { style?: HomeStyle };
      const colored = d.style ? Object.values(d.style.colors || {}).filter(Boolean).length : 0;
      return `${d.headline || ''} ${d.highlight || ''} · 테마 ${d.theme}${d.style?.image ? ' · 직접 올린 사진' : ''}${colored ? ` · 글자 색 ${colored}곳` : ''}${d.style?.rotate ? ' · 로테이션 켜짐' : ''}`;
    }
    const d = r.data as unknown as AdminLayout;
    const hidden = (d.sections || []).filter((s) => !s.visible).length;
    return `추천 배너 ${d.hero?.mode === 'manual' ? `직접 ${d.hero.ids.length}편` : '자동'} · 숨긴 섹션 ${hidden}개 · 에디터 추천 ${d.curated?.ids?.length || 0}편${d.notice?.enabled ? ` · 공지 “${d.notice.text}”` : ''}`;
  };
  return (
    <div className="home-copy-editor">
      <div className="panel-heading">
        <div>
          <History size={19} />
          <h2>변경 기록</h2>
        </div>
        <p>메인페이지를 바꿀 때마다 최근 30개까지 기록해요. 예전 모습으로 되돌릴 수 있어요.</p>
      </div>
      {!rows ? (
        <p className="muted">불러오는 중…</p>
      ) : !rows.length ? (
        <p className="muted">아직 기록이 없어요.</p>
      ) : (
        <ul className="home-history">
          {rows.map((r, i) => (
            <li key={r.id}>
              <span className={'home-history-kind ' + r.kind}>{r.kind === 'appearance' ? 'PC 여백' : '메인 구성'}</span>
              <div>
                <strong>{summary(r)}</strong>
                <small>
                  {kst(r.created_at)} · {r.actor_name || '관리자'}
                  {i === rows.findIndex((x) => x.kind === r.kind) ? ' · 지금 적용 중' : ''}
                </small>
              </div>
              {i !== rows.findIndex((x) => x.kind === r.kind) && (
                <button
                  className="secondary compact"
                  disabled={!!busy}
                  onClick={async () => {
                    if (!(await ask({ title: '이 모습으로 되돌릴까요?', text: '지금 메인페이지에 바로 적용돼요. 되돌린 것도 기록에 남아요.', ok: '되돌리기' }))) return;
                    setBusy(r.id);
                    try {
                      const res = await api<{ appearance?: Appearance }>(`/admin/home-history/${r.id}/restore`, 'POST');
                      if (res.appearance) onAppearance(res.appearance);
                      notify('선택한 기록으로 되돌렸어요.');
                      onRestored();
                    } catch (e) {
                      notify((e as Error).message);
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  <RotateCcw size={13} /> 되돌리기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="text-link" onClick={() => void load()}>
        <RefreshCw size={13} /> 새로고침
      </button>
    </div>
  );
}
