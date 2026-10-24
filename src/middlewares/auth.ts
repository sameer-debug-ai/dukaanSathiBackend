import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { verifyAccessToken } from '../services/token.service';
import { AppError } from '../utils/AppError';

export interface AuthContext {
  userId: string;
  /** Every query must be scoped by this. For now shopId === userId (one owner per shop). */
  shopId: Types.ObjectId;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Verifies the Bearer access token and attaches the tenant context. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(AppError.unauthorized());

  try {
    const payload = verifyAccessToken(header.slice(7));
    req.auth = { userId: payload.sub, shopId: new Types.ObjectId(payload.shopId) };
    next();
  } catch {
    next(AppError.unauthorized('Session expired, please login again'));
  }
}

/** Shop id of the logged-in user. Use in every service call so tenants stay isolated. */
export function shopIdOf(req: Request): Types.ObjectId {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth.shopId;
}
