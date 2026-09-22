import { z } from 'zod';

// 숏폼 드라마 제작용 프롬프트와 결과 검증. 모델이 달라도 같은 JSON 형태를 받도록 합니다.
// 시각 묘사(visual·look)는 영상·이미지 모델이 잘 알아듣는 영어로, 대사와 장면 설명은 한국어로 받습니다.
const SYSTEM = `당신은 한국 모바일 숏폼 드라마(세로 9:16, 회당 1~2분) 전문 작가이자 연출가입니다.
- 첫 3초 안에 갈등이나 궁금증을 던지고, 매 회차 끝은 다음 화가 궁금한 반전·클리프행어로 끝냅니다.
- 실존 인물, 실제 브랜드, 기존 작품의 캐릭터·설정을 쓰지 않습니다. 선정적·폭력적 묘사는 15세 관람가 수준으로 제한합니다.
- 반드시 요청한 JSON 형식만 출력합니다. 설명 문장이나 마크다운을 붙이지 않습니다.`;

export const planSchema = z.object({
  title: z.string().min(1).max(70),
  logline: z.string().min(1).max(200),
  synopsis: z.string().min(1).max(3000),
  style: z.string().max(400).default(''),
  characters: z
    .array(
      z.object({
        name: z.string().min(1).max(30),
        role: z.string().max(60).default(''),
        description: z.string().max(500).default(''),
        look: z.string().max(500).default(''),
      }),
    )
    .min(1)
    .max(8),
  episodes: z
    .array(z.object({ number: z.coerce.number().int().min(1), title: z.string().min(1).max(100), summary: z.string().max(800).default('') }))
    .min(1)
    .max(60),
});
export const scriptSchema = z.object({
  shots: z
    .array(
      z.object({
        scene: z.string().max(200).default(''),
        visual: z.string().min(1).max(800),
        dialogue: z.string().max(300).default(''),
        speaker: z.string().max(30).default(''),
        camera: z.string().max(80).default(''),
        seconds: z.coerce.number().min(2).max(15).default(5),
      }),
    )
    .min(1)
    .max(40),
});

export function planPrompt(p) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 6000,
    purpose: 'plan',
    context: p,
    prompt: `다음 조건으로 숏폼 드라마 기획안을 만들어 주세요.
- 가제: ${p.title || '(자유)'}
- 한 줄 아이디어: ${p.logline}
- 장르: ${p.genre} / 분위기: ${p.tone || '자유'}
- 회차 수: ${p.episode_count}화, 회당 약 ${p.episode_seconds}초
- 화면 스타일: ${p.style || '실사 드라마, 따뜻한 조명'}

JSON 형식:
{"title":"제목","logline":"한 줄 소개","synopsis":"전체 줄거리(5~8문장)","style":"영상 스타일을 영어로 한 문장(예: cinematic Korean drama, soft warm lighting, 35mm)",
 "characters":[{"name":"이름","role":"주인공/조연 등","description":"성격과 목표(한국어)","look":"외모를 영어로 구체적으로(나이대, 머리, 옷, 특징)"}],
 "episodes":[{"number":1,"title":"회차 제목","summary":"회차 줄거리 2~3문장과 마지막 반전"}]}
episodes는 정확히 ${p.episode_count}개, characters는 2~5명.`,
  };
}
export function scriptPrompt({ project, characters, episode, previous, maxShotSeconds }) {
  const cast = characters.map((c) => `- ${c.name} (${c.role}): ${c.description} / look: ${c.look}`).join('\n');
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 6000,
    purpose: 'script',
    context: { project, characters, episode },
    prompt: `작품 "${project.title}" (${project.genre}) ${episode.number}화 대본을 컷 단위로 써 주세요.
작품 줄거리: ${project.synopsis}
영상 스타일: ${project.style}
등장인물:
${cast}
${previous ? `이전 화 요약: ${previous}\n` : ''}이번 화: ${episode.title} — ${episode.summary}

규칙:
- 전체 길이 약 ${project.episode_seconds}초, 컷 하나는 3~${maxShotSeconds}초.
- 첫 컷에서 바로 갈등을 보여 주고, 마지막 컷은 다음 화가 궁금해지는 장면.
- visual: 이 컷의 화면을 영어로 묘사(인물 외모는 look을 반복해 일관성 유지, 세로 구도, 조명, 동작).
- dialogue: 한국어 대사 한 줄(없으면 빈 문자열). speaker: 말하는 인물 이름(대사 없으면 빈 문자열).
- camera: 샷 크기·움직임(예: 클로즈업, 미디엄, 트래킹).

JSON 형식: {"shots":[{"scene":"장소와 상황(한국어)","visual":"English visual prompt","dialogue":"대사","speaker":"이름","camera":"클로즈업","seconds":5}]}`,
  };
}
export const shotSchema = z.object({
  scene: z.string().max(200).default(''),
  visual: z.string().min(1).max(800),
  dialogue: z.string().max(300).default(''),
  speaker: z.string().max(30).default(''),
  camera: z.string().max(80).default(''),
  seconds: z.coerce.number().min(2).max(15).default(5),
});
// 컷 하나를 PD 요청대로 고쳐 씁니다.
export function rewriteShotPrompt({ project, characters, shot, speaker, instruction }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 1200,
    purpose: 'rewrite',
    context: { shot, speaker, instruction },
    prompt: `작품 "${project.title}" (${project.genre})의 컷 하나를 고쳐 주세요.
등장인물: ${characters.map((c) => `${c.name}(${c.role}) look: ${c.look}`).join(' / ')}
현재 컷: ${JSON.stringify({ scene: shot.scene, visual: shot.visual, dialogue: shot.dialogue, speaker: speaker || '', camera: shot.camera, seconds: shot.seconds })}
요청: ${instruction}
규칙: visual은 영어, 대사는 한국어 한 줄, 화자는 등장인물 이름 중 하나(대사가 없으면 빈 문자열), 길이 2~10초.
JSON 형식: {"scene":"","visual":"","dialogue":"","speaker":"","camera":"","seconds":5}`,
  };
}
// 캐릭터 기준 이미지(얼굴·의상 고정용)
export const characterImagePrompt = (project, c) =>
  `Character reference sheet, single person, front-facing portrait, neutral background, vertical 9:16. ${c.look}. ${project.style}. Photorealistic, consistent face, no text, no watermark.`;
