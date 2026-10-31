import { Schema } from 'mongoose';

/** A bill/purchase line. rate and total are paise; qty may be fractional (0.5 kg). */
export const LineItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    unit: { type: String, default: 'piece' },
    qty: { type: Number, required: true, min: 0.001 },
    rate: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    /** Purchase price at the time of sale, for profit reports. */
    costRate: { type: Number, default: 0 },
    /** GST bills only (no defaults, so other bills and purchases stay as they were). */
    hsnCode: { type: String },
    gstRate: { type: Number },
    priceIncludesGst: { type: Boolean },
    /** Share of the bill discount, taxable value and tax of this line, in paise. */
    discountShare: { type: Number },
    taxable: { type: Number },
    cgst: { type: Number },
    sgst: { type: Number },
    igst: { type: Number },
  },
  { _id: false },
);
