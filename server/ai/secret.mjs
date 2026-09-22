import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// AI API 키는 DB에 평문으로 두지 않습니다. AES-256-GCM으로 암호화하고,
// 운영에서는 AI_SECRET_KEY 환경변수를, 개발에서는 데이터 폴더의 키 파일을 씁니다.
let cached = null;
function masterKey() {
  if (cached) return cached;
  const env = process.env.AI_SECRET_KEY;
  if (env) {
    cached = createHash('sha256').update(env).digest();
    return cached;
  }
  const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
  if (production)
    throw Object.assign(new Error('운영 환경에서는 AI_SECRET_KEY 환경변수를 설정해야 API 키를 저장할 수 있어요.'), {
      status: 503,
    });
  const dir = process.env.DATA_DIR || path.resolve('data');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.ai-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  cached = createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest();
  return cached;
}
export function encrypt(text) {
  if (!text) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}
export function decrypt(value) {
  if (!value) return '';
  const [v, iv, tag, body] = String(value).split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
// 화면에는 끝 4자리만 보여 줍니다.
export const hintOf = (key) => (key ? '••••' + String(key).trim().slice(-4) : '');
