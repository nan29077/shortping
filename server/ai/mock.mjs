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
        look: looks[i],
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
        visual: `${['A cozy cafe by the window', 'A dim office corridor', 'A rainy street at night with neon reflections', 'A rooftop at sunset', 'A quiet living room'][i % 5]}, ${speaker || 'the protagonist'} looks at the camera with a tense expression`,
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
  if (input.purpose === 'rewrite') {
    const shot = c.shot || {};
    return {
      scene: `${shot.scene || '장면'} (수정)`,
      visual: `${shot.visual || 'A tense scene'}, more dramatic lighting`,
      dialogue: shot.dialogue ? `${shot.dialogue.replace(/[.?!]$/, '')}… ${String(c.instruction || '').slice(0, 10)}` : '',
      speaker: c.speaker || '',
      camera: shot.camera || '클로즈업',
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
  capabilities: ['text', 'image', 'video', 'tts', 'stt'],
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
        '-loop', '1', '-t', String(seconds), '-i', source,
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
