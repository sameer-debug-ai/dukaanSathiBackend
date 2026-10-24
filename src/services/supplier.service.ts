import { Types } from 'mongoose';
import { runInTransaction } from '../config/db';
import { Product } from '../models/product.model';
import { Purchase } from '../models/purchase.model';
import { Supplier } from '../models/supplier.model';
import { SupplierPayment } from '../models/supplierPayment.model';
import { AppError } from '../utils/AppError';
import { resolveRange } from '../utils/istDate';
import { lineTotal } from '../utils/money';
import { escapeRegex, getPageParams, pageMeta } from '../utils/pagination';
import type {
  CreatePurchaseInput,
  CreateSupplierInput,
  CreateSupplierPaymentInput,
  UpdateSupplierInput,
} from '../validators/supplier.validators';
import { attachRef } from './lookup';
import { applyStockChange } from './stock.service';

interface SupplierTotals {
  totalPurchased: number;
  paidAtPurchase: number;
  payments: number;
  purchaseCount: number;
}

async function totalsBySupplier(shopId: Types.ObjectId, ids?: Types.ObjectId[]): Promise<Map<string, SupplierTotals>> {
  const match: Record<string, unknown> = { shopId };
  if (ids) match.supplierId = { $in: ids };
  const [purchases, payments] = await Promise.all([
    Purchase.aggregate<{ _id: Types.ObjectId; total: number; paid: number; count: number }>([
      { $match: match },
      { $group: { _id: '$supplierId', total: { $sum: '$totalAmount' }, paid: { $sum: '$paidAmount' }, count: { $sum: 1 } } },
    ]),
    SupplierPayment.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: match },
      { $group: { _id: '$supplierId', total: { $sum: '$amount' } } },
    ]),
  ]);
  const map = new Map<string, SupplierTotals>();
  const get = (id: string) => {
    if (!map.has(id)) map.set(id, { totalPurchased: 0, paidAtPurchase: 0, payments: 0, purchaseCount: 0 });
    return map.get(id)!;
  };
  for (const p of purchases) Object.assign(get(String(p._id)), { totalPurchased: p.total, paidAtPurchase: p.paid, purchaseCount: p.count });
  for (const p of payments) get(String(p._id)).payments = p.total;
  return map;
}

const withTotals = (doc: { toJSON: () => unknown; _id: Types.ObjectId }, t?: SupplierTotals) => ({
  ...(doc.toJSON() as Record<string, unknown>),
  totalPurchased: t?.totalPurchased ?? 0,
  totalPaid: (t?.paidAtPurchase ?? 0) + (t?.payments ?? 0),
  purchaseCount: t?.purchaseCount ?? 0,
});

