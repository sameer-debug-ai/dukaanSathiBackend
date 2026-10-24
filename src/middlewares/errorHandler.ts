import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { AppError } from '../utils/AppError';
import { fail } from '../utils/apiResponse';

export function notFoundHandler(req: Request, res: Response): void {
  fail(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    fail(res, err.statusCode, err.message, err.details);
    return;
  }

  if (err instanceof ZodError) {
    const fields = err.flatten().fieldErrors;
    const first = err.errors[0];
    const message = first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input';
    fail(res, 400, message, { fields, issues: err.errors });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    fail(res, 400, err.message);
    return;
  }

  if (err instanceof mongoose.Error.CastError) {
    fail(res, 400, `Invalid ${err.path}`);
    return;
  }

  if (typeof err === 'object' && err && (err as { code?: number }).code === 11000) {
    const keys = Object.keys((err as { keyValue?: object }).keyValue ?? {});
    fail(res, 409, `Already exists: ${keys.join(', ') || 'duplicate value'}`);
    return;
  }

  if (typeof err === 'object' && err && (err as { type?: string }).type === 'entity.parse.failed') {
    fail(res, 400, 'Malformed JSON body');
    return;
  }

  logger.error('Unhandled error', err);
  fail(res, 500, 'Something went wrong. Please try again.');
}
