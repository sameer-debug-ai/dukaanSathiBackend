import type { Types } from 'mongoose';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Purchase } from '../models/purchase.model';
import { NOT_CANCELLED, Sale } from '../models/sale.model';
import { Supplier } from '../models/supplier.model';
import { SupplierPayment } from '../models/supplierPayment.model';
import { IST_TIMEZONE, resolveRange } from '../utils/istDate';
import { openCreditsFor } from './creditScore.service';
import { stockValuation } from './product.service';
import { gstHsnReport, gstRegisterReport } from './gstReport.service';

export interface ReportRange {
  from?: string;
  to?: string;
}

/** A report is a titled table plus totals, so the client and CSV export share one shape. */
export interface Report {
  title: string;
  from?: string;
  to?: string;
  columns: { key: string; label: string; type: 'text' | 'money' | 'number' | 'date' }[];
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
  chart?: { labels: string[]; series: { label: string; data: number[] }[] };
}

/** Ledger entry that takes back a cancelled bill's udhaar (see billing.service cancelSale). */
const IS_REVERSAL = { $ne: [{ $ifNull: ['$reversalOf', null] }, null] };

const dayExpr ={ $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: IST_TIMEZONE } };

function rangeOf(q: ReportRange) {
  const r = resolveRange(q.from, q.to, 30);
  return { match: { $gte: r.from, $lte: r.to }, ...r };
}

