// AI 공급사 호출 공통 도우미: 시간 제한, 오류 메시지 정리, 결과 파일 내려받기(크기 제한).
import { lookup } from 'node:dns/promises';
import net from 'node:net';
export class VendorError extends Error {
  constructor(message, { status = 502, retryable = true, transient = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    // 일시적인 연결·과부하 오류(시간 초과, 429, 5xx). 결과 확인 중이면 작업을 버리지 않고 나중에 다시 확인합니다.
    this.transient = transient;
  }
}
const snippet = (text) => String(text || '').replace(/\s+/g, ' ').slice(0, 300);
export async function call(url, { method = 'POST', headers = {}, json, body, timeout = 120000, raw = false } = {}) {
  let res;
  let current = url;
  let sendHeaders = json !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers;
  // 리다이렉트는 직접 따라가며, 다른 곳으로 넘어가면 API 키가 든 헤더를 모두 뺍니다.
  for (let hop = 0; ; hop++) {
    try {
      res = await fetch(current, {
        method,
        headers: sendHeaders,
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: AbortSignal.timeout(timeout),
        redirect: 'manual',
      });
    } catch (e) {
      throw new VendorError('AI 공급사에 연결하지 못했어요: ' + (e.name === 'TimeoutError' ? '시간 초과' : e.message), { transient: true });
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const location = res.headers.get('location');
    if (!location || hop >= MAX_REDIRECTS) throw new VendorError('AI 공급사 주소가 너무 여러 번 바뀌었어요.', { retryable: false });
    const next = new URL(location, current).toString();
    if (new URL(next).origin !== new URL(current).origin) {
      if (!(await allowedUrl(next))) throw new VendorError('안전하지 않은 공급사 주소예요.', { retryable: false });
      sendHeaders = json !== undefined ? { 'Content-Type': 'application/json' } : {};
    }
    current = next;
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
      transient: res.status === 429 || res.status >= 500,
    });
  }
  // 공급사 응답도 크기 한도 안에서만 읽습니다(비정상적으로 큰 응답으로 서버 메모리가 가득 차지 않게).
  const payload = await readLimited(res, raw ? MAX_DOWNLOAD : 64 * 1024 * 1024);
  if (raw) return payload;
  const text = payload.toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new VendorError('AI 공급사 응답을 읽지 못했어요: ' + snippet(text));
  }
}
const MAX_DOWNLOAD = 400 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// 개발·테스트에서만 로컬 가짜 공급사(127.0.0.1)의 http 결과 주소를 허용합니다.
let allowLocal = false;
export const allowLocalDownloads = (value) => {
  allowLocal = !!value;
};
// 결과 주소 검사: https만 허용하고, 내부망·루프백 주소는 막습니다(리다이렉트된 주소도 매번 다시 검사).
// 내부망·루프백·링크 로컬 주소인지 확인합니다(IPv4, IPv6, IPv4-mapped IPv6 포함).
export function privateIp(ip) {
  let a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const hexMapped = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16),
      lo = parseInt(hexMapped[2], 16);
    a = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  if (net.isIPv4(a))
    return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(a);
  if (net.isIPv6(a)) return /^(::1?$|::$|f[cd]|fe[89ab]|ff|0:0:0:0:0:0:0:[01]$)/.test(a) || /^[0:]+$/.test(a) || a === '::';
  return false;
}
const privateName = (host) => /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host);
async function allowedUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (allowLocal && u.protocol === 'http:' && host === '127.0.0.1') return true;
  if (u.protocol !== 'https:' || !host || privateName(host) || privateIp(host)) return false;
  if (net.isIP(host)) return true;
  // 도메인이 내부 주소로 풀리는 경우(예: 127.0.0.1.nip.io)도 막습니다.
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((r) => !privateIp(r.address));
  } catch {
    return false;
  }
}
export const safeUrl = (url) => allowedUrl(url);
// 응답 본문을 조금씩 읽으며 크기를 셉니다. content-length가 없거나 거짓이어도 한도를 넘으면 바로 끊습니다.
async function readLimited(res, limit) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) throw new VendorError('결과 파일이 너무 커요.', { retryable: false });
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new VendorError('결과 파일이 너무 커요.', { retryable: false });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
export async function download(url, headers = {}) {
  if (url.startsWith('data:')) {
    const [, meta, data] = url.match(/^data:([^,]*),(.*)$/s) || [];
    if (!meta) throw new VendorError('결과 파일을 읽지 못했어요.');
    const buffer = meta.includes(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data));
    if (buffer.length > MAX_DOWNLOAD) throw new VendorError('결과 파일이 너무 커요.', { retryable: false });
    return buffer;
  }
  let current = url;
  let sendHeaders = headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await allowedUrl(current))) throw new VendorError('안전하지 않은 결과 주소예요.', { retryable: false });
    let res;
    try {
      res = await fetch(current, { headers: sendHeaders, signal: AbortSignal.timeout(300000), redirect: 'manual' });
    } catch (e) {
      throw new VendorError('결과 파일을 내려받지 못했어요: ' + e.message, { transient: true });
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new VendorError('결과 파일을 내려받지 못했어요(주소 없음).');
      const next = new URL(location, current).toString();
      // 다른 곳으로 넘어가면 공급사 인증 헤더(API 키)를 보내지 않습니다.
      if (new URL(next).origin !== new URL(current).origin) sendHeaders = {};
      current = next;
      continue;
    }
    if (!res.ok) throw new VendorError(`결과 파일을 내려받지 못했어요(${res.status}).`);
    return readLimited(res, MAX_DOWNLOAD);
  }
  throw new VendorError('결과 주소가 너무 여러 번 바뀌었어요.', { retryable: false });
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
