import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

export const LEDGER_TYPES = ['credit', 'payment'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export const LedgerItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    qty: { type: Number, required: true },
    rate: { type: Number, required: true },
  },
  { _id: false },
);

const customerLedgerSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    /** credit = goods given on udhaar (balance up), payment = money received (balance down). */
    type: { type: String, enum: LEDGER_TYPES, required: true },
    amount: { type: Number, required: true, min: 1 },
    items: { type: [LedgerItemSchema], default: [] },
    note: { type: String, trim: true, default: '' },
    source: { type: String, enum: ['manual', 'voice', 'sale'], default: 'manual' },
    rawVoiceText: { type: String },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    /** Set on the entry that takes back a cancelled bill's udhaar: not money received. */
    reversalOf: { type: Schema.Types.ObjectId, ref: 'Sale' },
    mode: { type: String, enum: ['cash', 'upi', 'bank', null], default: null },
    date: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

customerLedgerSchema.index({ shopId: 1, customerId: 1, date: 1 });
customerLedgerSchema.index({ shopId: 1, date: -1 });

tenantModel(customerLedgerSchema);

export type CustomerLedgerAttrs = InferSchemaType<typeof customerLedgerSchema>;
export const CustomerLedger = model('CustomerLedger', customerLedgerSchema);
