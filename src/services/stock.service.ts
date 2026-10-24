import type { ClientSession, Types } from 'mongoose';
import { Product, type ProductDoc } from '../models/product.model';
import { StockMovement, type MovementType } from '../models/stockMovement.model';
import { AppError } from '../utils/AppError';
import { getPageParams, pageMeta } from '../utils/pagination';
import { resolveRange } from '../utils/istDate';

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface StockChange {
  shopId: Types.ObjectId;
  productId: Types.ObjectId | string;
  /** Signed change: + adds stock, - removes. */
  quantity: number;
  type: MovementType;
  referenceType?: 'sale' | 'purchase' | 'manual';
  referenceId?: Types.ObjectId;
  note?: string;
  userId?: string;
  date?: Date;
}

/**
 * The ONLY way product stock changes. Atomically increments currentStock and
 * records a StockMovement with the resulting balance.
 */
export async function applyStockChange(change: StockChange, session?: ClientSession): Promise<ProductDoc> {
  const qty = round3(change.quantity);
  if (qty === 0) throw AppError.badRequest('Quantity cannot be 0');

  const product = await Product.findOneAndUpdate(
    { _id: change.productId, shopId: change.shopId, isDeleted: false },
    { $inc: { currentStock: qty } },
    { new: true, session },
  );
  if (!product) throw AppError.notFound('Product not found');

  // Floating-point $inc can leave 2.9999999; normalise to 3 decimals.
  const balance = round3(product.currentStock);
  if (balance !== product.currentStock) {
    await Product.updateOne({ _id: product._id, shopId: change.shopId }, { currentStock: balance }, { session });
    product.currentStock = balance;
  }

  const at = change.date ?? new Date();
  await StockMovement.create(
    [
      {
        shopId: change.shopId,
        productId: product._id,
        type: change.type,
        quantity: qty,
        balanceAfter: balance,
        referenceType: change.referenceType ?? 'manual',
        referenceId: change.referenceId,
        note: change.note ?? '',
        createdBy: change.userId,
        createdAt: at,
        updatedAt: at,
      },
    ],
    { session, timestamps: false },
  );
  return product;
}

export async function stockHistory(
  shopId: Types.ObjectId,
  productId: string,
  query: { page?: number; limit?: number; from?: string; to?: string },
) {
  const product = await Product.findOne({ _id: productId, shopId });
  if (!product) throw AppError.notFound('Product not found');

  const filter: Record<string, unknown> = { shopId, productId: product._id };
  if (query.from || query.to) {
    const { from, to } = resolveRange(query.from, query.to);
    filter.createdAt = { $gte: from, $lte: to };
  }
  const page = getPageParams(query, 30);
  const [items, total] = await Promise.all([
    StockMovement.find(filter).sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit),
    StockMovement.countDocuments(filter),
  ]);
  return { items: items.map((m) => m.toJSON()), meta: pageMeta(page, total), product: product.toJSON() };
}
