import { useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle, Save, X } from 'lucide-react';
import {
  SANS,
  SERIF,
  drawBlurredCover,
  drawLegibleLines,
  ensureFontsFor,
  fitText,
  loadImage,
  luminance,
  rgba,
  toPngBlob,
  uploadBlob,
  verticalOverlay,
  vignette,
} from './canvasText';
import './thumbs.css';

export type CardMakerProps = {
  kind: 'intro' | 'outro';
  title: string;
  episodeNumber: number;
  episodeTitle: string;
  background?: string;
  nextHint?: string;
  onSaved: (url: string) => void;
  notify: (s: string) => void;
  close?: () => void;
};

type PresetId = 'cinema' | 'neon' | 'paper' | 'mono';
type Card = {
  preset: PresetId;
  accent: string;
  textColor: string;
  dramaTitle: string;
  episodeTitle: string;
  nextHint: string;
  useBackground: boolean;
  blur: number;
  darkness: number;
};

const W = 720;
const H = 1280;

const PRESETS: Record<PresetId, { name: string; desc: string; accent: string; textColor: string; darkness: number }> = {
  cinema: { name: '시네마', desc: '흐린 배경과 명조 제목', accent: '#f5c451', textColor: '#ffffff', darkness: 0.5 },
  neon: { name: '네온', desc: '빛나는 강조색 굵은 글씨', accent: '#c4f562', textColor: '#ffffff', darkness: 0.6 },
  paper: { name: '페이퍼', desc: '밝은 종이 느낌', accent: '#b23a48', textColor: '#1d1d1f', darkness: 0 },
  mono: { name: '모노', desc: '흑백과 얇은 선', accent: '#ffffff', textColor: '#ffffff', darkness: 0.55 },
};
const PRESET_ORDER: PresetId[] = ['cinema', 'neon', 'paper', 'mono'];

