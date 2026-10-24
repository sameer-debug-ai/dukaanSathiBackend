import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

export const UNITS = ['kg', 'g', 'litre', 'ml', 'piece', 'packet', 'dozen', 'box'] as const;
export type Unit = (typeof UNITS)[number];

const productSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameHindi: { type: String, trim: true, default: '' },
    /** Extra names used for search and voice matching, e.g. "cheeni" for Sugar. */
    aliases: { type: [String], default: [] },
    category: { type: String, trim: true, default: 'General' },
    unit: { type: String, enum: UNITS, default: 'piece' },
    /** All prices are integer paise per unit. */
    purchasePrice: { type: Number, default: 0, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    mrp: { type: Number, default: 0, min: 0 },
    /** Only ever changed through stock.service (which writes a StockMovement). */
    currentStock: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    barcode: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

productSchema.index({ shopId: 1, name: 1 });
productSchema.index({ shopId: 1, category: 1 });
productSchema.index({ shopId: 1, barcode: 1 }, { sparse: true });
productSchema.index({ name: 'text', nameHindi: 'text', aliases: 'text' });

tenantModel(productSchema);

export type ProductAttrs = InferSchemaType<typeof productSchema>;
export type ProductDoc = HydratedDocument<ProductAttrs>;
export const Product = model('Product', productSchema);