// 컷 스토리보드 이미지(영상 첫 장면으로도 씀)
export const shotImagePrompt = (project, shot, cast) =>
  `${shot.visual}. ${cast.map((c) => `${c.name}: ${c.look}`).join('; ')}. ${project.style}. Vertical 9:16 frame, cinematic still, no text, no watermark.`;
export const shotVideoPrompt = (project, shot) =>
  `${shot.visual}. Camera: ${shot.camera || 'medium shot'}. ${project.style}. Vertical 9:16, natural motion, no text overlay.`;
export const posterPrompt = (project, cast) =>
  `Korean short drama poster, vertical 9:16, dramatic key art for "${project.title}" (${project.genre}). ${project.logline}. ${cast
    .slice(0, 2)
    .map((c) => c.look)
    .join(' and ')}. ${project.style}. Leave empty space at top for the title, no text.`;

// 모델이 코드 블록이나 앞뒤 설명을 붙여도 첫 JSON 객체를 찾아 검증합니다.
export function parseJson(text, schema) {
  const src = String(text || '').replace(/```(?:json)?/g, '');
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start < 0 || end <= start) throw Object.assign(new Error('AI 응답에서 JSON을 찾지 못했어요.'), { retryable: true });
  let data;
  try {
    data = JSON.parse(src.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('AI 응답 JSON 형식이 올바르지 않아요.'), { retryable: true });
  }
  const r = schema.safeParse(data);
  if (!r.success) throw Object.assign(new Error('AI 응답 내용이 형식에 맞지 않아요.'), { retryable: true });
  return r.data;
}

// 기본 금칙어: 실존 인물·타 작품 복제·미성년 대상 선정성 등 명백한 위험 요청을 막습니다.
const BASE_BLOCK = ['미성년자 성', '아동 성', '로리', '딥페이크', 'deepfake', 'nude', '누드', '포르노', 'porn', '실존 인물', '마약 제조', '폭탄 제조'];
export function blockedTerm(texts, extra = '') {
  const list = [...BASE_BLOCK, ...String(extra || '').split('\n').map((s) => s.trim()).filter(Boolean)];
  const hay = texts.filter(Boolean).join('\n').toLowerCase();
  return list.find((w) => hay.includes(w.toLowerCase())) || null;
}