function renderCard(ctx: CanvasRenderingContext2D, kind: CardMakerProps['kind'], n: number, c: Card, img: HTMLImageElement | null) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  const paper = c.preset === 'paper';

  // 배경
  if (img && c.useBackground) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawBlurredCover(ctx, img, W, H, c.blur);
    if (c.preset === 'mono') {
      // 채도를 빼는 대신 회색 층을 덮어 흑백 느낌을 줘요 (filter 미지원 브라우저 대응).
      ctx.globalCompositeOperation = 'saturation';
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (paper) {
      ctx.fillStyle = 'rgba(246,241,232,0.82)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = `rgba(0,0,0,${c.darkness})`;
      ctx.fillRect(0, 0, W, H);
      vignette(ctx, W, H, 0.7);
    }
  } else if (paper) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#f8f4ec');
    g.addColorStop(1, '#ece4d6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, W * 0.5, H);
    g.addColorStop(0, c.preset === 'mono' ? '#2a2a2a' : rgba(c.accent, 0.55));
    g.addColorStop(0.5, '#15191d');
    g.addColorStop(1, '#050608');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    vignette(ctx, W, H, 0.6);
  }
  if (c.preset === 'neon' && !paper) {
    verticalOverlay(ctx, W, H, [
      [0.55, rgba(c.accent, 0)],
      [1, rgba(c.accent, 0.18)],
    ]);
  }

  const margin = 64;
  const maxW = W - margin * 2;
  const cx = W / 2;
  const serifish = c.preset === 'cinema' || c.preset === 'paper';
  const family = serifish ? SERIF : SANS;
  const stroke = paper ? null : 'rgba(0,0,0,0.45)';
  const shadow = paper ? null : c.preset === 'neon' ? rgba(c.accent, 0.8) : 'rgba(0,0,0,0.6)';
  const sub = paper ? rgba(c.textColor, 0.72) : rgba(c.textColor, 0.8);

  const line = (y: number, len = 120) => {
    ctx.fillStyle = c.accent;
    if (c.preset === 'neon') {
      ctx.shadowColor = c.accent;
      ctx.shadowBlur = 18;
    }
    ctx.fillRect(cx - len / 2, y, len, c.preset === 'mono' ? 2 : 4);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  };
  const small = (text: string, y: number, size: number, spacing = 6, color = sub) => {
    ctx.save();
    ctx.font = `700 ${size}px ${SANS}`;
    ctx.letterSpacing = `${spacing}px`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, cx + spacing / 2, y);
    ctx.restore();
  };

  if (kind === 'intro') {
    // 드라마 제목(작게) → N화(크게) → 선 → 회차 제목
    const drama = fitText(ctx, c.dramaTitle.trim() || '드라마 제목', (s) => `700 ${s}px ${family}`, {
      maxWidth: maxW,
      maxLines: 2,
      start: 40,
      min: 26,
      lineHeight: 1.3,
    });
    const epSize = 200;
    const epTitle = fitText(ctx, c.episodeTitle.trim() || `${n}화`, (s) => `${serifish ? 800 : 900} ${s}px ${family}`, {
      maxWidth: maxW,
      maxLines: 3,
      start: 64,
      min: 38,
      lineHeight: 1.25,
    });
    const total = drama.height + 36 + epSize * 1.05 + 40 + 4 + 44 + epTitle.height;
    let y = (H - total) / 2 - 20;
    ctx.font = `700 ${drama.size}px ${family}`;
    drawLegibleLines(ctx, drama.lines, cx, y, {
      size: drama.size,
      lineHeight: 1.3,
      color: sub,
      align: 'center',
      shadow: paper ? null : 'rgba(0,0,0,0.6)',
    });
    y += drama.height + 36;
    ctx.save();
    ctx.font = `900 ${epSize}px ${family}`;
    ctx.textAlign = 'center';
    if (c.preset === 'neon') {
      ctx.shadowColor = c.accent;
      ctx.shadowBlur = 40;
    } else if (!paper) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 30;
    }
    ctx.fillStyle = c.preset === 'mono' ? c.textColor : c.accent;
    const num = String(n);
    const numW = ctx.measureText(num).width;
    ctx.font = `800 ${Math.round(epSize * 0.42)}px ${family}`;
    const hwaW = ctx.measureText('화').width;
    const startX = cx - (numW + hwaW + 8) / 2;
    ctx.textAlign = 'left';
    ctx.font = `900 ${epSize}px ${family}`;
    ctx.fillText(num, startX, y);
    ctx.font = `800 ${Math.round(epSize * 0.42)}px ${family}`;
    ctx.fillStyle = c.textColor;
    ctx.fillText('화', startX + numW + 8, y + epSize * 0.62);
    ctx.restore();
    y += epSize * 1.05 + 40;
    line(y);
    y += 4 + 44;
    ctx.font = `${serifish ? 800 : 900} ${epTitle.size}px ${family}`;
    drawLegibleLines(ctx, epTitle.lines, cx, y, {
      size: epTitle.size,
      lineHeight: 1.25,
      color: c.textColor,
      align: 'center',
      stroke,
      shadow,
    });
    small('EPISODE ' + String(n).padStart(2, '0'), H - 150, 22, 8);
  } else {
    // 다음 화에서 계속 → 선 → 떡밥 문구 → 드라마 제목(아래)
    const head = fitText(ctx, '다음 화에서\n계속', (s) => `900 ${s}px ${family}`, {
      maxWidth: maxW,
      maxLines: 2,
      start: 92,
      min: 56,
      lineHeight: 1.18,
    });
    const hintText = c.nextHint.trim();
    const hint = hintText
      ? fitText(ctx, `“${hintText}”`, (s) => `500 ${s}px ${serifish ? SERIF : SANS}`, {
          maxWidth: maxW - 20,
          maxLines: 5,
          start: 40,
          min: 26,
          lineHeight: 1.5,
        })
      : null;
    const total = 30 + 34 + head.height + 44 + 4 + (hint ? 48 + hint.height : 0);
    let y = (H - total) / 2 - 60;
    small(`${n}화 끝`, y, 26, 6, c.preset === 'mono' ? sub : c.accent);
    y += 30 + 34;
    ctx.font = `900 ${head.size}px ${family}`;
    drawLegibleLines(ctx, head.lines, cx, y, {
      size: head.size,
      lineHeight: 1.18,
      color: c.textColor,
      align: 'center',
      stroke,
      shadow,
      shadowBlur: c.preset === 'neon' ? 36 : undefined,
    });
    y += head.height + 44;
    line(y, 80);
    y += 4;
    if (hint) {
      y += 48;
      ctx.font = `500 ${hint.size}px ${serifish ? SERIF : SANS}`;
      drawLegibleLines(ctx, hint.lines, cx, y, {
        size: hint.size,
        lineHeight: 1.5,
        color: sub,
        align: 'center',
        shadow: paper ? null : 'rgba(0,0,0,0.7)',
      });
    }
    const t = fitText(ctx, c.dramaTitle.trim() || '드라마 제목', (s) => `800 ${s}px ${family}`, {
      maxWidth: maxW,
      maxLines: 1,
      start: 36,
      min: 24,
      lineHeight: 1.3,
    });
    ctx.font = `800 ${t.size}px ${family}`;
    drawLegibleLines(ctx, t.lines, cx, H - 170, {
      size: t.size,
      lineHeight: 1.3,
      color: c.textColor,
      align: 'center',
      shadow: paper ? null : 'rgba(0,0,0,0.6)',
    });
  }
  ctx.restore();
}

