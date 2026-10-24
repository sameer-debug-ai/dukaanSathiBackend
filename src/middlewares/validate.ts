import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';

type Source = 'body' | 'query' | 'params';

/**
 * Validates and replaces req[source] with the parsed (coerced, stripped) value.
 * ZodErrors are turned into 400 responses by the error handler.
 */
export const validate =
  (schema: ZodTypeAny, source: Source = 'body') =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(result.error);
    if (source === 'query') {
      // req.query is a getter in some Express setups; mutate in place.
      const q = req.query as Record<string, unknown>;
      Object.keys(q).forEach((k) => delete q[k]);
      Object.assign(q, result.data);
    } else {
      req[source] = result.data;
    }
    next();
  };
