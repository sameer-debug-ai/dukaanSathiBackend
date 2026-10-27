import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { runInTransaction, transactionsEnabled } from '../config/db';
import { logger } from '../config/logger';
import { Customer } from '../models/customer.model';
import { Supplier } from '../models/supplier.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { AppError } from '../utils/AppError';
import { lineTotal } from '../utils/money';
import { objectId, optionalDate, trimmed } from '../validators/common';
import { addCreditSchema, addPaymentSchema, createCustomerSchema } from '../validators/customer.validators';
import { adjustStockSchema, createProductSchema } from '../validators/product.validators';
import { createSaleSchema } from '../validators/sale.validators';
import { createPurchaseSchema, createSupplierPaymentSchema } from '../validators/supplier.validators';
import { addCredit, addPayment, createCustomer } from './customer.service';
import { adjustStock, createProduct } from './product.service';
import { createSale } from './sale.service';
import { createPurchase, createSupplierPayment } from './supplier.service';
import { undoVoiceCommand } from './voiceUndo.service';

const money = z.number().int().min(0).nullable().default(null);

/** One reviewed action from the confirmation card (same shape the app uses for a single command). */
const batchAction = z.object({
  intent: z.enum(['add_credit', 'receive_payment', 'add_purchase', 'supplier_payment', 'add_sale', 'adjust_stock', 'add_product']),
  customerId: objectId.optional(),
  newCustomerName: trimmed(100).optional(),
  supplierId: objectId.optional(),
  productId: objectId.optional(),
  productName: trimmed(120).optional(),
  amount: money,
  paidAmount: money,
  quantity: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
  sellingPrice: money,
  paymentMode: z.enum(['cash', 'upi', 'udhaar', 'bank']).nullable().default(null),
  date: optionalDate,
  items: z
    .array(z.object({ productId: objectId.optional(), name: trimmed(120), qty: z.number().positive(), unit: z.string().nullable().default(null), rate: z.number().int().min(0).nullable() }))
    .default([]),
});

export const executeBatchSchema = z.object({
  logId: objectId,
  /** The spoken sentence, stored on udhaar entries like single voice saves do. */
  text: trimmed(1000).default(''),
  /** "Voice entry" in the app's language, used as the note on every record. */
  note: trimmed(300).default(''),
  actions: z.array(batchAction).min(1).max(5),
});

export type ExecuteBatchInput = z.infer<typeof executeBatchSchema>;
type BatchAction = z.infer<typeof batchAction>;

/** What each saved action did, for the success message and spoken reply. */
export interface BatchOutcome {
  intent: BatchAction['intent'];
  name: string;
  amount: number;
  /** Customer's udhaar / supplier's due after this action. */
  balance?: number;
  billNumber?: number;
  stock?: number;
  unit?: string;
}

/**
 * Saves every action of a multi-action voice command in ONE transaction, through the same
 * services the forms use. All effects land on the one voice log, so Undo reverses the whole group.
 * On a standalone mongod (no transactions) a failure part-way is compensated by undoing what
 * was already saved.
 */
export async function executeVoiceBatch(shopId: Types.ObjectId, input: ExecuteBatchInput, userId?: string): Promise<BatchOutcome[]> {
  const log = await VoiceCommandLog.findOne({ _id: input.logId, shopId }).select('status');
  if (!log) throw AppError.notFound('Voice command not found');
  if (log.status === 'confirmed' || log.status === 'undone') throw new AppError(409, 'These entries were already saved');

  try {
    return await runInTransaction(async (session) => {
      const out: BatchOutcome[] = [];
      for (const [i, action] of input.actions.entries()) {
        try {
          out.push(await executeOne(shopId, action, input, session, userId));
        } catch (err) {
          if (err instanceof AppError) throw new AppError(err.statusCode, `${i + 1}: ${err.message}`, err.details);
          throw err;
        }
      }
      return out;
    });
  } catch (err) {
    if (!transactionsEnabled()) {
      const saved = await VoiceCommandLog.findOne({ _id: input.logId, shopId, status: 'confirmed', 'effects.0': { $exists: true } }).select('_id');
      if (saved) {
        await undoVoiceCommand(shopId, input.logId, userId).catch((e) => logger.error('Could not roll back a partly saved voice batch', e));
        await VoiceCommandLog.updateOne({ _id: input.logId, shopId }, { $set: { status: 'failed', error: err instanceof Error ? err.message : 'Save failed' } });
      }
    }
    throw err;
  }
}

