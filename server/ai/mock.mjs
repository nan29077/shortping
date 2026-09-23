import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../media.mjs';

// 개발용 가짜 AI. API 키 없이 제작 전 과정을 끝까지 돌려 보기 위한 것으로, 운영에서는 등록되지 않습니다.
// 글은 입력을 바탕으로 한 템플릿, 이미지는 기본 포스터를 잘라 색을 바꾼 것, 영상은 이미지를 천천히 확대한 것,
// 음성은 대사 길이만큼의 짧은 신호음입니다.
const names = ['서윤', '도현', '하린', '지호', '민재'];
const roles = ['주인공', '상대역', '조력자', '라이벌', '비밀을 쥔 인물'];
const looks = [
  'Korean woman in her late 20s, shoulder-length black hair, beige trench coat, determined eyes',
  'Korean man in his early 30s, short neat hair, navy suit, calm but tired expression',
  'Korean woman in her 20s, long wavy brown hair, cozy knit sweater, bright smile',
  'Korean man in his 30s, undercut hair, black leather jacket, sharp gaze',
  'Korean woman in her 40s, elegant bob hair, pearl earrings, mysterious aura',
];
const looksKo = [
  '20대 후반 여성, 어깨 길이 검은 머리, 베이지 트렌치코트, 단호한 눈빛',
  '30대 초반 남성, 짧고 단정한 머리, 네이비 정장, 차분하지만 지친 표정',
  '20대 여성, 긴 웨이브 갈색 머리, 포근한 니트, 밝은 미소',
  '30대 남성, 투블럭 머리, 검은 가죽 재킷, 날카로운 눈빛',
  '40대 여성, 단정한 단발, 진주 귀걸이, 신비로운 분위기',
];
const hash = (s) => parseInt(createHash('md5').update(String(s)).digest('hex').slice(0, 8), 16);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mockText(input) {
  const c = input.context || {};
  if (input.purpose === 'plan') {
    const count = Math.min(60, Math.max(1, Number(c.episode_count || 3)));
    const cast = Math.min(5, 3);
    return {
      title: (c.title || `${c.logline || '비밀'}`.slice(0, 14)).trim() || '새로운 이야기',
      logline: c.logline || '평범한 하루가 한 통의 전화로 뒤집힌다.',
      synopsis: `${c.logline || '평범한 주인공'}. ${c.genre || '로맨스'} 장르의 ${count}부작 숏폼 드라마로, 매 회 새로운 비밀이 드러나며 두 사람의 관계가 흔들린다. 마지막 회에서 모든 진실이 밝혀진다.`,
      style: 'cinematic Korean drama, soft warm lighting, 35mm, shallow depth of field',
      characters: Array.from({ length: cast }, (_, i) => ({
        name: names[i],
        role: roles[i],
        description: `${roles[i]}. 겉으로는 담담하지만 숨기고 있는 사연이 있다.`,
        look: looksKo[i],
        look_en: looks[i],
      })),
      episodes: Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        title: `${i + 1}화 · ${['낯선 전화', '두 번째 거짓말', '엇갈린 시선', '숨겨진 편지', '마지막 선택'][i % 5]}`,
        summary: `${i + 1}화에서는 새로운 단서가 등장하고, 마지막 장면에서 예상치 못한 인물이 문을 연다.`,
      })),
    };
  }
  if (input.purpose === 'script') {
    const total = Number(c.project?.episode_seconds || 60);
    const cast = (c.characters || []).map((x) => x.name);
    const shots = [];
    let used = 0;
    let i = 0;
    while (used < total && shots.length < 20) {
      const seconds = Math.min(6, Math.max(3, total - used));
      const speaker = cast.length ? cast[i % cast.length] : '';
      shots.push({
        scene: `${['카페', '사무실 복도', '비 오는 거리', '옥상', '집 거실'][i % 5]} · ${i === 0 ? '갈등의 시작' : '긴장이 고조됨'}`,
        visual: `${['창가 옆 아늑한 카페', '어두운 사무실 복도', '네온이 비치는 비 오는 밤거리', '노을 지는 옥상', '조용한 거실'][i % 5]}에서 ${speaker || '주인공'}이 긴장한 얼굴로 카메라를 본다`,
        visual_en: `${['A cozy cafe by the window', 'A dim office corridor', 'A rainy street at night with neon reflections', 'A rooftop at sunset', 'A quiet living room'][i % 5]}, ${speaker || 'the protagonist'} looks at the camera with a tense expression`,
        cast: speaker ? [speaker] : [],
        camera_move: ['천천히 다가가기', '고정', '따라가기', '천천히 멀어지기', '왼쪽으로 패닝'][i % 5],
        emotion: ['놀람', '담담', '분노', '설렘', '두려움'][i % 5],
        sfx: i % 2 ? '' : ['빗소리', '문 닫히는 소리', '발소리'][i % 3],
        dialogue: speaker ? `${['이게 무슨 뜻이야?', '처음부터 알고 있었어.', '이제 와서 왜 그래?', '우리 다시 시작할 수 있을까?', '문 열어. 네가 누군지 알아.'][i % 5]}` : '',
        speaker,
        camera: ['클로즈업', '미디엄', '트래킹', '와이드', '오버 더 숄더'][i % 5],
        seconds,
      });
      used += seconds;
      i++;
    }
    return { shots };
  }
  if (input.purpose === 'range') {
    const list = c.shots || [];
    return {
      shots: list.map((x, i) => ({
        scene: `${x.scene || '장면'} (다시 씀)`,
        visual: `${x.visual || '장면'} — ${String(c.instruction || '').slice(0, 20)}`,
        visual_en: `${x.visual || 'scene'}, rewritten`,
        dialogue: x.dialogue ? `${x.dialogue.replace(/[.?!]$/, '')}!` : '',
        speaker: '',
        cast: [],
        camera: '미디엄',
        camera_move: '고정',
        emotion: '담담',
        sfx: '',
        seconds: Number(x.seconds || 4),
      })),
    };
  }
  if (input.purpose === 'bible')
    return {
      world: '서울의 오래된 동네와 빌딩 숲이 공존하는 현재. 모두가 한 가지 비밀을 숨기고 산다.',
      rules: '주인공은 29세 회사원이며 가족사를 누구에게도 말하지 않았다.',
      relations: (c.characters || []).map((x) => x.name).join(' ↔ ') + ' 사이에 오래된 약속이 있다.',
      speech: (c.characters || []).slice(0, 4).map((x, i) => ({ name: x.name, style: ['존댓말, 짧게 끊어 말함', '반말, 농담 섞기', '존댓말, 부드러움', '반말, 퉁명스러움'][i % 4] })),
      taboos: '실존 인물·브랜드 언급 금지, 과도한 폭력 묘사 금지',
      foreshadow: [{ hint: '1화에 나온 낡은 편지', payoff: '마지막 화에서 발신인이 밝혀짐', episode: 1 }],
    };
  if (input.purpose === 'season') {
    const eps = c.episodes?.length ? c.episodes : Array.from({ length: Number(c.project?.episode_count || 1) }, (_, i) => ({ number: i + 1, title: `${i + 1}화`, summary: '' }));
    return {
      arc: '발단: 낯선 전화 → 전개: 비밀이 하나씩 드러남 → 위기: 믿었던 사람의 배신 → 반전: 편지의 진짜 주인 → 결말: 새로운 시작',
      paywall_from: Math.min(eps.length, 3),
      paywall_reason: '2화 마지막 반전 직후라 다음 이야기가 가장 궁금한 시점이에요.',
      episodes: eps.map((e) => ({ number: e.number, title: e.title, summary: e.summary || `${e.number}화 줄거리`, hook: `${e.number}화 첫 장면: 울리는 전화벨`, cliffhanger: `${e.number}화 끝: 문 앞에 선 낯선 사람`, twist: '숨겨 둔 편지가 발견된다' })),
    };
  }
  if (input.purpose === 'diagnose') {
    const shots = c.shots || [];
    return {
      scores: { hook: 78, pacing: 72, dialogue: 80, cliffhanger: 85, consistency: 90 },
      summary: `컷 ${shots.length}개 · 첫 장면 긴장감은 좋지만 중간 전개가 조금 느려요.`,
      fixes: shots.slice(1, 3).map((x, i) => ({ shot: i + 2, problem: '설명이 길어요', suggestion: '대사를 반으로 줄이고 표정으로 보여 주세요' })),
      risks: [],
    };
  }
  if (input.purpose === 'adapt') return mockText({ ...input, purpose: 'plan', context: c });
  if (input.purpose === 'meta') {
    const p = c.project || {};
    return {
      titles: [p.title || '비밀의 편지', `${p.title || '비밀'}: 두 번째 거짓말`, '그날 밤의 약속', '오늘부터 거짓말'],
      tagline: '한 통의 전화가 모든 걸 바꿨다',
      synopsis: `${p.logline || '평범한 하루가 뒤집힌다'}. 매 회 새로운 비밀이 드러나는 숏폼 드라마.`,
      hashtags: ['숏폼드라마', p.genre || '로맨스', '반전', '비밀', '정주행'],
      episode_titles: (c.episodes || []).map((e) => ({ number: e.number, title: `${e.number}화 · ${['끝나지 않은 전화', '거짓말의 대가', '열리는 문'][e.number % 3]}` })),
    };
  }
  if (input.purpose === 'translate') return { items: (c.items || []).map((x) => ({ id: x.id, en: `EN: ${String(x.ko).slice(0, 200)}` })) };
  if (input.purpose === 'rewrite') {
    const shot = c.shot || {};
    return {
      scene: `${shot.scene || '장면'} (수정)`,
      visual: `${shot.visual || 'A tense scene'}, more dramatic lighting`,
      dialogue: shot.dialogue ? `${shot.dialogue.replace(/[.?!]$/, '')}… ${String(c.instruction || '').slice(0, 10)}` : '',
      speaker: c.speaker || '',
      camera: shot.camera || '클로즈업',
      visual_en: `${shot.visual_en || shot.visual || 'A tense scene'}, more dramatic lighting`,
      seconds: Number(shot.seconds || 5),
    };
  }
  return { text: String(input.prompt || '').slice(0, 200) };
}

