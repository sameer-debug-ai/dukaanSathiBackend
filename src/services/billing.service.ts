import type { ClientSession, Types } from 'mongoose';
import { runInTransaction } from '../config/db';
import { BillSequence } from '../models/billSequence.model';
import { Customer } from '../models/customer.model';
import { Product } from '../models/product.model';
import { Sale } from '../models/sale.model';
import { User } from '../models/user.model';
import { AppError } from '../utils/AppError';
import { escapeRegex } from '../utils/pagination';
import { GST_STATES, defaultInvoicePrefix, financialYear, formatInvoiceNo, stateOfGstin } from '../utils/gst';
import type { CancelSaleInput, UpdateBillingInput } from '../validators/billing.validators';
import type { GstByCategoryInput } from '../validators/product.validators';
import { addLedgerEntry } from './ledger.service';
import { applyStockChange } from './stock.service';

export async function getBillingSettings(shopId: Types.ObjectId) {
  const shop = await User.findById(shopId).select('shopName billing');
  if (!shop) throw AppError.notFound('Shop not found');
  const { billing } = shop.toJSON() as { billing?: Record<string, unknown> };
  return {
    ...billing,
    defaultPrefix: defaultInvoicePrefix(shop.shopName),
    states: Object.entries(GST_STATES).map(([code, name]) => ({ code, name })),
  };
}

export async function updateBillingSettings(shopId: Types.ObjectId, input: UpdateBillingInput) {
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) update[`billing.${k}`] = v;
  // The GSTIN decides the state; keep the old profile field in step for older screens.
  if (input.gstin) {
    update['billing.stateCode'] = stateOfGstin(input.gstin);
    update.gstNumber = input.gstin;
  }
  const shop = await User.findById(shopId).select('billing');
  const gstOn = input.gstEnabled ?? shop?.billing?.gstEnabled ?? false;
  const gstin = input.gstin ?? shop?.billing?.gstin ?? '';
  if (gstOn && !gstin) throw AppError.badRequest('Enter your GSTIN to turn on GST bills');
  await User.updateOne({ _id: shopId }, { $set: update }, { runValidators: true });
  return getBillingSettings(shopId);
}

/**
 * Next invoice number for the financial year of `date`, e.g. KGS/2026-27/0001. A single
 * $inc on a per-year counter, so two bills saved at the same moment never get the same number.
 */
export async function nextInvoiceNo(shopId: Types.ObjectId, prefix: string, date: Date, session?: ClientSession): Promise<{ invoiceNo: string; fy: string }> {
  const fy = financialYear(date);
  const bump = () => BillSequence.findOneAndUpdate({ shopId, fy }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  let doc;
  try {
    doc = await bump();
  } catch (err) {
    // Two first-bills-of-the-year at once: one upsert wins, the other retries as an update.
    if ((err as { code?: number }).code !== 11000) throw err;
    doc = await bump();
  }
  return { invoiceNo: formatInvoiceNo(prefix, fy, doc!.seq), fy };
}

/** Sets the GST rate (and optionally HSN / inclusive) on every product of a category. */
export async function setGstByCategory(shopId: Types.ObjectId, input: GstByCategoryInput) {
  const set: Record<string, unknown> = { gstRate: input.gstRate };
  if (input.hsnCode !== undefined) set.hsnCode = input.hsnCode;
  if (input.priceIncludesGst !== undefined) set.priceIncludesGst = input.priceIncludesGst;
  const res = await Product.updateMany(
    { shopId, isDeleted: false, category: { $regex: `^\\s*${escapeRegex(input.category.trim())}\\s*$`, $options: 'i' } },
    { $set: set },
  );
  return { updated: res.modifiedCount, matched: res.matchedCount };
}

/**
 * Cancels a bill: it stays (with its number) but is marked cancelled, its stock goes back
 * through StockMovement and its udhaar is taken back with a ledger entry. Money already paid
 * at the counter has to be returned by hand.
 */
export async function cancelSale(shopId: Types.ObjectId, id: string, input: CancelSaleInput, userId?: string) {
  return runInTransaction(async (session) => {
    const sale = await Sale.findOneAndUpdate(
      { _id: id, shopId, status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: input.reason } },
      { new: true, session },
    );
    if (!sale) {
      const exists = await Sale.exists({ _id: id, shopId }).session(session ?? null);
      throw exists ? AppError.conflict('This bill is already cancelled') : AppError.notFound('Bill not found');
    }
    const label = sale.invoiceNo ?? `#${sale.billNumber}`;

    // A product deleted since the sale has no stock to return.
    const live = new Set(
      (await Product.find({ shopId, _id: { $in: sale.items.map((i) => i.productId) }, isDeleted: false }).select('_id').session(session ?? null)).map((p) => String(p._id)),
    );
    for (const item of sale.items) {
      if (!live.has(String(item.productId))) continue;
      await applyStockChange(
        { shopId, productId: item.productId, quantity: item.qty, type: 'return', referenceType: 'sale', referenceId: sale._id, note: `Bill ${label} cancelled`, userId },
        session,
      );
    }

    if (sale.creditAmount > 0 && sale.customerId) {
      const customer = await Customer.exists({ _id: sale.customerId, shopId, isDeleted: false }).session(session ?? null);
      if (customer) {
        await addLedgerEntry(
          {
            shopId,
            customerId: sale.customerId,
            type: 'payment',
            amount: sale.creditAmount,
            note: `Bill ${label} cancelled: ${input.reason}`,
            source: 'sale',
            saleId: sale._id,
            reversalOf: sale._id,
          },
          session,
        );
      }
    }
    return sale.toJSON();
  });
}
