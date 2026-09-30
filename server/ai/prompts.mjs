import { z } from 'zod';
import { DIRECTION, CAMERA_MOVES, ANGLE_IDS, LENS_IDS, LIGHT_IDS, TONE_IDS, framingText, motionText, lightText } from './direction.mjs';

export { CAMERA_MOVES };

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
        look_en: z.string().max(500).default(''),
      }),
    )
    .min(1)
    .max(8),
  episodes: z
    .array(z.object({ number: z.coerce.number().int().min(1), title: z.string().min(1).max(100), summary: z.string().max(800).default('') }))
    .min(1)
    .max(60),
});
const shotItem = z.object({
  scene: z.string().max(200).default(''),
  visual: z.string().min(1).max(800),
  visual_en: z.string().max(800).default(''),
  dialogue: z.string().max(300).default(''),
  speaker: z.string().max(30).default(''),
  cast: z.array(z.string().max(30)).max(6).default([]),
  camera: z.string().max(80).default(''),
  camera_move: z.string().max(30).default(''),
  // 힉스필드 벤치마킹(2026-09-29): 앵글·렌즈 느낌(사전에 없는 값은 저장할 때 비웁니다)
  // AI가 null이나 긴 영어 문장을 돌려줘도 대본 전체가 실패하지 않게 비웁니다(저장할 때 사전 값만 남김).
  angle: z.string().nullish().transform((v) => String(v ?? '').slice(0, 20)).catch(''),
  lens: z.string().nullish().transform((v) => String(v ?? '').slice(0, 20)).catch(''),
  // 2단계(2026-09-30): 조명 · 시간과 색감(사전에 없는 값은 저장할 때 비웁니다)
  light: z.string().nullish().transform((v) => String(v ?? '').slice(0, 20)).catch(''),
  tone: z.string().nullish().transform((v) => String(v ?? '').slice(0, 20)).catch(''),
  emotion: z.string().max(20).default(''),
  sfx: z.string().max(120).default(''),
  seconds: z.coerce.number().min(2).max(15).default(5),
  // 드라매직 벤치마킹(2026-09-25): 장소 이름 · 소품 이름 · 인물 상태(이 컷부터 바뀌는 외형)
  location: z.string().max(40).optional().default(''),
  props: z.array(z.string().max(40)).max(6).optional().default([]),
  states: z.record(z.string().max(30), z.string().max(120)).optional().default({}),
});
export const scriptSchema = z.object({ shots: z.array(shotItem).min(1).max(40) });
export const rangeSchema = z.object({ shots: z.array(shotItem).min(1).max(20) });

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
 "characters":[{"name":"이름","role":"주인공/조연 등","description":"성격과 목표(한국어)","look":"외모를 한국어로 구체적으로(나이대, 머리, 옷, 특징)","look_en":"같은 외모를 영어로"}],
 "episodes":[{"number":1,"title":"회차 제목","summary":"회차 줄거리 2~3문장과 마지막 반전"}]}
episodes는 정확히 ${p.episode_count}개, characters는 2~5명.`,
  };
}
const bibleText = (bible) => {
  if (!bible) return '';
  const b = typeof bible === 'string' ? safe(bible) : bible;
  if (!b) return '';
  const lines = [];
  if (b.world) lines.push(`세계관·배경: ${b.world}`);
  if (b.rules) lines.push(`지켜야 할 설정: ${b.rules}`);
  if (b.relations) lines.push(`인물 관계: ${b.relations}`);
  if (b.speech?.length) lines.push('말투: ' + b.speech.map((x) => `${x.name}=${x.style}`).join(' / '));
  if (b.taboos) lines.push(`금기(쓰지 말 것): ${b.taboos}`);
  if (b.foreshadow?.length) lines.push('복선·떡밥: ' + b.foreshadow.map((x) => `${x.hint}${x.payoff ? ` → ${x.payoff}` : ''}`).join(' / '));
  return lines.length ? '작품 설정집:\n' + lines.join('\n') + '\n' : '';
};
function safe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export const EMOTIONS = ['담담', '기쁨', '설렘', '슬픔', '분노', '두려움', '놀람', '속삭임', '비꼼'];
export function scriptPrompt({ project, characters, episode, previous, maxShotSeconds, locations = [], props = [], instruction = '', history = [] }) {
  const cast = characters.map((c) => `- ${c.name} (${c.role}): ${c.description} / look: ${c.look_en || c.look}`).join('\n');
  const places =
    (locations.length ? '장소:\n' + locations.map((l) => `- ${l.name}: ${l.look_en || l.look}`).join('\n') + '\n' : '') +
    (props.length ? '소품:\n' + props.map((x) => `- ${x.name}: ${x.look_en || x.look}`).join('\n') + '\n' : '') +
    relationsText(project.relations, characters);
  const past = history.length ? '지난 회차 흐름:\n' + history.map((h) => `- ${h.number}화 ${h.title}: ${h.summary}`).join('\n') + '\n' : previous ? `이전 화 요약: ${previous}\n` : '';
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 7000,
    purpose: 'script',
    context: { project, characters, episode, instruction },
    prompt: `작품 "${project.title}" (${project.genre}) ${episode.number}화 대본을 컷 단위로 써 주세요.
작품 줄거리: ${project.synopsis}
영상 스타일: ${project.style}
${bibleText(project.bible)}등장인물:
${cast}
${places}${past}이번 화: ${episode.title} — ${episode.summary}
${episode.hook ? `첫 3초 훅: ${episode.hook}\n` : ''}${episode.cliffhanger ? `마지막 장면(클리프행어): ${episode.cliffhanger}\n` : ''}${instruction ? `PD 요청: ${instruction}\n` : ''}
규칙:
- 전체 길이 약 ${project.episode_seconds}초, 컷 하나는 3~${maxShotSeconds}초.
- 첫 컷에서 바로 갈등을 보여 주고, 마지막 컷은 다음 화가 궁금해지는 장면.
- visual: 이 컷의 화면을 한국어로 구체적으로(인물 동작, 표정, 조명, 구도). visual_en: 같은 내용을 영상 모델용 영어 프롬프트로(인물 외모는 look을 반복해 일관성 유지, 세로 구도).
- dialogue: 한국어 대사 한 줄(없으면 빈 문자열). speaker: 말하는 인물 이름(대사 없으면 빈 문자열, 내레이션이면 "내레이션").
- cast: 화면에 나오는 인물 이름 목록. camera: 샷 크기(클로즈업, 미디엄, 와이드 등). camera_move: ${CAMERA_MOVES.join('/')} 중 하나.
- angle: ${ANGLE_IDS.join('/')} 중 하나(평범하면 빈 문자열). lens: ${LENS_IDS.join('/')} 중 하나(평범하면 빈 문자열). light: ${LIGHT_IDS.join('/')} 중 하나(평범하면 빈 문자열). tone: ${TONE_IDS.join('/')} 중 하나(장면의 시간·분위기, 평범하면 빈 문자열 — 같은 장소·시간의 컷은 같은 값으로 이어 주세요). 감정이 큰 컷은 가까운 샷과 강한 움직임, 대화는 안정적인 샷으로 리듬을 만드세요.
- emotion: 대사 감정(${EMOTIONS.join('/')}). sfx: 필요한 효과음을 짧은 한국어로(없으면 빈 문자열).
- location: 위 장소 목록 중 이 컷의 장소 이름(없으면 빈 문자열). props: 화면에 꼭 보여야 하는 소품 이름 목록(위 소품 목록 우선).
- states: 이 컷부터 인물 외형이 바뀌면 {"이름":"젖은 머리, 찢어진 소매"}처럼 적고, 원래대로 돌아가면 "기본". 바뀌지 않으면 빈 객체.