export async function salesReport(shopId: Types.ObjectId, q: ReportRange): Promise<Report> {
  const { match } = rangeOf(q);
  const rows = await Sale.aggregate<{
    _id: string;
    bills: number;
    total: number;
    discount: number;
    cash: number;
    upi: number;
    credit: number;
  }>([
    { $match: { shopId, ...NOT_CANCELLED, date: match } },
    {
      $group: {
        _id: dayExpr,
        bills: { $sum: 1 },
        total: { $sum: '$totalAmount' },
        discount: { $sum: '$discount' },
        // Money taken at the counter on a part-paid bill is cash too; leaving it out made
        // cash + UPI + udhaar fall short of the total.
        cash: { $sum: { $cond: [{ $in: ['$paymentMode', ['cash', 'partial']] }, '$paidAmount', 0] } },
        upi: { $sum: { $cond: [{ $eq: ['$paymentMode', 'upi'] }, '$paidAmount', 0] } },
        credit: { $sum: '$creditAmount' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const out = rows.map((r) => ({ day: r._id, bills: r.bills, total: r.total, discount: r.discount, cash: r.cash, upi: r.upi, credit: r.credit, other: r.total - r.cash - r.upi - r.credit }));
  return {
    title: 'Sales summary',
    ...q,
    columns: [
      { key: 'day', label: 'Date', type: 'date' },
      { key: 'bills', label: 'Bills', type: 'number' },
      { key: 'cash', label: 'Cash', type: 'money' },
      { key: 'upi', label: 'UPI', type: 'money' },
      { key: 'credit', label: 'Udhaar', type: 'money' },
      { key: 'discount', label: 'Discount', type: 'money' },
      { key: 'total', label: 'Total', type: 'money' },
    ],
    rows: out,
    totals: sumCols(out, ['bills', 'cash', 'upi', 'credit', 'discount', 'total']),
    chart: { labels: out.map((r) => r.day), series: [{ label: 'Sales', data: out.map((r) => r.total) }] },
  };
}

export async function profitReport(shopId: Types.ObjectId, q: ReportRange): Promise<Report> {
  const { match } = rangeOf(q);
  const rows = await Sale.aggregate<{ _id: string; revenue: number; cost: number; discount: number }>([
    { $match: { shopId, ...NOT_CANCELLED, date: match } },
    {
      $project: {
        date: 1,
        discount: 1,
        revenue: { $sum: '$items.total' },
        cost: { $sum: { $map: { input: '$items', as: 'i', in: { $multiply: ['$$i.qty', '$$i.costRate'] } } } },
      },
    },
    { $group: { _id: dayExpr, revenue: { $sum: '$revenue' }, cost: { $sum: '$cost' }, discount: { $sum: '$discount' } } },
    { $sort: { _id: 1 } },
  ]);
  const out = rows.map((r) => {
    const net = r.revenue - r.discount;
    const cost = Math.round(r.cost);
    const profit = net - cost;
    return { day: r._id, revenue: net, cost, profit, margin: net > 0 ? Math.round((profit / net) * 1000) / 10 : 0 };
  });
  const totals = sumCols(out, ['revenue', 'cost', 'profit']);
  totals.margin = totals.revenue! > 0 ? Math.round((totals.profit! / totals.revenue!) * 1000) / 10 : 0;
  return {
    title: 'Profit estimate',
    ...q,
    columns: [
      { key: 'day', label: 'Date', type: 'date' },
      { key: 'revenue', label: 'Sales (after discount)', type: 'money' },
      { key: 'cost', label: 'Purchase cost', type: 'money' },
      { key: 'profit', label: 'Profit', type: 'money' },
      { key: 'margin', label: 'Margin %', type: 'number' },
    ],
    rows: out,
    totals,
    chart: { labels: out.map((r) => r.day), series: [{ label: 'Profit', data: out.map((r) => r.profit) }, { label: 'Sales', data: out.map((r) => r.revenue) }] },
  };
}

export async function udhaarReport(shopId: Types.ObjectId, q: ReportRange): Promise<Report> {
  const { match } = rangeOf(q);
  const [movements, customers] = await Promise.all([
    CustomerLedger.aggregate<{ _id: Types.ObjectId; given: number; received: number }>([
      { $match: { shopId, date: match } },
      {
        $group: {
          _id: '$customerId',
          // A cancelled bill's udhaar coming back is not money received: it takes the udhaar off.
          given: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$amount', { $cond: [IS_REVERSAL, { $multiply: ['$amount', -1] }, 0] }] } },
          received: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'payment'] }, { $not: [IS_REVERSAL] }] }, '$amount', 0] } },
        },
      },
    ]),
    Customer.find({ shopId, isDeleted: false }).select('name phone currentBalance'),
  ]);
  const byId = new Map(movements.map((m) => [String(m._id), m]));
  const out = customers
    .map((c) => ({
      name: c.name,
      phone: c.phone,
      given: byId.get(String(c._id))?.given ?? 0,
      received: byId.get(String(c._id))?.received ?? 0,
      balance: c.currentBalance,
    }))
    .filter((r) => r.given || r.received || r.balance)
    .sort((a, b) => b.balance - a.balance);
  return {
    title: 'Udhaar summary',
    ...q,
    columns: [
      { key: 'name', label: 'Customer', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'given', label: 'Udhaar given', type: 'money' },
      { key: 'received', label: 'Received', type: 'money' },
      { key: 'balance', label: 'Balance now', type: 'money' },
    ],
    rows: out,
    totals: sumCols(out, ['given', 'received', 'balance']),
  };
}

