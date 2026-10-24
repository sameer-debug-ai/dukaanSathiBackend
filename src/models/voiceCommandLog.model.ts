import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

export const VOICE_STATUSES = ['pending', 'confirmed', 'cancelled', 'failed'] as const;

const voiceCommandLogSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rawText: { type: String, required: true },
    intent: { type: String, default: 'unknown' },
    parsedJson: { type: Schema.Types.Mixed },
    status: { type: String, enum: VOICE_STATUSES, default: 'pending' },
    /** Which parser produced the result: the AI provider or the offline rule-based fallback. */
    engine: { type: String, default: 'ai' },
    resultMessage: { type: String, default: '' },
    error: { type: String },
  },
  { timestamps: true },
);

voiceCommandLogSchema.index({ shopId: 1, createdAt: -1 });

tenantModel(voiceCommandLogSchema);

export type VoiceCommandLogAttrs = InferSchemaType<typeof voiceCommandLogSchema>;
export const VoiceCommandLog = model('VoiceCommandLog', voiceCommandLogSchema);