async function posterFile(seed) {
  const dir = path.resolve('public/images');
  const files = (await readdir(dir)).filter((f) => /^(hero|spring|shadow|moon|office|midnight|desktop-cinema)\.webp$/.test(f));
  return path.join(dir, files[hash(seed) % files.length] || 'hero.webp');
}
async function temp(ext) {
  const dir = path.join(tmpdir(), 'shortping-mock');
  await mkdir(dir, { recursive: true });
  return path.join(dir, randomUUID() + ext);
}

export const mockAdapter = {
  label: '개발용 가짜 AI (키 없이 전체 흐름 확인)',
  capabilities: ['text', 'image', 'video', 'tts', 'stt', 'music', 'sfx', 'lipsync'],
  base: '',
  async run({ capability, input }) {
    const delay = Number(process.env.AI_MOCK_DELAY_MS || 0);
    if (delay) await wait(delay);
    if (input.prompt && /MOCK_FAIL/.test(input.prompt)) throw Object.assign(new Error('가짜 AI가 일부러 실패했어요.'), { retryable: false });
    if (capability === 'text') {
      const out = JSON.stringify(mockText(input));
      return { status: 'done', result: { text: out, usage: { input: Math.ceil(String(input.prompt || '').length / 2), output: Math.ceil(out.length / 2) } } };
    }
    if (capability === 'video') return { status: 'pending', ref: JSON.stringify({ seconds: input.seconds || 5, seed: input.prompt || '', image: input.image ? input.image.buffer.toString('base64') : '' }) };
    if (capability === 'image') {
      const out = await temp('.jpg');
      const source = input.refImage ? await temp('.jpg') : await posterFile(input.prompt);
      if (input.refImage) await writeFile(source, input.refImage.buffer);
      await runFfmpeg(['-i', source, '-vf', `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,hue=h=${hash(input.prompt) % 360}:s=0.9`, '-frames:v', '1', '-q:v', '4', out]);
      const data = await readFile(out);
      await rm(out, { force: true });
      if (input.refImage) await rm(source, { force: true });
      return { status: 'done', result: { data, mime: 'image/jpeg' } };
    }
    if (capability === 'tts') {
      const seconds = Math.min(15, Math.max(1, String(input.text || '').length / 6));
      const out = await temp('.mp3');
      await runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=${200 + (hash(input.voice || '') % 200)}:duration=${seconds.toFixed(2)}`, '-af', 'volume=0.06', '-c:a', 'libmp3lame', '-b:a', '64k', out]);
      const data = await readFile(out);
      await rm(out, { force: true });
      return { status: 'done', result: { data, mime: 'audio/mpeg' } };
    }
    if (capability === 'music' || capability === 'sfx') {
      // 배경음악은 낮은 화음, 효과음은 짧은 잡음 — 길이만 맞춘 가짜 소리입니다.
      const seconds = Math.max(1, Math.min(capability === 'music' ? 180 : 30, Number(input.seconds) || (capability === 'music' ? 20 : 3)));
      const out = await temp('.mp3');
      const src =
        capability === 'music'
          ? `sine=frequency=${110 + (hash(input.prompt || '') % 60)}:duration=${seconds}`
          : `anoisesrc=d=${seconds}:c=pink:a=0.2`;
      await runFfmpeg(['-f', 'lavfi', '-i', src, '-af', capability === 'music' ? 'volume=0.08' : 'volume=0.15,afade=t=out:st=' + Math.max(0, seconds - 0.4) + ':d=0.4', '-c:a', 'libmp3lame', '-b:a', '96k', out]);
      const data = await readFile(out);
      await rm(out, { force: true });
      return { status: 'done', result: { data, mime: 'audio/mpeg' } };
    }
    if (capability === 'lipsync') {
      // 영상에 대사 음성을 입혀 돌려줍니다(입 모양은 그대로).
      const v = await temp('.mp4'),
        a = await temp('.' + (input.audio.ext || 'mp3')),
        out = await temp('.mp4');
      await writeFile(v, input.video.buffer);
      await writeFile(a, input.audio.buffer);
      await runFfmpeg(['-i', v, '-i', a, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out]);
      const data = await readFile(out);
      await Promise.all([v, a, out].map((f) => rm(f, { force: true })));
      return { status: 'done', result: { data, mime: 'video/mp4' } };
    }
    if (capability === 'stt') {
      const duration = Number(input.duration || 12);
      const segments = [];
      for (let t = 0, n = 1; t < duration; t += 3, n++) segments.push({ start: t, end: Math.min(duration, t + 2.8), text: `(자동 자막 예시) ${n}번째 대사` });
      return { status: 'done', result: { segments } };
    }
    throw new Error('지원하지 않는 작업이에요.');
  },
  async poll({ ref }) {
    const { seconds, seed, image } = JSON.parse(ref);
    const source = image ? await temp('.jpg') : await posterFile(seed);
    if (image) await writeFile(source, Buffer.from(image, 'base64'));
    const out = await temp('.mp4');
    await runFfmpeg(
      [
        '-framerate', '30', '-loop', '1', '-t', String(seconds), '-i', source,
        '-vf', "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=z='min(zoom+0.0015,1.25)':d=1:s=720x1280:fps=30,format=yuv420p",
        '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-an', '-movflags', '+faststart', out,
      ],
      180000,
    );
    const data = await readFile(out);
    await rm(out, { force: true });
    if (image) await rm(source, { force: true });
    return { status: 'done', result: { data, mime: 'video/mp4' } };
  },
  async test() {
    return '개발용 가짜 AI는 항상 연결돼 있어요.';
  },
};
