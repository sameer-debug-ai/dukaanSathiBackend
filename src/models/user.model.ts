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
