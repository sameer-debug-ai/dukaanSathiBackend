import { Types, type ClientSession, type PipelineStage } from 'mongoose';
import { runInTransaction } from '../config/db';
import { Product } from '../models/product.model';
import { User } from '../models/user.model';
import { AppError } from '../utils/AppError';
import { escapeRegex, getPageParams, pageMeta } from '../utils/pagination';
import {
  importRowCreateSchema,
  type AdjustStockInput,
  type CreateProductInput,
  type ImportProductsInput,
  type ProductListQuery,
  type UpdateProductInput,
} from '../validators/product.validators';
import { applyStockChange } from './stock.service';
import { recordVoiceEffect } from './voiceEffects';

export type StockStatus = 'in' | 'low' | 'out';

export const stockStatusOf = (stock: number, threshold: number): StockStatus =>
  stock <= 0 ? 'out' : stock <= threshold ? 'low' : 'in';

type PlainProduct = Record<string, unknown> & { currentStock: number; lowStockThreshold: number };

export function serializeProduct(doc: { toJSON: () => unknown }): PlainProduct & { stockStatus: StockStatus } {
  const p = doc.toJSON() as PlainProduct;
  return { ...p, stockStatus: stockStatusOf(p.currentStock, p.lowStockThreshold) };
}

const STOCK_FILTERS: Record<string, Record<string, unknown>> = {
  out: { currentStock: { $lte: 0 } },
  low: { currentStock: { $gt: 0 }, $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } },
  in: { $expr: { $gt: ['$currentStock', '$lowStockThreshold'] } },
  alerts: { $expr: { $lte: ['$currentStock', '$lowStockThreshold'] } },
};

const SORTS: Record<string, Record<string, 1 | -1>> = {
  name: { name: 1 },
  '-name': { name: -1 },
  stock: { currentStock: 1, name: 1 },
  '-stock': { currentStock: -1, name: 1 },
  price: { sellingPrice: 1 },
  '-price': { sellingPrice: -1 },
  '-updatedAt': { updatedAt: -1 },
  '-createdAt': { createdAt: -1 },
};

export function buildProductFilter(shopId: Types.ObjectId, q: Pick<ProductListQuery, 'search' | 'category' | 'stock'>) {
  const filter: Record<string, unknown> = { shopId, isDeleted: false };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { nameHindi: rx }, { aliases: rx }, { barcode: q.search }, { category: rx }];
  }
  if (q.category) filter.category = q.category;
  if (q.stock && q.stock !== 'all') Object.assign(filter, STOCK_FILTERS[q.stock]);
  return filter;
}

export async function listProducts(shopId: Types.ObjectId, q: ProductListQuery) {
  const filter = buildProductFilter(shopId, q);
  const page = getPageParams(q, 50, 500);
  const sort = SORTS[q.sort ?? 'name'] ?? SORTS.name!;
  const [docs, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(page.skip).limit(page.limit),
    Product.countDocuments(filter),
  ]);
  return { items: docs.map(serializeProduct), meta: pageMeta(page, total) };
}

export async function getProduct(shopId: Types.ObjectId, id: string) {
  const doc = await Product.findOne({ _id: id, shopId, isDeleted: false });
  if (!doc) throw AppError.notFound('Product not found');
  return doc;
}

async function defaultThreshold(shopId: Types.ObjectId): Promise<number> {
  const user = await User.findById(shopId).select('settings');
  return user?.settings?.lowStockDefault ?? 5;
}

export async function createProduct(shopId: Types.ObjectId, input: CreateProductInput, userId?: string, session?: ClientSession) {
  const { openingStock, voiceLogId, ...rest } = input;
  const threshold = rest.lowStockThreshold ?? (await defaultThreshold(shopId));
  const create = async (s?: ClientSession) => {
    const [doc] = await Product.create([{ ...rest, lowStockThreshold: threshold, shopId, currentStock: 0 }], { session: s });
    await recordVoiceEffect(shopId, voiceLogId, [{ kind: 'product', id: doc!._id }], s);
    if (openingStock > 0) {
      return applyStockChange(
        { shopId, productId: doc!._id, quantity: openingStock, type: 'adjustment', note: 'Opening stock', userId },
        s,
      );
    }
    return doc!;
  };
  return session ? create(session) : runInTransaction(create);
}

export async function updateProduct(shopId: Types.ObjectId, id: string, input: UpdateProductInput) {
  const doc = await Product.findOneAndUpdate({ _id: id, shopId, isDeleted: false }, { $set: input }, { new: true, runValidators: true });
  if (!doc) throw AppError.notFound('Product not found');
  return doc;
}

export async function deleteProduct(shopId: Types.ObjectId, id: string) {
  const doc = await Product.findOneAndUpdate({ _id: id, shopId, isDeleted: false }, { isDeleted: true, isActive: false }, { new: true });
  if (!doc) throw AppError.notFound('Product not found');
}

