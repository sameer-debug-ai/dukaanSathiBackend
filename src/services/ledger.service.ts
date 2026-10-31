import type { ClientSession, Types } from 'mongoose';
import { Customer } from '../models/customer.model';
import { CustomerLedger, type LedgerType } from '../models/customerLedger.model';
import { AppError } from '../utils/AppError';

export interface LedgerLike {
  type: LedgerType;
  amount: number;
  date: Date | string;
}

export interface LedgerRow<T extends LedgerLike> {
  entry: T;
  credit: number;
  payment: number;
  balance: number;
}

/** Signed effect of an entry on what the customer owes. */
export const ledgerDelta = (e: Pick<LedgerLike, 'type' | 'amount'>): number => (e.type === 'credit' ? e.amount : -e.amount);

/**
 * Running balance for a chronologically sorted ledger. Pure so it can be
 * unit tested and reused for statements/PDFs.
 */
export function computeRunningBalance<T extends LedgerLike>(entries: T[], opening = 0): LedgerRow<T>[] {
  let balance = opening;
  return entries.map((entry) => {
    balance += ledgerDelta(entry);
    return {
      entry,
      credit: entry.type === 'credit' ? entry.amount : 0,
      payment: entry.type === 'payment' ? entry.amount : 0,
      balance,
    };
  });
}

/** Final balance of a ledger (any order). */
export const sumLedger = (entries: Pick<LedgerLike, 'type' | 'amount'>[]): number =>
  entries.reduce((acc, e) => acc + ledgerDelta(e), 0);

export interface NewLedgerEntry {
  shopId: Types.ObjectId;
  customerId: Types.ObjectId | string;
  type: LedgerType;
  amount: number;
  items?: { productId?: Types.ObjectId | string; name: string; qty: number; rate: number }[];
  note?: string;
  source?: 'manual' | 'voice' | 'sale';
  rawVoiceText?: string;
  saleId?: Types.ObjectId;
  /** Taking back a cancelled bill's udhaar (not money received). */
  reversalOf?: Types.ObjectId;
  mode?: 'cash' | 'upi' | 'bank' | null;
  date?: Date;
}

/** Writes a ledger entry and keeps the customer's cached balance in sync. */
export async function addLedgerEntry(input: NewLedgerEntry, session?: ClientSession) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw AppError.badRequest('Amount must be greater than 0');
  const date = input.date ?? new Date();

  const customer = await Customer.findOneAndUpdate(
    { _id: input.customerId, shopId: input.shopId, isDeleted: false },
    { $inc: { currentBalance: ledgerDelta(input) }, $max: { lastTransactionAt: date } },
    { new: true, session },
  );
  if (!customer) throw AppError.notFound('Customer not found');

  const [entry] = await CustomerLedger.create(
    [
      {
        shopId: input.shopId,
        customerId: customer._id,
        type: input.type,
        amount: input.amount,
        items: input.items ?? [],
        note: input.note ?? '',
        source: input.source ?? 'manual',
        rawVoiceText: input.rawVoiceText,
        saleId: input.saleId,
        reversalOf: input.reversalOf,
        mode: input.mode ?? null,
        date,
      },
    ],
    { session },
  );
  return { entry: entry!, customer };
}

/** Recomputes the cached balance from the ledger (repair tool / consistency check). */
export async function recalculateBalance(shopId: Types.ObjectId, customerId: Types.ObjectId | string): Promise<number> {
  const entries = await CustomerLedger.find({ shopId, customerId }).select('type amount');
  const balance = sumLedger(entries);
  await Customer.updateOne({ _id: customerId, shopId }, { currentBalance: balance });
  return balance;
}