JSON 형식: {"shots":[{"scene":"장소와 상황","visual":"한국어 화면 묘사","visual_en":"English visual prompt","dialogue":"대사","speaker":"이름","cast":["이름"],"camera":"클로즈업","camera_move":"천천히 다가가기","angle":"눈높이","lens":"배경 흐림","light":"자연광","tone":"노을","emotion":"설렘","sfx":"문 닫히는 소리","seconds":5,"location":"카페","props":["편지"],"states":{}}]}`,
  };
}
// 여러 컷(구간)만 PD 요청대로 다시 씁니다.
export function rangePrompt({ project, characters, shots, instruction }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 3500,
    purpose: 'range',
    context: { shots, instruction },
    prompt: `작품 "${project.title}" (${project.genre})의 연속된 컷 ${shots.length}개를 고쳐 주세요.
${bibleText(project.bible)}등장인물: ${characters.map((c) => `${c.name}(${c.role})`).join(', ')}
현재 컷: ${JSON.stringify(shots.map((x) => ({ scene: x.scene, visual: x.visual, dialogue: x.dialogue, seconds: x.seconds })))}
요청: ${instruction}
규칙: 컷 수는 1~${Math.min(20, shots.length + 3)}개. 형식은 대본과 같습니다(visual 한국어, visual_en 영어).
JSON 형식: {"shots":[{"scene":"","visual":"","visual_en":"","dialogue":"","speaker":"","cast":[],"camera":"","camera_move":"","emotion":"","sfx":"","seconds":5}]}`,
  };
}
export const shotSchema = shotItem;
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
현재 컷: ${JSON.stringify({ scene: shot.scene, visual: shot.visual, dialogue: shot.dialogue, speaker: speaker || '', camera: shot.camera, camera_move: shot.camera_move || '', emotion: shot.emotion || '', seconds: shot.seconds })}
요청: ${instruction}
규칙: visual은 한국어 화면 묘사, visual_en은 같은 내용의 영어 프롬프트, 대사는 한국어 한 줄, 화자는 등장인물 이름 중 하나(대사가 없으면 빈 문자열), 길이 2~10초. 요청과 관계없는 카메라 움직임(camera_move: ${CAMERA_MOVES.join('/')} 중 하나)·감정은 현재 값을 그대로 둡니다.
JSON 형식: {"scene":"","visual":"","visual_en":"","dialogue":"","speaker":"","camera":"","camera_move":"","emotion":"","seconds":5}`,
  };
}
// 캐릭터 기준 이미지(얼굴·의상 고정용)
export const characterImagePrompt = (project, c) =>
  `Character reference sheet, single person, front-facing portrait, neutral background, vertical 9:16. ${c.look_en && c.look_en_src === c.look ? c.look_en : c.look}. ${project.style}. Photorealistic, consistent face, no text, no watermark.`;
// 컷 스토리보드 이미지(영상 첫 장면으로도 씀)
// 화면 묘사: 영어 번역이 최신이면 그것을, 아니면 PD가 쓴 묘사를 그대로 씁니다.
export const visualOf = (shot) => (shot.visual_en && shot.visual_en_src === shot.visual ? shot.visual_en : shot.visual);
export const lookOf = (c) => (c.look_en && c.look_en_src === c.look ? c.look_en : c.look);
// states: {인물ID: '젖은 머리'}(앞 컷에서 이어진 상태 포함), props: 이 컷의 소품, styleLock: 스타일 참고 이미지가 있으면 true
// 3단계(2026-09-30) 일관성 고정: 인물 헤어 · 체형 · 금지 요소, 외형 고정이면 기준 이미지와 똑같이
export const castLockText = (c, state = '') =>
  `${c.name}: ${lookOf(c)}${c.hair ? `, hair: ${c.hair}` : ''}${c.body ? `, body: ${c.body}` : ''}${c.outfit ? `, wearing ${c.outfit}` : ''}${state ? `, currently ${state}` : ''}${
    Number(c.locked) ? ' (LOCKED: identical face, hairstyle, body shape and outfit to the reference image)' : ''
  }${c.forbid ? ` (never show on ${c.name}: ${c.forbid})` : ''}`;
export const placeLockText = (place) =>
  place ? `. Location: ${lookOf(place)}${Number(place.locked) ? ' (LOCKED: same exact layout, colors and furniture as the location reference image)' : ''}${place.forbid ? ` (never show here: ${place.forbid})` : ''}` : '';
export const propLockText = (x) => `${x.name} (${lookOf(x)}${Number(x.locked) ? ', LOCKED: same exact design as its reference image' : ''})`;
export const shotImagePrompt = (project, shot, cast, place, { states = {}, props = [], styleLock = false } = {}) =>
  `${visualOf(shot)}. ${cast.map((c) => castLockText(c, states[c.id])).join('; ')}${placeLockText(place)}${
    props.length ? `. Props in frame: ${props.map(propLockText).join(', ')}` : ''
  }${framingText(shot) ? `. Framing: ${framingText(shot)}` : ''}${lightText(shot) ? `. Lighting and mood: ${lightText(shot)}` : ''}. ${project.style}. Vertical 9:16 frame, cinematic still, keep the same faces and outfits as the reference images${styleLock ? ', match the color grading and art style of the style reference image' : ''}, no text, no watermark.`;
