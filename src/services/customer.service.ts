import type { Types } from 'mongoose';
import { runInTransaction } from '../config/db';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { AppError } from '../utils/AppError';
import { resolveRange } from '../utils/istDate';
import { escapeRegex, getPageParams, pageMeta } from '../utils/pagination';
import type {
  AddCreditInput,
  AddPaymentInput,
  CreateCustomerInput,
  CustomerListQuery,
  UpdateCustomerInput,
} from '../validators/customer.validators';
import { addLedgerEntry, computeRunningBalance, sumLedger } from './ledger.service';

const SORTS: Record<string, Record<string, 1 | -1>> = {
  '-balance': { currentBalance: -1, name: 1 },
  balance: { currentBalance: 1, name: 1 },
  name: { name: 1 },
  '-name': { name: -1 },
  '-lastTransaction': { lastTransactionAt: -1 },
  '-createdAt': { createdAt: -1 },
};

export async function listCustomers(shopId: Types.ObjectId, q: CustomerListQuery) {
  const filter: Record<string, unknown> = { shopId, isDeleted: false };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { aliases: rx }, { phone: rx }];
  }
  if (q.filter === 'due') filter.currentBalance = { $gt: 0 };
  if (q.filter === 'clear') filter.currentBalance = { $lte: 0 };

  const page = getPageParams(q, 50, 500);
  const sort = SORTS[q.sort ?? '-balance'] ?? SORTS['-balance']!;
  const [docs, total, totals] = await Promise.all([
    Customer.find(filter).sort(sort).skip(page.skip).limit(page.limit),
    Customer.countDocuments(filter),
    Customer.aggregate<{ outstanding: number; dueCount: number }>([
      { $match: { shopId, isDeleted: false, currentBalance: { $gt: 0 } } },
      { $group: { _id: null, outstanding: { $sum: '$currentBalance' }, dueCount: { $sum: 1 } } },
    ]),
  ]);
  return {
    items: docs.map((d) => d.toJSON()),
    meta: { ...pageMeta(page, total), outstanding: totals[0]?.outstanding ?? 0, dueCount: totals[0]?.dueCount ?? 0 },
  };
}

export async function getCustomer(shopId: Types.ObjectId, id: string) {
  const doc = await Customer.findOne({ _id: id, shopId, isDeleted: false });
  if (!doc) throw AppError.notFound('Customer not found');
  return doc;
}

export async function customerDetail(shopId: Types.ObjectId, id: string) {
  const customer = await getCustomer(shopId, id);
  const stats = await CustomerLedger.aggregate<{ _id: string; total: number; count: number }>([
    { $match: { shopId, customerId: customer._id } },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const by = (t: string) => stats.find((s) => s._id === t);
  return {
    ...customer.toJSON(),
    stats: {
      totalCredit: by('credit')?.total ?? 0,
      totalPaid: by('payment')?.total ?? 0,
      entries: (by('credit')?.count ?? 0) + (by('payment')?.count ?? 0),
    },
  };
}

export async function createCustomer(shopId: Types.ObjectId, input: CreateCustomerInput) {
  if (input.phone) {
    const dup = await Customer.exists({ shopId, phone: input.phone, isDeleted: false });
    if (dup) throw AppError.conflict('A customer with this phone number already exists');
  }
  return Customer.create({ ...input, shopId });
}

export async function updateCustomer(shopId: Types.ObjectId, id: string, input: UpdateCustomerInput) {
  if (input.phone) {
    const dup = await Customer.exists({ shopId, phone: input.phone, isDeleted: false, _id: { $ne: id } });
    if (dup) throw AppError.conflict('A customer with this phone number already exists');
  }
  // currentBalance is derived from the ledger and never set directly.
  const doc = await Customer.findOneAndUpdate({ _id: id, shopId, isDeleted: false }, { $set: input }, { new: true, runValidators: true });
  if (!doc) throw AppError.notFound('Customer not found');
  return doc;
}

export async function deleteCustomer(shopId: Types.ObjectId, id: string) {
  const doc = await Customer.findOneAndUpdate({ _id: id, shopId, isDeleted: false }, { isDeleted: true }, { new: true });
  if (!doc) throw AppError.notFound('Customer not found');
}

/** Full ledger with running balance. With a date range, the opening balance carries prior entries. */
export async function customerLedger(shopId: Types.ObjectId, id: string, q: { from?: string; to?: string }) {
  const customer = await getCustomer(shopId, id);
  const filter: Record<string, unknown> = { shopId, customerId: customer._id };
  let opening = 0;

  if (q.from || q.to) {
    const range = resolveRange(q.from, q.to, 3650);
    filter.date = { $gte: range.from, $lte: range.to };
    const before = await CustomerLedger.find({ shopId, customerId: customer._id, date: { $lt: range.from } }).select('type amount');
    opening = sumLedger(before);
  }

  const entries = await CustomerLedger.find(filter).sort({ date: 1, createdAt: 1 });
  const rows = computeRunningBalance(
    entries.map((e) => e.toJSON() as { type: 'credit' | 'payment'; amount: number; date: Date } & Record<string, unknown>),
    opening,
  ).map((r) => ({ ...r.entry, credit: r.credit, payment: r.payment, balance: r.balance }));

  return {
    customer: customer.toJSON(),
    openingBalance: opening,
    closingBalance: rows.length ? rows[rows.length - 1]!.balance : opening,
    entries: rows,
  };
}

export function addCredit(shopId: Types.ObjectId, customerId: string, input: AddCreditInput) {
  return runInTransaction(async (session) => {
    const { entry, customer } = await addLedgerEntry(
      {
        shopId,
        customerId,
        type: 'credit',
        amount: input.amount,
        items: input.items,
        note: input.note,
        source: input.source,
        rawVoiceText: input.rawVoiceText,
        date: input.date,
      },
      session,
    );
    return { entry: entry.toJSON(), customer: customer.toJSON() };
  });
}

export function addPayment(shopId: Types.ObjectId, customerId: string, input: AddPaymentInput) {
  return runInTransaction(async (session) => {
    const { entry, customer } = await addLedgerEntry(
      {
        shopId,
        customerId,
        type: 'payment',
        amount: input.amount,
        mode: input.mode,
        note: input.note,
        source: input.source,
        rawVoiceText: input.rawVoiceText,
        date: input.date,
      },
      session,
    );
    return { entry: entry.toJSON(), customer: customer.toJSON() };
  });
}
