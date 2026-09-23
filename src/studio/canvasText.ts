import { asset } from '../platform';
// 썸네일·타이틀 카드 공용 캔버스 도우미. DOM에 의존하지 않는 부분(wrapLines 등)은 순수 함수라
// node에서도 단독으로 확인할 수 있어요.
import { api } from '../api';

export const SANS = '"Noto Sans KR Variable", "Noto Sans KR", sans-serif';
export const SERIF = '"Noto Serif KR Variable", "Noto Serif KR", serif';
export const UPLOAD_LIMIT = 10 * 1024 * 1024;

export type Rgb = { r: number; g: number; b: number };

let fontsPromise: Promise<void> | null = null;
/** 캔버스에 그리기 전에 한글 가변 폰트를 확실히 불러와요. 실패해도 대체 폰트로 계속 그려요. */
export function ensureFonts(): Promise<void> {
  if (fontsPromise) return fontsPromise;
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const sample = '숏핑 드라마 다음 화에서 계속 0123456789';
  const specs = [
    `400 32px ${SANS}`,
    `700 64px ${SANS}`,
    `900 64px ${SANS}`,
    `500 32px ${SERIF}`,
    `700 64px ${SERIF}`,
    `900 64px ${SERIF}`,
  ];
  fontsPromise = Promise.all(specs.map((s) => document.fonts.load(s, sample).catch(() => [])))
    .then(() => undefined)
    .catch(() => undefined);
  return fontsPromise;
}

/**
 * 한글 웹폰트는 글자 범위(unicode-range)별로 쪼개져 있어서, 실제로 그릴 글자가 든 조각을
 * 미리 받아 두지 않으면 캔버스가 일부 글자를 대체 폰트로 그려요. 그릴 문구로 한 번 더 불러와요.
 */
export async function ensureFontsFor(text: string, families: string[] = [SANS, SERIF]): Promise<void> {
  await ensureFonts();
  if (typeof document === 'undefined' || !document.fonts) return;
  const chars = Array.from(new Set(Array.from(text.replace(/\s+/g, '')))).join('');
  if (!chars) return;
  const specs: string[] = [];
  for (const f of families) for (const w of [500, 700, 900]) specs.push(`${w} 48px ${f}`);
  await Promise.all(specs.map((s) => document.fonts.load(s, chars).catch(() => []))).catch(() => undefined);
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
/** 이미지를 불러와요. 같은 출처 이미지여도 crossOrigin을 지정해 캔버스가 오염되지 않게 해요. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  const hit = imageCache.get(url);
  if (hit) return hit;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    if (!url.startsWith('blob:') && !url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러오지 못했어요.'));
    img.src = asset(url);
  });
  p.catch(() => imageCache.delete(url));
  imageCache.set(url, p);
  return p;
}

/**
 * 텍스트를 너비에 맞춰 줄바꿈해요. 사용자가 넣은 줄바꿈(\n)은 그대로 지키고,
 * 띄어쓰기 단위로 먼저 나누되 한 단어가 너무 길면 음절(글자) 단위로 끊어요.
 * maxLines를 넘으면 마지막 줄 끝에 말줄임표를 붙여요.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
  maxLines = Infinity,
): { lines: string[]; overflow: boolean } {
  const out: string[] = [];
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (out.length && paragraphs.length > 1) out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = '';
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      // 긴 단어는 글자 단위로 쪼개요 (서로게이트 쌍 보존을 위해 Array.from 사용).
      for (const ch of Array.from(word)) {
        if (line && measure(line + ch) > maxWidth) {
          out.push(line);
          line = ch;
        } else line += ch;
      }
    }
    if (line) out.push(line);
  }
  // 앞뒤 빈 줄 정리
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  if (out.length <= maxLines) return { lines: out, overflow: false };
  const kept = out.slice(0, maxLines);
  let last = kept[kept.length - 1] + '…';
  while (last.length > 1 && measure(last) > maxWidth) last = last.slice(0, -2) + '…';
  kept[kept.length - 1] = last;
  return { lines: kept, overflow: true };
}

/**
 * 글자 크기를 줄여 가며 maxLines·maxHeight 안에 들어가는 가장 큰 크기를 찾아요.
 * font(size)는 ctx.font에 넣을 문자열을 돌려줘야 해요.
 */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: (size: number) => string,
  opts: { maxWidth: number; maxLines: number; start: number; min: number; lineHeight: number; maxHeight?: number },
): { size: number; lines: string[]; height: number } {
  let size = Math.max(opts.min, opts.start);
  for (;;) {
    ctx.font = font(size);
    const { lines, overflow } = wrapLines(text, opts.maxWidth, (s) => ctx.measureText(s).width, opts.maxLines);
    const height = lines.length * size * opts.lineHeight;
    const fits = !overflow && (!opts.maxHeight || height <= opts.maxHeight);
    if (fits || size <= opts.min) return { size, lines, height };
    size = Math.max(opts.min, Math.floor(size * 0.92));
  }
}