export const propPrompt = (project, x) => `Prop reference, a single object on a plain neutral background, no people. ${lookOf(x)}. ${project.style}. Vertical 9:16, sharp detail, no text, no watermark.`;
// 인물 관계(JSON 배열 [{a,b,kind,note}]) → 프롬프트 한 줄
export function relationsText(raw, characters = []) {
  let list = [];
  try {
    list = Array.isArray(raw) ? raw : raw ? JSON.parse(raw) : [];
  } catch {
    list = [];
  }
  const name = (id) => characters.find((c) => c.id === id)?.name || '';
  const lines = list.map((r) => (name(r.a) && name(r.b) ? `${name(r.a)} ↔ ${name(r.b)}: ${r.kind}${r.note ? ` (${r.note})` : ''}` : '')).filter(Boolean);
  return lines.length ? '인물 관계:\n' + lines.map((l) => '- ' + l).join('\n') + '\n' : '';
}
// basic: 카메라 제어가 약한 모델용(궤도·크레인 같은 복잡한 움직임을 비슷한 쉬운 움직임으로 바꿈)
// locked: 외형을 고정한 인물(영상 중에 헤어 · 옷이 바뀌지 않게 한 줄로 알려요)
export const shotVideoPrompt = (project, shot, speaker, { basic = false, locked = [] } = {}) =>
  `${visualOf(shot)}. Camera: ${framingText(shot) || 'medium shot'}${motionText(shot, { basic }) ? `, ${motionText(shot, { basic })}` : ''}${lightText(shot) ? `. Lighting and mood: ${lightText(shot)}` : ''}. ${project.style}. Vertical 9:16, natural motion, no text overlay.${
    locked.length ? ` Keep ${locked.map((c) => `${c.name}'s ${[c.hair && `hair (${c.hair})`, c.outfit && `outfit (${c.outfit})`].filter(Boolean).join(' and ') || 'appearance'}`).join('; ')} unchanged throughout the clip.` : ''
  }${shot.dialogue && speaker ? ` ${speaker.name} speaks in Korean${shot.emotion ? ` (${shot.emotion})` : ''}: "${shot.dialogue}"` : ''}`;
export const characterRefPrompt = (project, c, pose) =>
  `Character reference, same person as the reference image. ${lookOf(c)}${c.outfit ? `, wearing ${c.outfit}` : ''}. ${
    { front: 'front-facing portrait, neutral expression', side: 'side profile view', full: 'full body standing pose', smile: 'smiling expression close-up', angry: 'angry expression close-up', sad: 'teary sad expression close-up' }[pose] || pose
  }. Neutral background, vertical 9:16. ${project.style}. Photorealistic, consistent face, no text.`;
export const locationPrompt = (project, l) => `Establishing shot of a location, no people. ${lookOf(l)}. ${project.style}. Vertical 9:16, cinematic, no text, no watermark.`;
export const posterPrompt = (project, cast) =>
  `Korean short drama poster, vertical 9:16, dramatic key art for "${project.title}" (${project.genre}). ${project.logline}. ${cast
    .slice(0, 2)
    .map((c) => lookOf(c))
    .join(' and ')}. ${project.style}. Leave empty space at top for the title, no text.`;

