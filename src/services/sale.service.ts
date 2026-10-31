import { Types, type ClientSession } from 'mongoose';
import { runInTransaction } from '../config/db';
import { Customer } from '../models/customer.model';
import { Product } from '../models/product.model';
import { NOT_CANCELLED, Sale, type DocType, type SalePaymentMode } from '../models/sale.model';
import { User } from '../models/user.model';
import { AppError } from '../utils/AppError';
import { amountInWordsEn, amountInWordsHi } from '../utils/amountWords';
import { defaultInvoicePrefix, stateOfGstin } from '../utils/gst';
import { computeBill, type TaxMode } from './billCalc';
import { nextInvoiceNo } from './billing.service';
import { resolveRange } from '../utils/istDate';
import { lineTotal } from '../utils/money';
import { escapeRegex, getPageParams, pageMeta } from '../utils/pagination';
import type { CreateSaleInput, SaleListQuery } from '../validators/sale.validators';
import { addLedgerEntry } from './ledger.service';
import { attachRef } from './lookup';
import { applyStockChange, round3 } from './stock.service';
import { recordVoiceEffect } from './voiceEffects';

/** Splits a bill total into paid now vs. added to udhaar. Pure for testing. */
export function splitPayment(mode: SalePaymentMode, total: number, paidInput?: number): { paid: number; credit: number } {
  switch (mode) {
    case 'cash':
    case 'upi':
      return { paid: total, credit: 0 };
    case 'udhaar':
      return { paid: 0, credit: total };
    case 'partial': {
      const paid = paidInput ?? 0;
      if (paid <= 0 || paid >= total) {
        throw AppError.badRequest('For partial payment, paid amount must be more than 0 and less than the bill total');
      }
      return { paid, credit: total - paid };
    }
  }
}

export interface StockShortage {
  productId: string;
  name: string;
  available: number;
  requested: number;
  unit: string;
}

type BillInput = Pick<CreateSaleInput, 'items' | 'discount' | 'customerId' | 'buyerName' | 'buyerGstin' | 'buyerStateCode'>;

/**
 * Everything a bill needs before it is saved: products, customer, line items and the totals
 * (tax included for GST shops). Shared by createSale and the billing screen's preview.
 */
async function prepareBill(shopId: Types.ObjectId, input: BillInput, session: ClientSession | undefined) {
  const shop = await User.findById(shopId).select('settings billing shopName shopAddress phone').session(session ?? null);
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const products = await Product.find({ shopId, _id: { $in: ids }, isDeleted: false }).session(session ?? null);
  const byId = new Map(products.map((p) => [String(p._id), p]));
  if (byId.size !== ids.length) throw AppError.notFound('One or more products were not found');

  let customer = null;
  if (input.customerId) {
    customer = await Customer.findOne({ _id: input.customerId, shopId, isDeleted: false }).session(session ?? null);
    if (!customer) throw AppError.notFound('Customer not found');
  }

  const b = shop?.billing;
  const mode: TaxMode = !b?.gstEnabled ? 'none' : b.composition ? 'composition' : 'gst';
  const seller = {
    name: b?.shopName || shop?.shopName || '',
    address: b?.address || shop?.shopAddress || '',
    phone: b?.phone || shop?.phone || '',
    gstin: mode === 'none' ? '' : (b?.gstin ?? ''),
    stateCode: mode === 'none' ? '' : b?.stateCode || stateOfGstin(b?.gstin),
  };
  const buyerGstin = input.buyerGstin || customer?.gstin || '';
  // A business name typed on the bill is a different party: don't print the customer's phone / address with it.
  const fromCustomer = !input.buyerName;
  const buyer = {
    name: input.buyerName || customer?.name || '',
    address: fromCustomer ? (customer?.address ?? '') : '',
    phone: fromCustomer ? (customer?.phone ?? '') : '',
    gstin: buyerGstin,
    stateCode: input.buyerStateCode || customer?.stateCode || stateOfGstin(buyerGstin),
  };
  // Customer from another state (by GSTIN or chosen state): IGST instead of CGST + SGST.
  const interState = mode === 'gst' && !!buyer.stateCode && !!seller.stateCode && buyer.stateCode !== seller.stateCode;

  const lines = input.items.map((i) => {
    const p = byId.get(i.productId)!;
    return { p, qty: i.qty, rate: i.rate ?? p.sellingPrice };
  });
  const subtotal = lines.reduce((s, l) => s + lineTotal(l.qty, l.rate), 0);
  if (input.discount > subtotal) throw AppError.badRequest('Discount cannot be more than the bill amount');
  const totals = computeBill(
    lines.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.p.gstRate ?? 0, inclusive: l.p.priceIncludesGst ?? true })),
    input.discount,
    { mode, interState },
  );
  const items = lines.map((l, n) => {
    const base = { productId: l.p._id, name: l.p.name, unit: l.p.unit, qty: l.qty, rate: l.rate, total: totals.lines[n]!.gross, costRate: l.p.purchasePrice };
    if (mode !== 'gst') return base;
    const t = totals.lines[n]!;
    return {
      ...base,
      hsnCode: l.p.hsnCode ?? '',
      gstRate: l.p.gstRate ?? 0,
      priceIncludesGst: l.p.priceIncludesGst ?? true,
      discountShare: t.discount,
      taxable: t.taxable,
      cgst: t.cgst,
      sgst: t.sgst,
      igst: t.igst,
    };
  });
  const docType: DocType = mode === 'gst' ? 'tax_invoice' : mode === 'composition' ? 'bill_of_supply' : 'bill';
  const tax =
    mode === 'gst'
      ? {
          taxableTotal: totals.taxableTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          taxTotal: totals.taxTotal,
          taxAdded: totals.taxAdded,
          roundOff: totals.roundOff,
          taxSummary: totals.taxSummary,
          interState,
        }
      : {};
  return { shop, byId, customer, items, totals, docType, seller, buyer, tax };
}