export async function supplierPurchaseReport(shopId: Types.ObjectId, q: ReportRange): Promise<Report> {
  const { match } = rangeOf(q);
  const [purchases, payments, suppliers] = await Promise.all([
    Purchase.aggregate<{ _id: Types.ObjectId; count: number; total: number; paid: number; items: { name: string; qty: number; unit: string }[] }>([
      { $match: { shopId, date: match } },
      { $group: { _id: '$supplierId', count: { $sum: 1 }, total: { $sum: '$totalAmount' }, paid: { $sum: '$paidAmount' }, items: { $push: '$items' } } },
    ]),
    SupplierPayment.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: { shopId, date: match } },
      { $group: { _id: '$supplierId', total: { $sum: '$amount' } } },
    ]),
    Supplier.find({ shopId, isDeleted: false }).select('name company currentPayable'),
  ]);
  const pMap = new Map(purchases.map((p) => [String(p._id), p]));
  const payMap = new Map(payments.map((p) => [String(p._id), p.total]));
  const out = suppliers
    .map((s) => {
      const p = pMap.get(String(s._id));
      const qtyByItem = new Map<string, { qty: number; unit: string }>();
      for (const batch of (p?.items ?? []) as unknown as { name: string; qty: number; unit: string }[][]) {
        for (const i of batch) {
          const cur = qtyByItem.get(i.name) ?? { qty: 0, unit: i.unit };
          cur.qty += i.qty;
          qtyByItem.set(i.name, cur);
        }
      }
      const topItems = [...qtyByItem.entries()]
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, 4)
        .map(([n, v]) => `${n} ${Math.round(v.qty * 100) / 100} ${v.unit}`)
        .join(', ');
      return {
        name: s.name,
        company: s.company,
        purchases: p?.count ?? 0,
        total: p?.total ?? 0,
        paid: (p?.paid ?? 0) + (payMap.get(String(s._id)) ?? 0),
        payable: s.currentPayable,
        items: topItems,
      };
    })
    .filter((r) => r.purchases || r.paid || r.payable)
    .sort((a, b) => b.total - a.total);
  return {
    title: 'Supplier purchase summary',
    ...q,
    columns: [
      { key: 'name', label: 'Supplier', type: 'text' },
      { key: 'purchases', label: 'Purchases', type: 'number' },
      { key: 'items', label: 'Main items', type: 'text' },
      { key: 'total', label: 'Goods taken', type: 'money' },
      { key: 'paid', label: 'Paid', type: 'money' },
      { key: 'payable', label: 'Payable now', type: 'money' },
    ],
    rows: out,
    totals: sumCols(out, ['purchases', 'total', 'paid', 'payable']),
  };
}

export async function stockValuationReport(shopId: Types.ObjectId): Promise<Report> {
  const { rows, totals } = await stockValuation(shopId);
  return {
    title: 'Stock valuation',
    columns: [
      { key: 'name', label: 'Product', type: 'text' },
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'currentStock', label: 'Stock', type: 'number' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'purchasePrice', label: 'Cost / unit', type: 'money' },
      { key: 'costValue', label: 'Value at cost', type: 'money' },
      { key: 'saleValue', label: 'Value at selling price', type: 'money' },
    ],
    rows,
    totals: { costValue: totals.costValue, saleValue: totals.saleValue },
  };
}

