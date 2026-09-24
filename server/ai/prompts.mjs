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
  emotion: z.string().max(20).default(''),
  sfx: z.string().max(120).default(''),
  seconds: z.coerce.number().min(2).max(15).default(5),
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
export const CAMERA_MOVES = ['고정', '천천히 다가가기', '천천히 멀어지기', '왼쪽으로 패닝', '오른쪽으로 패닝', '위로 틸트', '핸드헬드', '따라가기'];
export const EMOTIONS = ['담담', '기쁨', '설렘', '슬픔', '분노', '두려움', '놀람', '속삭임', '비꼼'];
export function scriptPrompt({ project, characters, episode, previous, maxShotSeconds, locations = [], instruction = '', history = [] }) {
  const cast = characters.map((c) => `- ${c.name} (${c.role}): ${c.description} / look: ${c.look_en || c.look}`).join('\n');
  const places = locations.length ? '장소:\n' + locations.map((l) => `- ${l.name}: ${l.look_en || l.look}`).join('\n') + '\n' : '';
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
- emotion: 대사 감정(${EMOTIONS.join('/')}). sfx: 필요한 효과음을 짧은 한국어로(없으면 빈 문자열).

JSON 형식: {"shots":[{"scene":"장소와 상황","visual":"한국어 화면 묘사","visual_en":"English visual prompt","dialogue":"대사","speaker":"이름","cast":["이름"],"camera":"클로즈업","camera_move":"천천히 다가가기","emotion":"설렘","sfx":"문 닫히는 소리","seconds":5}]}`,
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
현재 컷: ${JSON.stringify({ scene: shot.scene, visual: shot.visual, dialogue: shot.dialogue, speaker: speaker || '', camera: shot.camera, seconds: shot.seconds })}
요청: ${instruction}
규칙: visual은 한국어 화면 묘사, visual_en은 같은 내용의 영어 프롬프트, 대사는 한국어 한 줄, 화자는 등장인물 이름 중 하나(대사가 없으면 빈 문자열), 길이 2~10초.
JSON 형식: {"scene":"","visual":"","visual_en":"","dialogue":"","speaker":"","camera":"","camera_move":"","emotion":"","seconds":5}`,
  };
}
// 캐릭터 기준 이미지(얼굴·의상 고정용)
export const characterImagePrompt = (project, c) =>
  `Character reference sheet, single person, front-facing portrait, neutral background, vertical 9:16. ${c.look_en && c.look_en_src === c.look ? c.look_en : c.look}. ${project.style}. Photorealistic, consistent face, no text, no watermark.`;
// 컷 스토리보드 이미지(영상 첫 장면으로도 씀)
// 화면 묘사: 영어 번역이 최신이면 그것을, 아니면 PD가 쓴 묘사를 그대로 씁니다.
export const visualOf = (shot) => (shot.visual_en && shot.visual_en_src === shot.visual ? shot.visual_en : shot.visual);
const lookOf = (c) => (c.look_en && c.look_en_src === c.look ? c.look_en : c.look);
const CAMERA_EN = {
  고정: 'static camera',
  '천천히 다가가기': 'slow push-in',
  '천천히 멀어지기': 'slow pull-out',
  '왼쪽으로 패닝': 'pan left',
  '오른쪽으로 패닝': 'pan right',
  '위로 틸트': 'tilt up',
  핸드헬드: 'handheld camera',
  따라가기: 'tracking shot following the subject',
};
export const shotImagePrompt = (project, shot, cast, place) =>
  `${visualOf(shot)}. ${cast.map((c) => `${c.name}: ${lookOf(c)}`).join('; ')}${place ? `. Location: ${lookOf(place)}` : ''}. ${project.style}. Vertical 9:16 frame, cinematic still, keep the same faces and outfits as the reference images, no text, no watermark.`;
export const shotVideoPrompt = (project, shot, speaker) =>
  `${visualOf(shot)}. Camera: ${shot.camera || 'medium shot'}${shot.camera_move ? `, ${CAMERA_EN[shot.camera_move] || shot.camera_move}` : ''}. ${project.style}. Vertical 9:16, natural motion, no text overlay.${
    shot.dialogue && speaker ? ` ${speaker.name} speaks in Korean${shot.emotion ? ` (${shot.emotion})` : ''}: "${shot.dialogue}"` : ''
  }`;
export const characterRefPrompt = (project, c, pose) =>
  `Character reference, same person as the reference image. ${lookOf(c)}${c.outfit ? `, wearing ${c.outfit}` : ''}. ${
    { front: 'front-facing portrait, neutral expression', side: 'side profile view', full: 'full body standing pose', smile: 'smiling expression close-up', angry: 'angry expression close-up', sad: 'teary sad expression close-up' }[pose] || pose
  }. Neutral background, vertical 9:16. ${project.style}. Photorealistic, consistent face, no text.`;
export const locationPrompt = (project, l) => `Establishing shot of a location, no people. ${lookOf(l)}. ${project.style}. Vertical 9:16, cinematic, no text, no watermark.`;
export const posterPrompt = (project, cast) =>
  `Korean short drama poster, vertical 9:16, dramatic key art for "${project.title}" (${project.genre}). ${project.logline}. ${cast
    .slice(0, 2)
    .map((c) => c.look)
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
  // 라마가 들지 않는 직접 수정
  edit_shot: '컷 내용 직접 고치기 (target: 컷, fields: dialogue·visual·emotion·seconds·camera·camera_move·speed 중 필요한 것만)',
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
            `E${episode.number}S${i + 1} [${s.seconds}초] ${String(s.scene || '').slice(0, 30)} / 화면: ${String(s.visual || '').slice(0, 90)} / 대사(${s.speaker || '-'}): ${String(s.dialogue || '').slice(0, 60)} / 감정: ${s.emotion || '-'} / 이미지 ${s.image ? 'O' : 'X'} 음성 ${s.audio ? 'O' : 'X'} 영상 ${s.video ? 'O' : 'X'}`,
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