// ── 작품 설정집 · 시즌 설계 · 진단 · 각색 · 메타데이터 · 번역 ─────────────
export const bibleSchema = z.object({
  world: z.string().max(1500).default(''),
  rules: z.string().max(1500).default(''),
  relations: z.string().max(1500).default(''),
  speech: z.array(z.object({ name: z.string().max(30), style: z.string().max(200) })).max(10).default([]),
  taboos: z.string().max(800).default(''),
  foreshadow: z.array(z.object({ hint: z.string().max(200), payoff: z.string().max(200).default(''), episode: z.coerce.number().int().min(0).max(60).default(0) })).max(20).default([]),
});
export function biblePrompt({ project, characters, episodes }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 3500,
    purpose: 'bible',
    context: { project, characters },
    prompt: `작품 "${project.title}" (${project.genre}, ${project.episode_count}화)의 설정집을 만들어 주세요. 모든 회차 대본이 이 설정을 지키게 됩니다.
줄거리: ${project.synopsis || project.logline}
등장인물: ${characters.map((c) => `${c.name}(${c.role}): ${c.description}`).join(' / ')}
회차: ${episodes.map((e) => `${e.number}화 ${e.title}`).join(', ')}
JSON 형식: {"world":"세계관·배경","rules":"지켜야 할 설정(직업, 나이, 관계의 사실 등)","relations":"인물 관계도 설명","speech":[{"name":"이름","style":"말투(존댓말/반말, 입버릇)"}],"taboos":"쓰면 안 되는 전개나 표현","foreshadow":[{"hint":"복선","payoff":"회수 방법","episode":3}]}`,
  };
}
export const seasonSchema = z.object({
  arc: z.string().max(1500).default(''),
  paywall_from: z.coerce.number().int().min(1).max(60).default(3),
  paywall_reason: z.string().max(300).default(''),
  episodes: z
    .array(z.object({ number: z.coerce.number().int().min(1), title: z.string().max(100).default(''), summary: z.string().max(800).default(''), hook: z.string().max(200).default(''), cliffhanger: z.string().max(200).default(''), twist: z.string().max(200).default('') }))
    .min(1)
    .max(60),
});
export function seasonPrompt({ project, characters, episodes }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 7000,
    purpose: 'season',
    context: { project, episodes },
    prompt: `숏폼 드라마 "${project.title}" (${project.genre}) ${project.episode_count}화 전체 흐름을 설계해 주세요.
줄거리: ${project.synopsis || project.logline}
${bibleText(project.bible)}등장인물: ${characters.map((c) => `${c.name}(${c.role})`).join(', ')}
현재 회차 구성: ${episodes.map((e) => `${e.number}화 ${e.title}: ${e.summary}`).join(' / ') || '(없음)'}
규칙:
- 발단→전개→위기→반전→결말 흐름(arc)을 먼저 정하고, 회차마다 첫 3초 훅(hook)과 마지막 클리프행어(cliffhanger), 반전 포인트(twist)를 한 문장씩.
- 숏폼 유료 전환: 시청자가 가장 궁금해질 회차부터 유료가 되도록 paywall_from(유료 시작 회차)과 그 이유를 제안.
JSON 형식: {"arc":"","paywall_from":4,"paywall_reason":"","episodes":[{"number":1,"title":"","summary":"","hook":"","cliffhanger":"","twist":""}]}
episodes는 정확히 ${project.episode_count}개.`,
  };
}
export const diagnoseSchema = z.object({
  scores: z.object({ hook: z.coerce.number().min(0).max(100), pacing: z.coerce.number().min(0).max(100), dialogue: z.coerce.number().min(0).max(100), cliffhanger: z.coerce.number().min(0).max(100), consistency: z.coerce.number().min(0).max(100) }),
  summary: z.string().max(600).default(''),
  fixes: z.array(z.object({ shot: z.coerce.number().int().min(0).max(40).default(0), problem: z.string().max(200), suggestion: z.string().max(300) })).max(12).default([]),
  risks: z.array(z.string().max(200)).max(8).default([]),
});
export function diagnosePrompt({ project, characters, episode, shots }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 2500,
    purpose: 'diagnose',
    context: { episode, shots },
    prompt: `숏폼 드라마 "${project.title}" ${episode.number}화 대본을 진단해 주세요.
${bibleText(project.bible)}등장인물: ${characters.map((c) => c.name).join(', ')}
대본: ${JSON.stringify(shots.map((s, i) => ({ n: i + 1, scene: s.scene, visual: s.visual, dialogue: s.dialogue, seconds: s.seconds })))}
평가(0~100): hook(첫 3초 흡입력), pacing(전개 속도), dialogue(대사 자연스러움), cliffhanger(다음 화 궁금증), consistency(설정·인물 일관성).
fixes: 고칠 컷 번호(shot)와 문제, 구체적 수정 제안. risks: 선정성·실존 인물·저작권 등 검수 위험 요소.
JSON 형식: {"scores":{"hook":80,"pacing":70,"dialogue":75,"cliffhanger":85,"consistency":90},"summary":"","fixes":[{"shot":2,"problem":"","suggestion":""}],"risks":[]}`,
  };
}
export function adaptPrompt({ project, source }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 7000,
    purpose: 'adapt',
    context: { ...project, source: String(source).slice(0, 200) },
    prompt: `아래 원작(PD가 직접 쓴 시놉시스·원고)을 ${project.episode_count}화, 회당 약 ${project.episode_seconds}초 숏폼 드라마로 각색해 주세요.
원작의 인물·사건을 살리되 회차마다 반전과 클리프행어가 있도록 나눕니다.
원작:
"""
${String(source).slice(0, 30000)}
"""
JSON 형식: {"title":"제목","logline":"한 줄 소개","synopsis":"전체 줄거리","style":"English visual style sentence",
 "characters":[{"name":"","role":"","description":"성격·목표(한국어)","look":"외모(한국어)"}],
 "episodes":[{"number":1,"title":"","summary":"회차 줄거리와 마지막 반전"}]}
episodes는 정확히 ${project.episode_count}개, characters는 2~8명.`,
  };
}
export const metaSchema = z.object({
  titles: z.array(z.string().max(70)).min(1).max(6),
  tagline: z.string().max(120).default(''),
  synopsis: z.string().max(1500).default(''),
  hashtags: z.array(z.string().max(30)).max(12).default([]),
  episode_titles: z.array(z.object({ number: z.coerce.number().int().min(1), title: z.string().max(100) })).max(60).default([]),
});
export function metaPrompt({ project, episodes }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 2500,
    purpose: 'meta',
    context: { project, episodes },
    prompt: `숏폼 드라마 "${project.title}" (${project.genre})를 숏핑에 공개하려 해요. 시청자가 누르고 싶게 만드는 소개 문구를 만들어 주세요.
줄거리: ${project.synopsis || project.logline}
회차: ${episodes.map((e) => `${e.number}화 ${e.title}: ${e.summary}`).join(' / ')}
규칙: 제목 후보 4~5개(70자 이내), 한 줄 소개(tagline, 40자 안팎), 작품 소개(synopsis, 3~5문장, 스포일러 없이), 해시태그 5~10개(# 없이), 회차별 궁금증을 자극하는 제목.
JSON 형식: {"titles":[""],"tagline":"","synopsis":"","hashtags":[""],"episode_titles":[{"number":1,"title":""}]}`,
  };
}
export const translateSchema = z.object({ items: z.array(z.object({ id: z.string().max(80), en: z.string().max(900) })).max(60) });
export function translatePrompt(items) {
  return {
    system: 'You translate Korean scene and appearance descriptions into concise English prompts for image and video generation models. Keep names as-is. Output JSON only.',
    json: true,
    maxTokens: 3000,
    purpose: 'translate',
    context: { items },
    prompt: `Translate each "ko" into an English visual prompt ("en"). Keep it concrete (subject, action, expression, lighting, framing).
${JSON.stringify(items.map((x) => ({ id: x.id, ko: x.ko })))}
JSON: {"items":[{"id":"","en":""}]}`,
  };
}
export const musicPrompt = (project, mood, seconds) =>
  `Instrumental background score for a Korean short drama (${project.genre}). Mood: ${mood || project.tone || 'emotional, cinematic'}. ${seconds} seconds, loopable, no vocals, subtle so dialogue stays clear.`;

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
// 단순 부분 문자열로 찾으면 "칼로리·글로리"가 '로리'에, "denuded"가 'nude'에 걸립니다.
// 그래서 짧은 금칙어는 앞에 같은 종류의 글자(영문자 또는 한글)가 붙어 있으면 다른 단어의 일부로 보고 넘어갑니다.
// 뒤쪽은 조사("로리를")나 파생어("pornography")까지 막기 위해 제한하지 않습니다.
function matches(hay, word) {
  const w = word.toLowerCase();
  // 짧은 단어(한글 2자 이하·영문 4자 이하)만 앞 글자를 봅니다. 긴 단어는 붙여 써도("아이돌딥페이크") 막습니다.
  const sameKind = /^[a-z]{1,4}$/.test(w) ? /[a-z]/ : /^[가-힣]{1,2}$/.test(w) ? /[가-힣]/ : null;
  if (!sameKind) return hay.includes(w);
  for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + 1))
    if (i === 0 || !sameKind.test(hay[i - 1])) return true;
  return false;
}
export function blockedTerm(texts, extra = '') {
  const list = [...BASE_BLOCK, ...String(extra || '').split('\n').map((s) => s.trim()).filter(Boolean)];
  const hay = texts.filter(Boolean).join('\n').toLowerCase();
  return list.find((w) => matches(hay, w)) || null;
}

