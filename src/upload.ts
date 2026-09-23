import { api } from './api';
import { apiUrl, authHeaders, fetchCredentials } from './platform';

// 큰 영상을 8MB 조각으로 나눠 올립니다. 조각이 실패하면 서버가 받은 위치를 다시 물어
// 그 지점부터 이어 올립니다(최대 4번 재시도). 같은 세션 id로 나중에 resume()도 가능합니다.
export type UploadResult = {
  url: string;
  duration: number;
  width: number;
  height: number;
  warnings: string[];
};
export const MAX_VIDEO_MB = 500;
export type UploadHandle = { id: string; size: number };

async function putChunk(id: string, offset: number, chunk: Blob, signal?: AbortSignal) {
  const res = await fetch(apiUrl(`/studio/uploads/${id}?offset=${offset}`), {
    method: 'PUT',
    credentials: fetchCredentials,
    headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
    body: chunk,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { received: Number(data.received) };
  if (res.status === 409 && typeof data.received === 'number') return { received: data.received };
  throw new Error(data.error || '업로드 조각을 보내지 못했어요.');
}

export async function uploadVideo(
  file: File,
  onProgress: (ratio: number) => void,
  options: { signal?: AbortSignal; handle?: UploadHandle; onHandle?: (h: UploadHandle) => void } = {},
): Promise<UploadResult> {
  if (file.type && file.type !== 'video/mp4') throw new Error('MP4 영상만 올릴 수 있어요.');
  if (file.size > MAX_VIDEO_MB * 1024 * 1024)
    throw new Error(`영상은 회차당 최대 ${MAX_VIDEO_MB}MB까지 올릴 수 있어요.`);
  let handle = options.handle;
  let chunkSize = 8 * 1024 * 1024;
  let received = 0;
  if (handle) {
    const s = await api<{ received: number; status: string; size: number }>('/studio/uploads/' + handle.id);
    // 조각은 다 올라갔는데 회차 등록만 실패한 경우: 다시 올리지 않고 완료 결과를 바로 받습니다.
    if (s.status === 'done') {
      onProgress(1);
      return api<UploadResult>(`/studio/uploads/${handle.id}/complete`, 'POST');
    }
    if (s.status !== 'open' || Number(s.size) !== file.size) handle = undefined;
    else received = Number(s.received) || 0;
  }
  if (!handle) {
    const r = await api<{ id: string; chunkSize: number }>('/studio/uploads', 'POST', {
      size: file.size,
      mime: 'video/mp4',
      filename: file.name.slice(0, 200),
    });
    handle = { id: r.id, size: file.size };
    chunkSize = r.chunkSize;
    options.onHandle?.(handle);
  }
  let failures = 0;
  while (received < file.size) {
    onProgress(received / file.size);
    try {
      const next = await putChunk(
        handle.id,
        received,
        file.slice(received, Math.min(file.size, received + chunkSize)),
        options.signal,
      );
      received = next.received;
      failures = 0;
    } catch (e) {
      if (options.signal?.aborted) throw new Error('업로드를 취소했어요.');
      failures += 1;
      if (failures > 4) throw e;
      await new Promise((r) => setTimeout(r, 800 * failures));
      // 서버가 실제로 받은 위치를 다시 확인하고 이어서 보냅니다. 확인 자체가 실패하면(네트워크 단절)
      // 지금 위치를 유지한 채 다음 재시도로 넘어갑니다.
      try {
        received = Number((await api<{ received: number }>('/studio/uploads/' + handle.id)).received) || received;
      } catch {
        /* 다음 루프에서 다시 시도 */
      }
    }
  }
  onProgress(1);
  return api<UploadResult>(`/studio/uploads/${handle.id}/complete`, 'POST');
}

// 파일 이름에서 회차 번호를 찾습니다. "03화", "EP02", "episode-4", "제5화", "7.mp4"
export function episodeNumberFrom(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, '');
  const patterns = [/(\d{1,3})\s*화/, /ep(?:isode)?[\s._-]*(\d{1,3})/i, /제\s*(\d{1,3})/, /^(\d{1,3})(?:\D|$)/, /(?<!\d)(\d{1,3})(?!.*\d)/];
  for (const p of patterns) {
    const m = base.match(p);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 500) return n;
    }
  }
  return null;
}
