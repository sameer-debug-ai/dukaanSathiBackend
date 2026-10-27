import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { applyJsonTransform } from './plugins';

/**
 * A User is a shop owner. One user == one shop, so the user's _id is the shopId
 * stamped on every other document.
 */
const shopSettingsSchema = new Schema(
  {
    lowStockDefault: { type: Number, default: 5, min: 0 },
    allowOversell: { type: Boolean, default: false },
    darkMode: { type: Boolean, default: false },
    /** "Hamesha save se pehle poochho": always show the confirmation card (no voice auto-save). */
    voiceAlwaysConfirm: { type: Boolean, default: true },
    /** Auto-save a voice command only at or above this confidence (0-1). */
    voiceAutoSaveThreshold: { type: Number, default: 0.85, min: 0.5, max: 1 },
    /** How long a saved voice entry can be undone. */
    voiceUndoSeconds: { type: Number, default: 60, min: 10, max: 600 },
    /** Shop's UPI ID (VPA), for "Pay via UPI" links and QR codes in reminders / statements. */
    upiId: { type: String, trim: true, default: '' },
    /** Name shown in the customer's UPI app (defaults to the shop name). */
    upiPayeeName: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, unique: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    shopName: { type: String, required: true, trim: true, maxlength: 120 },
    shopAddress: { type: String, trim: true, default: '' },
    gstNumber: { type: String, trim: true, uppercase: true },
    preferredLanguage: { type: String, enum: ['hi', 'en'], default: 'en' },
    settings: { type: shopSettingsSchema, default: () => ({}) },
    refreshTokenHash: { type: String, select: false },
    billCounter: { type: Number, default: 0 },
  },
  { timestamps: true },
);

applyJsonTransform(userSchema);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = model('User', userSchema);
