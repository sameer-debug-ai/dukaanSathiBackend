import type { ClientSession, Types } from 'mongoose';
import { runInTransaction, transactionsEnabled } from '../config/db';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product } from '../models/product.model';
import { Purchase } from '../models/purchase.model';
import { Sale } from '../models/sale.model';
import { Supplier } from '../models/supplier.model';
import { SupplierPayment } from '../models/supplierPayment.model';
import { User } from '../models/user.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { AppError } from '../utils/AppError';
import { ledgerDelta } from './ledger.service';
import { applyStockChange, round3 } from './stock.service';

type Effect = {
  kind: string;
  id?: Types.ObjectId | null;
  productId?: Types.ObjectId | null;
  quantity?: number | null;
  prevPrices?: { productId?: Types.ObjectId | null; purchasePrice?: number | null }[] | null;
};

const DEFAULT_UNDO_SECONDS = 60;

export async function undoWindowMs(shopId: Types.ObjectId): Promise<number> {
  const shop = await User.findById(shopId).select('settings');
  return (shop?.settings?.voiceUndoSeconds ?? DEFAULT_UNDO_SECONDS) * 1000;
}

/** The most recent saved voice command that can still be undone, if any. */
export async function lastUndoableVoiceLog(shopId: Types.ObjectId) {
  const cutoff = new Date(Date.now() - (await undoWindowMs(shopId)));
  return VoiceCommandLog.findOne({ shopId, status: 'confirmed', 'effects.0': { $exists: true }, executedAt: { $gte: cutoff } }).sort({ executedAt: -1 });
}

/**
 * Reverses everything a saved voice command did (ledger entries, balances, bills, purchases,
 * payments, stock) in one transaction, then marks its log 'undone'. Stock is put back with
 * new 'reversal' StockMovements so the history stays complete.
 */
export async function undoVoiceCommand(shopId: Types.ObjectId, logId: string, userId?: string) {
  const windowMs = await undoWindowMs(shopId);
  const now = new Date();
  let claimed = false;
  try {
    return await runInTransaction(async (session) => {
      // Claim the log first so two taps on "Undo" can never reverse twice.
      const log = await VoiceCommandLog.findOneAndUpdate(
        { _id: logId, shopId, status: 'confirmed', 'effects.0': { $exists: true }, executedAt: { $gte: new Date(now.getTime() - windowMs) } },
        { $set: { status: 'undone', undoneAt: now } },
        { new: true, session },
      );
      if (!log) throw await whyNotUndoable(shopId, logId, windowMs);
      claimed = true;

      for (const effect of [...log.effects].reverse()) await reverse(shopId, effect as Effect, session, userId);
      return log.toJSON();
    });
  } catch (err) {
    // With transactions everything above rolled back. Without them (standalone mongod) at least
    // release the claim so the user can retry once the blocking problem is fixed.
    if (claimed && !transactionsEnabled()) {
      await VoiceCommandLog.updateOne({ _id: logId, shopId, status: 'undone', undoneAt: now }, { $set: { status: 'confirmed' }, $unset: { undoneAt: 1 } });
    }
    throw err;
  }
}

async function whyNotUndoable(shopId: Types.ObjectId, logId: string, windowMs: number): Promise<AppError> {
  const log = await VoiceCommandLog.findOne({ _id: logId, shopId }).select('status effects executedAt');
  if (!log) return AppError.notFound('Voice command not found');
  if (log.status === 'undone') return new AppError(409, 'This entry was already undone');
  if (!log.effects.length || log.status !== 'confirmed') return AppError.badRequest('Nothing was saved by this command, so there is nothing to undo');
  const secs = Math.round(windowMs / 1000);
  return new AppError(409, `Undo is only possible within ${secs} seconds of saving. Please correct it from the record instead.`);
}