/** object-fit: cover처럼 이미지를 채워 그려요. pan은 -1~1(0이 가운데), zoom은 1 이상. */
export function coverRect(
  iw: number,
  ih: number,
  w: number,
  h: number,
  zoom = 1,
  panX = 0,
  panY = 0,
): { x: number; y: number; w: number; h: number } {
  const s = Math.max(w / iw, h / ih) * Math.max(1, zoom);
  const dw = iw * s;
  const dh = ih * s;
  const cx = Math.max(-1, Math.min(1, panX));
  const cy = Math.max(-1, Math.min(1, panY));
  return { x: (w - dw) / 2 + (cx * (dw - w)) / 2, y: (h - dh) / 2 + (cy * (dh - h)) / 2, w: dw, h: dh };
}

export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width: number; height: number },
  w: number,
  h: number,
  zoom = 1,
  panX = 0,
  panY = 0,
) {
  const iw = (img as HTMLImageElement).naturalWidth || img.width;
  const ih = (img as HTMLImageElement).naturalHeight || img.height;
  if (!iw || !ih) return;
  const r = coverRect(iw, ih, w, h, zoom, panX, panY);
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
}

/**
 * ctx.filter를 지원하지 않는 브라우저(구형 사파리)에서도 동작하도록
 * 작게 줄였다가 다시 키우는 방식으로 흐리게 그려요.
 */
export function drawBlurredCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  strength = 24,
) {
  const factor = Math.max(4, Math.min(48, strength));
  const sw = Math.max(8, Math.round(w / factor));
  const sh = Math.max(8, Math.round(h / factor));
  const mid = document.createElement('canvas');
  mid.width = sw * 4;
  mid.height = sh * 4;
  const mctx = mid.getContext('2d');
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  if (!mctx || !sctx) return drawCover(ctx, img, w, h, 1.1);
  mctx.imageSmoothingQuality = 'high';
  drawCover(mctx, img, mid.width, mid.height, 1.1);
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(mid, 0, 0, sw, sh);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, -w * 0.02, -h * 0.02, w * 1.04, h * 1.04);
  ctx.restore();
}