export async function listCategories(shopId: Types.ObjectId): Promise<string[]> {
  const cats = await Product.distinct('category', { shopId, isDeleted: false });
  return (cats as string[]).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** Counts + top items for the header bell and the low-stock page. */
export async function stockAlerts(shopId: Types.ObjectId, limit = 50) {
  const base = { shopId, isDeleted: false, isActive: true };
  const [low, out, items] = await Promise.all([
    Product.countDocuments({ ...base, ...STOCK_FILTERS.low }),
    Product.countDocuments({ ...base, ...STOCK_FILTERS.out }),
    Product.find({ ...base, ...STOCK_FILTERS.alerts }).sort({ currentStock: 1, name: 1 }).limit(limit),
  ]);
  return { lowCount: low, outCount: out, total: low + out, items: items.map(serializeProduct) };
}

export async function adjustStock(shopId: Types.ObjectId, input: AdjustStockInput, userId?: string, outer?: ClientSession) {
  // Damage always removes stock; return/purchase always add, regardless of the sign sent.
  let quantity = input.quantity;
  if (input.type === 'damage') quantity = -Math.abs(quantity);
  if (input.type === 'return' || input.type === 'purchase') quantity = Math.abs(quantity);

  const product = outer ? await Product.findOne({ _id: input.productId, shopId, isDeleted: false }).session(outer) : await getProduct(shopId, input.productId);
  if (!product) throw AppError.notFound('Product not found');
  if (product.currentStock + quantity < 0) {
    throw AppError.badRequest(`Only ${product.currentStock} ${product.unit} in stock; cannot remove ${Math.abs(quantity)}`);
  }
  const apply = async (session: ClientSession | undefined) => {
    const p = await applyStockChange({ shopId, productId: input.productId, quantity, type: input.type, note: input.note, userId }, session);
    await recordVoiceEffect(shopId, input.voiceLogId, [{ kind: 'stock', productId: p._id, quantity }], session);
    return p;
  };
  const updated = outer ? await apply(outer) : await runInTransaction(apply);
  return serializeProduct(updated);
}

export async function importProducts(shopId: Types.ObjectId, input: ImportProductsInput, userId?: string) {
  let created = 0;
  let updated = 0;
  const errors: { row: number; message: string }[] = [];
  const threshold = await defaultThreshold(shopId);

  for (const [i, row] of input.rows.entries()) {
    try {
      const existing = input.updateExisting
        ? await Product.findOne({ shopId, isDeleted: false, name: new RegExp(`^${escapeRegex(row.name)}$`, 'i') })
        : null;
      if (existing) {
        // Only the columns present in the file; blank cells leave the product as it is.
        const { openingStock, ...given } = row;
        const fields = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
        if (Object.keys(fields).length) await Product.updateOne({ _id: existing._id, shopId }, { $set: fields });
        if (openingStock && openingStock > 0) {
          await applyStockChange({ shopId, productId: existing._id, quantity: openingStock, type: 'purchase', note: 'CSV import', userId });
        }
        updated++;
      } else {
        const full = importRowCreateSchema.parse(row);
        await createProduct(shopId, { ...full, lowStockThreshold: full.lowStockThreshold ?? threshold }, userId);
        created++;
      }
    } catch (err) {
      errors.push({ row: i + 2, message: err instanceof Error ? err.message : 'Invalid row' });
    }
  }
  return { created, updated, failed: errors.length, errors: errors.slice(0, 50) };
}

const CSV_COLUMNS = [
  'name',
  'nameHindi',
  'aliases',
  'category',
  'unit',
  'purchasePrice',
  'sellingPrice',
  'mrp',
  'currentStock',
  'lowStockThreshold',
  'barcode',
] as const;

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export. Prices are written in rupees for spreadsheet friendliness. */
export async function exportProductsCsv(shopId: Types.ObjectId, q: ProductListQuery): Promise<string> {
  const docs = await Product.find(buildProductFilter(shopId, q)).sort({ name: 1 });
  const rows = docs.map((d) =>
    CSV_COLUMNS.map((c) => {
      const v = d.get(c) as unknown;
      if (c === 'aliases') return csvCell((v as string[]).join('|'));
      if (c === 'purchasePrice' || c === 'sellingPrice' || c === 'mrp') return csvCell(((v as number) / 100).toFixed(2));
      return csvCell(v);
    }).join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

/** Stock valuation (shared by dashboard and reports). */
export async function stockValuation(shopId: Types.ObjectId) {
  const pipeline: PipelineStage[] = [
    { $match: { shopId, isDeleted: false } },
    {
      $project: {
        name: 1,
        category: 1,
        unit: 1,
        currentStock: 1,
        purchasePrice: 1,
        sellingPrice: 1,
        costValue: { $round: [{ $multiply: [{ $max: ['$currentStock', 0] }, '$purchasePrice'] }, 0] },
        saleValue: { $round: [{ $multiply: [{ $max: ['$currentStock', 0] }, '$sellingPrice'] }, 0] },
      },
    },
    { $sort: { costValue: -1 } },
  ];
  const rows = await Product.aggregate<{
    _id: Types.ObjectId;
    name: string;
    category: string;
    unit: string;
    currentStock: number;
    purchasePrice: number;
    sellingPrice: number;
    costValue: number;
    saleValue: number;
  }>(pipeline);
  const totals = rows.reduce(
    (acc, r) => ({ costValue: acc.costValue + r.costValue, saleValue: acc.saleValue + r.saleValue, items: acc.items + 1 }),
    { costValue: 0, saleValue: 0, items: 0 },
  );
  return { rows: rows.map(({ _id, ...r }) => ({ id: String(_id), ...r })), totals };
}

export const toObjectId = (id: string): Types.ObjectId => new Types.ObjectId(id);
