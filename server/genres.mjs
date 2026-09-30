import { readFileSync } from 'node:fs';

// 장르·진열 분류 단일 기준표(genres.json). 화면(src/genres.ts)도 같은 파일을 읽어요.
const raw = JSON.parse(readFileSync(new URL('./genres.json', import.meta.url), 'utf8'));
export const GENRES = Object.freeze([...raw.genres]);
export const SHELVES = Object.freeze([...raw.shelves]);
// 방송국 진열 카테고리 추천: 진열 묶음 + 장르
export const CATEGORY_PRESETS = Object.freeze([...raw.shelves, ...raw.genres]);