export async function productSalesReport(shopId: Types.ObjectId, q: ReportRange): Promise<Report> {
  const { match } = rangeOf(q);
  const rows = await Sale.aggregate<{ _id: Types.ObjectId; name: string; unit: string; qty: number; revenue: number; cost: number; bills: number }>([
    { $match: { shopId, ...NOT_CANCELLED, date: match } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        name: { $first: '$items.name' },
        unit: { $first: '$items.unit' },
        qty: { $sum: '$items.qty' },
        revenue: { $sum: '$items.total' },
        cost: { $sum: { $multiply: ['$items.qty', '$items.costRate'] } },
        bills: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
  ]);
  const out = rows.map((r) => ({
    name: r.name,
    unit: r.unit,
    qty: Math.round(r.qty * 1000) / 1000,
    bills: r.bills,
    revenue: r.revenue,
    cost: Math.round(r.cost),
    profit: r.revenue - Math.round(r.cost),
  }));
  return {
    title: 'Product-wise sales',
    ...q,
    columns: [
      { key: 'name', label: 'Product', type: 'text' },
      { key: 'qty', label: 'Qty sold', type: 'number' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'bills', label: 'Bills', type: 'number' },
      { key: 'revenue', label: 'Sales', type: 'money' },
      { key: 'cost', label: 'Cost', type: 'money' },
      { key: 'profit', label: 'Profit', type: 'money' },
    ],
    rows: out,
    totals: sumCols(out, ['bills', 'revenue', 'cost', 'profit']),
    chart: { labels: out.slice(0, 10).map((r) => r.name), series: [{ label: 'Sales', data: out.slice(0, 10).map((r) => r.revenue) }] },
  };
}

/** Age buckets (days) of the "Purana udhaar" report. */
export const AGING_BUCKETS = [
  { key: 'd0_30', max: 30 },
  { key: 'd31_60', max: 60 },
  { key: 'd61_90', max: 90 },
  { key: 'd90_plus', max: Infinity },
] as const;

/**
 * "Purana udhaar": each customer's pending udhaar split by how old it is. Payments settle the
 * oldest udhaar first (FIFO), so what is left is the newest part of the debt.
 */
export async function agingReport(shopId: Types.ObjectId, now = new Date()): Promise<Report> {
  const customers = await Customer.find({ shopId, isDeleted: false, currentBalance: { $gt: 0 } }).select('name phone currentBalance');
  const open = await openCreditsFor(shopId, customers.map((c) => c._id));
  const out = customers
    .map((c) => {
      const row: { name: string; phone: string; balance: number } & Record<(typeof AGING_BUCKETS)[number]['key'], number> = { name: c.name, phone: c.phone, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, balance: c.currentBalance };
      for (const o of open.get(String(c._id))?.open ?? []) {
        const age = Math.floor((now.getTime() - o.date.getTime()) / 86_400_000);
        row[AGING_BUCKETS.find((b) => age <= b.max)!.key] += o.remaining;
      }
      return row;
    })
    .sort((a, b) => b.d90_plus - a.d90_plus || b.d61_90 - a.d61_90 || b.d31_60 - a.d31_60 || b.balance - a.balance);
  const totals = sumCols(out, ['d0_30', 'd31_60', 'd61_90', 'd90_plus', 'balance']);
  return {
    title: 'Old udhaar (aging)',
    columns: [
      { key: 'name', label: 'Customer', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'd0_30', label: '0-30 days', type: 'money' },
      { key: 'd31_60', label: '31-60 days', type: 'money' },
      { key: 'd61_90', label: '61-90 days', type: 'money' },
      { key: 'd90_plus', label: '90+ days', type: 'money' },
      { key: 'balance', label: 'Balance now', type: 'money' },
    ],
    rows: out,
    totals,
    chart: {
      labels: ['0-30', '31-60', '61-90', '90+'],
      series: [{ label: 'Udhaar', data: [totals.d0_30!, totals.d31_60!, totals.d61_90!, totals.d90_plus!] }],
    },
  };
}

function sumCols(rows: Record<string, unknown>[], keys: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const k of keys) totals[k] = rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return totals;
}

/** CSV with money columns in rupees. */
export function reportToCsv(report: Report): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmt = (col: Report['columns'][number], v: unknown) => (col.type === 'money' ? ((Number(v) || 0) / 100).toFixed(2) : v);
  const header = report.columns.map((c) => cell(c.type === 'money' ? `${c.label} (Rs)` : c.label)).join(',');
  const lines = report.rows.map((r) => report.columns.map((c) => cell(fmt(c, r[c.key]))).join(','));
  const totalLine = report.columns
    .map((c, i) => (i === 0 ? 'TOTAL' : c.key in report.totals ? cell(fmt(c, report.totals[c.key])) : ''))
    .join(',');
  return [header, ...lines, totalLine].join('\n');
}

export const REPORTS = {
  sales: salesReport,
  profit: profitReport,
  udhaar: udhaarReport,
  'supplier-purchases': supplierPurchaseReport,
  'stock-valuation': (shopId: Types.ObjectId) => stockValuationReport(shopId),
  'product-sales': productSalesReport,
  aging: (shopId: Types.ObjectId) => agingReport(shopId),
  'gst-register': gstRegisterReport,
  'gst-hsn': gstHsnReport,
} as const;

export type ReportName = keyof typeof REPORTS;