/** The billing screen's live total: same maths as saving, nothing written. */
export async function quoteSale(shopId: Types.ObjectId, input: BillInput) {
  const { items, totals, docType, buyer, tax } = await prepareBill(shopId, input, undefined);
  return {
    docType,
    items,
    subtotal: totals.subtotal,
    discount: totals.discount,
    totalAmount: totals.totalAmount,
    ...tax,
    buyer,
    amountInWords: { en: amountInWordsEn(totals.totalAmount), hi: amountInWordsHi(totals.totalAmount) },
  };
}

/** Bill JSON plus the total in words (English + Hindi) for printing. */
export const withWords = <T extends { totalAmount?: unknown }>(sale: T) => ({
  ...sale,
  amountInWords: { en: amountInWordsEn(Number(sale.totalAmount) || 0), hi: amountInWordsHi(Number(sale.totalAmount) || 0) },
});

export async function createSale(shopId: Types.ObjectId, input: CreateSaleInput, userId?: string, outer?: ClientSession) {
  const run = async (session: ClientSession | undefined) => {
    const { shop, byId, customer, items, totals, docType, seller, buyer, tax } = await prepareBill(shopId, input, session);

    // Stock check across lines (the same product may appear twice).
    const requested = new Map<string, number>();
    for (const i of input.items) requested.set(i.productId, round3((requested.get(i.productId) ?? 0) + i.qty));
    const shortages: StockShortage[] = [];
    for (const [id, qty] of requested) {
      const p = byId.get(id)!;
      if (qty > p.currentStock) shortages.push({ productId: id, name: p.name, available: p.currentStock, requested: qty, unit: p.unit });
    }
    const canOversell = input.allowOversell && (shop?.settings?.allowOversell ?? false);
    if (shortages.length && !canOversell) {
      throw new AppError(409, `Not enough stock: ${shortages.map((s) => `${s.name} (${s.available} ${s.unit} left)`).join(', ')}`, {
        code: 'INSUFFICIENT_STOCK',
        shortages,
      });
    }

    const { subtotal, totalAmount } = totals;
    const { paid, credit } = splitPayment(input.paymentMode, totalAmount, input.paidAmount);
    if (credit > 0 && !customer) throw AppError.badRequest('Select a customer for udhaar or partial payment');

    const counter = await User.findOneAndUpdate({ _id: shopId }, { $inc: { billCounter: 1 } }, { new: true, session });
    const billNumber = counter?.billCounter ?? 1;
    const saleId = new Types.ObjectId();
    const date = input.date ?? new Date();
    const prefix = shop?.billing?.invoicePrefix || defaultInvoicePrefix(shop?.shopName ?? '');
    const { invoiceNo, fy } = await nextInvoiceNo(shopId, prefix, date, session);

    const [sale] = await Sale.create(
      [
        {
          _id: saleId,
          shopId,
          billNumber,
          invoiceNo,
          fy,
          docType,
          seller,
          ...(buyer.name || buyer.gstin ? { buyer } : {}),
          ...tax,
          customerId: customer?._id,
          customerName: customer?.name ?? (input.buyerName || ''),
          items,
          subtotal,
          discount: input.discount,
          totalAmount,
          paymentMode: input.paymentMode,
          paidAmount: paid,
          creditAmount: credit,
          date,
          note: input.note,
          source: input.source,
        },
      ],
      { session },
    );

    for (const item of items) {
      await applyStockChange(
        { shopId, productId: item.productId, quantity: -item.qty, type: 'sale', referenceType: 'sale', referenceId: saleId, note: `Bill #${billNumber}`, userId, date },
        session,
      );
    }

    if (credit > 0 && customer) {
      await addLedgerEntry(
        {
          shopId,
          customerId: customer._id,
          type: 'credit',
          amount: credit,
          items: items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, rate: i.rate })),
          note: `Bill #${billNumber}${paid > 0 ? ' (partly paid)' : ''}`,
          source: input.source === 'voice' ? 'voice' : 'sale',
          saleId,
          date,
        },
        session,
      );
    } else if (customer) {
      await Customer.updateOne({ _id: customer._id, shopId }, { $max: { lastTransactionAt: date } }, { session });
    }
    await recordVoiceEffect(shopId, input.voiceLogId, [{ kind: 'sale', id: saleId }], session);

    return { ...withWords(sale!.toJSON()), warnings: shortages.length ? shortages : undefined };
  };
  return outer ? run(outer) : runInTransaction(run);
}