// ── AI 조수(작업 공간 채팅, 2026-09-24) ─────────────────────────────────
// PD의 말을 '실행 계획'으로 바꿉니다. 바로 실행하지 않고, PD가 계획을 보고 승인하면 숏핑이 실행합니다.
export const ASSISTANT_ACTIONS = {
  // 라마가 드는 AI 작업
  shot_image: '컷 이미지 새로 만들기 (target: 컷)',
  shot_image_edit: '컷 이미지 일부만 고치기 (target: 컷, instruction: 바꿀 내용)',
  shot_video: '컷 영상 만들기 (target: 컷)',
  shot_tts: '대사 음성 만들기 (target: 컷)',
  shot_sfx: '효과음 만들기 (target: 컷, prompt: 효과음 설명)',
  shot_lipsync: '입 모양 맞추기 (target: 컷, 영상·음성이 있어야 함)',
  rewrite_shot: '컷 하나 AI로 다시 쓰기 (target: 컷, instruction)',
  rewrite_range: '여러 컷 AI로 다시 쓰기 (targets: 같은 회차 컷 목록, instruction)',
  script: '회차 대본 새로 쓰기 (target: 회차, instruction)',
  diagnose: '회차 대본 진단 (target: 회차)',
  character_image: '인물 기준 이미지 만들기 (target: 인물)',
  location_image: '장소 이미지 만들기 (target: 장소)',
  batch_shot_image: '회차의 빈 컷 이미지 모두 만들기 (target: 회차)',
  batch_shot_tts: '회차의 빈 대사 음성 모두 만들기 (target: 회차)',
  batch_shot_video: '회차의 빈 컷 영상 모두 만들기 (target: 회차)',
  music: '배경음악 만들기 (target: 회차 또는 비움, mood: 분위기)',
  poster: '작품 포스터 만들기',
  metadata: '작품 제목·소개·해시태그 추천',
  verify_shot: 'AI가 만든 컷 이미지 검수(얼굴·손·글자·소품 이상 찾기) (target: 이미지가 있는 컷)',
  batch_verify_shot: '회차의 컷 이미지 모두 검수 (target: 회차)',
  verify_video: 'AI가 만든 컷 영상 검수(얼굴·옷 바뀜·뭉개짐·입 모양·앞 컷과 이어짐) (target: 영상이 있는 컷)',
  batch_verify_video: '회차의 컷 영상 모두 검수 (target: 회차)',
  bridge_shot: '컷 뒤에 2~3초 연결 컷 넣기 (target: 컷, instruction: 원하는 연결 장면·비워도 됨)',
  shot_upscale: '컷 이미지 화질 올리기 (target: 이미지가 있는 컷)',
  shot_upscale_video: '컷 영상 화질 올리기 (target: 영상이 있는 컷)',
  batch_shot_upscale_video: '회차의 컷 영상 모두 화질 올리기 (target: 회차)',
  // 라마가 들지 않는 직접 수정
  edit_shot: '컷 내용 직접 고치기 (target: 컷, fields: dialogue·visual·emotion·seconds·camera·camera_move·angle·lens·move_strength·speed 중 필요한 것만. camera_move·angle·lens는 연출 사전 값)',
  edit_direction: `여러 컷 연출(카메라·조명) 한 번에 바꾸기 (targets: 컷 목록, preset: 연출 세트 이름(${DIRECTION.presets.map((x) => x.name).join('·')}) 또는 fields: camera·camera_move·angle·lens·move_strength·effect·light(${LIGHT_IDS.join('/')})·tone(${TONE_IDS.join('/')})·height)`,
  edit_character: '인물 설정 고치기 (target: 인물, fields: description·look·voice_style)',
  edit_episode: '회차 제목·줄거리 고치기 (target: 회차, fields: title·summary)',
  edit_project: '작품 톤·스타일 고치기 (fields: tone·style)',
};
const assistantAction = z.object({
  type: z.enum(Object.keys(ASSISTANT_ACTIONS)),
  target: z.string().max(40).optional().default(''),
  targets: z.array(z.string().max(40)).max(20).optional().default([]),
  instruction: z.string().max(300).optional().default(''),
  prompt: z.string().max(200).optional().default(''),
  mood: z.string().max(200).optional().default(''),
  preset: z.string().max(30).optional().default(''),
  fields: z.record(z.string(), z.union([z.string(), z.number()])).optional().default({}),
  reason: z.string().max(200).optional().default(''),
});
export const assistantSchema = z.object({
  reply: z.string().max(1500),
  actions: z.array(z.unknown()).max(12).optional().default([]),
});
export const assistantActionSchema = assistantAction;
export function assistantPrompt({ project, characters, episodes, episode, shots, locations, message, history, focus }) {
  const cast = characters.map((c, i) => `C${i + 1} ${c.name}(${c.role}) · ${String(c.description || '').slice(0, 80)} · 이미지 ${c.image ? '있음' : '없음'}`).join('\n');
  const eps = episodes.map((e) => `E${e.number} ${e.title} — ${String(e.summary || '').slice(0, 80)} · 컷 ${e.shot_count}개`).join('\n');
  const places = locations.map((l, i) => `L${i + 1} ${l.name}`).join(', ');
  const shotLines = episode
    ? shots
        .map(
          (s, i) =>
            `E${episode.number}S${i + 1} [${s.seconds}초] ${String(s.scene || '').slice(0, 30)} / 화면: ${String(s.visual || '').slice(0, 90)} / 대사(${s.speaker || '-'}): ${String(s.dialogue || '').slice(0, 60)} / 감정: ${s.emotion || '-'} / 연출: ${[s.camera, s.angle, s.camera_move].filter(Boolean).join('·') || '-'} / 이미지 ${s.image ? 'O' : 'X'} 음성 ${s.audio ? 'O' : 'X'} 영상 ${s.video ? 'O' : 'X'}`,
        )
        .join('\n')
    : '(회차 없음)';
  const talk = history.map((h) => `${h.role === 'user' ? 'PD' : '조수'}: ${String(h.content).slice(0, 300)}`).join('\n');
  return {
    system: `당신은 숏폼 드라마 제작 도구 '숏핑 스튜디오'의 AI 조수입니다. PD의 요청을 듣고, 숏핑이 실행할 수 있는 작업 목록(실행 계획)으로 바꿉니다.
- 직접 실행하지 말고 계획만 제안합니다. PD가 승인하면 숏핑이 실행합니다.
- 라마(비용)가 드는 AI 작업은 꼭 필요한 것만 넣고, 글만 바꾸면 되는 요청은 edit_* 작업(무료)으로 처리하세요.
- 질문·조언만 필요한 요청이면 actions는 빈 배열로 두고 reply로 답합니다.
- 대상은 아래 목록의 코드(E1S3=1화 3번 컷, E2=2화, C1=첫 번째 인물, L1=첫 번째 장소)로만 가리킵니다. 없는 대상을 만들지 마세요.
- 이미지·영상·음성을 만들 수 없는 글쓰기 AI라서 직접 그리지는 못하지만, 숏핑의 이미지·영상·음성 작업을 계획에 넣으면 연결된 모델이 만들어 줍니다.
- reply는 친근한 한국어 존댓말로 2~4문장. 무엇을 왜 하는지 짧게 설명합니다.
- 반드시 JSON 하나만 출력합니다.`,
    json: true,
    maxTokens: 2500,
    purpose: 'assistant',
    context: { message, focus, episode: episode ? { number: episode.number } : null, shots: shots.map((s, i) => ({ ref: episode ? `E${episode.number}S${i + 1}` : '', dialogue: s.dialogue, visual: s.visual, image: !!s.image, audio: !!s.audio, video: !!s.video })), characters: characters.map((c, i) => ({ ref: `C${i + 1}`, name: c.name })) },
    prompt: `작품: "${project.title}" (${project.genre}) · 톤: ${project.tone || '-'} · 스타일: ${String(project.style || '').slice(0, 120)}
로그라인: ${project.logline}
인물:
${cast || '(아직 없음)'}
회차:
${eps || '(아직 없음)'}
장소: ${places || '(없음)'}
지금 보고 있는 회차의 컷:
${shotLines}
${focus ? `PD가 지금 고른 컷: ${focus}\n` : ''}
쓸 수 있는 작업(type):
${Object.entries(ASSISTANT_ACTIONS)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join('\n')}

최근 대화:
${talk || '(없음)'}

PD 요청: ${message}

JSON 형식: {"reply":"설명","actions":[{"type":"shot_image_edit","target":"E1S3","instruction":"배경을 밤으로","reason":"요청한 분위기"},{"type":"edit_shot","target":"E1S3","fields":{"dialogue":"새 대사"}}]}`,
  };
}

