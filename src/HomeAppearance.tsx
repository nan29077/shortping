import { useEffect, useState } from 'react';
import { Check, Eye, Palette, RefreshCw, Save } from 'lucide-react';
import {
  api,
  defaultHomeAppearance,
  type HomeAppearance as Appearance,
  type HomeTheme,
} from './api';

export default function HomeAppearance({
  notify,
  onAppearance,
}: {
  notify: (message: string) => void;
  onAppearance: (appearance: Appearance) => void;
}) {
  const [appearance, setAppearance] = useState<Appearance>(defaultHomeAppearance);
  const [themes, setThemes] = useState<HomeTheme[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const result = await api<{ appearance: Appearance; themes: HomeTheme[] }>(
        '/admin/home-appearance',
      );
      setAppearance(result.appearance);
      setThemes(result.themes);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selectTheme = (theme: HomeTheme) =>
    setAppearance({
      theme: theme.id,
      image: theme.image,
      eyebrow: theme.eyebrow,
      headline: theme.headline,
      highlight: theme.highlight,
      description: theme.description,
      caption: theme.caption,
      copyright: appearance.copyright,
    });

  const change = (key: keyof Appearance, value: string) =>
    setAppearance((current) => ({ ...current, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      const result = await api<{ appearance: Appearance }>('/admin/home-appearance', 'PUT', {
        theme: appearance.theme,
        eyebrow: appearance.eyebrow,
        headline: appearance.headline,
        highlight: appearance.highlight,
        description: appearance.description,
        caption: appearance.caption,
        copyright: appearance.copyright,
      });
      setAppearance(result.appearance);
      onAppearance(result.appearance);
      notify('메인페이지 여백 디자인을 적용했어요.');
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <div className="loading home-appearance-loading">
        <span className="spinner" /> 메인 디자인을 불러오고 있어요
      </div>
    );

  return (
    <section className="home-appearance-panel">
      <div className="management-section-heading">
        <div>
          <span className="eyebrow lime">HOME EXPERIENCE</span>
          <h1>메인페이지 여백 관리</h1>
          <p>PC 화면 양옆의 분위기와 소개 문구를 선택하고 바로 적용합니다.</p>
        </div>
        <button className="secondary compact" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={16} /> 다시 불러오기
        </button>
      </div>

      <div className="home-theme-grid" role="radiogroup" aria-label="메인 여백 테마">
        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={appearance.theme === theme.id}
            className={
              appearance.theme === theme.id ? 'home-theme-card selected' : 'home-theme-card'
            }
            onClick={() => selectTheme(theme)}
          >
            <img src={theme.image} alt={`${theme.name} 여백 미리보기`} />
            <span>
              <strong>{theme.name}</strong>
              <small>{theme.mood}</small>
            </span>
            {appearance.theme === theme.id && (
              <i aria-hidden="true">
                <Check size={14} />
              </i>
            )}
          </button>
        ))}
      </div>

      <div className="home-appearance-workspace">
        <div className="home-copy-editor">
          <div className="panel-heading">
            <div>
              <Palette size={19} />
              <h2>카피 편집</h2>
            </div>
            <p>테마 문구를 선택한 뒤 서비스 톤에 맞게 직접 다듬을 수 있어요.</p>
          </div>
          <label>
            영문 보조 문구
            <input
              value={appearance.eyebrow}
              maxLength={60}
              onChange={(event) => change('eyebrow', event.target.value)}
            />
          </label>
          <div className="form-grid two">
            <label>
              메인 문구
              <input
                value={appearance.headline}
                maxLength={40}
                onChange={(event) => change('headline', event.target.value)}
              />
            </label>
            <label>
              강조 문구
              <input
                value={appearance.highlight}
                maxLength={40}
                onChange={(event) => change('highlight', event.target.value)}
              />
            </label>
          </div>
          <label>
            설명
            <textarea
              value={appearance.description}
              rows={3}
              maxLength={160}
              onChange={(event) => change('description', event.target.value)}
            />
          </label>
          <label>
            하단 한 줄
            <input
              value={appearance.caption}
              maxLength={80}
              onChange={(event) => change('caption', event.target.value)}
            />
          </label>
          <label>
            저작권 표기
            <input
              value={appearance.copyright}
              maxLength={60}
              onChange={(event) => change('copyright', event.target.value)}
            />
          </label>
          <button
            className="primary home-appearance-save"
            disabled={busy}
            onClick={() => void save()}
          >
            <Save size={17} /> {busy ? '적용 중…' : '메인페이지에 적용'}
          </button>
        </div>

        <div className="home-appearance-preview">
          <div className="panel-heading">
            <div>
              <Eye size={19} />
              <h2>PC 여백 미리보기</h2>
            </div>
          </div>
          <div
            className="home-preview-canvas"
            style={{ backgroundImage: `url(${appearance.image})` }}
          >
            <div className="home-preview-copy">
              <span>{appearance.eyebrow}</span>
              <h3>
                {appearance.headline}
                <em>{appearance.highlight}</em>
              </h3>
              <p>{appearance.description}</p>
              <small>{appearance.caption}</small>
            </div>
            <div className="home-preview-app">숏핑 메인 콘텐츠</div>
          </div>
          <p className="settings-note">
            실제 PC 화면에서는 중앙에 콘텐츠와 우측 메뉴가 표시됩니다. 모바일 화면은 기존 집중형
            레이아웃을 유지합니다.
          </p>
        </div>
      </div>
    </section>
  );
}
