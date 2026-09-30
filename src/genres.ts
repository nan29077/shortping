// 장르·진열 분류 단일 기준표. 서버(server/genres.mjs)와 같은 JSON을 읽어요.
import table from '../server/genres.json';

export const GENRES: readonly string[] = table.genres;
export const SHELVES: readonly string[] = table.shelves;
export const CATEGORY_PRESETS: readonly string[] = [...table.shelves, ...table.genres];

// 작품이 있는 장르만 기준표 순서대로(메인·검색 칩용). 기준표에 없는 옛 장르도 뒤에 붙여요.
export function genresIn(items: { genre?: string | null }[]) {
  const have = new Set(items.map((d) => d.genre).filter(Boolean) as string[]);
  return [...GENRES.filter((g) => have.has(g)), ...[...have].filter((g) => !GENRES.includes(g))];
}
