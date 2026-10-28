import type { ClientSession, Types } from 'mongoose';
import { Product } from '../models/product.model';
import { ProductBatch } from '../models/productBatch.model';
import { AppError } from '../utils/AppError';
import { addDays, startOfIstDay } from '../utils/istDate';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------------------------------
 * Pure FEFO (first expiry, first out) planning. Tested in batch-fefo.test.ts.
 * ---------------------------------------------------------------------------------------- */
export interface BatchLike {
  id: string;
  qty: number;
  expiryDate: Date | null;
  createdAt?: Date;
}

/** Earliest expiry first; batches without an expiry last; ties by age (oldest first). */
export function fefoCompare(a: BatchLike, b: BatchLike): number {
  const ea = a.expiryDate ? a.expiryDate.getTime() : Infinity;
  const eb = b.expiryDate ? b.expiryDate.getTime() : Infinity;
  if (ea !== eb) return ea < eb ? -1 : 1;
  return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
}

/**
 * Which batches to take `qty` units from. `prefer` (e.g. the expired batch being written off,
 * or the batches of a purchase being undone) are used first, then FEFO.
 * `short` is what the batches could not cover (stock sold beyond what was tracked).
 */
export function planFefo(
  batches: BatchLike[],
  qty: number,
  prefer: (b: BatchLike) => boolean = () => false,
): { take: { id: string; qty: number }[]; short: number } {
  const ordered = [...batches].filter((b) => b.qty > 0).sort((a, b) => Number(prefer(b)) - Number(prefer(a)) || fefoCompare(a, b));
  let left = round3(qty);
  const take: { id: string; qty: number }[] = [];
  for (const b of ordered) {
    if (left <= 0) break;
    const q = round3(Math.min(b.qty, left));
    take.push({ id: b.id, qty: q });
    left = round3(left - q);
  }
  return { take, short: Math.max(0, left) };
}

/* ------------------------------------------------------------------------------------------
 * Keeping batches in step with stock. Called from applyStockChange for tracked products only.
 * ---------------------------------------------------------------------------------------- */
export interface BatchChange {
  shopId: Types.ObjectId;
  productId: Types.ObjectId;
  /** Signed units, as in the StockMovement. */
  quantity: number;
  type: string;
  expiryDate?: Date | null;
  /** Take from this batch first (writing off an expired batch). */
  batchId?: string;
  referenceType?: string;
  referenceId?: Types.ObjectId;
  note?: string;
}

export async function syncBatches(change: BatchChange, session?: ClientSession): Promise<void> {
  const { shopId, productId } = change;
  if (change.quantity > 0) {
    await ProductBatch.create(
      [
        {
          shopId,
          productId,
          qty: round3(change.quantity),
          initialQty: round3(change.quantity),
          expiryDate: change.expiryDate ?? null,
          purchaseId: change.referenceType === 'purchase' ? change.referenceId : undefined,
          note: change.note ?? '',
        },
      ],
      { session },
    );
    return;
  }

  const docs = await ProductBatch.find({ shopId, productId, qty: { $gt: 0 } }).session(session ?? null);
  const batches = docs.map((d) => ({ id: String(d._id), qty: d.qty, expiryDate: d.expiryDate ?? null, createdAt: d.get('createdAt') as Date, purchaseId: d.purchaseId }));
  const undoPurchase = change.type === 'reversal' && change.referenceType === 'purchase' && change.referenceId;
  const prefer = (b: BatchLike) =>
    (change.batchId !== undefined && b.id === change.batchId) ||
    (!!undoPurchase && !!batches.find((x) => x.id === b.id)?.purchaseId?.equals(change.referenceId!));
  const { take } = planFefo(batches, -change.quantity, prefer);
  if (!take.length) return;
  await ProductBatch.bulkWrite(
    take.map((t) => ({ updateOne: { filter: { _id: t.id, shopId }, update: { $inc: { qty: -t.qty } } } })),
    { session },
  );
  await ProductBatch.deleteMany({ shopId, productId, qty: { $lte: 0.0005 } }, { session });
}

/** Turning tracking on: today's stock becomes one batch with no expiry. Off: batches are dropped. */
export async function setTracking(shopId: Types.ObjectId, productId: Types.ObjectId, on: boolean, currentStock: number): Promise<void> {
  if (!on) {
    await ProductBatch.deleteMany({ shopId, productId });
    return;
  }
  const existing = await ProductBatch.countDocuments({ shopId, productId });
  if (existing === 0 && currentStock > 0) {
    await ProductBatch.create({ shopId, productId, qty: round3(currentStock), initialQty: round3(currentStock), expiryDate: null, note: 'Opening stock' });
  }
}

export async function listBatches(shopId: Types.ObjectId, productId: string) {
  const product = await Product.findOne({ _id: productId, shopId, isDeleted: false }).select('_id');
  if (!product) throw AppError.notFound('Product not found');
  const docs = await ProductBatch.find({ shopId, productId: product._id, qty: { $gt: 0 } });
  return docs
    .map((d) => ({ id: String(d._id), qty: d.qty, initialQty: d.initialQty, expiryDate: d.expiryDate ?? null, purchaseId: d.purchaseId ? String(d.purchaseId) : null, note: d.note, createdAt: d.get('createdAt') as Date }))
    .sort(fefoCompare);
}

export interface ExpiryItem {
  batchId: string;
  productId: string;
  name: string;
  unit: string;
  qty: number;
  expiryDate: Date;
  /** Whole IST days until expiry; negative when already expired. */
  daysLeft: number;
}

/** Batches already expired and those expiring within `days` (dashboard alert). */
export async function expiryAlerts(shopId: Types.ObjectId, days = 7, now = new Date()) {
  const today = startOfIstDay(now);
  const batches = await ProductBatch.find({ shopId, qty: { $gt: 0 }, expiryDate: { $ne: null, $lt: addDays(today, days + 1) } }).sort({ expiryDate: 1 });
  const ids = [...new Set(batches.map((b) => String(b.productId)))];
  const products = ids.length ? await Product.find({ shopId, _id: { $in: ids }, isDeleted: false, trackExpiry: true }).select('name unit') : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const expired: ExpiryItem[] = [];
  const expiringSoon: ExpiryItem[] = [];
  for (const b of batches) {
    const p = byId.get(String(b.productId));
    if (!p || !b.expiryDate) continue;
    const daysLeft = Math.round((startOfIstDay(b.expiryDate).getTime() - today.getTime()) / DAY_MS);
    const item = { batchId: String(b._id), productId: String(p._id), name: p.name, unit: p.unit, qty: b.qty, expiryDate: b.expiryDate, daysLeft };
    // Expiring today still counts as "soon"; the day after it is expired.
    (daysLeft < 0 ? expired : expiringSoon).push(item);
  }
  return { days, expired, expiringSoon };
}
