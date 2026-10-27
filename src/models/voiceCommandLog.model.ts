import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

export const VOICE_STATUSES = ['pending', 'confirmed', 'cancelled', 'failed', 'undone'] as const;

/** What a saved voice command created, so it can be undone exactly. */
export const VOICE_EFFECT_KINDS = ['ledger', 'sale', 'purchase', 'supplierPayment', 'stock', 'product', 'customer'] as const;
export type VoiceEffectKind = (typeof VOICE_EFFECT_KINDS)[number];

const voiceEffectSchema = new Schema(
  {
    kind: { type: String, enum: VOICE_EFFECT_KINDS, required: true },
    /** The created document (ledger entry, sale, purchase, payment, product, customer). */
    id: { type: Schema.Types.ObjectId },
    /** For 'stock': the product and the signed quantity that was applied. */
    productId: { type: Schema.Types.ObjectId },
    quantity: { type: Number },
    /** For 'purchase': purchase prices before the purchase overwrote them. */
    prevPrices: { type: [{ productId: Schema.Types.ObjectId, purchasePrice: Number, _id: false }], default: undefined },
  },
  { _id: false },
);

const voiceCommandLogSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rawText: { type: String, required: true },
    intent: { type: String, default: 'unknown' },
    parsedJson: { type: Schema.Types.Mixed },
    status: { type: String, enum: VOICE_STATUSES, default: 'pending' },
    /** Which parser produced the result: the AI provider or the offline rule-based fallback. */
    engine: { type: String, default: 'ai' },
    /** rule = local fast parser (no AI call), ai = the AI, offline = offline parser (no AI key / AI failed). */
    parsePath: { type: String, enum: ['rule', 'ai', 'offline'] },
    resultMessage: { type: String, default: '' },
    error: { type: String },
    effects: { type: [voiceEffectSchema], default: [] },
    /** When the command was saved; the undo window counts from here. */
    executedAt: { type: Date },
    undoneAt: { type: Date },
  },
  { timestamps: true },
);

voiceCommandLogSchema.index({ shopId: 1, createdAt: -1 });
voiceCommandLogSchema.index({ shopId: 1, executedAt: -1 });

tenantModel(voiceCommandLogSchema);

export type VoiceCommandLogAttrs = InferSchemaType<typeof voiceCommandLogSchema>;
export const VoiceCommandLog = model('VoiceCommandLog', voiceCommandLogSchema);