// ── 완성 대본 붙여 넣기 → 컷으로 나누기(드라매직 벤치마킹, 2026-09-25) ─────────────────
// 한국 드라마 대본 관습(S#1. 장소 - 낮 / 인물: 대사 / (지문))을 읽어 회차·컷·인물·장소·소품·상태로 구조화합니다.
export const parseScriptSchema = z.object({
  title: z.string().max(70).optional().default(''),
  synopsis: z.string().max(3000).optional().default(''),
  characters: z
    .array(z.object({ name: z.string().min(1).max(30), role: z.string().max(60).default(''), description: z.string().max(500).default(''), look: z.string().max(500).default(''), look_en: z.string().max(500).default('') }))
    .max(12)
    .default([]),
  locations: z.array(z.object({ name: z.string().min(1).max(40), look: z.string().max(500).default('') })).max(12).default([]),
  props: z.array(z.object({ name: z.string().min(1).max(40), look: z.string().max(500).default('') })).max(20).default([]),
  relations: z.array(z.object({ a: z.string().max(30), b: z.string().max(30), kind: z.string().max(20), note: z.string().max(120).default('') })).max(30).default([]),
  episodes: z
    .array(z.object({ number: z.coerce.number().int().min(1).max(60), title: z.string().max(100).default(''), summary: z.string().max(800).default(''), shots: z.array(shotItem).min(1).max(40) }))
    .min(1)
    .max(12),
});
export function parseScriptPrompt({ project, text, characters = [], locations = [], props = [] }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 16000,
    purpose: 'parse_script',
    context: { text, project: { title: project.title, episode_seconds: project.episode_seconds } },
    prompt: `아래는 PD가 직접 쓴 숏폼 드라마 대본입니다. 내용은 바꾸지 말고 제작용 데이터로 나눠 주세요.
작품: "${project.title}" (${project.genre}) · 회당 약 ${project.episode_seconds}초 · 영상 스타일: ${project.style || '실사 드라마'}
${characters.length ? '이미 등록된 인물(이름을 그대로 쓰세요): ' + characters.map((c) => c.name).join(', ') + '\n' : ''}${locations.length ? '이미 등록된 장소: ' + locations.map((l) => l.name).join(', ') + '\n' : ''}${props.length ? '이미 등록된 소품: ' + props.map((x) => x.name).join(', ') + '\n' : ''}
규칙:
- 대본에 회차 구분(1화, EP.1, #1 등)이 있으면 그대로, 없으면 전체를 1화로 봅니다. 최대 12화까지.
- 장면 머리글(S#, 씬, 장소-시간)과 지문을 읽어 컷으로 나눕니다. 컷 하나는 2~8초, 대사 한 줄 또는 동작 하나.
- 대사는 원문 그대로(맞춤법만 고침). speaker는 인물 이름, 내레이션·독백(N/NA)은 "내레이션".
- visual은 한국어 화면 묘사(인물 동작·표정·조명·구도), visual_en은 같은 내용의 영어 영상 프롬프트(인물 외모 반복, 세로 구도).
- location은 장소 이름, props는 화면에 꼭 나와야 하는 소품, states는 이 컷부터 바뀌는 인물 외형({"이름":"비에 젖은 머리"}, 원래대로는 "기본").
- camera는 샷 크기, camera_move는 ${CAMERA_MOVES.join('/')} 중 하나, angle은 ${ANGLE_IDS.join('/')} 중 하나, lens는 ${LENS_IDS.join('/')} 중 하나(평범하면 빈 문자열). 지문의 연출 단서를 따르고 없으면 장면 감정에 맞게 고르세요.
- characters·locations·props는 대본에 나오는 것 모두(외모·모습은 대본 단서로 추정, look_en은 영어). relations는 인물 사이 관계(연인·가족·친구·라이벌·적·비밀·상하·기타).

대본:
"""
${String(text).slice(0, 30000)}
"""

JSON 형식: {"title":"제목(대본에 있으면)","synopsis":"줄거리 3~5문장","characters":[{"name":"","role":"","description":"","look":"","look_en":""}],"locations":[{"name":"","look":""}],"props":[{"name":"","look":""}],"relations":[{"a":"이름","b":"이름","kind":"연인","note":""}],"episodes":[{"number":1,"title":"","summary":"","shots":[{"scene":"","visual":"","visual_en":"","dialogue":"","speaker":"","cast":[],"camera":"","camera_move":"","angle":"","lens":"","emotion":"","sfx":"","seconds":4,"location":"","props":[],"states":{}}]}]}`,
  };
}