export function hexToRgb(hex: string): Rgb {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 255, g: 255, b: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgba(hex: string, a: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** 밝기(0~1). 글자색 대비 판단에 써요. */
export function luminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 세로 그라데이션 오버레이. stops는 [위치(0~1), 색] 목록이에요. */
export function verticalOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  stops: [number, string][],
  from = 0,
  to = h,
) {
  const g = ctx.createLinearGradient(0, from, 0, to);
  for (const [at, color] of stops) g.addColorStop(Math.max(0, Math.min(1, at)), color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export function vignette(ctx: CanvasRenderingContext2D, w: number, h: number, strength = 0.75, color = '0,0,0') {
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.25, w / 2, h / 2, r);
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(1, `rgba(${color},${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 알약 모양 라벨을 그리고 그 높이를 돌려줘요. (x는 align 기준점) */
export function drawPill(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { font: string; size: number; bg: string; color: string; align?: CanvasTextAlign; padX?: number; radius?: number },
) {
  ctx.save();
  ctx.font = opts.font;
  const padX = opts.padX ?? opts.size * 0.7;
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  const bh = opts.size * 1.75;
  const left = opts.align === 'center' ? x - bw / 2 : opts.align === 'right' ? x - bw : x;
  roundRectPath(ctx, left, y, bw, bh, opts.radius ?? bh / 2);
  ctx.fillStyle = opts.bg;
  ctx.fill();
  ctx.fillStyle = opts.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + padX, y + bh / 2 + opts.size * 0.04);
  ctx.restore();
  return { width: bw, height: bh };
}

/** 가독성을 위해 외곽선 + 그림자를 먼저 그리고 그 위에 글자를 채워요. */
export function drawLegibleLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  opts: {
    size: number;
    lineHeight: number;
    color: string;
    align: CanvasTextAlign;
    stroke?: string | null;
    strokeWidth?: number;
    shadow?: string | null;
    shadowBlur?: number;
  },
) {
  ctx.save();
  ctx.textAlign = opts.align;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const lh = opts.size * opts.lineHeight;
  const pad = (lh - opts.size) / 2;
  lines.forEach((line, i) => {
    const ly = y + i * lh + pad;
    if (opts.stroke) {
      ctx.save();
      if (opts.shadow) {
        ctx.shadowColor = opts.shadow;
        ctx.shadowBlur = opts.shadowBlur ?? opts.size * 0.3;
        ctx.shadowOffsetY = opts.size * 0.04;
      }
      ctx.strokeStyle = opts.stroke;
      ctx.lineWidth = opts.strokeWidth ?? Math.max(2, opts.size * 0.09);
      ctx.strokeText(line, x, ly);
      ctx.restore();
    } else if (opts.shadow) {
      ctx.shadowColor = opts.shadow;
      ctx.shadowBlur = opts.shadowBlur ?? opts.size * 0.3;
      ctx.shadowOffsetY = opts.size * 0.04;
    }
    ctx.fillStyle = opts.color;
    ctx.fillText(line, x, ly);
  });
  ctx.restore();
  return lines.length * lh;
}

/**
 * 캔버스를 PNG Blob으로 바꿔요. 업로드 한도(10MB)를 넘으면 JPEG로 한 번 더 압축해요.
 * 다른 출처 이미지 때문에 캔버스가 오염되면 한국어 오류로 알려 줘요.
 */
export async function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const encode = (type: string, quality?: number) =>
    new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('이미지를 만들지 못했어요. 다시 시도해 주세요.'))),
          type,
          quality,
        );
      } catch (e) {
        const name = (e as Error)?.name;
        reject(
          new Error(
            name === 'SecurityError'
              ? '배경 이미지의 보안 제한 때문에 저장할 수 없어요. 다른 배경을 골라 주세요.'
              : '이미지를 만들지 못했어요. 다시 시도해 주세요.',
          ),
        );
      }
    });
  const png = await encode('image/png');
  if (png.size <= UPLOAD_LIMIT * 0.95) return png;
  for (const q of [0.92, 0.85, 0.75]) {
    const jpg = await encode('image/jpeg', q);
    if (jpg.size <= UPLOAD_LIMIT * 0.95) return jpg;
  }
  throw new Error('이미지 용량이 너무 커서 올릴 수 없어요.');
}

export type UploadedImage = { url: string; width?: number; height?: number };
/** POST /api/studio/upload (multipart 필드 `file`)로 올리고 결과를 돌려줘요. */
export async function uploadBlob(blob: Blob, name = 'image.png'): Promise<UploadedImage> {
  const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
  const fileName = name.replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
  const form = new FormData();
  form.append('file', blob, fileName);
  const r = await api<UploadedImage>('/studio/upload', 'POST', form);
  if (!r || typeof r.url !== 'string') throw new Error('업로드 결과를 확인하지 못했어요.');
  return r;
}

export function createCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
