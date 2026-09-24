// AI 모델 안내(2026-09-24): 모델을 '브랜드(계열)'로 묶어 PD에게 무엇을 잘하고 무엇을 못 하는지 알려 줍니다.
// 예) Claude는 글(기획·대본·연출) 전문이라 이미지·영상·음성은 만들 수 없어요 → 영상은 다른 모델 추천.
// caps: 그 계열이 원래 할 수 있는 작업(연결 여부와 별개). 연결된 모델은 PD 화면에서 따로 확인합니다.
export const FAMILIES = [
  { id: 'claude', name: 'Claude', maker: 'Anthropic', caps: ['text'], note: '글쓰기 전문 — 기획안·대본·연출 지시·대사 다듬기에 강해요.', match: /claude|anthropic/i },
  { id: 'gpt', name: 'GPT · OpenAI', maker: 'OpenAI', caps: ['text', 'image', 'tts', 'stt', 'video'], note: '글·이미지·음성을 두루 해요. 영상(Sora)은 공급 여부에 따라 달라요.', match: /gpt|openai|whisper|sora/i },
  { id: 'gemini', name: 'Gemini · Veo', maker: 'Google', caps: ['text', 'image', 'video', 'tts'], note: '글·이미지·영상(Veo)·음성까지 한 계열로 만들 수 있어요.', match: /gemini|veo|google|imagen|lyria/i },
  { id: 'kling', name: 'Kling', maker: 'Kuaishou', caps: ['video'], note: '영상 전문 — 인물 움직임·액션이 자연스러워요.', match: /kling/i },
  { id: 'hailuo', name: 'Hailuo · MiniMax', maker: 'MiniMax', caps: ['video', 'tts'], note: '저렴한 영상과 한국어 음성을 만들어요.', match: /hailuo|minimax/i },
  { id: 'wan', name: 'Wan', maker: 'Alibaba', caps: ['video', 'image'], note: '저렴한 영상·이미지, 풍경 장면에 알맞아요.', match: /\bwan\b|wan[0-9]|wan-|alibaba wan/i },
  { id: 'seed', name: 'Seedance · Seedream', maker: 'ByteDance', caps: ['video', 'image'], note: '영화 같은 영상(Seedance)과 인물 이미지(Seedream)에 강해요.', match: /seedance|seedream|doubao|bytedance/i },
  { id: 'flux', name: 'FLUX', maker: 'Black Forest Labs', caps: ['image'], note: '이미지 전문 — 빠르고 저렴해요.', match: /flux/i },
  { id: 'eleven', name: 'ElevenLabs', maker: 'ElevenLabs', caps: ['tts', 'stt', 'music', 'sfx'], note: '소리 전문 — 감정 있는 목소리·배경음악·효과음을 만들어요.', match: /eleven/i },
  { id: 'sync', name: 'Sync', maker: 'Sync Labs', caps: ['lipsync'], note: '입 모양 맞추기 전문이에요.', match: /sync-lipsync|sync lipsync/i },
  { id: 'mmaudio', name: 'MMAudio', maker: 'MMAudio', caps: ['sfx'], note: '영상에 맞는 효과음을 만들어요.', match: /mmaudio/i },
  { id: 'deepseek', name: 'DeepSeek', maker: 'DeepSeek', caps: ['text'], note: '저렴한 글쓰기 모델이에요.', match: /deepseek/i },
  { id: 'qwen', name: 'Qwen', maker: 'Alibaba', caps: ['text'], note: '저렴한 글쓰기 모델이에요.', match: /qwen/i },
  { id: 'kimi', name: 'Kimi', maker: 'Moonshot', caps: ['text'], note: '긴 이야기 구성에 쓰는 글쓰기 모델이에요.', match: /kimi|moonshot/i },
  { id: 'glm', name: 'GLM', maker: 'Zhipu', caps: ['text'], note: '글쓰기 모델이에요.', match: /glm|zhipu/i },
  { id: 'mock', name: '개발용 가짜 AI', maker: '숏핑', caps: ['text', 'image', 'video', 'tts', 'stt', 'music', 'sfx', 'lipsync'], note: '개발·시험용이에요. 실제 결과물이 아니에요.', match: /mock|가짜/i },
];
// 모델 하나가 어느 계열인지(이름·모델 ID·공급사 종류로 판단). 모르면 'other'
export function familyOf(row) {
  const text = [row.label, row.model_id, row.provider_name, row.kind].filter(Boolean).join(' ');
  if (row.kind === 'mock') return 'mock';
  return FAMILIES.find((f) => f.id !== 'mock' && f.match.test(text))?.id || 'other';
}
export const familyList = () => FAMILIES.map(({ match, ...f }) => f);
