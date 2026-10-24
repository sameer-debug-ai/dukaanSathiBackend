import crypto from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessPayload {
  sub: string;
  shopId: string;
}

export interface RefreshPayload {
  sub: string;
  /** Random id so each refresh token is unique and can be rotated. */
  jti: string;
}

export function signAccessToken(userId: string, shopId: string): string {
  const payload: AccessPayload = { sub: userId, shopId };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES as SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded === 'string' || !decoded.sub || !('shopId' in decoded)) {
    throw new Error('Invalid token payload');
  }
  return { sub: String(decoded.sub), shopId: String(decoded.shopId) };
}

export function signRefreshToken(userId: string): string {
  const payload: RefreshPayload = { sub: userId, jti: crypto.randomUUID() };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: `${env.JWT_REFRESH_EXPIRES_DAYS}d` });
}

export function verifyRefreshToken(token: string): RefreshPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
  if (typeof decoded === 'string' || !decoded.sub) throw new Error('Invalid token payload');
  return { sub: String(decoded.sub), jti: String(decoded.jti) };
}

/** Refresh tokens are stored hashed so a DB leak can't be replayed. */
export const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export const refreshCookieMaxAgeMs = (): number => env.JWT_REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000;
