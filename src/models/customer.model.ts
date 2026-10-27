import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

const customerSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    /** Nicknames like "Sharma ji" used for search and voice matching. */
    aliases: { type: [String], default: [] },
    phone: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    creditLimit: { type: Number, min: 0 },
    /** Cached from the ledger, in paise. Positive = customer owes the shop. */
    currentBalance: { type: Number, default: 0 },
    lastTransactionAt: { type: Date },
    /** Udhaar reminders: every N days (0 = off) and/or on a promised due date. */
    reminderEveryDays: { type: Number, enum: [0, 7, 15, 30], default: 0 },
    dueDate: { type: Date },
    /** When a payment reminder was last sent (WhatsApp from the app). */
    lastReminderAt: { type: Date },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

customerSchema.index({ shopId: 1, name: 1 });
customerSchema.index({ shopId: 1, phone: 1 });
customerSchema.index({ shopId: 1, currentBalance: -1 });
customerSchema.index({ name: 'text', aliases: 'text' });

tenantModel(customerSchema);

export type CustomerAttrs = InferSchemaType<typeof customerSchema>;
export type CustomerDoc = HydratedDocument<CustomerAttrs>;
export const Customer = model('Customer', customerSchema);
