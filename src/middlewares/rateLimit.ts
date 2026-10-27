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

/** Public khata links (no login): per IP, enough for a customer refreshing their page. */
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json('Too many requests. Please wait a minute and try again.'),
});

/** Speech-to-text uploads (paid per minute of audio): limit per shop. */
export const sttLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.auth ? String(req.auth.shopId) : req.ip ?? 'anon'),
  message: json('Too many recordings. Please wait a minute and try again.'),
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

/** Bill photo scans (vision calls are the most expensive AI request): limit per shop. */
export const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.auth ? String(req.auth.shopId) : req.ip ?? 'anon'),
  message: json('Too many bill photos. Please wait a minute and try again.'),
});
