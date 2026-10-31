import { z } from 'zod';
import { PAPER_SIZES } from '../models/user.model';
import { indianPhoneOptional, stateCodeOptional, trimmed } from './common';
import { isValidGstin } from '../utils/gst';

/** Logo as a small data URL; the app compresses it before upload. */
const logo = z
  .string()
  .max(200_000, 'Logo is too large - use a smaller image')
  .refine((v) => v === '' || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v), 'Logo must be a PNG, JPG or WebP image');

export const updateBillingSchema = z
  .object({
    shopName: trimmed(120),
    address: trimmed(300),
    phone: indianPhoneOptional,
    logo,
    footerNote: trimmed(160),
    paperSize: z.enum(PAPER_SIZES),
    showUpiQr: z.boolean(),
    // Letters/digits/"-" only and short, so the full number stays within GST's 16 characters.
    invoicePrefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{0,4}$/, 'Prefix: up to 4 letters or digits, e.g. KGS'),
    gstEnabled: z.boolean(),
    gstin: z.string().trim().toUpperCase().max(15),
    stateCode: stateCodeOptional,
    composition: z.boolean(),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.gstin && !isValidGstin(v.gstin)) {
      ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'Enter a valid 15-character GSTIN, e.g. 27ABCDE1234F1Z5' });
    }
  });

export const cancelSaleSchema = z.object({
  reason: z.string().trim().min(3, 'Write a short reason').max(200),
});

export type UpdateBillingInput = z.infer<typeof updateBillingSchema>;
export type CancelSaleInput = z.infer<typeof cancelSaleSchema>;
