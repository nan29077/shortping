import { createHmac, randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './ai/secret.mjs';

// 이메일 · 문자 발송 창구. 기능 코드(비밀번호 재설정·휴대폰 인증 등)는 sendEmail / sendSms만 부르고,
// 실제로 어느 업체로 보낼지는 최고 관리자가 '이메일 · 문자 발송' 화면에서 고릅니다.
//  - none    : 발송하지 않음(발송이 필요한 기능은 503 안내)
//  - log     : 개발·테스트용. 실제로 보내지 않고 발송 기록(message_outbox)에 내용까지 남깁니다.
//  - webhook : 관리자가 정한 주소로 JSON을 POST합니다. SendGrid·NHN Cloud·알리고·솔라피 등은 작은 중계 서버로 연결해요.
// 업체를 직접 붙일 때는 아래 providers에 { label, channels, send } 한 덩어리만 더하면 됩니다(registerProvider).
// 모든 발송 시도는 결과(성공·실패·꺼짐)와 가린 수신자로 message_outbox에 남습니다.

const CONFIG_KEY = 'messaging_config';
const production = () => process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const statusError = (status, message) => Object.assign(new Error(message), { status });

export const providers = {
  none: {
    label: '사용 안 함',
    channels: ['email', 'sms'],
    async send() {
      return { skipped: true };
    },
  },
  log: {
    label: '기록만 남기기 (개발 · 테스트)',
    channels: ['email', 'sms'],
    // 실제로 보내지 않고 발송 기록에 본문까지 남깁니다(테스트와 관리자 확인용).
    keepBody: true,
    async send() {
      return { stored: true };
    },
  },
  webhook: {
    label: '웹훅 (외부 발송 중계)',
    channels: ['email', 'sms'],
    async send(message, config) {
      if (!config.webhook_url) throw new Error('웹훅 주소가 설정되지 않았어요.');
      const body = JSON.stringify(message);
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'shortping-messaging/1' };
      if (config.secret) {
        // 중계 서버는 비밀값 머리글이나 본문 서명(HMAC-SHA256)으로 숏핑이 보낸 요청인지 확인할 수 있어요.
        headers['X-Shortping-Secret'] = config.secret;
        headers['X-Shortping-Signature'] = 'sha256=' + createHmac('sha256', config.secret).update(body).digest('hex');
      }
      const r = await fetch(config.webhook_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`웹훅 응답 ${r.status}`);
      return { status: r.status };
    },
  },
};
// 업체 어댑터를 코드로 더할 때 씁니다. 예) registerProvider('solapi', { label: '솔라피', channels: ['sms'], send })
export function registerProvider(id, adapter) {
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(id)) throw new Error('invalid provider id');
  providers[id] = adapter;
}

const defaultProvider = () => (production() ? 'none' : 'log');
const defaults = () => ({
  email_provider: defaultProvider(),
  sms_provider: defaultProvider(),
  webhook_url: '',
  secret_enc: '',
  sender_name: '숏핑',
  sender_email: '',
  sender_number: '',
});

export async function loadMessagingConfig(db) {
  const row = await db.get('SELECT value FROM platform_settings WHERE key=?', [CONFIG_KEY]);
  let saved = {};
  try {
    saved = row?.value ? JSON.parse(row.value) : {};
  } catch {
    saved = {};
  }
  return { ...defaults(), ...saved };
}
// 관리자 화면용: 비밀값은 절대 돌려주지 않고 설정 여부만 알려 줍니다.
export function publicMessagingConfig(config) {
  const { secret_enc, ...rest } = config;
  return { ...rest, secret_set: Boolean(secret_enc) };
}
export async function saveMessagingConfig(db, patch, actorId) {
  const current = await loadMessagingConfig(db);
  const next = { ...current };
  for (const key of ['email_provider', 'sms_provider', 'webhook_url', 'sender_name', 'sender_email', 'sender_number'])
    if (patch[key] !== undefined) next[key] = patch[key];
  for (const key of ['email_provider', 'sms_provider'])
    if (!providers[next[key]]) throw statusError(400, '알 수 없는 발송 방식이에요.');
  // secret: undefined면 그대로, ''면 지우기, 값이 있으면 암호화해 저장
  if (patch.secret !== undefined) next.secret_enc = patch.secret ? encrypt(patch.secret) : '';
  if (production() && next.webhook_url && !next.webhook_url.startsWith('https://'))
    throw statusError(400, '운영 환경에서는 https:// 로 시작하는 웹훅 주소만 쓸 수 있어요.');
  await db.run(
    'INSERT INTO platform_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
    [CONFIG_KEY, JSON.stringify(next), new Date().toISOString(), actorId || null],
  );
  return next;
}

