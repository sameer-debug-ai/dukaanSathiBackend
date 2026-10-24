import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

const supplierSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    aliases: { type: [String], default: [] },
    phone: { type: String, trim: true, default: '' },
    company: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    gstNumber: { type: String, trim: true, uppercase: true, default: '' },
    /** Cached, in paise. Positive = shop owes the supplier. */
    currentPayable: { type: Number, default: 0 },
    lastTransactionAt: { type: Date },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

supplierSchema.index({ shopId: 1, name: 1 });
supplierSchema.index({ shopId: 1, phone: 1 });

tenantModel(supplierSchema);

export type SupplierAttrs = InferSchemaType<typeof supplierSchema>;
export type SupplierDoc = HydratedDocument<SupplierAttrs>;
export const Supplier = model('Supplier', supplierSchema);