export async function listSales(shopId: Types.ObjectId, q: SaleListQuery) {
  const filter: Record<string, unknown> = { shopId };
  if (q.customerId) filter.customerId = new Types.ObjectId(q.customerId);
  if (q.paymentMode) filter.paymentMode = q.paymentMode;
  if (q.from || q.to) {
    const r = resolveRange(q.from, q.to);
    filter.date = { $gte: r.from, $lte: r.to };
  }
  if (q.search) {
    const n = Number(q.search.replace('#', ''));
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ customerName: rx }, { 'items.name': rx }, { invoiceNo: rx }, ...(Number.isInteger(n) && n > 0 ? [{ billNumber: n }] : [])];
  }
  if (q.status === 'cancelled') filter.status = 'cancelled';
  else if (q.status === 'active') Object.assign(filter, NOT_CANCELLED);
  const page = getPageParams(q, 30);
  const [docs, total, sums] = await Promise.all([
    Sale.find(filter).sort({ date: -1 }).skip(page.skip).limit(page.limit),
    Sale.countDocuments(filter),
    // A cancelled bill is listed but its amount is not a sale.
    Sale.aggregate<{ total: number }>([{ $match: { ...filter, ...(filter.status ? {} : NOT_CANCELLED) } }, { $group: { _id: null, total: { $sum: '$totalAmount' } } }]),
  ]);
  return { items: docs.map((d) => d.toJSON()), meta: { ...pageMeta(page, total), totalAmount: sums[0]?.total ?? 0 } };
}

export async function getSale(shopId: Types.ObjectId, id: string) {
  const doc = await Sale.findOne({ _id: id, shopId });
  if (!doc) throw AppError.notFound('Bill not found');
  const [row] = await attachRef([doc.toJSON() as Record<string, unknown>], 'customerId', Customer, shopId, 'name phone address currentBalance gstin stateCode');
  return withWords(row!);
}
