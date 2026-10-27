import { Schema, model, type InferSchemaType } from 'mongoose';
import { applyJsonTransform } from './plugins';

/**
 * A customer's read-only public khata link. Only the SHA-256 hash of the random token is stored,
 * so a database leak does not reveal working links.
 *
 * Not tenant-guarded on purpose: the public page has no login, so the link is found by its token
 * hash alone. Everything read after that is scoped by the link's own shopId + customerId.
 */
const khataLinkSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    tokenHash: { type: String, required: true },
    revokedAt: { type: Date },
    lastViewedAt: { type: Date },
    views: { type: Number, default: 0 },
  },
  { timestamps: true },
);

khataLinkSchema.index({ tokenHash: 1 }, { unique: true });
khataLinkSchema.index({ shopId: 1, customerId: 1, revokedAt: 1 });

applyJsonTransform(khataLinkSchema);

export type KhataLinkAttrs = InferSchemaType<typeof khataLinkSchema>;
export const KhataLink = model('KhataLink', khataLinkSchema);
