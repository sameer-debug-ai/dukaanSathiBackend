import { Types } from 'mongoose';
import { z } from 'zod';

export const objectId = z
  .string()
  .trim()
  .refine((v) => Types.ObjectId.isValid(v), 'Invalid id');

export const idParams = z.object({ id: objectId });

/** Money in integer paise. */
export const paise = z.coerce.number().int('Amount must be in paise (whole number)').min(0);
export const positivePaise = paise.refine((v) => v > 0, 'Amount must be greater than 0');

/** Quantities may be fractional (0.5 kg), rounded to 3 decimals. */
export const qty = z.coerce
  .number()
  .positive('Quantity must be greater than 0')
  .transform((v) => Math.round(v * 1000) / 1000);

export const optionalDate = z.coerce.date().optional();

export const trimmed = (max = 200) => z.string().trim().max(max);

export const stringList = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')))
  .transform((arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))])
  .default([]);

/** Shared list query: pagination + free text search + sort. */
export const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.string().trim().max(40).optional(),
});

export const dateRangeQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
});

export const indianPhoneOptional = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((v) => v === '' || /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number')
  .default('');
