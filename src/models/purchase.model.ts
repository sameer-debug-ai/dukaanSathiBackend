import { Schema, model, type InferSchemaType } from 'mongoose';
import { LineItemSchema } from './lineItem.schema';
import { tenantModel } from './plugins';

const purchaseSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    items: { type: [LineItemSchema], required: true },
    totalAmount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    dueAmount: { type: Number, default: 0, min: 0 },
    invoiceNumber: { type: String, trim: true, default: '' },
    date: { type: Date, required: true, default: () => new Date() },
    note: { type: String, trim: true, default: '' },
    source: { type: String, enum: ['manual', 'voice'], default: 'manual' },
  },
  { timestamps: true },
);

purchaseSchema.index({ shopId: 1, date: -1 });
purchaseSchema.index({ shopId: 1, supplierId: 1, date: -1 });

tenantModel(purchaseSchema);

export type PurchaseAttrs = InferSchemaType<typeof purchaseSchema>;
export const Purchase = model('Purchase', purchaseSchema);
