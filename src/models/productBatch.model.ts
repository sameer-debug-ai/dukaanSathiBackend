import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

/**
 * A lot of one product with its own expiry date, for products with "Expiry track karo" on.
 * Kept in step with the product's stock by stock.service (applyStockChange); sales take from the
 * batch that expires first (FEFO). Empty batches are deleted.
 */
const productBatchSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    /** Units left in this batch. */
    qty: { type: Number, required: true, min: 0 },
    /** Units it started with. */
    initialQty: { type: Number, required: true, min: 0 },
    /** null = no expiry known (opening stock, undo of a sale); used last. */
    expiryDate: { type: Date, default: null },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase' },
    note: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

productBatchSchema.index({ shopId: 1, productId: 1, expiryDate: 1 });
productBatchSchema.index({ shopId: 1, expiryDate: 1 });

tenantModel(productBatchSchema);

export type ProductBatchAttrs = InferSchemaType<typeof productBatchSchema>;
export const ProductBatch = model('ProductBatch', productBatchSchema);
