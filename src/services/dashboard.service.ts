import type { Types } from 'mongoose';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Purchase } from '../models/purchase.model';
import { NOT_CANCELLED, Sale } from '../models/sale.model';
import { Supplier } from '../models/supplier.model';
import { SupplierPayment } from '../models/supplierPayment.model';
import { IST_TIMEZONE, addDays, endOfIstDay, istDayKey, startOfIstDay } from '../utils/istDate';
import { stockAlerts } from './product.service';

const sumOf = async (
  agg: Promise<{ total: number; count?: number }[]>,
): Promise<{ total: number; count: number }> => {
  const r = await agg;
  return { total: r[0]?.total ?? 0, count: r[0]?.count ?? 0 };
};

export interface RecentTxn {
  kind: 'sale' | 'udhaar' | 'payment' | 'purchase' | 'supplier_payment';
  id: string;
  title: string;
  subtitle: string;
  amount: number;
  date: Date;
  link: string;
}

export async function dashboardSummary(shopId: Types.ObjectId) {
  const from = startOfIstDay();
  const to = endOfIstDay();
  const today = { $gte: from, $lte: to };

  const [sales, udhaar, payments, outstanding, payable, alerts, topDebtors, recent] = await Promise.all([
    sumOf(Sale.aggregate([{ $match: { shopId, ...NOT_CANCELLED, date: today } }, { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } }])),
    sumOf(
      CustomerLedger.aggregate([
        { $match: { shopId, type: 'credit', date: today } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ),
    sumOf(
      CustomerLedger.aggregate([
        { $match: { shopId, type: 'payment', date: today, reversalOf: { $exists: false } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ),
    sumOf(
      Customer.aggregate([
        { $match: { shopId, isDeleted: false, currentBalance: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$currentBalance' }, count: { $sum: 1 } } },
      ]),
    ),
    sumOf(
      Supplier.aggregate([
        { $match: { shopId, isDeleted: false, currentPayable: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$currentPayable' }, count: { $sum: 1 } } },
      ]),
    ),
    stockAlerts(shopId, 8),
    Customer.find({ shopId, isDeleted: false, currentBalance: { $gt: 0 } }).sort({ currentBalance: -1 }).limit(5),
    recentTransactions(shopId, 10),
  ]);

  return {
    today: {
      sales: sales.total,
      salesCount: sales.count,
      udhaarGiven: udhaar.total,
      paymentsReceived: payments.total,
    },
    totalOutstanding: outstanding.total,
    customersWithDue: outstanding.count,
    totalPayable: payable.total,
    lowStockCount: alerts.lowCount,
    outOfStockCount: alerts.outCount,
    lowStockProducts: alerts.items,
    topDebtors: topDebtors.map((c) => c.toJSON()),
    recentTransactions: recent,
  };
}

export async function recentTransactions(shopId: Types.ObjectId, limit = 10): Promise<RecentTxn[]> {
  const [sales, ledger, purchases, supplierPayments] = await Promise.all([
    Sale.find({ shopId }).sort({ date: -1 }).limit(limit),
    // Sale-generated udhaar is already shown via the sale itself.
    CustomerLedger.find({ shopId, source: { $ne: 'sale' } }).sort({ date: -1 }).limit(limit),
    Purchase.find({ shopId }).sort({ date: -1 }).limit(limit),
    SupplierPayment.find({ shopId }).sort({ date: -1 }).limit(limit),
  ]);

  const customerIds = ledger.map((l) => l.customerId);
  const supplierIds = [...purchases.map((p) => p.supplierId), ...supplierPayments.map((p) => p.supplierId)];
  const [customers, suppliers] = await Promise.all([
    Customer.find({ shopId, _id: { $in: customerIds } }).select('name'),
    Supplier.find({ shopId, _id: { $in: supplierIds } }).select('name'),
  ]);
  const cName = new Map(customers.map((c) => [String(c._id), c.name]));
  const sName = new Map(suppliers.map((s) => [String(s._id), s.name]));

  const rows: RecentTxn[] = [
    ...sales.map((s) => ({
      kind: 'sale' as const,
      id: String(s._id),
      title: `Bill #${s.billNumber}`,
      subtitle: `${s.customerName || 'Walk-in'} · ${s.paymentMode}`,
      amount: s.totalAmount,
      date: s.date,
      link: `/sales/${String(s._id)}`,
    })),
    ...ledger.map((l) => ({
      kind: l.type === 'credit' ? ('udhaar' as const) : ('payment' as const),
      id: String(l._id),
      title: cName.get(String(l.customerId)) ?? 'Customer',
      subtitle: l.note || (l.type === 'credit' ? 'Udhaar given' : 'Payment received'),
      amount: l.amount,
      date: l.date,
      link: `/customers/${String(l.customerId)}`,
    })),
    ...purchases.map((p) => ({
      kind: 'purchase' as const,
      id: String(p._id),
      title: sName.get(String(p.supplierId)) ?? 'Supplier',
      subtitle: `Purchase · ${p.items.length} item(s)`,
      amount: p.totalAmount,
      date: p.date,
      link: `/suppliers/${String(p.supplierId)}`,
    })),
    ...supplierPayments.map((p) => ({
      kind: 'supplier_payment' as const,
      id: String(p._id),
      title: sName.get(String(p.supplierId)) ?? 'Supplier',
      subtitle: `Paid to supplier · ${p.mode}`,
      amount: p.amount,
      date: p.date,
      link: `/suppliers/${String(p.supplierId)}`,
    })),
  ];
  return rows.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
}

/** Fills missing days with zero so charts have a continuous x-axis. */
function dayKeys(days: number): string[] {
  const end = startOfIstDay();
  return Array.from({ length: days }, (_, i) => istDayKey(addDays(end, i - days + 1)));
}

export async function dashboardCharts(shopId: Types.ObjectId, days: number) {
  const from = startOfIstDay(addDays(new Date(), -(days - 1)));
  const range = { $gte: from, $lte: endOfIstDay() };
  const dayExpr = { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: IST_TIMEZONE } };

  const [salesByDay, topProducts, ledgerByDay] = await Promise.all([
    Sale.aggregate<{ _id: string; total: number; count: number }>([
      { $match: { shopId, ...NOT_CANCELLED, date: range } },
      { $group: { _id: dayExpr, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]),
    Sale.aggregate<{ _id: string; name: string; qty: number; total: number; unit: string }>([
      { $match: { shopId, ...NOT_CANCELLED, date: range } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          name: { $first: '$items.name' },
          unit: { $first: '$items.unit' },
          qty: { $sum: '$items.qty' },
          total: { $sum: '$items.total' },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]),
    CustomerLedger.aggregate<{ _id: { day: string; type: string }; total: number }>([
      { $match: { shopId, date: range, reversalOf: { $exists: false } } },
      { $group: { _id: { day: dayExpr, type: '$type' }, total: { $sum: '$amount' } } },
    ]),
  ]);

  const keys = dayKeys(days);
  const salesMap = new Map(salesByDay.map((s) => [s._id, s]));
  const credit = new Map<string, number>();
  const paid = new Map<string, number>();
  for (const r of ledgerByDay) (r._id.type === 'credit' ? credit : paid).set(r._id.day, r.total);

  return {
    days,
    sales: keys.map((d) => ({ day: d, total: salesMap.get(d)?.total ?? 0, count: salesMap.get(d)?.count ?? 0 })),
    topProducts: topProducts.map((p) => ({ productId: String(p._id), name: p.name, unit: p.unit, qty: p.qty, total: p.total })),
    udhaar: keys.map((d) => ({ day: d, given: credit.get(d) ?? 0, recovered: paid.get(d) ?? 0 })),
  };
}
