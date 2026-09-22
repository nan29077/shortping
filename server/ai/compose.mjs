import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeMedia, runFfmpeg } from '../media.mjs';

// 회차 합성: 컷 영상(없으면 스토리보드 이미지를 천천히 확대한 화면)과 대사 음성을 컷 길이에 맞춰 붙이고,
// 720×1280 · 30fps · H.264/AAC 세로 MP4 한 편과 WebVTT 자막을 만듭니다. AI를 쓰지 않으므로 라마가 들지 않습니다.
const W = 720,
  H = 1280;
const vtt = (t) => {
  const ms = Math.round(t * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
};
export function subtitlesFor(shots, durations, nameOf) {
  const cues = [];
  let t = 0;
  shots.forEach((shot, i) => {
    const d = durations[i];
    const text = String(shot.dialogue || '').replace(/[<>{}]/g, '').trim();
    if (text) {
      const speaker = nameOf(shot.speaker_id);
      cues.push(`${vtt(t + 0.15)} --> ${vtt(t + d - 0.1)}\n${speaker ? speaker + ': ' : ''}${text}`);
    }
    t += d;
  });
  return 'WEBVTT\n\n' + cues.join('\n\n') + (cues.length ? '\n' : '');
}
export async function composeEpisode({ shots, uploadDir, nameOf, onProgress = () => {} }) {
  if (!shots.length) throw Object.assign(new Error('대본(컷)이 없어요. 대본을 먼저 만들어 주세요.'), { status: 400 });
  const missing = shots.findIndex((s) => !s.video && !s.image);
  if (missing >= 0) throw Object.assign(new Error(`${missing + 1}번째 컷에 영상이나 스토리보드 이미지가 없어요.`), { status: 400 });
  const file = (url) => path.join(uploadDir, path.basename(url));
  const work = path.join(tmpdir(), 'shortping-compose', randomUUID());
  await mkdir(work, { recursive: true });
  try {
    const parts = [];
    const durations = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      onProgress(i / (shots.length + 1));
      const clip = shot.video && existsSync(file(shot.video)) ? file(shot.video) : null;
      const still = !clip && shot.image && existsSync(file(shot.image)) ? file(shot.image) : null;
      if (!clip && !still) throw Object.assign(new Error(`${i + 1}번째 컷 파일을 찾을 수 없어요.`), { status: 400 });
      const audio = shot.audio && existsSync(file(shot.audio)) ? file(shot.audio) : null;
      const clipLen = clip ? (await probeMedia(clip)).duration || Number(shot.seconds) : Number(shot.seconds);
      const audioLen = audio ? (await probeMedia(audio)).duration : 0;
      // 대사가 영상보다 길면 마지막 장면을 늘려서 대사가 잘리지 않게 합니다.
      const d = Math.max(1, Math.min(30, Math.max(clip ? Math.min(clipLen, Number(shot.seconds) || clipLen) : Number(shot.seconds) || 4, audioLen ? audioLen + 0.35 : 0)));
      durations.push(d);
      const out = path.join(work, `part-${String(i).padStart(3, '0')}.mp4`);
      const vf = clip
        ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p`
        : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},zoompan=z='min(zoom+0.0012,1.2)':d=1:s=${W}x${H}:fps=30,trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p`;
      const inputs = clip ? ['-i', clip] : ['-loop', '1', '-t', String(d), '-i', still];
      const audioIn = audio ? ['-i', audio] : ['-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=44100:cl=stereo'];
      await runFfmpeg(
        [
          ...inputs,
          ...audioIn,
          '-filter_complex',
          `[0:v]${vf}[v];[1:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a]`,
          '-map', '[v]', '-map', '[a]',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
          '-t', String(d),
          out,
        ],
        240000,
      );
      parts.push(out);
    }
    onProgress(shots.length / (shots.length + 1));
    const list = path.join(work, 'list.txt');
    await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const filename = randomUUID() + '.mp4';
    const target = path.join(uploadDir, filename);
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', target], 240000);
    const meta = await probeMedia(target);
    return {
      filename,
      url: '/uploads/' + filename,
      duration: Math.max(1, Math.round(meta.duration)),
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
      size: (await stat(target)).size,
      vtt: subtitlesFor(shots, durations, nameOf),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