// 기록에는 수신자를 가려서 남깁니다.
export function maskRecipient(to) {
  const v = String(to || '');
  if (v.includes('@')) {
    const [name, domain] = v.split('@');
    return (name.slice(0, 2) || '*') + '***@' + domain;
  }
  const digits = v.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}
export const disabledMessage = (channel) =>
  channel === 'sms'
    ? '관리자가 아직 문자 발송을 설정하지 않았어요. 잠시 후 다시 시도하거나 고객센터로 문의해 주세요.'
    : '관리자가 아직 이메일 발송을 설정하지 않았어요. 잠시 후 다시 시도하거나 고객센터로 문의해 주세요.';

// 발송 가능 여부(발송 전에 미리 확인해, 계정 존재 여부와 상관없이 같은 안내를 하기 위함)
export async function channelReady(db, channel) {
  const config = await loadMessagingConfig(db);
  const id = channel === 'sms' ? config.sms_provider : config.email_provider;
  return Boolean(id && id !== 'none' && providers[id]);
}

async function dispatch(db, channel, { to, subject = '', text = '', html = '', purpose = '', userId = null }) {
  const config = await loadMessagingConfig(db);
  const id = channel === 'sms' ? config.sms_provider : config.email_provider;
  const provider = providers[id] || providers.none;
  const outboxId = randomUUID();
  const record = (status, error = '') =>
    db
      .run(
        'INSERT INTO message_outbox (id,channel,provider,recipient,subject,body,purpose,user_id,status,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [
          outboxId,
          channel,
          id,
          // 기록만 남기는 방식(개발·테스트)은 받는 사람과 본문을 그대로 남겨 확인할 수 있게 합니다.
          provider.keepBody ? String(to) : maskRecipient(to),
          String(subject).slice(0, 200),
          provider.keepBody ? String(text).slice(0, 4000) : '',
          purpose,
          userId,
          status,
          String(error).slice(0, 500),
          new Date().toISOString(),
        ],
      )
      .catch((e) => console.error('[숏핑] 발송 기록 실패', e.message));
  if (id === 'none' || !provider.channels.includes(channel)) {
    await record('disabled', '발송 방식이 설정되지 않음');
    throw statusError(503, disabledMessage(channel));
  }
  let secret = '';
  try {
    secret = config.secret_enc ? decrypt(config.secret_enc) : '';
  } catch {
    secret = '';
  }
  const message = {
    id: outboxId,
    channel,
    purpose,
    to,
    subject,
    text,
    html,
    from:
      channel === 'sms'
        ? { name: config.sender_name, number: config.sender_number }
        : { name: config.sender_name, email: config.sender_email },
  };
  try {
    await provider.send(message, { ...config, secret });
  } catch (e) {
    await record('failed', e?.message || 'send failed');
    throw statusError(502, channel === 'sms' ? '문자를 보내지 못했어요. 잠시 후 다시 시도해 주세요.' : '이메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  await record('sent');
  return { id: outboxId, provider: id };
}
export const sendEmail = (db, message) => dispatch(db, 'email', message);
export const sendSms = (db, message) => dispatch(db, 'sms', { ...message, subject: '' });

export async function recentOutbox(db, limit = 50) {
  const rows = await db.all(
    'SELECT id,channel,provider,recipient,subject,body,purpose,status,error,created_at FROM message_outbox ORDER BY created_at DESC LIMIT ?',
    [limit],
  );
  // 재설정 링크·인증번호가 담긴 본문은 관리자 화면에도 보여 주지 않습니다(테스트 발송만 표시).
  return rows.map((r) => ({
    ...r,
    recipient: r.provider === 'log' ? maskRecipient(r.recipient) : r.recipient,
    body: r.purpose === 'test' ? r.body : '',
  }));
}
