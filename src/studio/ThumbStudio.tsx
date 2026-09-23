import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Check, ImagePlus, LoaderCircle, RotateCcw, Save, X } from 'lucide-react';
import {
  SANS,
  SERIF,
  coverRect,
  createCanvas,
  drawCover,
  drawLegibleLines,
  drawPill,
  ensureFontsFor,
  fitText,
  hexToRgb,
  loadImage,
  luminance,
  rgba,
  toPngBlob,
  uploadBlob,
  verticalOverlay,
  vignette,
  wrapLines,
} from './canvasText';
import './thumbs.css';
import { asset } from '../platform';

export type ThumbStudioProps = {
  title: string;
  genre: string;
  tagline?: string;
  backgrounds: { url: string; label: string }[];
  episodeLabel?: string;
  onSaved: (result: { poster?: string; square?: string; wide?: string }) => void;
  notify: (s: string) => void;
  close?: () => void;
};

type TemplateId = 'classic' | 'thriller' | 'romance' | 'minimal' | 'news';
type Position = 'top' | 'middle' | 'bottom';
type Format = 'poster' | 'square' | 'wide';

type Design = {
  template: TemplateId;
  title: string;
  subtitle: string;
  showSubtitle: boolean;
  badge: string;
  showBadge: boolean;
  textColor: string;
  accent: string;
  position: Position;
  scale: number;
  zoom: number;
  panX: number;
  panY: number;
  darkness: number;
  genre: string;
};

const FORMATS: Record<Format, { w: number; h: number; label: string; short: string }> = {
  poster: { w: 720, h: 1280, label: '세로 포스터 9:16', short: '9:16' },
  square: { w: 1080, h: 1080, label: '정사각 1:1', short: '1:1' },
  wide: { w: 1280, h: 720, label: '가로 공유 카드 16:9', short: '16:9' },
};
const FORMAT_ORDER: Format[] = ['poster', 'square', 'wide'];

type Template = {
  name: string;
  desc: string;
  family: string;
  weight: number;
  align: 'center' | 'left';
  sizeMul: number;
  lineHeight: number;
  defaults: { textColor: string; accent: string; position: Position; darkness: number };
};
const TEMPLATES: Record<TemplateId, Template> = {
  classic: {
    name: '드라마 클래식',
    desc: '아래 그라데이션과 큰 명조 제목',
    family: SERIF,
    weight: 900,
    align: 'center',
    sizeMul: 1,
    lineHeight: 1.18,
    defaults: { textColor: '#ffffff', accent: '#f5c451', position: 'bottom', darkness: 0.1 },
  },
  thriller: {
    name: '강렬한 스릴러',
    desc: '어두운 비네트와 붉은 강조선',
    family: SANS,
    weight: 900,
    align: 'left',
    sizeMul: 1.05,
    lineHeight: 1.12,
    defaults: { textColor: '#ffffff', accent: '#e5262b', position: 'bottom', darkness: 0.2 },
  },
  romance: {
    name: '로맨스 파스텔',
    desc: '부드러운 분홍빛과 둥근 라벨',
    family: SANS,
    weight: 700,
    align: 'center',
    sizeMul: 0.92,
    lineHeight: 1.22,
    defaults: { textColor: '#ffffff', accent: '#ff7aa2', position: 'bottom', darkness: 0 },
  },
  minimal: {
    name: '미니멀',
    desc: '왼쪽 위의 작은 제목',
    family: SANS,
    weight: 700,
    align: 'left',
    sizeMul: 0.5,
    lineHeight: 1.3,
    defaults: { textColor: '#ffffff', accent: '#c4f562', position: 'top', darkness: 0.05 },
  },
  news: {
    name: '뉴스 자막형',
    desc: '박스 배너 자막',
    family: SANS,
    weight: 900,
    align: 'left',
    sizeMul: 0.8,
    lineHeight: 1.2,
    defaults: { textColor: '#111111', accent: '#e11d48', position: 'bottom', darkness: 0.1 },
  },
};
const TEMPLATE_ORDER: TemplateId[] = ['classic', 'thriller', 'romance', 'minimal', 'news'];

