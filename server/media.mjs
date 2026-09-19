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
  return { duration, width: Number(size[1]), height: Number(size[2]) };
}
