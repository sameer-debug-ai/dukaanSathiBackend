import type { ClientSession, Types } from 'mongoose';
import { runInTransaction } from '../config/db';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { AppError } from '../utils/AppError';
import { resolveRange } from '../utils/istDate';
import { formatInr } from '../utils/money';
import { escapeRegex, getPageParams, pageMeta } from '../utils/pagination';
import type {
  AddCreditInput,
  AddPaymentInput,
  CreateCustomerInput,
  CustomerListQuery,
  UpdateCustomerInput,
} from '../validators/customer.validators';
import { creditScoreOf, creditScoresFor } from './creditScore.service';
import { addLedgerEntry, computeRunningBalance, sumLedger } from './ledger.service';
import { recordVoiceEffect } from './voiceEffects';

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
  const scores = await creditScoresFor(shopId, docs.map((d) => d._id));
  return {
    items: docs.map((d) => ({ ...d.toJSON(), credit: scores.get(String(d._id)) })),
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
    // A cancelled bill's udhaar coming back counts against the udhaar given, not as a payment.
    { $group: { _id: { $cond: [{ $ne: [{ $ifNull: ['$reversalOf', null] }, null] }, 'reversal', '$type'] }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const by = (t: string) => stats.find((s) => s._id === t);
  return {
    ...customer.toJSON(),
    credit: await creditScoreOf(shopId, customer._id),
    stats: {
      totalCredit: (by('credit')?.total ?? 0) - (by('reversal')?.total ?? 0),
      totalPaid: by('payment')?.total ?? 0,
      entries: (by('credit')?.count ?? 0) + (by('payment')?.count ?? 0),
    },
  };
}

/** `session`: run inside a caller's transaction (a multi-action voice command). */
export async function createCustomer(shopId: Types.ObjectId, input: CreateCustomerInput, session?: ClientSession) {
  if (input.phone) {
    const dup = await Customer.exists({ shopId, phone: input.phone, isDeleted: false }).session(session ?? null);
    if (dup) throw AppError.conflict('A customer with this phone number already exists');
  }
  const { voiceLogId, ...fields } = input;
  const doc = session ? (await Customer.create([{ ...fields, shopId }], { session }))[0]! : await Customer.create({ ...fields, shopId });
  await recordVoiceEffect(shopId, voiceLogId, [{ kind: 'customer', id: doc._id }], session);
  return doc;
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
  // Deleting someone with pending udhaar (or an advance) would silently drop it from every total.
  const doc = await Customer.findOneAndUpdate({ _id: id, shopId, isDeleted: false, currentBalance: 0 }, { isDeleted: true }, { new: true });
  if (doc) return;
  const existing = await Customer.findOne({ _id: id, shopId, isDeleted: false }).select('name currentBalance');
  if (!existing) throw AppError.notFound('Customer not found');
  throw new AppError(
    409,
    existing.currentBalance > 0
      ? `${existing.name} still owes ${formatInr(existing.currentBalance)}. Clear the udhaar before deleting.`
      : `${existing.name} has an advance of ${formatInr(-existing.currentBalance)}. Settle it before deleting.`,
  );
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

export function addCredit(shopId: Types.ObjectId, customerId: string, input: AddCreditInput, outer?: ClientSession) {
  const run = async (session: ClientSession | undefined) => {
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
    await recordVoiceEffect(shopId, input.voiceLogId, [{ kind: 'ledger', id: entry._id }], session);
    return { entry: entry.toJSON(), customer: customer.toJSON() };
  };
  return outer ? run(outer) : runInTransaction(run);
}

export function addPayment(shopId: Types.ObjectId, customerId: string, input: AddPaymentInput, outer?: ClientSession) {
  const run = async (session: ClientSession | undefined) => {
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
    await recordVoiceEffect(shopId, input.voiceLogId, [{ kind: 'ledger', id: entry._id }], session);
    return { entry: entry.toJSON(), customer: customer.toJSON() };
  };
  return outer ? run(outer) : runInTransaction(run);
}
