import { Types } from 'mongoose';
import { Product } from '../models/product.model';
import { StockMovement } from '../models/stockMovement.model';
import { Supplier } from '../models/supplier.model';
import { User } from '../models/user.model';
import { IST_TIMEZONE, addDays, istDayKey, startOfIstDay } from '../utils/istDate';

/* ------------------------------------------------------------------------------------------
 * Pure forecasting maths (tested in stock-prediction.test.ts).
 * ---------------------------------------------------------------------------------------- */
export const WINDOW_DAYS = 30;
/** A day's sales count half as much every HALF_LIFE_DAYS days back. */
export const HALF_LIFE_DAYS = 10;
/** New products: average over at least this many days so one busy day is not "per day". */
export const MIN_DAYS = 7;
export const DEFAULT_REORDER_DAYS = 15;

const DAY_MS = 24 * 60 * 60 * 1000;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Recency-weighted average units sold per day.
 * `daily[0]` is today, `daily[1]` yesterday, ... (missing days = 0 sold).
 * `activeDays` = days the product has existed in the window; older days are ignored.
 */
export function weightedDailyRate(daily: number[], activeDays = WINDOW_DAYS): number {
  const n = Math.min(WINDOW_DAYS, Math.max(MIN_DAYS, Math.floor(activeDays)));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(0.5, i / HALF_LIFE_DAYS);
    num += w * Math.max(0, daily[i] ?? 0);
    den += w;
  }
  return den ? round3(num / den) : 0;
}

/** Whole days the stock will last at this rate; null when it is not selling. */
export function daysLeftFor(stock: number, dailyRate: number): number | null {
  if (!(dailyRate > 0)) return null;
  if (stock <= 0) return 0;
  return Math.floor(stock / dailyRate);
}

/** Units that come in whole numbers; the rest (kg, litre, g, ml) can be ordered in parts. */
const WHOLE_UNITS = new Set(['piece', 'packet', 'box', 'dozen']);

/** Order quantity rounded up to what a supplier would sell: whole packs, 0.5 kg/l, 50 g/ml. */
export function roundOrderQty(qty: number, unit: string): number {
  if (qty <= 0) return 0;
  if (unit === 'g' || unit === 'ml') return Math.ceil(qty / 50) * 50;
  if (WHOLE_UNITS.has(unit)) return Math.ceil(round3(qty));
  return Math.ceil(round3(qty) * 2) / 2;
}

/**
 * How much to order so the stock lasts `days`. Selling items: days of sales minus stock.
 * Not selling (often because it ran out) but at/below its low-stock level: refill to twice that level.
 */
export function reorderQtyFor(p: { dailyRate: number; currentStock: number; lowStockThreshold: number; unit: string }, days: number): number {
  const stock = Math.max(0, p.currentStock);
  if (p.dailyRate > 0) return roundOrderQty(p.dailyRate * days - stock, p.unit);
  if (p.currentStock <= p.lowStockThreshold) return roundOrderQty(Math.max(1, p.lowStockThreshold) * 2 - stock, p.unit);
  return 0;
}

/* ------------------------------------------------------------------------------------------
 * Data access.
 * ---------------------------------------------------------------------------------------- */
export interface StockForecast {
  /** Units per day (weighted). */
  dailyRate: number;
  daysLeft: number | null;
}

interface ForecastTarget {
  _id: Types.ObjectId;
  currentStock: number;
  createdAt?: Date;
}

/** Net units sold per product per IST day over the window (undone bills are subtracted). */
async function dailySales(shopId: Types.ObjectId, productIds: Types.ObjectId[] | null, now: Date) {
  const from = startOfIstDay(addDays(now, -(WINDOW_DAYS - 1)));
  const match: Record<string, unknown> = {
    shopId,
    createdAt: { $gte: from },
    $or: [{ type: 'sale' }, { type: 'reversal', referenceType: 'sale' }],
  };
  if (productIds) match.productId = { $in: productIds };
  const rows: { _id: { p: Types.ObjectId; d: string }; sold: number }[] = await StockMovement.aggregate([
    { $match: match },
    {
      $group: {
        _id: { p: '$productId', d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: IST_TIMEZONE } } },
        sold: { $sum: { $multiply: ['$quantity', -1] } },
      },
    },
  ]);
  const byProduct = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = String(r._id.p);
    if (!byProduct.has(key)) byProduct.set(key, new Map());
    byProduct.get(key)!.set(r._id.d, r.sold);
  }
  return byProduct;
}

function forecastOne(p: ForecastTarget, days: Map<string, number> | undefined, now: Date): StockForecast {
  const today = startOfIstDay(now);
  const daily: number[] = [];
  let firstIdx = -1;
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const v = days?.get(istDayKey(addDays(today, -i))) ?? 0;
    daily.push(v);
    if (v !== 0) firstIdx = i;
  }
  // Days in the window since the product was added (or its first sale, for older data).
  const sinceCreated = p.createdAt ? Math.floor((today.getTime() - startOfIstDay(p.createdAt).getTime()) / DAY_MS) + 1 : WINDOW_DAYS;
  const activeDays = Math.max(sinceCreated, firstIdx + 1);
  const dailyRate = weightedDailyRate(daily, activeDays);
  return { dailyRate, daysLeft: daysLeftFor(p.currentStock, dailyRate) };
}