export async function listSuppliers(shopId: Types.ObjectId, q: { search?: string; page?: number; limit?: number; sort?: string }) {
  const filter: Record<string, unknown> = { shopId, isDeleted: false };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { company: rx }, { phone: rx }, { aliases: rx }];
  }
  const page = getPageParams(q, 50, 500);
  const sort: Record<string, 1 | -1> = q.sort === 'name' ? { name: 1 } : { currentPayable: -1, name: 1 };
  const [docs, total] = await Promise.all([
    Supplier.find(filter).sort(sort).skip(page.skip).limit(page.limit),
    Supplier.countDocuments(filter),
  ]);
  const totals = await totalsBySupplier(shopId, docs.map((d) => d._id));
  const payable = await Supplier.aggregate<{ total: number }>([
    { $match: { shopId, isDeleted: false, currentPayable: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$currentPayable' } } },
  ]);
  return {
    items: docs.map((d) => withTotals(d, totals.get(String(d._id)))),
    meta: { ...pageMeta(page, total), totalPayable: payable[0]?.total ?? 0 },
  };
}

export async function getSupplier(shopId: Types.ObjectId, id: string) {
  const doc = await Supplier.findOne({ _id: id, shopId, isDeleted: false });
  if (!doc) throw AppError.notFound('Supplier not found');
  return doc;
}

export async function supplierDetail(shopId: Types.ObjectId, id: string) {
  const doc = await getSupplier(shopId, id);
  const totals = await totalsBySupplier(shopId, [doc._id]);
  return withTotals(doc, totals.get(String(doc._id)));
}

export function createSupplier(shopId: Types.ObjectId, input: CreateSupplierInput) {
  return Supplier.create({ ...input, shopId });
}

export async function updateSupplier(shopId: Types.ObjectId, id: string, input: UpdateSupplierInput) {
  const doc = await Supplier.findOneAndUpdate({ _id: id, shopId, isDeleted: false }, { $set: input }, { new: true, runValidators: true });
  if (!doc) throw AppError.notFound('Supplier not found');
  return doc;
}

export async function deleteSupplier(shopId: Types.ObjectId, id: string) {
  const doc = await Supplier.findOneAndUpdate({ _id: id, shopId, isDeleted: false }, { isDeleted: true }, { new: true });
  if (!doc) throw AppError.notFound('Supplier not found');
}

/** Purchases and payments merged chronologically with a running payable balance. */
export async function supplierHistory(shopId: Types.ObjectId, id: string) {
  const supplier = await getSupplier(shopId, id);
  const [purchases, payments] = await Promise.all([
    Purchase.find({ shopId, supplierId: supplier._id }).sort({ date: 1 }),
    SupplierPayment.find({ shopId, supplierId: supplier._id }).sort({ date: 1 }),
  ]);
  type Row = { kind: 'purchase' | 'payment'; date: Date; id: string; amount: number; paid: number; due: number; description: string; ref: unknown };
  const rows: Row[] = [
    ...purchases.map((p) => ({
      kind: 'purchase' as const,
      date: p.date,
      id: String(p._id),
      amount: p.totalAmount,
      paid: p.paidAmount,
      due: p.dueAmount,
      description: `${p.items.length} item(s)${p.invoiceNumber ? ` Â· Inv ${p.invoiceNumber}` : ''}`,
      ref: p.toJSON(),
    })),
    ...payments.map((p) => ({
      kind: 'payment' as const,
      date: p.date,
      id: String(p._id),
      amount: p.amount,
      paid: p.amount,
      due: -p.amount,
      description: `Payment (${p.mode})${p.note ? ` Â· ${p.note}` : ''}`,
      ref: p.toJSON(),
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  let balance = 0;
  const history = rows.map((r) => {
    balance += r.due;
    return { ...r, balance };
  });
  return { supplier: (await supplierDetail(shopId, id)), history: history.reverse() };
}

export async function createPurchase(shopId: Types.ObjectId, input: CreatePurchaseInput, userId?: string) {
  return runInTransaction(async (session) => {
    const supplier = await Supplier.findOne({ _id: input.supplierId, shopId, isDeleted: false }).session(session ?? null);
    if (!supplier) throw AppError.notFound('Supplier not found');

    const purchaseId = new Types.ObjectId();
    const items: { productId: Types.ObjectId; name: string; unit: string; qty: number; rate: number; total: number }[] = [];

    for (const line of input.items) {
      let product;
      if (line.productId) {
        product = await Product.findOne({ _id: line.productId, shopId, isDeleted: false }).session(session ?? null);
        if (!product) throw AppError.notFound('Product not found in purchase items');
      } else {
        const np = line.newProduct!;
        [product] = await Product.create(
          [
            {
              shopId,
              name: np.name,
              unit: np.unit,
              category: np.category,
              purchasePrice: line.rate,
              sellingPrice: np.sellingPrice || Math.round(line.rate * 1.15),
              supplierId: supplier._id,
              currentStock: 0,
            },
          ],
          { session },
        );
      }
      items.push({ productId: product!._id, name: product!.name, unit: product!.unit, qty: line.qty, rate: line.rate, total: lineTotal(line.qty, line.rate) });
    }

    const totalAmount = items.reduce((s, i) => s + i.total, 0);
    if (input.paidAmount > totalAmount) throw AppError.badRequest('Paid amount cannot be more than the purchase total');
    const dueAmount = totalAmount - input.paidAmount;
    const date = input.date ?? new Date();

    const [purchase] = await Purchase.create(
      [
        {
          _id: purchaseId,
          shopId,
          supplierId: supplier._id,
          items,
          totalAmount,
          paidAmount: input.paidAmount,
          dueAmount,
          invoiceNumber: input.invoiceNumber,
          date,
          note: input.note,
          source: input.source,
        },
      ],
      { session },
    );

    for (const item of items) {
      await applyStockChange(
        {
          shopId,
          productId: item.productId,
          quantity: item.qty,
          type: 'purchase',
          referenceType: 'purchase',
          referenceId: purchaseId,
          note: `From ${supplier.name}`,
          userId,
          date,
        },
        session,
      );
      if (input.updatePurchasePrice) {
        await Product.updateOne({ _id: item.productId, shopId }, { purchasePrice: item.rate, supplierId: supplier._id }, { session });
      }
    }

    await Supplier.updateOne(
      { _id: supplier._id, shopId },
      { $inc: { currentPayable: dueAmount }, $max: { lastTransactionAt: date } },
      { session },
    );
    return purchase!.toJSON();
  });
}

export async function listPurchases(
  shopId: Types.ObjectId,
  q: { page?: number; limit?: number; from?: string; to?: string; supplierId?: string; search?: string },
) {
  const filter: Record<string, unknown> = { shopId };
  if (q.supplierId) filter.supplierId = new Types.ObjectId(q.supplierId);
  if (q.from || q.to) {
    const r = resolveRange(q.from, q.to);
    filter.date = { $gte: r.from, $lte: r.to };
  }
  if (q.search) filter.$or = [{ invoiceNumber: new RegExp(escapeRegex(q.search), 'i') }, { 'items.name': new RegExp(escapeRegex(q.search), 'i') }];
  const page = getPageParams(q, 30);
  const [docs, total] = await Promise.all([
    Purchase.find(filter).sort({ date: -1 }).skip(page.skip).limit(page.limit),
    Purchase.countDocuments(filter),
  ]);
  const items = await attachRef(docs.map((d) => d.toJSON() as Record<string, unknown>), 'supplierId', Supplier, shopId, 'name company');
  return { items, meta: pageMeta(page, total) };
}

export async function getPurchase(shopId: Types.ObjectId, id: string) {
  const doc = await Purchase.findOne({ _id: id, shopId });
  if (!doc) throw AppError.notFound('Purchase not found');
  const [row] = await attachRef([doc.toJSON() as Record<string, unknown>], 'supplierId', Supplier, shopId, 'name company phone');
  return row;
}

export async function createSupplierPayment(shopId: Types.ObjectId, input: CreateSupplierPaymentInput) {
  return runInTransaction(async (session) => {
    const date = input.date ?? new Date();
    const supplier = await Supplier.findOneAndUpdate(
      { _id: input.supplierId, shopId, isDeleted: false },
      { $inc: { currentPayable: -input.amount }, $max: { lastTransactionAt: date } },
      { new: true, session },
    );
    if (!supplier) throw AppError.notFound('Supplier not found');
    const [payment] = await SupplierPayment.create([{ ...input, date, shopId }], { session });
    return { payment: payment!.toJSON(), supplier: supplier.toJSON() };
  });
}

export async function listSupplierPayments(
  shopId: Types.ObjectId,
  q: { page?: number; limit?: number; from?: string; to?: string; supplierId?: string },
) {
  const filter: Record<string, unknown> = { shopId };
  if (q.supplierId) filter.supplierId = new Types.ObjectId(q.supplierId);
  if (q.from || q.to) {
    const r = resolveRange(q.from, q.to);
    filter.date = { $gte: r.from, $lte: r.to };
  }
  const page = getPageParams(q, 30);
  const [docs, total] = await Promise.all([
    SupplierPayment.find(filter).sort({ date: -1 }).skip(page.skip).limit(page.limit),
    SupplierPayment.countDocuments(filter),
  ]);
  const items = await attachRef(docs.map((d) => d.toJSON() as Record<string, unknown>), 'supplierId', Supplier, shopId, 'name company');
  return { items, meta: pageMeta(page, total) };
}