const POSITIONS: { id: Position; label: string }[] = [
  { id: 'top', label: '위' },
  { id: 'middle', label: '가운데' },
  { id: 'bottom', label: '아래' },
];

type Block = { h: number; draw: (y: number) => void };

/** 하나의 디자인을 원하는 크기(포맷)에 맞춰 다시 배치해 그려요. */
function renderThumb(
  ctx: CanvasRenderingContext2D,
  fmt: Format,
  d: Design,
  img: HTMLImageElement | null,
) {
  const { w: W, h: H } = FORMATS[fmt];
  const t = TEMPLATES[d.template];
  const unit = Math.min(W, H);
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'top';

  // 1) 배경
  if (img) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawCover(ctx, img, W, H, d.zoom, d.panX, d.panY);
  } else {
    const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, rgba(d.accent, 0.85));
    g.addColorStop(0.55, '#1b2025');
    g.addColorStop(1, '#07090b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (d.darkness > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, d.darkness)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // 2) 템플릿 오버레이 (글자가 놓일 쪽을 더 어둡게)
  const toward = (strength: number, reach = 0.6) => {
    if (d.position === 'bottom')
      verticalOverlay(ctx, W, H, [
        [1 - reach, 'rgba(0,0,0,0)'],
        [1, `rgba(0,0,0,${strength})`],
      ]);
    else if (d.position === 'top')
      verticalOverlay(ctx, W, H, [
        [0, `rgba(0,0,0,${strength})`],
        [reach, 'rgba(0,0,0,0)'],
      ]);
    else
      verticalOverlay(ctx, W, H, [
        [0.15, 'rgba(0,0,0,0)'],
        [0.5, `rgba(0,0,0,${strength * 0.8})`],
        [0.85, 'rgba(0,0,0,0)'],
      ]);
  };
  if (d.template === 'classic') toward(0.88, 0.58);
  else if (d.template === 'thriller') {
    vignette(ctx, W, H, 0.9);
    toward(0.6, 0.5);
    verticalOverlay(ctx, W, H, [
      [0.6, rgba(d.accent, 0)],
      [1, rgba(d.accent, 0.22)],
    ]);
  } else if (d.template === 'romance') {
    ctx.fillStyle = 'rgba(255,190,212,0.26)';
    ctx.fillRect(0, 0, W, H);
    toward(0.38, 0.55);
    const glow = ctx.createRadialGradient(W * 0.85, H * 0.1, 0, W * 0.85, H * 0.1, unit * 0.9);
    glow.addColorStop(0, 'rgba(255,236,244,0.35)');
    glow.addColorStop(1, 'rgba(255,236,244,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  } else if (d.template === 'minimal') toward(0.55, 0.45);
  else toward(0.45, 0.4);

  // 3) 글자 배치 영역
  const margin = unit * 0.075;
  const safeTop = margin + (fmt === 'poster' ? H * 0.035 : 0);
  const safeBottom = margin + (fmt === 'poster' ? H * 0.065 : 0);
  const align = t.align;
  const leftX = margin;
  let maxW = W - margin * 2;
  if (fmt === 'wide') maxW = W * (align === 'left' ? 0.6 : 0.74);
  const anchorX = align === 'center' ? W / 2 : leftX;
  const sizeBase = unit * { poster: 0.105, square: 0.09, wide: 0.1 }[fmt] * t.sizeMul * d.scale;
  const maxLines = d.template === 'minimal' ? 3 : fmt === 'poster' ? 4 : 3;
  const maxTitleH = H * (d.position === 'middle' ? 0.55 : 0.42);
  const titleText = d.title.trim() || '제목을 입력해 주세요';
  const titleFont = (s: number) => `${t.weight} ${s}px ${t.family}`;

  const blocks: Block[] = [];
  const gap = (h: number) => blocks.push({ h, draw: () => {} });

  // 3-1) 에피소드 배지
  const badge = d.showBadge ? d.badge.trim() : '';
  if (badge) {
    const bs = Math.round(unit * 0.03);
    const bh = bs * 1.75;
    blocks.push({
      h: bh,
      draw: (y) =>
        drawPill(ctx, badge, anchorX, y, {
          font: `800 ${bs}px ${SANS}`,
          size: bs,
          bg: d.template === 'news' ? '#111111' : d.accent,
          color: d.template === 'news' ? '#ffffff' : pickOn(d.accent),
          align,
          radius: d.template === 'news' || d.template === 'thriller' ? bs * 0.25 : undefined,
        }),
    });
    gap(unit * 0.025);
  }

  // 3-2) 템플릿별 머리 장식
  if (d.template === 'thriller') {
    const lh = Math.max(4, unit * 0.009);
    blocks.push({
      h: lh,
      draw: (y) => {
        ctx.fillStyle = d.accent;
        ctx.fillRect(anchorX, y, unit * 0.16, lh);
      },
    });
    gap(unit * 0.03);
  }
  if (d.template === 'minimal' && d.genre.trim()) {
    const ks = Math.round(unit * 0.024);
    blocks.push({
      h: ks * 1.3,
      draw: (y) => {
        ctx.save();
        ctx.font = `700 ${ks}px ${SANS}`;
        ctx.letterSpacing = `${Math.round(ks * 0.35)}px`;
        ctx.fillStyle = d.accent;
        ctx.textAlign = 'left';
        ctx.fillText(d.genre.trim().toUpperCase(), anchorX, y);
        ctx.restore();
      },
    });
    gap(unit * 0.02);
  }

  // 3-3) 제목
  if (d.template === 'news') {
    const tagSize = Math.round(unit * 0.028);
    const tagText = d.genre.trim() || '속보';
    const pad = unit * 0.028;
    ctx.save();
    const fit = fitText(ctx, titleText, titleFont, {
      maxWidth: maxW - pad * 2,
      maxLines,
      start: Math.round(sizeBase),
      min: Math.round(unit * 0.035),
      lineHeight: t.lineHeight,
      maxHeight: maxTitleH,
    });
    ctx.font = titleFont(fit.size);
    const widest = Math.max(...fit.lines.map((l) => ctx.measureText(l).width), unit * 0.2);
    ctx.restore();
    const tagH = tagSize * 1.8;
    blocks.push({
      h: tagH,
      draw: (y) => {
        ctx.save();
        ctx.font = `900 ${tagSize}px ${SANS}`;
        const tw = ctx.measureText(tagText).width + tagSize * 1.4;
        ctx.fillStyle = d.accent;
        ctx.fillRect(leftX, y, tw, tagH);
        ctx.fillStyle = pickOn(d.accent);
        ctx.textBaseline = 'middle';
        ctx.fillText(tagText, leftX + tagSize * 0.7, y + tagH / 2);
        ctx.restore();
      },
    });
    const boxH = fit.height + pad * 1.6;
    blocks.push({
      h: boxH,
      draw: (y) => {
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = unit * 0.02;
        ctx.fillRect(leftX, y, Math.min(maxW, widest + pad * 2), boxH);
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = d.accent;
        ctx.fillRect(leftX, y, Math.max(4, unit * 0.008), boxH);
        ctx.font = titleFont(fit.size);
        drawLegibleLines(ctx, fit.lines, leftX + pad, y + pad * 0.8, {
          size: fit.size,
          lineHeight: t.lineHeight,
          color: d.textColor,
          align: 'left',
        });
        ctx.restore();
      },
    });
  } else {
    const fit = fitText(ctx, titleText, titleFont, {
      maxWidth: maxW,
      maxLines,
      start: Math.round(sizeBase),
      min: Math.round(unit * (d.template === 'minimal' ? 0.03 : 0.04)),
      lineHeight: t.lineHeight,
      maxHeight: maxTitleH,
    });
    const style =
      d.template === 'classic'
        ? { stroke: 'rgba(0,0,0,0.45)', shadow: 'rgba(0,0,0,0.7)' }
        : d.template === 'thriller'
          ? { stroke: 'rgba(0,0,0,0.65)', shadow: rgba(d.accent, 0.55) }
          : d.template === 'romance'
            ? { stroke: 'rgba(150,40,85,0.45)', shadow: 'rgba(120,20,60,0.5)' }
            : { stroke: null, shadow: 'rgba(0,0,0,0.6)' };
    blocks.push({
      h: fit.height,
      draw: (y) => {
        ctx.save();
        ctx.font = titleFont(fit.size);
        if (d.template === 'minimal') ctx.letterSpacing = `${Math.round(fit.size * 0.04)}px`;
        if (d.template === 'thriller') ctx.letterSpacing = `${Math.round(-fit.size * 0.02)}px`;
        drawLegibleLines(ctx, fit.lines, anchorX, y, {
          size: fit.size,
          lineHeight: t.lineHeight,
          color: d.textColor,
          align,
          stroke: style.stroke,
          strokeWidth: fit.size * 0.1,
          shadow: style.shadow,
          shadowBlur: fit.size * 0.35,
        });
        ctx.restore();
      },
    });
  }

  // 3-4) 부제
  const sub = d.showSubtitle ? d.subtitle.trim() : '';
  if (sub) {
    const ss = Math.round(unit * (d.template === 'minimal' ? 0.026 : 0.034) * Math.min(1.2, Math.max(0.85, d.scale)));
    gap(unit * (d.template === 'news' ? 0 : 0.028));
    if (d.template === 'romance') {
      ctx.font = `600 ${ss}px ${SANS}`;
      const one = wrapLines(sub, maxW - ss * 1.6, (s) => ctx.measureText(s).width, 1).lines[0] ?? '';
      blocks.push({
        h: ss * 1.75,
        draw: (y) =>
          drawPill(ctx, one, anchorX, y, {
            font: `600 ${ss}px ${SANS}`,
            size: ss,
            bg: rgba('#ffffff', 0.9),
            color: shade(d.accent),
            align,
          }),
      });
    } else if (d.template === 'news') {
      const pad = ss * 0.6;
      ctx.font = `600 ${ss}px ${SANS}`;
      const { lines } = wrapLines(sub, maxW - pad * 2, (s) => ctx.measureText(s).width, 2);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const h = lines.length * ss * 1.4 + pad * 1.2;
      blocks.push({
        h,
        draw: (y) => {
          ctx.save();
          ctx.fillStyle = 'rgba(12,14,16,0.86)';
          ctx.fillRect(leftX, y, Math.min(maxW, widest + pad * 2), h);
          ctx.font = `600 ${ss}px ${SANS}`;
          drawLegibleLines(ctx, lines, leftX + pad, y + pad * 0.6, {
            size: ss,
            lineHeight: 1.4,
            color: '#ffffff',
            align: 'left',
          });
          ctx.restore();
        },
      });
    } else {
      const weight = d.template === 'classic' ? 500 : 600;
      const family = d.template === 'classic' ? SERIF : SANS;
      ctx.font = `${weight} ${ss}px ${family}`;
      const { lines } = wrapLines(sub, maxW, (s) => ctx.measureText(s).width, 2);
      blocks.push({
        h: lines.length * ss * 1.45,
        draw: (y) => {
          ctx.save();
          ctx.font = `${weight} ${ss}px ${family}`;
          drawLegibleLines(ctx, lines, anchorX, y, {
            size: ss,
            lineHeight: 1.45,
            color: d.template === 'thriller' ? '#e9e9e9' : rgba(d.textColor, 0.92),
            align,
            shadow: 'rgba(0,0,0,0.75)',
            shadowBlur: ss * 0.5,
          });
          ctx.restore();
        },
      });
    }
  }

  // 4) 세로 위치 결정 후 차례로 그리기
  const total = blocks.reduce((s, b) => s + b.h, 0);
  let y =
    d.position === 'top'
      ? safeTop
      : d.position === 'middle'
        ? (H - total) / 2
        : H - safeBottom - total;
  y = Math.max(margin * 0.5, Math.min(y, H - total - margin * 0.5));
  for (const b of blocks) {
    b.draw(y);
    y += b.h;
  }
  ctx.restore();
}

function pickOn(hex: string) {
  return luminance(hex) > 0.62 ? '#111111' : '#ffffff';
}
function shade(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v: number) => Math.round(v * 0.62);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function initialDesign(p: ThumbStudioProps): Design {
  const tpl = guessTemplate(p.genre);
  return {
    template: tpl,
    title: p.title || '',
    subtitle: p.tagline || '',
    showSubtitle: Boolean(p.tagline),
    badge: p.episodeLabel || '',
    showBadge: Boolean(p.episodeLabel),
    ...TEMPLATES[tpl].defaults,
    scale: 1,
    zoom: 1,
    panX: 0,
    panY: 0,
    genre: p.genre || '',
  };
}
function guessTemplate(genre: string): TemplateId {
  const g = genre || '';
  if (/스릴러|범죄|미스터리|호러|공포|복수|액션/.test(g)) return 'thriller';
  if (/로맨스|멜로|연애|하이틴/.test(g)) return 'romance';
  if (/다큐|시사|뉴스|사회/.test(g)) return 'news';
  return 'classic';
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export default function ThumbStudio(props: ThumbStudioProps) {
  const { backgrounds, notify, onSaved, close } = props;
  const uid = useId();
  const [design, setDesign] = useState<Design>(() => initialDesign(props));
  const [localBgs, setLocalBgs] = useState<{ url: string; label: string }[]>([]);
  const [bg, setBg] = useState<string | null>(() => backgrounds[0]?.url ?? null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgState, setImgState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [fontsReady, setFontsReady] = useState(0);
  const [fmt, setFmt] = useState<Format>('poster');
  const [saving, setSaving] = useState<{ done: number; label: string } | null>(null);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const localRef = useRef<string[]>([]);

  const set = useCallback(<K extends keyof Design>(k: K, v: Design[K]) => {
    setDesign((d) => ({ ...d, [k]: v }));
    setSavedAt(false);
  }, []);

  // 그릴 문구가 바뀌면 그 글자가 든 폰트 조각을 받아 두고 다시 그려요.
  const fontText = `${design.title}${design.subtitle}${design.badge}${design.genre}${design.genre.toUpperCase()}제목을 입력해 주세요속보`;
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      ensureFontsFor(fontText).then(() => alive && setFontsReady((n) => n + 1));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [fontText]);

  useEffect(
    () => () => {
      localRef.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    if (!bg) {
      setImg(null);
      setImgState('idle');
      return;
    }
    setImgState('loading');
    loadImage(bg).then(
      (i) => {
        if (!alive) return;
        setImg(i);
        setImgState('idle');
      },
      () => {
        if (!alive) return;
        setImg(null);
        setImgState('error');
        notify('배경 이미지를 불러오지 못했어요. 다른 이미지를 골라 주세요.');
      },
    );
    return () => {
      alive = false;
    };
    // notify는 부모가 매번 새로 만들 수 있어 의존성에서 뺐어요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg]);

  // 미리보기 그리기 (드래그 중에도 한 프레임에 한 번만)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const raf = requestAnimationFrame(() => {
      const { w, h } = FORMATS[fmt];
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      const ctx = c.getContext('2d');
      if (ctx) renderThumb(ctx, fmt, design, img);
    });
    return () => cancelAnimationFrame(raf);
  }, [design, img, fmt, fontsReady]);

  const applyTemplate = (id: TemplateId) => {
    setDesign((d) => ({ ...d, template: id, ...TEMPLATES[id].defaults }));
    setSavedAt(false);
  };

  const panBy = (dx: number, dy: number) => {
    setDesign((d) => ({ ...d, panX: clamp(d.panX + dx, -1, 1), panY: clamp(d.panY + dy, -1, 1) }));
    setSavedAt(false);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!img) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = drag.current;
    if (!s || s.id !== e.pointerId || !img) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const { w, h } = FORMATS[fmt];
    const px = ((e.clientX - s.x) * w) / Math.max(1, rect.width);
    const py = ((e.clientY - s.y) * h) / Math.max(1, rect.height);
    drag.current = { ...s, x: e.clientX, y: e.clientY };
    const r = coverRect(img.naturalWidth, img.naturalHeight, w, h, design.zoom, 0, 0);
    const ox = r.w - w;
    const oy = r.h - h;
    panBy(ox > 1 ? (2 * px) / ox : 0, oy > 1 ? (2 * py) / oy : 0);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onCanvasKey = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 0.15 : 0.05;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (map[e.key]) {
      e.preventDefault();
      panBy(...map[e.key]);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      set('zoom', clamp(design.zoom + 0.1, 1, 3));
    } else if (e.key === '-') {
      e.preventDefault();
      set('zoom', clamp(design.zoom - 0.1, 1, 3));
    }
  };

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type))
      return notify('JPG, PNG, WEBP 이미지만 쓸 수 있어요.');
    if (f.size > 20 * 1024 * 1024) return notify('배경 이미지는 20MB 이하로 골라 주세요.');
    const url = URL.createObjectURL(f);
    localRef.current.push(url);
    setLocalBgs((l) => [...l, { url, label: f.name || '내 이미지' }]);
    setBg(url);
    setSavedAt(false);
  };

  const save = async () => {
    if (saving) return;
    if (!design.title.trim()) {
      setError('제목을 입력해 주세요.');
      return;
    }
    setError('');
    const out: { poster?: string; square?: string; wide?: string } = {};
    try {
      await ensureFontsFor(fontText);
      for (let i = 0; i < FORMAT_ORDER.length; i++) {
        const f = FORMAT_ORDER[i];
        setSaving({ done: i, label: FORMATS[f].label });
        const c = createCanvas(FORMATS[f].w, FORMATS[f].h);
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('이 브라우저에서는 이미지를 만들 수 없어요.');
        renderThumb(ctx, f, design, img);
        const blob = await toPngBlob(c);
        const r = await uploadBlob(blob, `thumb-${f}.png`);
        out[f] = r.url;
      }
      setSaving({ done: FORMAT_ORDER.length, label: '완료' });
      onSaved(out);
      setSavedAt(true);
      notify('썸네일 3종(9:16 · 1:1 · 16:9)을 저장했어요.');
    } catch (e) {
      const msg = (e as Error)?.message || '저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
      const doneCount = Object.keys(out).length;
      const full = doneCount ? `${msg} (${doneCount}개는 올라갔지만 저장을 마치지 못했어요.)` : msg;
      setError(full);
      notify(full);
    } finally {
      setSaving(null);
    }
  };

  const allBgs = useMemo(() => [...backgrounds, ...localBgs], [backgrounds, localBgs]);
  const f = FORMATS[fmt];
  const tpl = TEMPLATES[design.template];
  const progress = saving ? Math.round((saving.done / FORMAT_ORDER.length) * 100) : 0;

  return (
    <section className="tstudio" aria-labelledby={`${uid}-h`}>
      <header className="tstudio-head">
        <div>
          <h2 id={`${uid}-h`}>썸네일 만들기</h2>
          <p>배경을 고르고 제목을 올려 세 가지 크기로 한 번에 저장해요.</p>
        </div>
        {close && (
          <button type="button" className="tstudio-icon" onClick={close} aria-label="썸네일 만들기 닫기">
            <X size={18} />
          </button>
        )}
      </header>

      <div className="tstudio-body">
        <div className="tstudio-stage">
          <div className="tstudio-tabs" role="tablist" aria-label="미리보기 크기">
            {FORMAT_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${uid}-tab-${id}`}
                aria-selected={fmt === id}
                aria-controls={`${uid}-panel`}
                tabIndex={fmt === id ? 0 : -1}
                className={fmt === id ? 'on' : ''}
                onClick={() => setFmt(id)}
                onKeyDown={(e) => {
                  const i = FORMAT_ORDER.indexOf(fmt);
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const n = FORMAT_ORDER[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
                    setFmt(n);
                    document.getElementById(`${uid}-tab-${n}`)?.focus();
                  }
                }}
              >
                {FORMATS[id].short}
                <small>{id === 'poster' ? '대표' : id === 'square' ? '피드' : '공유'}</small>
              </button>
            ))}
          </div>
          <div
            className={`tstudio-canvas-wrap is-${fmt}`}
            role="tabpanel"
            id={`${uid}-panel`}
            aria-labelledby={`${uid}-tab-${fmt}`}
          >
            <canvas
              ref={canvasRef}
              width={f.w}
              height={f.h}
              tabIndex={0}
              role="img"
              aria-label={`${f.label} 미리보기: ${design.title || '제목 없음'}. 화살표 키로 배경 위치를, +와 - 키로 확대를 바꿀 수 있어요.`}
              className={img ? 'can-drag' : ''}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onCanvasKey}
            />
            {imgState === 'loading' && (
              <span className="tstudio-overlay-note">
                <LoaderCircle size={16} className="tstudio-spin" /> 배경을 불러오는 중이에요
              </span>
            )}
          </div>
          <p className="tstudio-hint">
            {f.w}×{f.h}px · {img ? '미리보기를 끌어서 배경 위치를 옮길 수 있어요.' : '배경 없이 그라데이션으로 만들어요.'}
          </p>
        </div>

        <div className="tstudio-controls">
          <fieldset className="tstudio-group">
            <legend>배경</legend>
            <div className="tstudio-bgs">
              <button
                type="button"
                className={`tstudio-bg tstudio-bg-none${bg === null ? ' on' : ''}`}
                aria-pressed={bg === null}
                onClick={() => {
                  setBg(null);
                  setSavedAt(false);
                }}
                style={{ background: `linear-gradient(160deg, ${design.accent}, #1b2025 60%, #07090b)` }}
              >
                <span>그라데이션</span>
              </button>
              {allBgs.map((b) => (
                <button
                  key={b.url}
                  type="button"
                  className={`tstudio-bg${bg === b.url ? ' on' : ''}`}
                  aria-pressed={bg === b.url}
                  aria-label={`배경: ${b.label}`}
                  title={b.label}
                  onClick={() => {
                    setBg(b.url);
                    setSavedAt(false);
                  }}
                >
                  <img src={asset(b.url)} alt="" loading="lazy" />
                  {bg === b.url && (
                    <i>
                      <Check size={14} />
                    </i>
                  )}
                </button>
              ))}
              <button
                type="button"
                className="tstudio-bg tstudio-bg-add"
                onClick={() => fileRef.current?.click()}
                aria-label="내 이미지로 배경 고르기"
              >
                <ImagePlus size={20} />
                <span>내 이미지</span>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  pickFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </fieldset>

          <fieldset className="tstudio-group">
            <legend>템플릿</legend>
            <div className="tstudio-templates">
              {TEMPLATE_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`tstudio-tpl tpl-${id}${design.template === id ? ' on' : ''}`}
                  aria-pressed={design.template === id}
                  onClick={() => applyTemplate(id)}
                >
                  <b>{TEMPLATES[id].name}</b>
                  <small>{TEMPLATES[id].desc}</small>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="tstudio-group">
            <legend>글자</legend>
            <label className="tstudio-field">
              <span>제목 (Enter로 줄바꿈)</span>
              <textarea
                rows={2}
                maxLength={60}
                value={design.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder={props.title || '드라마 제목'}
              />
            </label>
            <div className="tstudio-check-row">
              <label className="tstudio-check">
                <input
                  type="checkbox"
                  checked={design.showSubtitle}
                  onChange={(e) => set('showSubtitle', e.target.checked)}
                />
                <span>부제 표시</span>
              </label>
            </div>
            {design.showSubtitle && (
              <label className="tstudio-field">
                <input
                  value={design.subtitle}
                  maxLength={60}
                  onChange={(e) => set('subtitle', e.target.value)}
                  placeholder="한 줄 소개나 명대사를 넣어 보세요"
                  aria-label="부제"
                />
              </label>
            )}
            <div className="tstudio-check-row">
              <label className="tstudio-check">
                <input
                  type="checkbox"
                  checked={design.showBadge}
                  onChange={(e) => set('showBadge', e.target.checked)}
                />
                <span>회차 배지</span>
              </label>
              {design.showBadge && (
                <input
                  className="tstudio-badge-input"
                  value={design.badge}
                  maxLength={12}
                  onChange={(e) => set('badge', e.target.value)}
                  placeholder="예: 3화"
                  aria-label="배지 문구"
                />
              )}
            </div>
            {(design.template === 'minimal' || design.template === 'news') && (
              <label className="tstudio-field">
                <span>{design.template === 'news' ? '자막 머리표' : '장르 표기'}</span>
                <input value={design.genre} maxLength={16} onChange={(e) => set('genre', e.target.value)} />
              </label>
            )}
            <div className="tstudio-colors">
              <label>
                <input type="color" value={design.textColor} onChange={(e) => set('textColor', e.target.value)} />
                <span>글자색</span>
              </label>
              <label>
                <input type="color" value={design.accent} onChange={(e) => set('accent', e.target.value)} />
                <span>강조색</span>
              </label>
            </div>
            <div className="tstudio-seg" role="radiogroup" aria-label="제목 위치">
              {POSITIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={design.position === p.id}
                  className={design.position === p.id ? 'on' : ''}
                  onClick={() => set('position', p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Range
              label="글자 크기"
              min={0.6}
              max={1.5}
              step={0.05}
              value={design.scale}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => set('scale', v)}
            />
          </fieldset>

          <fieldset className="tstudio-group">
            <legend>배경 조정</legend>
            <Range
              label="확대"
              min={1}
              max={3}
              step={0.01}
              value={design.zoom}
              format={(v) => `${v.toFixed(2)}배`}
              onChange={(v) => set('zoom', v)}
              disabled={!img}
            />
            <Range
              label="좌우 위치"
              min={-1}
              max={1}
              step={0.01}
              value={design.panX}
              format={(v) => `${Math.round(v * 100)}`}
              onChange={(v) => set('panX', v)}
              disabled={!img}
            />
            <Range
              label="상하 위치"
              min={-1}
              max={1}
              step={0.01}
              value={design.panY}
              format={(v) => `${Math.round(v * 100)}`}
              onChange={(v) => set('panY', v)}
              disabled={!img}
            />
            <Range
              label="어둡게"
              min={0}
              max={0.8}
              step={0.01}
              value={design.darkness}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => set('darkness', v)}
            />
            <button
              type="button"
              className="tstudio-ghost"
              onClick={() => {
                setDesign((d) => ({ ...d, zoom: 1, panX: 0, panY: 0, darkness: tpl.defaults.darkness }));
                setSavedAt(false);
              }}
            >
              <RotateCcw size={14} /> 배경 조정 되돌리기
            </button>
          </fieldset>

          <div className="tstudio-save">
            {saving && (
              <div className="tstudio-progress" role="status" aria-live="polite">
                <div className="bar">
                  <span style={{ width: `${Math.max(6, progress)}%` }} />
                </div>
                <small>
                  {saving.done < FORMAT_ORDER.length
                    ? `${saving.label} 올리는 중 (${saving.done + 1}/${FORMAT_ORDER.length})`
                    : '마무리하는 중이에요'}
                </small>
              </div>
            )}
            {error && (
              <p className="tstudio-error" role="alert">
                {error}
              </p>
            )}
            {savedAt && !saving && !error && (
              <p className="tstudio-ok" role="status">
                <Check size={14} /> 저장했어요. 다시 고치면 새로 저장할 수 있어요.
              </p>
            )}
            <button type="button" className="tstudio-primary" onClick={save} disabled={Boolean(saving)}>
              {saving ? <LoaderCircle size={16} className="tstudio-spin" /> : <Save size={16} />}
              {saving ? '저장하는 중…' : '3가지 크기로 저장'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Range(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`tstudio-range${props.disabled ? ' is-off' : ''}`}>
      <label htmlFor={id}>
        <span>{props.label}</span>
        <output htmlFor={id}>{props.format(props.value)}</output>
      </label>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={props.format(props.value)}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}
