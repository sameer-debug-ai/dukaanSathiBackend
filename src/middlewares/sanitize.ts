import type { NextFunction, Request, Response } from 'express';

/**
 * Strips keys that start with "$" or contain "." from user input to prevent
 * MongoDB operator injection (e.g. { phone: { $gt: "" } }).
 */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

export function sanitizeInput(req: Request, _res: Response, next: NextFunction): void {
  if (req.body) req.body = clean(req.body);
  if (req.params) req.params = clean(req.params) as Request['params'];
  if (req.query) {
    const cleaned = clean(req.query) as Record<string, unknown>;
    const q = req.query as Record<string, unknown>;
    Object.keys(q).forEach((k) => delete q[k]);
    Object.assign(q, cleaned);
  }
  next();
}
