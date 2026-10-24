import { z } from 'zod';
import { UNITS } from '../models/product.model';
import { dateRangeQuery, listQuery, objectId, paise, stringList, trimmed } from './common';

const productBase = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(120),
  nameHindi: trimmed(120).default(''),
  aliases: stringList,
  category: trimmed(60).default('General'),
  unit: z.enum(UNITS).default('piece'),
  purchasePrice: paise.default(0),
  sellingPrice: paise,
  mrp: paise.default(0),
  lowStockThreshold: z.coerce.number().min(0).max(1_000_000).optional(),
  barcode: trimmed(60).optional(),
  imageUrl: z.string().trim().url().optional().or(z.literal('')),
  supplierId: objectId.optional().or(z.literal('').transform(() => undefined)),
  isActive: z.boolean().default(true),
});

export const createProductSchema = productBase.extend({
  /** Opening stock is recorded as an 'adjustment' StockMovement. */
  openingStock: z.coerce.number().min(0).default(0),
});

/** Stock is intentionally not editable here: use /stock/adjust. */
export const updateProductSchema = productBase.partial();

export const productListQuery = listQuery.extend({
  category: z.string().trim().max(60).optional(),
  stock: z.enum(['all', 'in', 'low', 'out', 'alerts']).optional(),
});

export const importProductsSchema = z.object({
  rows: z
    .array(
      createProductSchema.extend({
        sellingPrice: paise.default(0),
      }),
    )
    .min(1, 'No rows to import')
    .max(2000, 'Import at most 2000 rows at a time'),
  /** When true, rows matching an existing product name update its prices instead of creating a duplicate. */
  updateExisting: z.boolean().default(true),
});

export const adjustStockSchema = z.object({
  productId: objectId,
  /** Signed change in units: +5 adds, -2 removes. */
  quantity: z.coerce.number().refine((v) => v !== 0, 'Quantity cannot be 0'),
  type: z.enum(['adjustment', 'damage', 'return', 'purchase']).default('adjustment'),
  note: trimmed(300).default(''),
});

export const stockHistoryQuery = listQuery.merge(dateRangeQuery);

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductListQuery = z.infer<typeof productListQuery>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type ImportProductsInput = z.infer<typeof importProductsSchema>;
