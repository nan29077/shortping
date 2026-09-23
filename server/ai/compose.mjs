import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeMedia, runFfmpeg } from '../media.mjs';

// 회차 합성: 컷 영상(입 모양 맞춘 영상 > 컷 영상 > 스토리보드 이미지를 카메라 움직임대로 움직인 화면)과
// 대사 음성·영상 원래 소리·효과음을 컷 길이에 맞춰 섞고, 인트로·엔딩 카드와 배경음악(대사 나올 때 자동으로 줄임)을
// 입혀 세로 MP4 한 편과 WebVTT 자막을 만듭니다. AI를 쓰지 않으므로 라마가 들지 않습니다.
export const RESOLUTIONS = { '720p': [720, 1280], '1080p': [1080, 1920] };
const vtt = (t) => {
  const ms = Math.round(t * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
};
// 자막 위치(아래·가운데·위)는 VTT 큐 설정으로 넣어 플레이어가 그대로 따르게 합니다.
const LINE = { bottom: 'line:88%', middle: 'line:50%', top: 'line:12%' };
export function subtitlesFor(shots, durations, nameOf, { offset = 0, position = 'bottom', names = true } = {}) {
  const cues = [];
  let t = offset;
  const setting = LINE[position] ? ' ' + LINE[position] : '';
  shots.forEach((shot, i) => {
    const d = durations[i];
    // 자막 문구를 따로 고쳤으면 그것을, 아니면 대사를 씁니다. 빈 줄은 자막 큐를 끊으므로 한 줄로 합칩니다.
    const raw = shot.caption !== null && shot.caption !== undefined ? shot.caption : shot.dialogue;
    const text = String(raw || '').replace(/[<>{}]/g, '').replace(/\s*\r?\n\s*/g, ' ').trim();
    if (text) {
      // 인물 이름에 줄바꿈·태그 문자가 있으면 자막 큐가 깨지므로 정리합니다.
      const speaker = names && !Number(shot.narration) ? String(nameOf(shot.speaker_id) || '').replace(/[<>{}\r\n]/g, '').trim() : '';
      cues.push(`${vtt(t + 0.15)} --> ${vtt(t + d - 0.1)}${setting}\n${speaker ? speaker + ': ' : ''}${text}`);
    }
    t += d;
  });
  return 'WEBVTT\n\n' + cues.join('\n\n') + (cues.length ? '\n' : '');
}
// 스토리보드 이미지를 컷 길이 동안 카메라 움직임대로 움직입니다(프레임 수 N 기준).
function stillMotion(move, W, H, N) {
  const zp = (z, x, y) => `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=30`;
  const cx = "iw/2-(iw/zoom/2)",
    cy = "ih/2-(ih/zoom/2)";
  switch (move) {
    case '고정':
      return zp('1', cx, cy);
    case '천천히 멀어지기':
      return zp(`max(1.2-0.2*on/${N},1)`, cx, cy);
    case '왼쪽으로 패닝':
      return zp('1.18', `(iw-iw/zoom)*(1-on/${N})`, cy);
    case '오른쪽으로 패닝':
      return zp('1.18', `(iw-iw/zoom)*on/${N}`, cy);
    case '위로 틸트':
      return zp('1.18', cx, `(ih-ih/zoom)*(1-on/${N})`);
    case '핸드헬드':
      return zp('1.08', `${cx}+sin(on/7)*6`, `${cy}+cos(on/9)*5`);
    case '따라가기':
      return zp(`min(1+0.0009*on,1.2)`, `(iw-iw/zoom)*on/${N}`, cy);
    default:
      return zp('min(zoom+0.0012,1.2)', cx, cy);
  }
}
const exists = (file) => file && existsSync(file);
export async function composeEpisode({
  shots,
  uploadDir,
  nameOf,
  onProgress = () => {},
  resolution = '720p',
  introCard = '',
  outroCard = '',
  bgm = '',
  bgmVolume = 0.22,
  subtitlePosition = 'bottom',
  subtitleNames = true,
}) {
  if (!shots.length) throw Object.assign(new Error('대본(컷)이 없어요. 대본을 먼저 만들어 주세요.'), { status: 400 });
  const missing = shots.findIndex((s) => !s.video && !s.image && !s.lipsync);
  if (missing >= 0) throw Object.assign(new Error(`${missing + 1}번째 컷에 영상이나 스토리보드 이미지가 없어요.`), { status: 400 });
  const [W, H] = RESOLUTIONS[resolution] || RESOLUTIONS['720p'];
  const file = (url) => (url ? path.join(uploadDir, path.basename(url)) : '');
  const work = path.join(tmpdir(), 'shortping-compose', randomUUID());
  await mkdir(work, { recursive: true });
  const steps = shots.length + (introCard ? 1 : 0) + (outroCard ? 1 : 0) + 2;
  let done = 0;
  const tick = () => onProgress(Math.min(0.99, ++done / steps));
  const encodeV = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30', '-pix_fmt', 'yuv420p'];
  const encodeA = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'];
  try {
    const parts = [];
    const durations = [];
    // 인트로·엔딩 카드: 움직이지 않는 이미지 + 무음(배경음악은 전체에 깔림)
    const card = async (img, seconds, name) => {
      const out = path.join(work, name);
      await runFfmpeg(
        [
          '-framerate', '30', '-loop', '1', '-t', String(seconds), '-i', img,
          '-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=44100:cl=stereo',
          '-filter_complex', `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, seconds - 0.3)}:d=0.3,format=yuv420p[v]`,
          '-map', '[v]', '-map', '1:a', ...encodeV, ...encodeA, '-t', String(seconds), out,
        ],
        120000,
      );
      tick();
      return out;
    };
    let offset = 0;
    if (introCard && exists(file(introCard))) {
      parts.push(await card(file(introCard), 2, 'intro.mp4'));
      offset = 2;
    }
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const synced = shot.lipsync && exists(file(shot.lipsync)) ? file(shot.lipsync) : null;
      const clip = synced || (shot.video && exists(file(shot.video)) ? file(shot.video) : null);
      const still = !clip && shot.image && exists(file(shot.image)) ? file(shot.image) : null;
      if (!clip && !still) throw Object.assign(new Error(`${i + 1}번째 컷 파일을 찾을 수 없어요.`), { status: 400 });
      // 입 모양을 맞춘 영상에는 대사가 이미 들어 있으므로 대사 음성을 다시 얹지 않습니다.
      const voice = !synced && shot.audio && exists(file(shot.audio)) ? file(shot.audio) : null;
      const sfx = shot.sfx && exists(file(shot.sfx)) ? file(shot.sfx) : null;
      const clipMeta = clip ? await probeMedia(clip) : null;
      const clipLen = clip ? clipMeta.duration || Number(shot.seconds) : Number(shot.seconds);
      const voiceLen = voice ? (await probeMedia(voice)).duration : 0;
      // 대사가 영상보다 길면 마지막 장면을 늘려서 대사가 잘리지 않게 합니다. 입 모양 영상은 그 길이를 그대로 씁니다.
      const d = Math.max(
        1,
        Math.min(30, synced ? clipLen : Math.max(clip ? Math.min(clipLen, Number(shot.seconds) || clipLen) : Number(shot.seconds) || 4, voiceLen ? voiceLen + 0.35 : 0)),
      );
      durations.push(d);
      const out = path.join(work, `part-${String(i).padStart(3, '0')}.mp4`);
      // 장면 전환: fade(검은 화면에서 서서히), dip(더 길게), flash(흰 화면에서) — 이 컷의 시작에 적용합니다.
      const tr = shot.transition || 'cut';
      const next = shots[i + 1]?.transition;
      const fx = [
        tr === 'fade' ? 'fade=t=in:st=0:d=0.3' : tr === 'dip' ? 'fade=t=in:st=0:d=0.5' : tr === 'flash' ? 'fade=t=in:st=0:d=0.25:color=white' : '',
        next === 'dip' ? `fade=t=out:st=${Math.max(0, d - 0.4)}:d=0.4` : '',
      ]
        .filter(Boolean)
        .join(',');
      const base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
      const vf = clip
        ? `${base},fps=30,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS${fx ? ',' + fx : ''},format=yuv420p`
        : `${base},${stillMotion(shot.camera_move, W, H, Math.max(1, Math.round(d * 30)))},trim=duration=${d},setpts=PTS-STARTPTS${fx ? ',' + fx : ''},format=yuv420p`;
      // 이미지는 30fps로 읽어야 움직임이 컷 길이와 정확히 맞습니다(기본 25fps면 약 17% 짧아짐).
      const inputs = clip ? ['-i', clip] : ['-framerate', '30', '-loop', '1', '-t', String(d), '-i', still];
      const extra = [];
      const mixes = [];
      const norm = `aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS`;
      let idx = 1;
      // 영상 모델이 만든 소리(대사·효과음) 또는 입 모양 영상의 대사
      if (clipMeta?.hasAudio) mixes.push(`[0:a]${norm},volume=${synced ? 1 : voice ? 0.45 : 1}[s0]`);
      if (voice) {
        extra.push('-i', voice);
        mixes.push(`[${idx++}:a]${norm}[s1]`);
      }
      if (sfx) {
        extra.push('-i', sfx);
        mixes.push(`[${idx++}:a]${norm},volume=${Math.max(0, Math.min(1.5, Number(shot.sfx_volume ?? 0.6)))}[s2]`);
      }
      let af;
      if (!mixes.length) {
        extra.push('-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=44100:cl=stereo');
        af = `[${idx}:a]${norm}[a]`;
      } else if (mixes.length === 1) af = mixes[0].replace(/\[s\d\]$/, '[a]');
      else {
        const labels = mixes.map((m) => m.match(/\[s\d\]$/)[0]).join('');
        af = mixes.join(';') + `;${labels}amix=inputs=${mixes.length}:duration=first:normalize=0[a]`;
      }
      await runFfmpeg([
        ...inputs,
        ...extra,
        '-filter_complex', `[0:v]${vf}[v];${af}`,
        '-map', '[v]', '-map', '[a]',
        ...encodeV, ...encodeA,
        '-t', String(d),
        out,
      ], 240000);
      parts.push(out);
      tick();
    }
    if (outroCard && exists(file(outroCard))) parts.push(await card(file(outroCard), 2.5, 'outro.mp4'));
    const list = path.join(work, 'list.txt');
    await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = path.join(work, 'joined.mp4');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined], 240000);
    tick();
    const filename = randomUUID() + '.mp4';
    const target = path.join(uploadDir, filename);
    let meta;
    try {
      const music = bgm && exists(file(bgm)) ? file(bgm) : null;
      const vol = Math.max(0, Math.min(1, Number(bgmVolume)));
      if (music && vol > 0) {
        const total = (await probeMedia(joined)).duration;
        // 배경음악은 영상 길이만큼 반복하고, 대사·효과음이 나오면 자동으로 줄였다가(덕킹) 끝에서 서서히 줄입니다.
        await runFfmpeg(
          [
            '-i', joined, '-stream_loop', '-1', '-i', music,
            '-filter_complex',
            `[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=${vol},atrim=duration=${total},afade=t=out:st=${Math.max(0, total - 1.5)}:d=1.5[b];` +
              `[0:a]asplit=2[main][key];[b][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[duck];` +
              `[main][duck]amix=inputs=2:duration=first:normalize=0[a]`,
            '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...encodeA, '-movflags', '+faststart', target,
          ],
          240000,
        );
      } else await runFfmpeg(['-i', joined, '-c', 'copy', '-movflags', '+faststart', target], 240000);
      meta = await probeMedia(target);
    } catch (e) {
      // 이어 붙이기·검사에 실패하면 반쯤 쓴 결과 파일을 남기지 않습니다.
      await rm(target, { force: true }).catch(() => {});
      throw e;
    }
    tick();
    return {
      filename,
      url: '/uploads/' + filename,
      duration: Math.max(1, Math.round(meta.duration)),
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
      size: (await stat(target)).size,
      vtt: subtitlesFor(shots, durations, nameOf, { offset, position: subtitlePosition, names: subtitleNames }),
      durations,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// 예고편: 고른 컷(없으면 회차마다 하이라이트 컷)을 짧게 잘라 이어 붙이고, 배경음악과 제목 카드로 15~30초 영상을 만듭니다.
export async function composeTrailer({ shots, uploadDir, nameOf, titleCard = '', endCard = '', bgm = '', bgmVolume = 0.35, resolution = '720p', onProgress }) {
  const trimmed = shots.map((s) => ({ ...s, seconds: Math.min(3, Number(s.seconds) || 3), transition: s.transition === 'cut' || !s.transition ? 'fade' : s.transition }));
  return composeEpisode({ shots: trimmed, uploadDir, nameOf, introCard: titleCard, outroCard: endCard, bgm, bgmVolume, resolution, onProgress, subtitleNames: false });
}
