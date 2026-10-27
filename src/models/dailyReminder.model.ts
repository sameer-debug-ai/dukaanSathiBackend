import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

/** "Aaj ke reminders": the customers due for a payment reminder on one IST day, built by the daily job. */
const dailyReminderSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** IST day, "YYYY-MM-DD". */
    day: { type: String, required: true },
    items: {
      type: [
        {
          customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
          reason: { type: String, enum: ['due_date', 'every'], required: true },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

dailyReminderSchema.index({ shopId: 1, day: 1 }, { unique: true });

tenantModel(dailyReminderSchema);

export type DailyReminderAttrs = InferSchemaType<typeof dailyReminderSchema>;
export const DailyReminder = model('DailyReminder', dailyReminderSchema);