export async function forecastFor(shopId: Types.ObjectId, products: ForecastTarget[], now = new Date()): Promise<Map<string, StockForecast>> {
  const out = new Map<string, StockForecast>();
  if (!products.length) return out;
  const sales = await dailySales(shopId, products.length > 300 ? null : products.map((p) => p._id), now);
  for (const p of products) out.set(String(p._id), forecastOne(p, sales.get(String(p._id)), now));
  return out;
}

/** Adds `forecast` to serialized products (list / detail / barcode lookups). */
export async function withForecast<T extends Record<string, unknown>>(shopId: Types.ObjectId, items: T[], now = new Date()): Promise<(T & { forecast: StockForecast })[]> {
  const targets = items.map((i) => ({ _id: new Types.ObjectId(String(i.id)), currentStock: Number(i.currentStock) || 0, createdAt: i.createdAt as Date | undefined }));
  const map = await forecastFor(shopId, targets, now);
  return items.map((i) => ({ ...i, forecast: map.get(String(i.id)) ?? { dailyRate: 0, daysLeft: null } }));
}

async function activeProducts(shopId: Types.ObjectId) {
  return Product.find({ shopId, isDeleted: false, isActive: true }).select('name nameHindi unit currentStock lowStockThreshold purchasePrice supplierId createdAt');
}

export interface RunOutItem {
  id: string;
  name: string;
  nameHindi: string;
  unit: string;
  currentStock: number;
  dailyRate: number;
  daysLeft: number;
}

/** In-stock items that will run out within `maxDays` at the current selling rate. */
export async function runOutList(shopId: Types.ObjectId, maxDays = 7, now = new Date()) {
  const products = (await activeProducts(shopId)).filter((p) => p.currentStock > 0);
  const fc = await forecastFor(shopId, products, now);
  const items: RunOutItem[] = [];
  for (const p of products) {
    const f = fc.get(String(p._id))!;
    if (f.daysLeft === null || f.daysLeft > maxDays) continue;
    items.push({ id: String(p._id), name: p.name, nameHindi: p.nameHindi ?? '', unit: p.unit, currentStock: p.currentStock, dailyRate: f.dailyRate, daysLeft: f.daysLeft });
  }
  items.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
  return { maxDays, within3: items.filter((i) => i.daysLeft <= 3).length, within7: items.length, items };
}

export interface ReorderItem {
  productId: string;
  name: string;
  nameHindi: string;
  unit: string;
  currentStock: number;
  dailyRate: number;
  daysLeft: number | null;
  qty: number;
  /** Last purchase price, paise per unit. */
  rate: number;
  reason: 'forecast' | 'low_stock';
}
export interface ReorderGroup {
  supplier: { id: string; name: string; phone: string } | null;
  items: ReorderItem[];
  /** Estimated cost in paise. */
  total: number;
}

export async function reorderDaysFor(shopId: Types.ObjectId): Promise<number> {
  const user = await User.findById(shopId).select('settings');
  return user?.settings?.reorderDays ?? DEFAULT_REORDER_DAYS;
}

/** Suggested order list for the next `days`, grouped by each product's supplier. */
export async function reorderSuggestions(shopId: Types.ObjectId, days?: number, now = new Date()) {
  const forDays = days ?? (await reorderDaysFor(shopId));
  const products = await activeProducts(shopId);
  const fc = await forecastFor(shopId, products, now);

  const groups = new Map<string, ReorderItem[]>();
  for (const p of products) {
    const f = fc.get(String(p._id))!;
    const qty = reorderQtyFor({ dailyRate: f.dailyRate, currentStock: p.currentStock, lowStockThreshold: p.lowStockThreshold, unit: p.unit }, forDays);
    if (qty <= 0) continue;
    const key = p.supplierId ? String(p.supplierId) : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({
      productId: String(p._id),
      name: p.name,
      nameHindi: p.nameHindi ?? '',
      unit: p.unit,
      currentStock: p.currentStock,
      dailyRate: f.dailyRate,
      daysLeft: f.daysLeft,
      qty,
      rate: p.purchasePrice,
      reason: f.dailyRate > 0 ? 'forecast' : 'low_stock',
    });
  }

  const supplierIds = [...groups.keys()].filter(Boolean);
  const suppliers = supplierIds.length ? await Supplier.find({ shopId, _id: { $in: supplierIds }, isDeleted: false }).select('name phone') : [];
  const supById = new Map(suppliers.map((s) => [String(s._id), { id: String(s._id), name: s.name, phone: s.phone ?? '' }]));

  // Products whose supplier was deleted go to "no supplier".
  const merged = new Map<string, { supplier: ReorderGroup['supplier']; items: ReorderItem[] }>();
  for (const [key, items] of groups) {
    const supplier = key ? supById.get(key) ?? null : null;
    const k = supplier?.id ?? '';
    if (!merged.has(k)) merged.set(k, { supplier, items: [] });
    merged.get(k)!.items.push(...items);
  }
  const result: ReorderGroup[] = [...merged.values()].map((g) => {
    g.items.sort((a, b) => (a.daysLeft ?? -1) - (b.daysLeft ?? -1) || a.name.localeCompare(b.name));
    return { ...g, total: g.items.reduce((s, i) => s + Math.round(i.qty * i.rate), 0) };
  });
  // Named suppliers first (largest order first), "no supplier" last.
  result.sort((a, b) => Number(!a.supplier) - Number(!b.supplier) || b.total - a.total);
  return { days: forDays, groups: result };
}
