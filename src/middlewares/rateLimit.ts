import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

const json = (message: string) => ({ success: false, data: null, message });

/** General API limit per IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json('Too many requests, please slow down'),
});

/** Login/register brute-force protection. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json('Too many login attempts. Please try again in a few minutes.'),
});

/** AI parsing is the costly endpoint: limit per shop, not per IP. */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.auth ? String(req.auth.shopId) : req.ip ?? 'anon'),
  message: json('Too many voice commands. Please wait a minute and try again.'),
});
