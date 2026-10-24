import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env';
import * as authService from '../services/auth.service';
import { refreshCookieMaxAgeMs } from '../services/token.service';
import { ok, created } from '../utils/apiResponse';
import { AppError } from '../utils/AppError';

const REFRESH_COOKIE = 'ds_refresh';

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict',
  path: '/api/auth',
  maxAge: refreshCookieMaxAgeMs(),
});

function sendAuth(res: Response, result: authService.AuthResult, message: string, status = 200): Response {
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions());
  const body = { user: result.user.toJSON(), accessToken: result.accessToken };
  return status === 201 ? created(res, body, message) : ok(res, body, message);
}

const userIdOf = (req: Request): string => {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth.userId;
};

export async function register(req: Request, res: Response) {
  const result = await authService.register(req.body);
  return sendAuth(res, result, 'Dukaan registered successfully', 201);
}

export async function login(req: Request, res: Response) {
  const result = await authService.login(req.body);
  return sendAuth(res, result, 'Login successful');
}

export async function refresh(req: Request, res: Response) {
  const token = (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
  try {
    const result = await authService.refresh(token);
    return sendAuth(res, result, 'Token refreshed');
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await authService.logout(userIdOf(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  return ok(res, null, 'Logged out');
}

export async function changePassword(req: Request, res: Response) {
  await authService.changePassword(userIdOf(req), req.body);
  return ok(res, null, 'Password changed');
}

export async function me(req: Request, res: Response) {
  const user = await authService.getProfile(userIdOf(req));
  return ok(res, user.toJSON());
}

export async function updateMe(req: Request, res: Response) {
  const user = await authService.updateProfile(userIdOf(req), req.body);
  return ok(res, user.toJSON(), 'Profile updated');
}
