import type { ClientSession, Types } from 'mongoose';
import { VoiceCommandLog, type VoiceEffectKind } from '../models/voiceCommandLog.model';

export interface VoiceEffect {
  kind: VoiceEffectKind;
  id?: Types.ObjectId | string;
  productId?: Types.ObjectId | string;
  quantity?: number;
  prevPrices?: { productId: Types.ObjectId | string; purchasePrice: number }[];
}

/**
 * Notes what a voice command created on its log, in the same transaction as the write,
 * so "Undo" can reverse exactly that. A no-op for entries made from forms (no log id).
 */
export async function recordVoiceEffect(
  shopId: Types.ObjectId,
  voiceLogId: string | undefined,
  effects: VoiceEffect[],
  session?: ClientSession,
): Promise<void> {
  if (!voiceLogId || !effects.length) return;
  await VoiceCommandLog.updateOne(
    { _id: voiceLogId, shopId, status: { $ne: 'undone' } },
    { $push: { effects: { $each: effects } }, $set: { status: 'confirmed', executedAt: new Date() } },
    { session },
  );
}
