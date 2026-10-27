import type { Types } from 'mongoose';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';

/**
 * Customer credit score from the udhaar ledger. Payments settle the oldest udhaar first (FIFO),
 * which tells how long each rupee of udhaar took to come back and how old the unpaid part is.
 * All money is paise.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScoreEntry {
  type: 'credit' | 'payment';
  amount: number;
  date: Date | string;
}

/** Udhaar still unpaid after FIFO, oldest first. */
export interface OpenCredit {
  date: Date;
  remaining: number;
}

export interface FifoResult {
  open: OpenCredit[];
  /** Amount-weighted average days from udhaar to payment; null when nothing was paid back yet. */
  avgDaysToPay: number | null;
  totalCredit: number;
  totalPaid: number;
}

/** Matches payments to the oldest udhaar first. Entries in any order. */
export function fifo(entries: ScoreEntry[]): FifoResult {
  const sorted = entries
    .map((e) => ({ ...e, date: new Date(e.date) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || (a.type === b.type ? 0 : a.type === 'credit' ? -1 : 1));
  const open: OpenCredit[] = [];
  let weightedDays = 0;
  let matched = 0;
  let totalCredit = 0;
  let totalPaid = 0;
  for (const e of sorted) {
    if (e.type === 'credit') {
      totalCredit += e.amount;
      open.push({ date: e.date, remaining: e.amount });
      continue;
    }
    totalPaid += e.amount;
    let left = e.amount;
    while (left > 0 && open.length) {
      const head = open[0]!;
      const used = Math.min(head.remaining, left);
      weightedDays += used * Math.max(0, (e.date.getTime() - head.date.getTime()) / DAY_MS);
      matched += used;
      head.remaining -= used;
      left -= used;
      if (head.remaining === 0) open.shift();
    }
    // Anything left over is an advance; it does not change the score.
  }
  return { open, avgDaysToPay: matched ? weightedDays / matched : null, totalCredit, totalPaid };
}

export type CreditBadge = 'good' | 'average' | 'risky' | 'new';

export interface CreditScore {
  /** 0-100, null for a new customer without enough history. */
  score: number | null;
  badge: CreditBadge;
  /** 0-100: payments vs udhaar in the last 180 days (lifetime when there was no udhaar then). */
  recoveredPct: number;
  avgDaysToPay: number | null;
  /** Age in days of the oldest unpaid udhaar; null when nothing is pending. */
  oldestDueDays: number | null;
}

export const SCORE_WINDOW_DAYS = 180;
/** Points: recovered 40, speed of payment 30, age of dues 30. */
const FAST_PAY_DAYS = 15;
const SLOW_PAY_DAYS = 90;
const FRESH_DUE_DAYS = 30;
const OLD_DUE_DAYS = 120;
export const GOOD_FROM = 70;
export const AVERAGE_FROM = 40;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** 1 at or below `full`, 0 at or above `zero`, linear in between. */
const falling = (v: number, full: number, zero: number) => clamp01((zero - v) / (zero - full));

export function computeCreditScore(entries: ScoreEntry[], now = new Date()): CreditScore {
  const { open, avgDaysToPay, totalCredit, totalPaid } = fifo(entries);
  const credits = entries.filter((e) => e.type === 'credit');
  const firstCredit = credits.reduce<Date | null>((min, e) => {
    const d = new Date(e.date);
    return !min || d < min ? d : min;
  }, null);
  const oldestDueDays = open.length ? Math.floor((now.getTime() - open[0]!.date.getTime()) / DAY_MS) : null;

  const since = now.getTime() - SCORE_WINDOW_DAYS * DAY_MS;
  const inWindow = entries.filter((e) => new Date(e.date).getTime() >= since);
  const windowCredit = inWindow.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
  const windowPaid = inWindow.filter((e) => e.type === 'payment').reduce((s, e) => s + e.amount, 0);
  const recovered = windowCredit > 0 ? clamp01(windowPaid / windowCredit) : totalCredit > 0 ? clamp01(totalPaid / totalCredit) : 1;
  const recoveredPct = Math.round(recovered * 100);
  const avg = avgDaysToPay === null ? null : Math.round(avgDaysToPay * 10) / 10;

  // Too little history to judge: no udhaar yet, or a single recent one.
  const recentOnly = !firstCredit || (credits.length < 2 && now.getTime() - firstCredit.getTime() < FRESH_DUE_DAYS * DAY_MS);
  if (recentOnly) return { score: null, badge: 'new', recoveredPct, avgDaysToPay: avg, oldestDueDays };

  // Nothing paid back yet: judge speed by how long the oldest udhaar has been waiting.
  const speedDays = avgDaysToPay ?? oldestDueDays ?? 0;
  const score = Math.round(
    40 * recovered + 30 * falling(speedDays, FAST_PAY_DAYS, SLOW_PAY_DAYS) + 30 * (oldestDueDays === null ? 1 : falling(oldestDueDays, FRESH_DUE_DAYS, OLD_DUE_DAYS)),
  );
  const badge: CreditBadge = score >= GOOD_FROM ? 'good' : score >= AVERAGE_FROM ? 'average' : 'risky';
  return { score, badge, recoveredPct, avgDaysToPay: avg, oldestDueDays };
}

async function entriesByCustomer(shopId: Types.ObjectId, customerIds: (Types.ObjectId | string)[]) {
  const rows = customerIds.length
    ? await CustomerLedger.find({ shopId, customerId: { $in: customerIds } }).select('customerId type amount date').sort({ date: 1 })
    : [];
  const by = new Map<string, ScoreEntry[]>();
  for (const r of rows) {
    const k = String(r.customerId);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push({ type: r.type as ScoreEntry['type'], amount: r.amount, date: r.date });
  }
  return by;
}

/** Scores for several customers of one shop (customer list). */
export async function creditScoresFor(shopId: Types.ObjectId, customerIds: (Types.ObjectId | string)[], now = new Date()): Promise<Map<string, CreditScore>> {
  const by = await entriesByCustomer(shopId, customerIds);
  return new Map(customerIds.map((id) => [String(id), computeCreditScore(by.get(String(id)) ?? [], now)]));
}

export async function creditScoreOf(shopId: Types.ObjectId, customerId: Types.ObjectId | string, now = new Date()): Promise<CreditScore> {
  return (await creditScoresFor(shopId, [customerId], now)).get(String(customerId))!;
}

/** Ledger in FIFO form per customer (reminders, aging report). */
export async function openCreditsFor(shopId: Types.ObjectId, customerIds: (Types.ObjectId | string)[]): Promise<Map<string, FifoResult>> {
  const by = await entriesByCustomer(shopId, customerIds);
  return new Map(customerIds.map((id) => [String(id), fifo(by.get(String(id)) ?? [])]));
}

export interface CreditWarning {
  customerId: string;
  /** New udhaar would take the balance over the customer's credit limit. */
  overLimit: boolean;
  limit: number | null;
  balance: number;
  newBalance: number;
  badge: CreditBadge;
  score: number | null;
}

/** Warning for new udhaar of `amount` paise, or null when the customer is within limit and not risky. */
export async function creditWarningFor(shopId: Types.ObjectId, customerId: string, amount: number): Promise<CreditWarning | null> {
  const c = await Customer.findOne({ _id: customerId, shopId, isDeleted: false }).select('creditLimit currentBalance');
  if (!c) return null;
  const newBalance = c.currentBalance + Math.max(0, amount);
  const limit = c.creditLimit ?? null;
  const overLimit = !!limit && newBalance > limit;
  const s = await creditScoreOf(shopId, c._id);
  if (!overLimit && s.badge !== 'risky') return null;
  return { customerId, overLimit, limit, balance: c.currentBalance, newBalance, badge: s.badge, score: s.score };
}