// ── AI 결과 검수(이미지 → 글 모델, 라마 차감) ─────────────────────────────
export const verifySchema = z.object({
  ok: z.boolean(),
  score: z.coerce.number().min(0).max(100).default(0),
  people: z.coerce.number().int().min(0).max(20).optional(),
  issues: z
    .array(
      z.object({
        code: z.enum(['face', 'count', 'text', 'anatomy', 'style', 'composition', 'prop', 'state', 'mismatch', 'lock', 'other']).catch('other'),
        text: z.string().max(200),
        // 문제 위치(가로·세로 %: [x, y, 너비, 높이]) — 부분 수정 붓을 미리 칠해 주는 데 써요(없어도 됨).
        box: z.array(z.coerce.number().min(0).max(100)).length(4).optional().catch(undefined),
      }),
    )
    .max(8)
    .default([]),
  // 인물 닮음 점수(2026-09-29): 인물마다 기준 얼굴과 같은 사람으로 보이는 정도(0~100)
  faces: z.array(z.object({ name: z.string().max(30), match: z.coerce.number().min(0).max(100) })).max(8).optional().default([]).catch([]),
  summary: z.string().max(300).default(''),
});
export function verifyPrompt({ shot, people, props = [], states = {}, styleLock = false, place = null }) {
  const names = people.map((c) => c.name);
  // 기준 얼굴 이미지가 실제로 붙는 인물(이미지가 있는 인물)만 얼굴 비교를 시켜요.
  const faceNames = people.filter((c) => c.image).map((c) => c.name);
  // 3단계 고정 요소: 헤어 · 체형 · 의상 · 금지 요소, 장소 · 소품 고정
  const locks = [
    ...people.filter((c) => Number(c.locked) || c.hair || c.body || c.forbid).map((c) => `${c.name} — ${[c.hair && `헤어: ${c.hair}`, c.body && `체형: ${c.body}`, c.outfit && `의상: ${c.outfit}`, c.forbid && `금지: ${c.forbid}`].filter(Boolean).join(', ') || '기준 이미지와 같은 외형'}`),
    ...(place && (Number(place.locked) || place.forbid) ? [`장소 ${place.name} — ${Number(place.locked) ? '기준 이미지와 같은 배치·색' : ''}${place.forbid ? ` 금지: ${place.forbid}` : ''}`] : []),
    ...props.filter((x) => Number(x.locked)).map((x) => `소품 ${x.name} — 기준 이미지와 같은 모양`),
  ];
  return {
    system: '당신은 한국 세로형 숏폼 드라마의 화면 품질 검수자입니다. 이미지를 꼼꼼히 보고 사실대로만 판단하며, 반드시 JSON 하나만 출력합니다.',
    json: true,
    maxTokens: 900,
    purpose: 'verify',
    context: { visual: shot.visual, people: names.length, names, locks },
    prompt: `첫 번째 이미지는 AI가 만든 컷 장면입니다.${faceNames.length ? ` 그 뒤 이미지들은 등장인물의 기준 얼굴입니다(순서대로: ${faceNames.join(', ')}).` : ''}
이 컷의 설명: ${shot.visual}
화면에 나와야 하는 인물 수: ${names.length || '제한 없음'}${names.length ? ` (${names.join(', ')})` : ''}
${props.length ? `꼭 보여야 하는 소품: ${props.map((x) => x.name).join(', ')}\n` : ''}${Object.keys(states).length ? `인물 상태: ${people.filter((c) => states[c.id]).map((c) => `${c.name}=${states[c.id]}`).join(', ')}\n` : ''}검사 항목:
1) face: 인물 얼굴이 기준 얼굴과 같은 사람으로 보이는가
2) count: 인물 수가 맞는가
3) text: 화면에 글자·워터마크·로고가 있는가(있으면 문제)
4) anatomy: 손가락·팔다리·얼굴이 어색하게 뭉개지거나 기형인가
5) composition: 세로 화면에서 주인공이 잘리지 않고 구도가 자연스러운가
6) prop / state: 소품·인물 상태가 설명대로 보이는가
7) mismatch: 설명과 크게 다른 장면인가${styleLock ? '\n8) style: 작품 스타일(색감·화풍)에서 크게 벗어났는가' : ''}${locks.length ? `\n9) lock: 고정 요소를 지켰는가 — ${locks.join(' / ')}` : ''}
문제가 없으면 ok=true, 있으면 ok=false와 issues에 한국어로 짧게(무엇이 어떻게 이상한지). 문제 위치를 알면 box에 첫 번째 이미지 기준 [x, y, 너비, 높이]를 %로 적으세요.
score는 전체 품질 0~100.${faceNames.length ? ' faces에는 인물마다 기준 얼굴과 같은 사람으로 보이는 정도(match 0~100)를 적으세요. 화면에 안 보이면 빼세요.' : ''}
JSON 형식: {"ok":true,"score":85,"people":2,"issues":[{"code":"face","text":"오른쪽 인물 얼굴이 기준과 달라요","box":[55,10,35,30]}],"faces":[{"name":"이름","match":90}],"summary":"한 줄 평가"}`,
  };
}

// ── 컷 영상 AI 검수(5단계, 2026-09-30): 영상에서 뽑은 장면 3장(처음 · 가운데 · 끝)을 봐요 ─────────────
export const videoVerifySchema = z.object({
  ok: z.boolean(),
  score: z.coerce.number().min(0).max(100).default(0),
  issues: z
    .array(
      z.object({
        code: z.enum(['face', 'outfit', 'drift', 'lipsync', 'continuity', 'artifact', 'text', 'mismatch', 'other']).catch('other'),
        text: z.string().max(200),
        frame: z.coerce.number().int().min(1).max(3).optional().catch(undefined),
      }),
    )
    .max(8)
    .default([]),
  faces: z.array(z.object({ name: z.string().max(30), match: z.coerce.number().min(0).max(100) })).max(8).optional().default([]).catch([]),
  summary: z.string().max(300).default(''),
});
export function videoVerifyPrompt({ shot, people, prevShot = null, hasPrevFrame = false }) {
  const names = people.map((c) => c.name);
  const locks = people.filter((c) => c.hair || c.outfit || Number(c.locked)).map((c) => `${c.name} — ${[c.hair && `헤어: ${c.hair}`, c.outfit && `의상: ${c.outfit}`].filter(Boolean).join(', ') || '기준 이미지와 같은 외형'}`);
  return {
    system: '당신은 한국 세로형 숏폼 드라마의 영상 품질 검수자입니다. 영상에서 뽑은 장면을 꼼꼼히 보고 사실대로만 판단하며, 반드시 JSON 하나만 출력합니다.',
    json: true,
    maxTokens: 900,
    purpose: 'verify_video',
    context: { visual: shot.visual, names, dialogue: shot.dialogue || '', locks },
    prompt: `처음 세 이미지는 AI가 만든 컷 영상의 처음 · 가운데 · 끝 장면입니다(순서대로 1, 2, 3).${names.length ? ` 그 뒤 이미지들은 등장인물의 기준 얼굴입니다(순서대로: ${names.join(', ')}).` : ''}${hasPrevFrame ? ' 마지막 이미지는 바로 앞 컷 영상의 마지막 장면입니다.' : ''}
이 컷의 설명: ${shot.visual}
${shot.dialogue ? `대사(입이 움직여야 함): "${shot.dialogue}"
` : ''}${locks.length ? `고정 요소: ${locks.join(' / ')}
` : ''}검사 항목:
1) face: 장면마다 인물 얼굴이 기준 얼굴과 같은 사람인가
2) drift · outfit: 영상이 흐르는 동안(1→3) 얼굴 · 헤어 · 옷이 바뀌거나 녹아내리지 않는가
3) artifact: 손 · 팔다리 · 얼굴이 뭉개지거나 물체가 이상하게 변하는가
4) text: 글자 · 워터마크 · 로고가 보이는가
5) mismatch: 설명과 크게 다른 장면인가${shot.dialogue ? '\n6) lipsync: 말하는 인물의 입이 대사처럼 움직이는 것으로 보이는가(입이 계속 닫혀 있으면 문제)' : ''}${hasPrevFrame ? '\n7) continuity: 앞 컷 마지막 장면과 인물 옷 · 머리 · 장소 · 조명이 자연스럽게 이어지는가' : ''}
문제가 없으면 ok=true, 있으면 ok=false와 issues에 한국어로 짧게, 어느 장면(frame 1~3)인지 적으세요. score는 전체 품질 0~100.${names.length ? ' faces에는 인물마다 기준 얼굴과 같은 사람으로 보이는 정도(match 0~100, 세 장면 중 가장 낮은 값)를 적으세요.' : ''}
JSON 형식: {"ok":true,"score":85,"issues":[{"code":"drift","text":"끝 장면에서 코트 색이 바뀌어요","frame":3}],"faces":[{"name":"이름","match":90}],"summary":"한 줄 평가"}`,
  };
}

