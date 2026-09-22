import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let executable = process.env.FFMPEG_PATH || 'ffmpeg';
if (!process.env.FFMPEG_PATH && process.env.NODE_ENV !== 'production') {
  try {
    executable = (await import('ffmpeg-static')).default || executable;
  } catch {}
}

// Decode the opening frame, rather than trusting a MIME header or filename.
// Full transcoding and whole-file quality checks belong in the production media worker.
export async function inspectMedia(file, mime) {
  if (mime.startsWith('image/') && file.size > 10 * 1024 * 1024)
    throw Object.assign(new Error('포스터 이미지는 10MB 이하로 등록해 주세요.'), { status: 400 });
  let stderr;
  try {
    ({ stderr } = await exec(
      executable,
      [
        '-hide_banner',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-xerror',
        '-i',
        file.path,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
    ));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw Object.assign(
        new Error('영상 검사 도구가 준비되지 않았습니다. 운영자에게 문의해 주세요.'),
        { status: 503 },
      );
    throw Object.assign(
      new Error('이미지 또는 영상을 읽을 수 없습니다. 정상 파일로 다시 업로드해 주세요.'),
      { status: 400 },
    );
  }
  const stream =
    stderr.split('\n').find((line) => line.includes('Stream #0:') && line.includes('Video:')) || '';
  const size = stream.match(/\b(\d{2,5})x(\d{2,5})\b/);
  if (!size)
    throw Object.assign(new Error('영상 또는 이미지 크기를 확인할 수 없습니다.'), { status: 400 });
  let duration = 0;
  if (mime === 'video/mp4') {
    const time = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
    duration = time
      ? Math.ceil(Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]))
      : 0;
    if (!/Video: h264\b/.test(stream) || duration < 1 || duration > 3600)
      throw Object.assign(
        new Error('H.264 MP4 영상으로 등록해 주세요. 재생 시간은 최대 60분입니다.'),
        { status: 400 },
      );
  }
  const hasAudio = /Stream #0:\d+[^\n]*Audio:/.test(stderr);
  return { duration, width: Number(size[1]), height: Number(size[2]), hasAudio };
}

export const ffmpegPath = () => executable;
// AI가 만든 파일처럼 코덱이 다양할 수 있는 파일의 길이·크기만 확인합니다(엄격한 등록 검사는 inspectMedia).
export async function probeMedia(file) {
  let stderr = '';
  try {
    await exec(executable, ['-hide_banner', '-nostdin', '-i', file], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (error) {
    // 출력 파일 없이 -i만 주면 ffmpeg는 항상 오류로 끝나지만 stderr에 정보가 남습니다.
    if (error.code === 'ENOENT') throw Object.assign(new Error('영상 처리 도구가 준비되지 않았습니다.'), { status: 503 });
    stderr = String(error.stderr || '');
  }
  const time = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0;
  const video = stderr.split('\n').find((l) => /Stream #0:\d+[^\n]*Video:/.test(l)) || '';
  const size = video.match(/\b(\d{2,5})x(\d{2,5})\b/);
  if (!time && !size) throw Object.assign(new Error('생성된 파일을 읽을 수 없어요.'), { status: 502, retryable: true });
  return {
    duration,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    hasAudio: /Stream #0:\d+[^\n]*Audio:/.test(stderr),
    hasVideo: !!video,
  };
}
// ffmpeg를 인자 배열로 실행합니다(셸을 거치지 않음). 긴 작업은 timeout으로 끊습니다.
export async function runFfmpeg(args, timeout = 120000) {
  try {
    return await exec(executable, ['-hide_banner', '-nostdin', '-y', ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (error.code === 'ENOENT')
      throw Object.assign(new Error('영상 처리 도구가 준비되지 않았습니다.'), { status: 503 });
    throw Object.assign(new Error('영상 처리에 실패했습니다. ' + String(error.stderr || error.message).slice(-300)), {
      status: 500,
    });
  }
}

// 숏폼 기준 사전 점검. 반려 사유가 아니라 PD에게 미리 알려 주는 경고입니다.
export function precheck(meta) {
  const warnings = [];
  const w = Number(meta?.width || 0),
    h = Number(meta?.height || 0),
    d = Number(meta?.duration || 0);
  if (w && h) {
    if (w >= h) warnings.push('가로 영상이에요. 숏핑은 세로(9:16) 영상을 권장해요.');
    else if (Math.abs(w / h - 9 / 16) > 0.03) warnings.push(`화면 비율이 9:16이 아니에요 (${w}×${h}).`);
    if (Math.min(w, h) < 720) warnings.push(`해상도가 낮아요 (${w}×${h}). 720×1280 이상을 권장해요.`);
  }
  if (d && d < 15) warnings.push(`재생 시간이 짧아요 (${d}초).`);
  if (d > 180) warnings.push(`재생 시간이 길어요 (${d}초). 숏폼은 3분 이하를 권장해요.`);
  if (meta && meta.has_audio === 0) warnings.push('소리가 없는 영상이에요.');
  return warnings;
}