export default function CardMaker(props: CardMakerProps) {
  const { kind, episodeNumber, background, notify, onSaved, close } = props;
  const uid = useId();
  const [card, setCard] = useState<Card>(() => ({
    preset: 'cinema',
    accent: PRESETS.cinema.accent,
    textColor: PRESETS.cinema.textColor,
    dramaTitle: props.title || '',
    episodeTitle: props.episodeTitle || '',
    nextHint: props.nextHint || '',
    useBackground: Boolean(background),
    blur: 24,
    darkness: PRESETS.cinema.darkness,
  }));
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [fontsReady, setFontsReady] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const n = Math.max(1, Math.floor(Number(episodeNumber) || 1));

  const set = <K extends keyof Card>(k: K, v: Card[K]) => {
    setCard((c) => ({ ...c, [k]: v }));
    setSaved(false);
  };

  const fontText = `${card.dramaTitle}${card.episodeTitle}${card.nextHint}“”다음 화에서 계속끝드라마 제목EPISODE0123456789화`;
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      ensureFontsFor(fontText).then(() => alive && setFontsReady((v) => v + 1));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [fontText]);

  useEffect(() => {
    let alive = true;
    setImg(null);
    if (!background) return;
    loadImage(background).then(
      (i) => alive && setImg(i),
      () => alive && notify('배경 이미지를 불러오지 못해 그라데이션으로 만들어요.'),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [background]);

  useEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!ctx) return;
    const raf = requestAnimationFrame(() => renderCard(ctx, kind, n, card, img));
    return () => cancelAnimationFrame(raf);
  }, [kind, n, card, img, fontsReady]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await ensureFontsFor(fontText);
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('이 브라우저에서는 이미지를 만들 수 없어요.');
      renderCard(ctx, kind, n, card, img);
      const blob = await toPngBlob(cv);
      const r = await uploadBlob(blob, `${kind}-card-${n}.png`);
      onSaved(r.url);
      setSaved(true);
      notify(kind === 'intro' ? `${n}화 오프닝 카드를 저장했어요.` : `${n}화 엔딩 카드를 저장했어요.`);
    } catch (e) {
      const msg = (e as Error)?.message || '저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
      setError(msg);
      notify(msg);
    } finally {
      setSaving(false);
    }
  };

  const label = kind === 'intro' ? '오프닝 타이틀 카드' : '엔딩 카드';
  return (
    <section className="tstudio tcard" aria-labelledby={`${uid}-h`}>
      <header className="tstudio-head">
        <div>
          <h2 id={`${uid}-h`}>{label} 만들기</h2>
          <p>
            {kind === 'intro'
              ? '회차 시작에 붙일 제목 카드를 만들어요.'
              : '회차 끝에 붙여 다음 화를 기대하게 만드는 카드예요.'}
          </p>
        </div>
        {close && (
          <button type="button" className="tstudio-icon" onClick={close} aria-label={`${label} 만들기 닫기`}>
            <X size={18} />
          </button>
        )}
      </header>
      <div className="tstudio-body">
        <div className="tstudio-stage">
          <div className="tstudio-canvas-wrap is-poster">
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              role="img"
              aria-label={`${label} 미리보기: ${card.dramaTitle} ${n}화`}
            />
          </div>
          <p className="tstudio-hint">
            {W}×{H}px · 9:16 세로 영상에 맞춘 크기예요.
          </p>
        </div>
        <div className="tstudio-controls">
          <fieldset className="tstudio-group">
            <legend>스타일</legend>
            <div className="tstudio-templates">
              {PRESET_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`tstudio-tpl${card.preset === id ? ' on' : ''}`}
                  aria-pressed={card.preset === id}
                  onClick={() => {
                    const p = PRESETS[id];
                    setCard((c) => ({ ...c, preset: id, accent: p.accent, textColor: p.textColor, darkness: p.darkness }));
                    setSaved(false);
                  }}
                >
                  <b>{PRESETS[id].name}</b>
                  <small>{PRESETS[id].desc}</small>
                </button>
              ))}
            </div>
            <div className="tstudio-colors">
              <label>
                <input type="color" value={card.textColor} onChange={(e) => set('textColor', e.target.value)} />
                <span>글자색</span>
              </label>
              <label>
                <input type="color" value={card.accent} onChange={(e) => set('accent', e.target.value)} />
                <span>강조색</span>
              </label>
            </div>
            {luminance(card.textColor) < 0.35 && card.preset !== 'paper' && (
              <p className="tstudio-warn">어두운 글자색은 어두운 배경에서 잘 안 보일 수 있어요.</p>
            )}
          </fieldset>
          <fieldset className="tstudio-group">
            <legend>문구</legend>
            <label className="tstudio-field">
              <span>드라마 제목</span>
              <input value={card.dramaTitle} maxLength={40} onChange={(e) => set('dramaTitle', e.target.value)} />
            </label>
            {kind === 'intro' ? (
              <label className="tstudio-field">
                <span>회차 제목</span>
                <input
                  value={card.episodeTitle}
                  maxLength={50}
                  onChange={(e) => set('episodeTitle', e.target.value)}
                  placeholder={`${n}화 제목`}
                />
              </label>
            ) : (
              <label className="tstudio-field">
                <span>다음 화 예고 한마디 (선택)</span>
                <textarea
                  rows={2}
                  maxLength={80}
                  value={card.nextHint}
                  onChange={(e) => set('nextHint', e.target.value)}
                  placeholder="예: 그날 밤, 그녀가 본 건 누구였을까?"
                />
              </label>
            )}
          </fieldset>
          {background && (
            <fieldset className="tstudio-group">
              <legend>배경</legend>
              <label className="tstudio-check">
                <input
                  type="checkbox"
                  checked={card.useBackground}
                  onChange={(e) => set('useBackground', e.target.checked)}
                />
                <span>흐린 배경 이미지 쓰기</span>
              </label>
              <Slider
                label="흐림 정도"
                min={6}
                max={48}
                step={1}
                value={card.blur}
                text={`${card.blur}`}
                disabled={!card.useBackground || !img}
                onChange={(v) => set('blur', v)}
              />
              {card.preset !== 'paper' && (
                <Slider
                  label="어둡게"
                  min={0}
                  max={0.85}
                  step={0.01}
                  value={card.darkness}
                  text={`${Math.round(card.darkness * 100)}%`}
                  disabled={!card.useBackground || !img}
                  onChange={(v) => set('darkness', v)}
                />
              )}
            </fieldset>
          )}
          <div className="tstudio-save">
            {error && (
              <p className="tstudio-error" role="alert">
                {error}
              </p>
            )}
            {saved && !saving && !error && (
              <p className="tstudio-ok" role="status">
                <Check size={14} /> 저장했어요.
              </p>
            )}
            <button type="button" className="tstudio-primary" onClick={save} disabled={saving}>
              {saving ? <LoaderCircle size={16} className="tstudio-spin" /> : <Save size={16} />}
              {saving ? '저장하는 중…' : `${label} 저장`}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  text: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className={`tstudio-range${props.disabled ? ' is-off' : ''}`}>
      <label htmlFor={id}>
        <span>{props.label}</span>
        <output htmlFor={id}>{props.text}</output>
      </label>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={props.text}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}
