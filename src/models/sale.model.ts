import { Schema, model, type InferSchemaType } from 'mongoose';
import { LineItemSchema } from './lineItem.schema';
import { tenantModel } from './plugins';

export const SALE_PAYMENT_MODES = ['cash', 'upi', 'udhaar', 'partial'] as const;
export type SalePaymentMode = (typeof SALE_PAYMENT_MODES)[number];

/** bill = not GST registered, tax_invoice = GST, bill_of_supply = composition scheme. */
export const DOC_TYPES = ['bill', 'tax_invoice', 'bill_of_supply'] as const;
export type DocType = (typeof DOC_TYPES)[number];

const TaxRowSchema = new Schema(
  {
    rate: { type: Number, required: true },
    taxable: { type: Number, required: true },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
  },
  { _id: false },
);

/** Seller / buyer details as they were when the bill was made (a bill never changes later). */
const PartySchema = new Schema(
  {
    name: { type: String, default: '' },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    gstin: { type: String, default: '' },
    stateCode: { type: String, default: '' },
  },
  { _id: false },
);

const saleSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    billNumber: { type: Number, required: true },
    /** Printed number, unique per shop: KGS/2026-27/0001 (older bills have none and show #billNumber). */
    invoiceNo: { type: String },
    fy: { type: String },
    docType: { type: String, enum: DOC_TYPES },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, default: '' },
    items: { type: [LineItemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    /** GST bills: totals in paise (see billCalc). */
    taxableTotal: { type: Number },
    cgst: { type: Number },
    sgst: { type: Number },
    igst: { type: Number },
    taxTotal: { type: Number },
    taxAdded: { type: Number },
    roundOff: { type: Number },
    taxSummary: { type: [TaxRowSchema], default: undefined },
    interState: { type: Boolean },
    seller: { type: PartySchema },
    buyer: { type: PartySchema },
    paymentMode: { type: String, enum: SALE_PAYMENT_MODES, required: true },
    paidAmount: { type: Number, default: 0, min: 0 },
    creditAmount: { type: Number, default: 0, min: 0 },
    date: { type: Date, required: true, default: () => new Date() },
    note: { type: String, trim: true, default: '' },
    source: { type: String, enum: ['manual', 'voice'], default: 'manual' },
    /** Cancelled bills keep their number; stock and udhaar are reversed. */
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    cancelledAt: { type: Date },
    cancelReason: { type: String, trim: true },
  },
  { timestamps: true },
);

saleSchema.index({ shopId: 1, date: -1 });
saleSchema.index({ shopId: 1, billNumber: 1 }, { unique: true });
saleSchema.index({ shopId: 1, invoiceNo: 1 }, { unique: true, partialFilterExpression: { invoiceNo: { $type: 'string' } } });
saleSchema.index({ shopId: 1, customerId: 1, date: -1 });

tenantModel(saleSchema);

export type SaleAttrs = InferSchemaType<typeof saleSchema>;
export const Sale = model('Sale', saleSchema);

/** Add to every sales total query: cancelled bills are history, not sales. */
export const NOT_CANCELLED = { status: { $ne: 'cancelled' } } as const;
