import crypto from 'node:crypto';
import { COOKIE_NAME, config } from './config.js';

/**
 * Encrypted, stateless session cookie.
 *
 * The GitHub Personal Access Token never leaves the server: it lives inside an
 * AES-256-GCM encrypted httpOnly cookie, so a Render restart or a scale-out does
 * not log the user out and nothing sensitive is persisted on disk.
 */

const KEY = crypto.createHash('sha256').update(config.sessionSecret).digest();

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function encodeSession(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
}

export function decodeSession(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [ivPart, tagPart, dataPart] = value.split('.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const forwarded = req.get('x-forwarded-proto');
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https';
}

export function readSession(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  return decodeSession(raw);
}

export function writeSession(res, req, payload, { clear = false } = {}) {
  if (clear) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return;
  }
  res.cookie(COOKIE_NAME, encodeSession(payload), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000) * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}
