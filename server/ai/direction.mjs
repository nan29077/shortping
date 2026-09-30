import { readFileSync } from 'node:fs';

// 컷 연출(샷 크기·앵글·렌즈 느낌·카메라 움직임·강도) 사전과 프롬프트 조각(2026-09-29, 힉스필드 벤치마킹 1단계).
// 화면(src/studio/ws/Direction.tsx)도 같은 direction.json을 읽어 카드로 보여 줍니다.
export const DIRECTION = JSON.parse(readFileSync(new URL('./direction.json', import.meta.url), 'utf8'));
const byId = (list) => new Map(list.map((x) => [x.id, x]));
const SIZES = byId(DIRECTION.sizes);
const ANGLES = byId(DIRECTION.angles);
const LENSES = byId(DIRECTION.lenses);
const MOVES = byId(DIRECTION.moves);
const STRENGTHS = byId(DIRECTION.strengths);
const LIGHTS = byId(DIRECTION.lights);
const TONES = byId(DIRECTION.tones);
const HEIGHTS = byId(DIRECTION.heights);
export const CAMERA_MOVES = DIRECTION.moves.map((m) => m.id);
export const ANGLE_IDS = DIRECTION.angles.map((a) => a.id);
export const LENS_IDS = DIRECTION.lenses.map((l) => l.id);
export const STRENGTH_IDS = DIRECTION.strengths.map((s) => s.id);
// 복잡한 움직임(궤도·크레인·달리 줌 등)은 카메라 제어가 약한 모델에서 비슷한 쉬운 움직임으로 바꿉니다.
export const isComplexMove = (move) => !!MOVES.get(move)?.complex;
export const fallbackMove = (move) => MOVES.get(move)?.fallback || move;
export const moveFactor = (strength) => Number(STRENGTHS.get(strength || '')?.factor || 1);

// 영어 프롬프트 조각. 사전에 없는 값(예전 자유 입력)은 그대로 넘깁니다.
const en = (map, v) => (v ? map.get(v)?.en || v : '');
export function framingText(shot) {
  return [en(SIZES, shot.camera), en(ANGLES, shot.angle), en(HEIGHTS, heightOf(shot.height)), en(LENSES, shot.lens), opticsText(shot)].filter(Boolean).join(', ');
}
export function motionText(shot, { basic = false } = {}) {
  const move = basic && isComplexMove(shot.camera_move) ? fallbackMove(shot.camera_move) : shot.camera_move;
  if (!move) return '';
  const strength = en(STRENGTHS, shot.move_strength || '');
  return [strength, en(MOVES, move)].filter(Boolean).join(' ');
}
// 사전 값만 저장(모르는 값은 비움)
export const angleOf = (v) => (ANGLE_IDS.includes(String(v || '').trim()) ? String(v).trim() : '');
export const lensOf = (v) => (LENS_IDS.includes(String(v || '').trim()) ? String(v).trim() : '');
// 합성 효과(4단계): 회상·꿈결·긴장·충격 줌·심장 박동·흔들림·흑백
export const SHOT_EFFECTS = ['', 'flashback', 'dream', 'tension', 'shock_zoom', 'heartbeat', 'shake', 'mono'];

// ── 2단계(2026-09-30): 조명 · 시간과 색감 · 카메라 높이 · 초점 거리(mm) · 조리개(f값) ─────────
export const LIGHT_IDS = DIRECTION.lights.map((x) => x.id);
export const TONE_IDS = DIRECTION.tones.map((x) => x.id);
export const HEIGHT_IDS = DIRECTION.heights.map((x) => x.id);
export const FOCALS = DIRECTION.focals;
export const APERTURES = DIRECTION.apertures;
export const lightOf = (v) => (LIGHT_IDS.includes(String(v || '').trim()) ? String(v).trim() : '');
export const toneOf = (v) => (TONE_IDS.includes(String(v || '').trim()) ? String(v).trim() : '');
export const heightOf = (v) => (HEIGHT_IDS.includes(String(v || '').trim()) ? String(v).trim() : '');
// 전문가 숫자: 초점 거리 12~300mm(0 = 자동), 조리개 f/1.2~f/22('' = 자동)
export const focalOf = (v) => {
  const n = Math.round(Number(v) || 0);
  return n >= 12 && n <= 300 ? n : 0;
};
export const dofOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.2 && n <= 22 ? String(Math.round(n * 10) / 10) : '';
};
// 렌즈 숫자 → 영어(초점 거리 · 조리개에 따른 심도)
export function opticsText(shot) {
  const parts = [];
  const f = focalOf(shot.focal);
  if (f) parts.push(`${f}mm lens`);
  const a = dofOf(shot.dof);
  if (a) parts.push(`f/${a} aperture, ${Number(a) <= 2.8 ? 'shallow depth of field with creamy bokeh' : Number(a) >= 8 ? 'deep focus, everything sharp' : 'moderate depth of field'}`);
  return parts.join(', ');
}
// 조명 · 시간과 색감 → 영어
export function lightText(shot) {
  return [en(LIGHTS, lightOf(shot.light)), en(TONES, toneOf(shot.tone))].filter(Boolean).join(', ');
}
// 합성할 때 입히는 색 보정(시간과 색감 중 '색감' 항목만)
export const toneGrade = (tone) => TONES.get(toneOf(tone))?.grade || '';
