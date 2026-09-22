// AI 공급사 호출 공통 도우미: 시간 제한, 오류 메시지 정리, 결과 파일 내려받기(크기 제한).
export class VendorError extends Error {
  constructor(message, { status = 502, retryable = true } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}
const snippet = (text) => String(text || '').replace(/\s+/g, ' ').slice(0, 300);
export async function call(url, { method = 'POST', headers = {}, json, body, timeout = 120000, raw = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: json !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
  } catch (e) {
    throw new VendorError('AI 공급사에 연결하지 못했어요: ' + (e.name === 'TimeoutError' ? '시간 초과' : e.message));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      const data = JSON.parse(text);
      message = data.error?.message || data.error || data.message || data.detail || data.base_resp?.status_msg || text;
      if (typeof message !== 'string') message = JSON.stringify(message);
    } catch {}
    throw new VendorError(`AI 공급사 오류(${res.status}): ${snippet(message)}`, {
      status: res.status === 401 || res.status === 403 ? 401 : 502,
      // 인증·요청 형식 오류는 다시 시도해도 같으므로 재시도하지 않습니다.
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new VendorError('AI 공급사 응답을 읽지 못했어요: ' + snippet(text));
  }
}
const MAX_DOWNLOAD = 400 * 1024 * 1024;
// 개발·테스트에서만 로컬 가짜 공급사(127.0.0.1)의 http 결과 주소를 허용합니다.
let allowLocal = false;
export const allowLocalDownloads = (value) => {
  allowLocal = !!value;
};
export async function download(url, headers = {}) {
  if (url.startsWith('data:')) {
    const [, meta, data] = url.match(/^data:([^,]*),(.*)$/s) || [];
    if (!meta) throw new VendorError('결과 파일을 읽지 못했어요.');
    return meta.includes(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data));
  }
  if (!/^https:\/\//.test(url) && !(allowLocal && /^http:\/\/127\.0\.0\.1[:/]/.test(url)))
    throw new VendorError('안전하지 않은 결과 주소예요.', { retryable: false });
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(300000), redirect: 'follow' });
  } catch (e) {
    throw new VendorError('결과 파일을 내려받지 못했어요: ' + e.message);
  }
  if (!res.ok) throw new VendorError(`결과 파일을 내려받지 못했어요(${res.status}).`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_DOWNLOAD) throw new VendorError('결과 파일이 너무 커요.', { retryable: false });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD) throw new VendorError('결과 파일이 너무 커요.', { retryable: false });
  return buffer;
}
export const dataUri = (buffer, mime) => `data:${mime};base64,${buffer.toString('base64')}`;
// Gemini TTS는 24kHz 16bit 모노 PCM을 돌려줍니다. 재생 가능한 WAV로 감쌉니다.
export function pcmToWav(pcm, rate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (rate * channels * bits) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
