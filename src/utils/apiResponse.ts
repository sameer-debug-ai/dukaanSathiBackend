import type { Response } from 'express';

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

export interface ApiBody<T> {
  success: boolean;
  data: T | null;
  message: string;
  meta?: ApiMeta;
}

export function ok<T>(res: Response, data: T, message = 'OK', meta?: ApiMeta, status = 200): Response {
  const body: ApiBody<T> = { success: true, data, message };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function created<T>(res: Response, data: T, message = 'Created'): Response {
  return ok(res, data, message, undefined, 201);
}

export function fail(res: Response, status: number, message: string, details?: unknown): Response {
  const body: ApiBody<null> & { details?: unknown } = { success: false, data: null, message };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}