// ── 사이 컷(전환 컷) · 대본 변형(드라매직 벤치마킹) ──────────────────────────
// 두 컷 사이에 짧은 연결 컷(인서트 · 장소 전경 · 표정 리액션)을 한 개 넣어 흐름을 부드럽게 합니다.
export function bridgePrompt({ project, characters, prev, next, instruction = '' }) {
  const brief = (s) => (s ? JSON.stringify({ scene: s.scene, visual: s.visual, dialogue: s.dialogue, camera: s.camera }) : '(없음 · 회차 마지막)');
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 1200,
    purpose: 'bridge',
    context: { prev, next, instruction },
    prompt: `작품 "${project.title}" (${project.genre})에서 두 컷 사이에 들어갈 짧은 연결 컷 하나를 써 주세요.
등장인물: ${characters.map((c) => `${c.name}(${c.role})`).join(', ')}
앞 컷: ${brief(prev)}
뒤 컷: ${brief(next)}
${instruction ? `요청: ${instruction}\n` : ''}규칙: 2~3초짜리 인서트(소품 클로즈업) · 장소 전경 · 인물 표정 리액션 중 흐름에 가장 맞는 것. 대사는 없거나 아주 짧게. visual은 한국어, visual_en은 영어.
JSON 형식: {"scene":"","visual":"","visual_en":"","dialogue":"","speaker":"","cast":[],"camera":"","camera_move":"","angle":"","lens":"","emotion":"","sfx":"","seconds":2,"location":"","props":[],"states":{}}`,
  };
}
export const variantsSchema = z.object({
  variants: z.array(z.object({ label: z.string().max(40), note: z.string().max(200).default(''), shots: z.array(shotItem).min(1).max(40) })).min(1).max(3),
});
// 같은 회차를 다른 방향(결말 반전 · 다른 시점 · 톤)으로 다시 쓴 변형 대본 여러 개. 지금 대본은 그대로 두고 버전으로만 남깁니다.
export function variantsPrompt({ project, characters, episode, shots, angles }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 12000,
    purpose: 'variants',
    context: { shots, angles },
    prompt: `작품 "${project.title}" (${project.genre}) ${episode.number}화 대본의 변형을 ${angles.length}개 만들어 주세요. 인물과 큰 줄거리는 유지하고 방향만 바꿉니다.
${bibleText(project.bible)}등장인물: ${characters.map((c) => `${c.name}(${c.role})`).join(', ')}
${relationsText(project.relations, characters)}지금 대본(컷): ${JSON.stringify(shots.map((s) => ({ scene: s.scene, visual: s.visual, dialogue: s.dialogue, seconds: s.seconds })))}
변형 방향: ${angles.map((a, i) => `${i + 1}) ${a}`).join(' / ')}
규칙: 각 변형은 전체 길이 약 ${project.episode_seconds}초, 컷 형식은 대본과 같음(visual 한국어, visual_en 영어), label은 변형 방향을 짧게.
JSON 형식: {"variants":[{"label":"결말 반전","note":"무엇이 달라졌는지 한 줄","shots":[{"scene":"","visual":"","visual_en":"","dialogue":"","speaker":"","cast":[],"camera":"","camera_move":"","angle":"","lens":"","emotion":"","sfx":"","seconds":4,"location":"","props":[],"states":{}}]}]}`,
  };
}

// ── 영상 → 대본 복원(2026-09-25): 올린 완성 영상의 자막(대사)으로 제작용 대본을 되살립니다 ──
export const reverseScriptSchema = z.object({
  script: z.string().min(10).max(30000),
  title: z.string().max(70).optional().default(''),
  synopsis: z.string().max(1000).optional().default(''),
});
export function reverseScriptPrompt({ project, transcript }) {
  return {
    system: SYSTEM,
    json: true,
    maxTokens: 12000,
    purpose: 'reverse_script',
    context: { transcript },
    prompt: `아래는 이미 완성된 숏폼 드라마 영상에서 뽑은 자막(대사)입니다. 이 영상을 AI로 다시 만들 수 있도록 제작용 대본으로 복원해 주세요.
작품: "${project.title}" (${project.genre}) · 회당 약 ${project.episode_seconds}초
규칙:
- 회차 구분("N화 자막")을 그대로 지켜 "1화", "2화"처럼 씁니다.
- 대사 흐름으로 장면을 나누고 "S#1. 장소 - 낮/밤" 머리글과 괄호 지문(인물 동작·표정·분위기)을 채웁니다.
- 대사 줄은 "인물 이름: 대사" 형식. 누가 말했는지 문맥으로 추정하고, 이름이 드러나지 않으면 역할로 이름을 지어 끝까지 같은 이름을 씁니다.
- 대사는 자막 원문을 그대로(맞춤법만 고침) 쓰고, 새 대사를 지어내지 않습니다. 나레이션은 "내레이션: ..."으로.
- 실존 인물 이름이나 상표는 쓰지 않습니다.

자막:
"""
${String(transcript).slice(0, 30000)}
"""

JSON 형식: {"title":"작품 제목 제안","synopsis":"줄거리 3~5문장","script":"1화\nS#1. 장소 - 밤\n(지문)\n이름: 대사\n..."}`,
  };
}
