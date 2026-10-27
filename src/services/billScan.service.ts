import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { matchBill, validateBillScan, type MatchedBill } from '../ai/billScan';
import { ClaudeBillVision, type BillImageType, type BillVisionProvider } from '../ai/billVision.provider';
import type { MatchTarget } from '../ai/matcher';
import { AiProviderError } from '../ai/provider';
import { logger } from '../config/logger';
import { BillImage } from '../models/billImage.model';
import { Product } from '../models/product.model';
import { Purchase } from '../models/purchase.model';
import { Supplier } from '../models/supplier.model';
import { getStorage } from '../storage/storage';
import { AppError } from '../utils/AppError';
import { istDayKey } from '../utils/istDate';

let vision: BillVisionProvider = new ClaudeBillVision();
/** Swap the vision provider (tests). */
export const setBillVisionProvider = (p: BillVisionProvider) => {
  vision = p;
};

/** Bill photos never linked to a purchase are removed after this long. */
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

/** The real type from the file's first bytes (the Content-Type header alone is not trusted). */
export function detectImageType(buf: Buffer): BillImageType | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export type BillScanResult = MatchedBill & { scanId: string | null; engine: string };

async function shopTargets(shopId: Types.ObjectId): Promise<{ suppliers: MatchTarget[]; products: MatchTarget[] }> {
  const [suppliers, products] = await Promise.all([
    Supplier.find({ shopId, isDeleted: false }).select('name aliases company').limit(500),
    Product.find({ shopId, isDeleted: false }).select('name nameHindi aliases unit currentStock').limit(3000),
  ]);
  return {
    suppliers: suppliers.map((s) => ({ id: String(s._id), name: s.name, aliases: [...s.aliases, s.company].filter(Boolean), subtitle: s.company })),
    products: products.map((p) => ({ id: String(p._id), name: p.name, aliases: [p.nameHindi, ...p.aliases].filter(Boolean), subtitle: `${p.currentStock} ${p.unit}` })),
  };
}

/** Reads the photo with the vision model; one retry on invalid output or a retryable error. */
async function readBill(image: Buffer, contentType: BillImageType) {
  const todayIst = istDayKey(new Date());
  let previousError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await vision.scan({ image, contentType, todayIst, previousError });
      const result = validateBillScan(raw, todayIst);
      if (result.ok) return result.value;
      previousError = result.error;
    } catch (err) {
      if (err instanceof AiProviderError && err.retryable && attempt === 0) {
        previousError = err.message;
        continue;
      }
      throw err;
    }
  }
  throw new AiProviderError(`Bill scan output failed validation twice: ${previousError}`, false);
}

/** Deletes this shop's scanned photos that were never saved as a purchase. Best effort. */
async function removeOrphans(shopId: Types.ObjectId): Promise<void> {
  const old = await BillImage.find({ shopId, purchaseId: null, createdAt: { $lt: new Date(Date.now() - ORPHAN_AFTER_MS) } }).limit(20);
  for (const img of old) {
    try {
      await getStorage().delete(img.key);
      await BillImage.deleteOne({ _id: img._id, shopId });
    } catch (err) {
      logger.warn('Could not remove an old bill photo', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Photo in, reviewed-ready purchase draft out. Nothing is saved as a purchase here: the app shows
 * the draft for review and saves through the normal purchase endpoint.
 */
export async function scanBillPhoto(shopId: Types.ObjectId, image: Buffer): Promise<BillScanResult> {
  if (!vision.isAvailable()) throw new AppError(503, 'Bill scanning needs the AI to be set up on this server (ANTHROPIC_API_KEY)');
  const contentType = detectImageType(image);
  if (!contentType) throw new AppError(415, 'Please send a photo (JPG, PNG or WebP)');
  if (image.length < 2000) throw AppError.badRequest('The photo is empty. Please take it again.');

  void removeOrphans(shopId);

  let scanned;
  try {
    scanned = await readBill(image, contentType);
  } catch (err) {
    if (err instanceof AiProviderError) {
      logger.warn('Bill scan failed', err.message);
      throw new AppError(502, 'Could not read the bill right now. Please try again in a moment.', { code: 'SCAN_FAILED' });
    }
    throw err;
  }

  const { suppliers, products } = await shopTargets(shopId);
  const matched = matchBill(scanned, suppliers, products);
  // A blurry / non-bill photo is not kept: there is nothing to review.
  if (!matched.readable) return { ...matched, scanId: null, engine: vision.name };

  const storage = getStorage();
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const key = `bills/${String(shopId)}/${istDayKey(new Date())}/${randomUUID()}.${ext}`;
  await storage.put(key, image, contentType);
  const doc = await BillImage.create({
    shopId,
    key,
    storage: storage.name,
    contentType,
    size: image.length,
    scan: { supplierName: scanned.supplierName, invoiceNumber: scanned.invoiceNumber, date: scanned.date, items: scanned.items, total: scanned.total },
  });
  return { ...matched, scanId: String(doc._id), engine: vision.name };
}

/** Links a scanned photo to the purchase saved from it (after the user confirmed). */
export async function attachBillImage(shopId: Types.ObjectId, imageId: string, purchaseId: string) {
  const purchase = await Purchase.exists({ _id: purchaseId, shopId });
  if (!purchase) throw AppError.notFound('Purchase not found');
  const img = await BillImage.findOneAndUpdate(
    { _id: imageId, shopId, $or: [{ purchaseId: null }, { purchaseId }] },
    { $set: { purchaseId } },
    { new: true },
  );
  if (!img) throw AppError.notFound('Bill photo not found (it may have expired). Please scan it again.');
  return { id: String(img._id), purchaseId };
}

async function load(filter: Record<string, unknown>) {
  const img = await BillImage.findOne(filter).sort({ createdAt: -1 });
  if (!img) return null;
  const data = await getStorage().get(img.key);
  return data ? { data, contentType: img.contentType } : null;
}

export async function readBillImage(shopId: Types.ObjectId, imageId: string) {
  const out = await load({ _id: imageId, shopId });
  if (!out) throw AppError.notFound('Bill photo not found');
  return out;
}

export async function readPurchaseBillImage(shopId: Types.ObjectId, purchaseId: string) {
  const out = await load({ shopId, purchaseId });
  if (!out) throw AppError.notFound('No bill photo for this purchase');
  return out;
}
