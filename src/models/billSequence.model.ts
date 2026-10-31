import { Schema, model } from 'mongoose';
import { tenantModel } from './plugins';

/** Invoice counter per shop per financial year ("2026-27"); bumped atomically with $inc. */
const billSequenceSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fy: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true },
);

billSequenceSchema.index({ shopId: 1, fy: 1 }, { unique: true });

tenantModel(billSequenceSchema);

export const BillSequence = model('BillSequence', billSequenceSchema);
