import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { CookieSecureMode } from './config';

export const MEMBER_COOKIE_NAME = 'yj_member';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length: number): string {
  let out = '';
  // 248 = 62 * 4: reject >= 248 to eliminate modulo bias
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      const b = bytes[i];
      if (b < 248) {
        out += BASE62[b % 62];
      }
    }
  }
  return out;
}

export function ownerCookieName(roomId: string): string {
  return `yj_owner_${roomId}`;
}

export function isValidRoomId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id);
}

export function isValidToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length >= 24 &&
    token.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}

export function generateRoomId(): string {
  return `r-${randomBase62(12)}`;
}

export function generateMemberId(): string {
  return `m_${randomBase62(10)}`;
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string, pepper: string): string {
  return crypto.createHash('sha256').update(`${token}${pepper}`).digest('hex');
}

export function hashPayload(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function timingSafeHashEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function resolveCookieSecure(request: FastifyRequest, mode: CookieSecureMode): boolean {
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return request.protocol === 'https';
}

export function verifySameOrigin(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): boolean {
  const rawOrigin =
    typeof request.headers.origin === 'string' ? request.headers.origin.trim() : '';
  const rawReferer =
    typeof request.headers.referer === 'string' ? request.headers.referer.trim() : '';

  let candidate: string;
  if (rawOrigin) {
    if (rawOrigin === 'null') return false;
    try {
      candidate = new URL(rawOrigin).origin;
    } catch {
      return false;
    }
  } else if (rawReferer) {
    try {
      candidate = new URL(rawReferer).origin;
    } catch {
      return false;
    }
  } else {
    return false;
  }

  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(candidate);
  }

  const host = typeof request.headers.host === 'string' ? request.headers.host.trim() : '';
  if (!host) return false;

  try {
    const expected = new URL(`${request.protocol}://${host}`).origin;
    return candidate === expected;
  } catch {
    return false;
  }
}
