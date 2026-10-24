import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

export const PAYMENT_MODES = ['cash', 'upi', 'bank'] as const;

const supplierPaymentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    amount: { type: Number, required: true, min: 1 },
    mode: { type: String, enum: PAYMENT_MODES, default: 'cash' },
    date: { type: Date, required: true, default: () => new Date() },
    note: { type: String, trim: true, default: '' },
    source: { type: String, enum: ['manual', 'voice'], default: 'manual' },
  },
  { timestamps: true },
);

supplierPaymentSchema.index({ shopId: 1, supplierId: 1, date: -1 });
supplierPaymentSchema.index({ shopId: 1, date: -1 });

tenantModel(supplierPaymentSchema);

export type SupplierPaymentAttrs = InferSchemaType<typeof supplierPaymentSchema>;
export const SupplierPayment = model('SupplierPayment', supplierPaymentSchema);
