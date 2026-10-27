import type { Types } from 'mongoose';
import { logger } from '../config/logger';
import { Customer } from '../models/customer.model';
import { DailyReminder } from '../models/dailyReminder.model';
import { User } from '../models/user.model';
import { AppError } from '../utils/AppError';
import { addDays, istDayKey, startOfIstDay } from '../utils/istDate';
import { shopUpiLink } from '../utils/upi';
import { openCreditsFor } from './creditScore.service';

export type ReminderReason = 'due_date' | 'every';

export interface ReminderCandidate {
  currentBalance: number;
  reminderEveryDays?: number | null;
  dueDate?: Date | null;
  lastReminderAt?: Date | null;
  /** When the oldest unpaid udhaar was given (FIFO); the "every N days" clock starts here. */
  oldestDueAt?: Date | null;
}

/**
 * Is a reminder due today (IST)? Never for someone who owes nothing or was reminded today.
 * - due date: on/after the promised day, unless already reminded on/after that day;
 * - every N days: N days after the last reminder (or after the oldest unpaid udhaar).
 */
export function reminderDue(c: ReminderCandidate, now = new Date()): ReminderReason | null {
  if (c.currentBalance <= 0) return null;
  const today = startOfIstDay(now);
  const last = c.lastReminderAt ? new Date(c.lastReminderAt) : null;
  if (last && last >= today) return null;
  if (c.dueDate) {
    const due = startOfIstDay(new Date(c.dueDate));
    if (due <= today && (!last || last < due)) return 'due_date';
  }
  const every = c.reminderEveryDays ?? 0;
  if (every > 0) {
    const base = last ?? (c.oldestDueAt ? new Date(c.oldestDueAt) : null);
    if (!base || addDays(startOfIstDay(base), every) <= today) return 'every';
  }
  return null;
}

/** Works out today's list for one shop. */
export async function computeReminders(shopId: Types.ObjectId, now = new Date()): Promise<{ customerId: Types.ObjectId; reason: ReminderReason }[]> {
  const customers = await Customer.find({
    shopId,
    isDeleted: false,
    currentBalance: { $gt: 0 },
    $or: [{ reminderEveryDays: { $gt: 0 } }, { dueDate: { $ne: null } }],
  }).select('currentBalance reminderEveryDays dueDate lastReminderAt');
  const open = await openCreditsFor(
    shopId,
    customers.filter((c) => (c.reminderEveryDays ?? 0) > 0 && !c.lastReminderAt).map((c) => c._id),
  );
  const out: { customerId: Types.ObjectId; reason: ReminderReason }[] = [];
  for (const c of customers) {
    const reason = reminderDue({ ...c.toObject(), oldestDueAt: open.get(String(c._id))?.open[0]?.date ?? null }, now);
    if (reason) out.push({ customerId: c._id, reason });
  }
  return out;
}

/** Builds and stores today's list (the daily job; also on demand if the job has not run yet). */
export async function buildDailyReminders(shopId: Types.ObjectId, now = new Date()) {
  const items = await computeReminders(shopId, now);
  return DailyReminder.findOneAndUpdate({ shopId, day: istDayKey(now) }, { $set: { items } }, { upsert: true, new: true });
}

export interface ReminderItem {
  customerId: string;
  name: string;
  phone: string;
  balance: number;
  reason: ReminderReason;
  dueDate: Date | null;
  lastReminderAt: Date | null;
  /** upi://pay link for the balance, when the shop has a UPI ID. */
  upiLink: string | null;
}

/**
 * "Aaj ke reminders" for the dashboard. Refreshed on every view (so a due date set today shows up
 * straight away); the 9 AM job builds the same list ahead of time. Anyone reminded today or paid
 * up drops off.
 */
export async function todayReminders(shopId: Types.ObjectId, now = new Date()) {
  const day = istDayKey(now);
  const today = startOfIstDay(now);
  const list = await buildDailyReminders(shopId, now);
  const ids = list.items.map((i) => i.customerId);
  const [customers, shop, sentToday] = await Promise.all([
    ids.length ? Customer.find({ shopId, _id: { $in: ids }, isDeleted: false }).select('name phone currentBalance dueDate lastReminderAt') : [],
    User.findById(shopId).select('shopName settings'),
    Customer.countDocuments({ shopId, isDeleted: false, lastReminderAt: { $gte: today } }),
  ]);
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  const items: ReminderItem[] = [];
  for (const i of list.items) {
    const c = byId.get(String(i.customerId));
    if (!c || c.currentBalance <= 0) continue;
    items.push({
      customerId: String(c._id),
      name: c.name,
      phone: c.phone,
      balance: c.currentBalance,
      reason: i.reason as ReminderReason,
      dueDate: c.dueDate ?? null,
      lastReminderAt: c.lastReminderAt ?? null,
      upiLink: shop ? shopUpiLink(shop.settings, shop.shopName, c.currentBalance, `Udhaar ${c.name}`) : null,
    });
  }
  items.sort((a, b) => b.balance - a.balance);
  return { day, items, sentToday };
}

/** The shopkeeper sent a reminder (WhatsApp from the app). */
export async function markReminderSent(shopId: Types.ObjectId, customerId: string, now = new Date()) {
  const doc = await Customer.findOneAndUpdate({ _id: customerId, shopId, isDeleted: false }, { $set: { lastReminderAt: now } }, { new: true });
  if (!doc) throw AppError.notFound('Customer not found');
  return doc.toJSON();
}

/** Runs the daily build for every shop that uses reminders. */
export async function runDailyReminderJob(now = new Date()): Promise<number> {
  const shops = await User.find().select('_id');
  let built = 0;
  for (const s of shops) {
    try {
      await buildDailyReminders(s._id, now);
      built++;
    } catch (err) {
      logger.warn(`Reminder job failed for shop ${String(s._id)}`, err instanceof Error ? err.message : err);
    }
  }
  return built;
}