async function reverse(shopId: Types.ObjectId, e: Effect, session: ClientSession | undefined, userId?: string): Promise<void> {
  const s = session ?? null;
  switch (e.kind) {
    case 'ledger': {
      const entry = await CustomerLedger.findOne({ _id: e.id, shopId }).session(s);
      if (!entry) return;
      await CustomerLedger.deleteOne({ _id: entry._id, shopId }, { session });
      await Customer.updateOne({ _id: entry.customerId, shopId }, { $inc: { currentBalance: -ledgerDelta(entry) } }, { session });
      return;
    }
    case 'sale': {
      const sale = await Sale.findOne({ _id: e.id, shopId }).session(s);
      if (!sale) return;
      // Cancelling already gave the stock and udhaar back; undoing too would do it twice.
      if (sale.status === 'cancelled') throw AppError.conflict('This bill was cancelled already, so there is nothing to undo');
      for (const item of sale.items) {
        await applyStockChange(
          { shopId, productId: item.productId, quantity: item.qty, type: 'reversal', referenceType: 'sale', referenceId: sale._id, note: `Undo bill #${sale.billNumber}`, userId },
          session,
        );
      }
      // The udhaar part of the bill lives in the customer's ledger.
      const credits = await CustomerLedger.find({ shopId, saleId: sale._id }).session(s);
      for (const c of credits) {
        await CustomerLedger.deleteOne({ _id: c._id, shopId }, { session });
        await Customer.updateOne({ _id: c.customerId, shopId }, { $inc: { currentBalance: -ledgerDelta(c) } }, { session });
      }
      await Sale.deleteOne({ _id: sale._id, shopId }, { session });
      return;
    }
    case 'purchase': {
      const purchase = await Purchase.findOne({ _id: e.id, shopId }).session(s);
      if (!purchase) return;
      for (const item of purchase.items) {
        const product = await Product.findOne({ _id: item.productId, shopId }).session(s);
        if (product && round3(product.currentStock - item.qty) < 0) {
          throw new AppError(409, `${product.name} from this purchase has already been sold, so it cannot be undone. Adjust the stock instead.`);
        }
        await applyStockChange(
          { shopId, productId: item.productId, quantity: -item.qty, type: 'reversal', referenceType: 'purchase', referenceId: purchase._id, note: 'Undo purchase', userId },
          session,
        );
      }
      for (const p of e.prevPrices ?? []) {
        if (p.productId && typeof p.purchasePrice === 'number') {
          await Product.updateOne({ _id: p.productId, shopId }, { $set: { purchasePrice: p.purchasePrice } }, { session });
        }
      }
      await Supplier.updateOne({ _id: purchase.supplierId, shopId }, { $inc: { currentPayable: -purchase.dueAmount } }, { session });
      await Purchase.deleteOne({ _id: purchase._id, shopId }, { session });
      return;
    }
    case 'supplierPayment': {
      const payment = await SupplierPayment.findOne({ _id: e.id, shopId }).session(s);
      if (!payment) return;
      await Supplier.updateOne({ _id: payment.supplierId, shopId }, { $inc: { currentPayable: payment.amount } }, { session });
      await SupplierPayment.deleteOne({ _id: payment._id, shopId }, { session });
      return;
    }
    case 'stock': {
      const quantity = e.quantity ?? 0;
      if (!e.productId || !quantity) return;
      const product = await Product.findOne({ _id: e.productId, shopId }).session(s);
      if (product && round3(product.currentStock - quantity) < 0) {
        throw new AppError(409, `${product.name} stock has changed since, so this cannot be undone. Adjust the stock instead.`);
      }
      await applyStockChange({ shopId, productId: e.productId, quantity: -quantity, type: 'reversal', note: 'Undo voice stock change', userId }, session);
      return;
    }
    case 'product':
      // Added by this command (directly or inside a purchase that was just reversed).
      await Product.updateOne({ _id: e.id, shopId }, { $set: { isDeleted: true, isActive: false } }, { session });
      return;
    case 'customer': {
      // A new person added for this udhaar; only removed if nothing else is on their khata.
      const customer = await Customer.findOne({ _id: e.id, shopId }).session(s);
      if (!customer || customer.currentBalance !== 0) return;
      const otherEntries = await CustomerLedger.countDocuments({ shopId, customerId: customer._id }).session(s);
      if (otherEntries === 0) await Customer.updateOne({ _id: customer._id, shopId }, { $set: { isDeleted: true } }, { session });
      return;
    }
  }
}
