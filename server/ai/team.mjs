// 협업(팀) 권한(2026-09-25): 소유자 · 공동 제작 · 작가 · 편집·연출 · 검수자.
// 권한 키: view(보기) · script(기획·대본 글) · scene(장면·이미지·영상·음성·합성) · approve(승인) · manage(공유·예산·공개·삭제 — 소유자만)
export const ROLES = ['producer', 'writer', 'editor', 'reviewer'];
export const ROLE_NAME = { owner: '소유자', producer: '공동 제작', writer: '작가', editor: '편집·연출', reviewer: '검수자' };
const PERMS = {
  owner: ['view', 'script', 'scene', 'approve', 'manage'],
  producer: ['view', 'script', 'scene', 'approve'],
  writer: ['view', 'script'],
  editor: ['view', 'scene'],
  reviewer: ['view', 'approve'],
};
export const permsOf = (role) => PERMS[role] || [];
// need: 문자열 하나 또는 배열(그중 하나만 있으면 됨)
export const can = (role, need) => (Array.isArray(need) ? need : [need]).some((n) => permsOf(role).includes(n));
const NEED_TEXT = { view: '보기', script: '기획·대본 편집', scene: '장면 편집', approve: '승인', manage: '프로젝트 관리' };
export const needText = (need) => (Array.isArray(need) ? need : [need]).map((n) => NEED_TEXT[n] || n).join(' 또는 ');

// AI 작업별로 필요한 권한(글 작업은 script, 그림·소리·영상은 scene)
const SCRIPT_ACTIONS = new Set(['plan', 'adapt', 'bible', 'season', 'metadata', 'parse_script', 'reverse_script', 'script', 'diagnose', 'rewrite_range', 'variants', 'rewrite_shot', 'bridge_shot']);
export const actionNeed = (action) => {
  const a = String(action || '').replace(/^batch_/, '');
  return SCRIPT_ACTIONS.has(a) ? 'script' : 'scene';
};
