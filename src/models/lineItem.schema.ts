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
  },
  { _id: false },
);
