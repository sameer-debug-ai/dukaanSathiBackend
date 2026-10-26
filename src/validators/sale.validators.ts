import { z } from 'zod';
import { SALE_PAYMENT_MODES } from '../models/sale.model';
import { dateRangeQuery, listQuery, objectId, optionalDate, paise, qty, trimmed } from './common';

export const createSaleSchema = z.object({
  customerId: objectId.optional().or(z.literal('').transform(() => undefined)),
  items: z
    .array(
      z.object({
        productId: objectId,
        qty,
        /** Optional price override; defaults to the product's selling price. */
        rate: paise.optional(),
      }),
    )
    .min(1, 'Add at least one item'),
  discount: paise.default(0),
  paymentMode: z.enum(SALE_PAYMENT_MODES),
  /** Required for 'partial'; ignored for cash/upi (full) and udhaar (zero). */
  paidAmount: paise.optional(),
  date: optionalDate,
  note: trimmed(300).default(''),
  /** Sell even if stock would go negative (only when the shop setting allows it). */
  allowOversell: z.boolean().default(false),
  source: z.enum(['manual', 'voice']).default('manual'),
  /** Set when the voice assistant saves this; lets the entry be undone. */
  voiceLogId: objectId.optional(),
});

export const saleListQuery = listQuery.merge(dateRangeQuery).extend({
  customerId: objectId.optional(),
  paymentMode: z.enum(SALE_PAYMENT_MODES).optional(),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type SaleListQuery = z.infer<typeof saleListQuery>;
