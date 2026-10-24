import { Schema, model, type InferSchemaType } from 'mongoose';
import { LineItemSchema } from './lineItem.schema';
import { tenantModel } from './plugins';

export const SALE_PAYMENT_MODES = ['cash', 'upi', 'udhaar', 'partial'] as const;
export type SalePaymentMode = (typeof SALE_PAYMENT_MODES)[number];

const saleSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    billNumber: { type: Number, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, default: '' },
    items: { type: [LineItemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    paymentMode: { type: String, enum: SALE_PAYMENT_MODES, required: true },
    paidAmount: { type: Number, default: 0, min: 0 },
    creditAmount: { type: Number, default: 0, min: 0 },
    date: { type: Date, required: true, default: () => new Date() },
    note: { type: String, trim: true, default: '' },
    source: { type: String, enum: ['manual', 'voice'], default: 'manual' },
  },
  { timestamps: true },
);

saleSchema.index({ shopId: 1, date: -1 });
saleSchema.index({ shopId: 1, billNumber: 1 }, { unique: true });
saleSchema.index({ shopId: 1, customerId: 1, date: -1 });

tenantModel(saleSchema);

export type SaleAttrs = InferSchemaType<typeof saleSchema>;
export const Sale = model('Sale', saleSchema);
