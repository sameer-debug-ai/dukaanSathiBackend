import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

/**
 * A scanned bill photo. Created when the photo is scanned; linked to the purchase once the
 * user saves it. Photos never linked are removed after a day.
 */
const billImageSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Storage key (local path under UPLOAD_DIR, or the S3 object key). */
    key: { type: String, required: true },
    storage: { type: String, enum: ['local', 's3'], required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', default: null },
    /** What the scan read (for support / re-review); money in paise. */
    scan: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

billImageSchema.index({ shopId: 1, purchaseId: 1 });
billImageSchema.index({ shopId: 1, createdAt: -1 });

tenantModel(billImageSchema);

export type BillImageAttrs = InferSchemaType<typeof billImageSchema>;
export const BillImage = model('BillImage', billImageSchema);
