import { z } from 'zod';
import { UNITS } from '../models/product.model';
import {
  dateRangeQuery,
  indianPhoneOptional,
  listQuery,
  objectId,
  optionalDate,
  paise,
  positivePaise,
  qty,
  stringList,
  trimmed,
} from './common';

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(120),
  aliases: stringList,
  phone: indianPhoneOptional,
  company: trimmed(120).default(''),
  address: trimmed(300).default(''),
  gstNumber: trimmed(20).default(''),
});

export const updateSupplierSchema = createSupplierSchema.partial();

export const supplierListQuery = listQuery;

/** A purchase line either references an existing product or creates one inline. */
const purchaseItem = z
  .object({
    productId: objectId.optional(),
    newProduct: z
      .object({
        name: z.string().trim().min(1).max(120),
        unit: z.enum(UNITS).default('piece'),
        category: trimmed(60).default('General'),
        sellingPrice: paise.default(0),
      })
      .optional(),
    qty,
    rate: paise,
  })
  .refine((i) => i.productId || i.newProduct, 'Select a product or create a new one');

export const createPurchaseSchema = z.object({
  supplierId: objectId,
  items: z.array(purchaseItem).min(1, 'Add at least one item'),
  paidAmount: paise.default(0),
  paymentMode: z.enum(['cash', 'upi', 'bank']).default('cash'),
  invoiceNumber: trimmed(60).default(''),
  date: optionalDate,
  note: trimmed(300).default(''),
  /** Also update each product's purchase price to this rate. */
  updatePurchasePrice: z.boolean().default(true),
  source: z.enum(['manual', 'voice']).default('manual'),
});

export const purchaseListQuery = listQuery.merge(dateRangeQuery).extend({ supplierId: objectId.optional() });

export const createSupplierPaymentSchema = z.object({
  supplierId: objectId,
  amount: positivePaise,
  mode: z.enum(['cash', 'upi', 'bank']).default('cash'),
  date: optionalDate,
  note: trimmed(300).default(''),
  source: z.enum(['manual', 'voice']).default('manual'),
});

export const supplierPaymentListQuery = listQuery.merge(dateRangeQuery).extend({ supplierId: objectId.optional() });

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;
export type CreateSupplierPaymentInput = z.infer<typeof createSupplierPaymentSchema>;