async function executeOne(
  shopId: Types.ObjectId,
  a: BatchAction,
  batch: ExecuteBatchInput,
  session: ClientSession | undefined,
  userId?: string,
): Promise<BatchOutcome> {
  const voiceLogId = batch.logId;
  const common = { date: a.date, source: 'voice' as const, voiceLogId };
  const mode = (m: BatchAction['paymentMode']) => (m === 'upi' || m === 'bank' ? m : 'cash');

  // A new person taking udhaar: add them to the khata first (undo removes them again).
  let customerId = a.customerId;
  if (!customerId && a.newCustomerName && (a.intent === 'add_credit' || (a.intent === 'add_sale' && a.paymentMode === 'udhaar'))) {
    customerId = String((await createCustomer(shopId, createCustomerSchema.parse({ name: a.newCustomerName, voiceLogId }), session))._id);
  }

  switch (a.intent) {
    case 'add_credit': {
      if (!customerId) throw AppError.badRequest('Select a customer');
      const allMatched = a.items.length > 0 && a.items.every((i) => i.productId && i.rate !== null);
      if (allMatched) {
        // Goods on udhaar: a sale with paymentMode "udhaar" so stock and ledger both update.
        const sale = await createSale(
          shopId,
          createSaleSchema.parse({ ...common, customerId, items: a.items.map((i) => ({ productId: i.productId, qty: i.qty, rate: i.rate })), paymentMode: 'udhaar' }),
          userId,
          session,
        );
        return { intent: a.intent, name: sale.customerName, amount: sale.totalAmount, billNumber: sale.billNumber, balance: await balanceOf(shopId, customerId, session) };
      }
      const { customer } = await addCredit(
        shopId,
        customerId,
        addCreditSchema.parse({
          ...common,
          amount: a.amount ?? 0,
          items: a.items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, rate: i.rate ?? 0 })),
          note: batch.note,
          rawVoiceText: batch.text || undefined,
        }),
        session,
      );
      return { intent: a.intent, name: customer.name, amount: a.amount ?? 0, balance: customer.currentBalance };
    }
    case 'receive_payment': {
      if (!customerId) throw AppError.badRequest('Select a customer');
      const { customer } = await addPayment(
        shopId,
        customerId,
        addPaymentSchema.parse({ ...common, amount: a.amount ?? 0, mode: mode(a.paymentMode), note: batch.note, rawVoiceText: batch.text || undefined }),
        session,
      );
      return { intent: a.intent, name: customer.name, amount: a.amount ?? 0, balance: customer.currentBalance };
    }
    case 'add_purchase': {
      if (!a.supplierId) throw AppError.badRequest('Select a supplier');
      if (a.items.some((i) => i.rate === null)) throw AppError.badRequest('Add a rate for every item');
      const items = a.items.map((i) =>
        i.productId
          ? { productId: i.productId, qty: i.qty, rate: i.rate! }
          : { newProduct: { name: i.name, unit: i.unit ?? 'piece' }, qty: i.qty, rate: i.rate! },
      );
      const total = items.reduce((s, i) => s + lineTotal(i.qty, i.rate), 0);
      const purchase = await createPurchase(
        shopId,
        createPurchaseSchema.parse({ ...common, supplierId: a.supplierId, items, paidAmount: Math.min(a.paidAmount ?? 0, total), note: batch.note }),
        userId,
        session,
      );
      return { intent: a.intent, name: await supplierName(shopId, a.supplierId, session), amount: purchase.totalAmount };
    }
    case 'supplier_payment': {
      if (!a.supplierId) throw AppError.badRequest('Select a supplier');
      const { supplier } = await createSupplierPayment(
        shopId,
        createSupplierPaymentSchema.parse({ ...common, supplierId: a.supplierId, amount: a.amount ?? 0, mode: mode(a.paymentMode), note: batch.note }),
        session,
      );
      return { intent: a.intent, name: supplier.name, amount: a.amount ?? 0, balance: supplier.currentPayable };
    }
    case 'add_sale': {
      if (!a.items.length || a.items.some((i) => !i.productId)) throw AppError.badRequest('Pick a product for every item');
      const paymentMode = a.paymentMode === 'udhaar' ? 'udhaar' : a.paymentMode === 'upi' ? 'upi' : 'cash';
      if (paymentMode === 'udhaar' && !customerId) throw AppError.badRequest('Select a customer');
      const sale = await createSale(
        shopId,
        createSaleSchema.parse({ ...common, customerId, items: a.items.map((i) => ({ productId: i.productId, qty: i.qty, rate: i.rate ?? undefined })), paymentMode }),
        userId,
        session,
      );
      return {
        intent: a.intent,
        name: sale.customerName,
        amount: sale.totalAmount,
        billNumber: sale.billNumber,
        balance: paymentMode === 'udhaar' && customerId ? await balanceOf(shopId, customerId, session) : undefined,
      };
    }
    case 'adjust_stock': {
      if (!a.productId) throw AppError.badRequest('Select a product');
      const p = await adjustStock(shopId, adjustStockSchema.parse({ productId: a.productId, quantity: a.quantity ?? 0, type: 'adjustment', note: batch.note, voiceLogId }), userId, session);
      return { intent: a.intent, name: String(p.name), amount: 0, stock: Number(p.currentStock), unit: String(p.unit) };
    }
    case 'add_product': {
      if (!a.productName) throw AppError.badRequest('Say the product name');
      const p = await createProduct(
        shopId,
        createProductSchema.parse({ name: a.productName, sellingPrice: a.sellingPrice ?? 0, purchasePrice: 0, unit: a.unit ?? 'piece', voiceLogId }),
        userId,
        session ?? undefined,
      );
      return { intent: a.intent, name: p.name, amount: p.sellingPrice };
    }
  }
}

async function balanceOf(shopId: Types.ObjectId, customerId: string, session?: ClientSession): Promise<number | undefined> {
  return (await Customer.findOne({ _id: customerId, shopId }).select('currentBalance').session(session ?? null))?.currentBalance;
}

async function supplierName(shopId: Types.ObjectId, supplierId: string, session?: ClientSession): Promise<string> {
  return (await Supplier.findOne({ _id: supplierId, shopId }).select('name').session(session ?? null))?.name ?? '';
}
