import { Types } from 'mongoose';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product, type Unit } from '../models/product.model';
import { Purchase } from '../models/purchase.model';
import { Sale } from '../models/sale.model';
import { StockMovement } from '../models/stockMovement.model';
import { Supplier } from '../models/supplier.model';
import { SupplierPayment } from '../models/supplierPayment.model';
import { User } from '../models/user.model';
import { addDays, startOfIstDay } from '../utils/istDate';
import { lineTotal } from '../utils/money';

/*
 * Generates a realistic, internally consistent history for one shop by simulating
 * 60 days of trading: opening stock, weekly restocks, daily sales (cash / UPI /
 * udhaar / partial), customer repayments and supplier payments. Every stock change
 * is a StockMovement and every balance is derived from its ledger.
 */

type P = [name: string, hindi: string, aliases: string[], category: string, unit: Unit, buy: number, sell: number, mrp: number, threshold: number, supplier: number, popularity: number];

// Prices in rupees here for readability; converted to paise below.
const PRODUCTS: P[] = [
  ['Sugar', 'चीनी', ['cheeni', 'shakkar', 'chini'], 'Grocery', 'kg', 40, 45, 48, 10, 0, 9],
  ['Aashirvaad Atta 5kg', 'आटा', ['aata', 'atta', 'gehun ka aata'], 'Grocery', 'packet', 230, 255, 270, 5, 0, 6],
  ['Basmati Rice', 'चावल', ['chawal', 'rice', 'basmati'], 'Grocery', 'kg', 70, 85, 90, 10, 0, 7],
  ['Toor Dal', 'अरहर दाल', ['dal', 'arhar dal', 'toor', 'tuar dal'], 'Grocery', 'kg', 120, 140, 150, 5, 0, 6],
  ['Fortune Mustard Oil 1L', 'सरसों तेल', ['tel', 'sarson tel', 'sarson ka tel', 'mustard oil'], 'Oil & Ghee', 'litre', 150, 170, 180, 6, 1, 6],
  ['Fortune Refined Oil 1L', 'रिफाइंड तेल', ['refined', 'refined tel'], 'Oil & Ghee', 'litre', 125, 140, 150, 6, 1, 4],
  ['Tata Salt 1kg', 'नमक', ['namak', 'salt'], 'Grocery', 'packet', 22, 26, 28, 10, 1, 6],
  ['Maggi Noodles', 'मैगी', ['maggi', 'noodles'], 'Snacks', 'packet', 12, 14, 14, 20, 2, 9],
  ['Parle-G', 'पारले जी', ['parle g', 'parle', 'parleg'], 'Snacks', 'packet', 8, 10, 10, 24, 2, 10],
  ['Good Day Biscuit', 'गुड डे', ['good day', 'biscuit'], 'Snacks', 'packet', 18, 20, 20, 12, 2, 5],
  ["Lay's Chips", 'चिप्स', ['lays', 'chips'], 'Snacks', 'packet', 17, 20, 20, 15, 2, 6],
  ['Amul Butter 100g', 'मक्खन', ['makhan', 'butter'], 'Dairy', 'packet', 52, 56, 58, 6, 3, 4],
  ['Amul Milk 500ml', 'दूध', ['doodh', 'milk', 'dudh'], 'Dairy', 'packet', 30, 33, 34, 20, 3, 10],
  ['Amul Dahi 400g', 'दही', ['dahi', 'curd'], 'Dairy', 'packet', 32, 35, 36, 8, 3, 5],
  ['Bread', 'ब्रेड', ['double roti', 'pav'], 'Dairy', 'packet', 35, 40, 45, 8, 3, 7],
  ['Eggs', 'अंडे', ['anda', 'ande', 'egg'], 'Dairy', 'dozen', 72, 84, 90, 5, 3, 5],
  ['Surf Excel 1kg', 'सर्फ', ['surf', 'surf excel', 'washing powder'], 'Household', 'packet', 115, 130, 140, 5, 1, 4],
  ['Vim Bar', 'विम', ['vim'], 'Household', 'piece', 9, 10, 10, 15, 1, 5],
  ['Lifebuoy Soap', 'साबुन', ['sabun', 'lifebuoy', 'soap'], 'Personal Care', 'piece', 30, 34, 36, 12, 1, 6],
  ['Colgate 100g', 'मंजन', ['colgate', 'toothpaste', 'manjan'], 'Personal Care', 'piece', 48, 55, 58, 6, 1, 4],
  ['Clinic Plus Sachet', 'शैम्पू', ['shampoo', 'clinic plus'], 'Personal Care', 'packet', 1.6, 2, 2, 30, 1, 6],
  ['Tata Tea 250g', 'चाय पत्ती', ['chai patti', 'tea', 'chai', 'patti'], 'Beverages', 'packet', 115, 130, 135, 6, 0, 6],
  ['Bru Coffee 50g', 'कॉफ़ी', ['coffee', 'bru'], 'Beverages', 'packet', 90, 100, 105, 4, 0, 2],
  ['Haldi Powder 100g', 'हल्दी', ['haldi', 'turmeric'], 'Spices', 'packet', 25, 30, 32, 6, 0, 4],
  ['Lal Mirch 100g', 'लाल मिर्च', ['mirch', 'lal mirch', 'chilli'], 'Spices', 'packet', 30, 36, 38, 6, 0, 4],
  ['Jeera 100g', 'जीरा', ['jeera', 'zeera', 'cumin'], 'Spices', 'packet', 45, 55, 60, 5, 0, 3],
  ['Poha', 'पोहा', ['poha', 'chivda'], 'Grocery', 'kg', 45, 55, 60, 5, 0, 4],
  ['Besan', 'बेसन', ['besan', 'gram flour'], 'Grocery', 'kg', 80, 95, 100, 5, 0, 4],
  ['Moong Dal', 'मूंग दाल', ['moong', 'moong dal'], 'Grocery', 'kg', 105, 120, 130, 5, 0, 4],
  ['Matchbox', 'माचिस', ['machis', 'matchbox', 'match'], 'Household', 'box', 9, 10, 10, 10, 1, 5],
];

const SUPPLIERS = [
  { name: 'Ramesh Traders', aliases: ['Ramesh', 'Ramesh bhai'], company: 'Ramesh Traders (Wholesale Grocery)', phone: '9839012345', address: 'Naka Hindola, Lucknow', gstNumber: '09ABCDE1234F1Z5' },
  { name: 'Gupta Distributors', aliases: ['Gupta distributor', 'Gupta agency'], company: 'Gupta Oil & General Distributors', phone: '9415023456', address: 'Aminabad, Lucknow', gstNumber: '09FGHIJ5678K1Z2' },
  { name: 'Balaji Snacks Agency', aliases: ['Balaji', 'Balaji agency'], company: 'Shree Balaji Snacks Agency', phone: '9918034567', address: 'Chowk, Lucknow', gstNumber: '' },
  { name: 'Verma Dairy', aliases: ['Verma dairy', 'dairy wala', 'Amul wala'], company: 'Verma Dairy & Amul Point', phone: '9935045678', address: 'Alambagh, Lucknow', gstNumber: '' },
];

const CUSTOMERS = [
  { name: 'Rakesh Sharma', aliases: ['Sharma ji', 'Sharma uncle'], phone: '9876501234', address: 'House 12, Gali No. 3', weight: 9 },
  { name: 'Anil Gupta', aliases: ['Gupta ji'], phone: '9876502345', address: 'Shop 4, Main Market', weight: 7 },
  { name: 'Suresh Verma', aliases: ['Verma ji'], phone: '9876503456', address: 'B-21, Nehru Colony', weight: 6 },
  { name: 'Kavita Mishra', aliases: ['Mishra aunty', 'Mishra ji'], phone: '9876504567', address: 'Flat 7, Shanti Apartments', weight: 6 },
  { name: 'Ramesh Pandey', aliases: ['Pandey ji'], phone: '9876505678', address: 'Near Hanuman Mandir', weight: 5 },
  { name: 'Rahul Yadav', aliases: ['Rahul', 'Yadav ji'], phone: '9876506789', address: 'Room 3, Student Hostel Road', weight: 4 },
  { name: 'Imran Khan', aliases: ['Imran bhai', 'Imran'], phone: '9876507890', address: 'C-9, Rahim Nagar', weight: 4 },
  { name: 'Harpreet Singh', aliases: ['Singh uncle', 'Sardar ji'], phone: '9876508901', address: '45, Gurudwara Road', weight: 3 },
  { name: 'Priya Tiwari', aliases: ['Tiwari ji', 'Priya'], phone: '9876509012', address: 'D-2, Indira Nagar', weight: 3 },
  { name: 'Mohan Sharma', aliases: ['Mohan', 'Mohan ji'], phone: '9876500123', address: 'Behind Post Office', weight: 2 },
];

/** Products that end the simulation out of stock / running low, so alerts look real. */
const END_OUT = ['Bru Coffee 50g', 'Jeera 100g', 'Amul Butter 100g'];
const END_LOW = ['Sugar', 'Maggi Noodles', 'Toor Dal', 'Surf Excel 1kg', 'Amul Milk 500ml'];

/** Deterministic PRNG (mulberry32) so the demo data is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rs = (n: number) => Math.round(n * 100);

export interface SampleDataResult {
  products: number;
  customers: number;
  suppliers: number;
  sales: number;
  purchases: number;
  ledgerEntries: number;
  stockMovements: number;
}

export async function generateSampleData(shopId: Types.ObjectId, days = 60): Promise<SampleDataResult> {
  const rand = rng(20251023);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const weighted = <T>(arr: T[], w: (t: T) => number): T => {
    const total = arr.reduce((s, x) => s + w(x), 0);
    let r = rand() * total;
    for (const x of arr) {
      r -= w(x);
      if (r <= 0) return x;
    }
    return arr[arr.length - 1]!;
  };

  const now = new Date();
  const at = (dayStart: Date, hour: number, minute = 0) => {
    const t = new Date(dayStart.getTime() + (hour * 60 + minute) * 60_000);
    return t > now ? new Date(now.getTime() - 60_000) : t;
  };

  // ---------- master data ----------
  const suppliers = SUPPLIERS.map((s) => ({ _id: new Types.ObjectId(), ...s, payable: 0, last: undefined as Date | undefined }));
  const products = PRODUCTS.map(([name, nameHindi, aliases, category, unit, buy, sell, mrp, threshold, sup, popularity]) => ({
    _id: new Types.ObjectId(),
    name, nameHindi, aliases, category, unit,
    purchasePrice: rs(buy), sellingPrice: rs(sell), mrp: rs(mrp),
    lowStockThreshold: threshold, supplier: suppliers[sup]!, popularity,
    stock: 0,
  }));
  const customers = CUSTOMERS.map((c) => ({ _id: new Types.ObjectId(), ...c, balance: 0, last: undefined as Date | undefined }));

  const movements: Record<string, unknown>[] = [];
  const purchases: Record<string, unknown>[] = [];
  const supplierPayments: Record<string, unknown>[] = [];
  const sales: Record<string, unknown>[] = [];
  const ledger: Record<string, unknown>[] = [];
  let billNumber = 0;

  const move = (p: (typeof products)[number], qty: number, type: string, date: Date, ref?: { type: 'sale' | 'purchase'; id: Types.ObjectId }, note = '') => {
    p.stock = Math.round((p.stock + qty) * 1000) / 1000;
    movements.push({
      _id: new Types.ObjectId(), shopId, productId: p._id, type, quantity: qty, balanceAfter: p.stock,
      referenceType: ref?.type ?? 'manual', referenceId: ref?.id, note, createdBy: shopId, createdAt: date, updatedAt: date,
    });
  };

  const addLedger = (c: (typeof customers)[number], type: 'credit' | 'payment', amount: number, date: Date, extra: Record<string, unknown> = {}) => {
    c.balance += type === 'credit' ? amount : -amount;
    c.last = !c.last || date > c.last ? date : c.last;
    ledger.push({ _id: new Types.ObjectId(), shopId, customerId: c._id, type, amount, date, createdAt: date, updatedAt: date, items: [], note: '', source: 'manual', mode: null, ...extra });
  };

  const buy = (sup: (typeof suppliers)[number], lines: { p: (typeof products)[number]; qty: number }[], date: Date, paidRatio: number, invoice: string) => {
    if (!lines.length) return;
    const id = new Types.ObjectId();
    const items = lines.map(({ p, qty }) => ({ productId: p._id, name: p.name, unit: p.unit, qty, rate: p.purchasePrice, total: lineTotal(qty, p.purchasePrice), costRate: 0 }));
    const total = items.reduce((s, i) => s + i.total, 0);
    const paid = paidRatio >= 1 ? total : Math.min(total, Math.round((total * paidRatio) / 10000) * 10000);
    purchases.push({ _id: id, shopId, supplierId: sup._id, items, totalAmount: total, paidAmount: paid, dueAmount: total - paid, invoiceNumber: invoice, date, note: '', source: 'manual', createdAt: date, updatedAt: date });
    for (const { p, qty } of lines) move(p, qty, 'purchase', date, { type: 'purchase', id }, `From ${sup.name}`);
    sup.payable += total - paid;
    sup.last = date;
  };

  const firstDay = startOfIstDay(addDays(now, -days));
  let invoiceNo = 1100;

  // Opening stock, fully paid.
  for (const sup of suppliers) {
    const lines = products.filter((p) => p.supplier === sup).map((p) => ({ p, qty: p.lowStockThreshold * 6 + Math.round(rand() * p.lowStockThreshold * 2) }));
    buy(sup, lines, at(firstDay, 9, 15), 1, `INV-${invoiceNo++}`);
  }

  for (let d = days; d >= 0; d--) {
    const dayStart = startOfIstDay(addDays(now, -d));
    const isToday = d === 0;
    const weekend = [0, 6].includes(new Date(dayStart.getTime() + 6 * 3600_000).getUTCDay());

    // Weekly restock (skipping the products we want to end low/out in the last 2 weeks).
    if (d !== days && d % 7 === 3) {
      for (const sup of suppliers) {
        const lines = products
          .filter((p) => p.supplier === sup && p.stock < p.lowStockThreshold * 3)
          .filter((p) => !(d < 15 && (END_OUT.includes(p.name) || END_LOW.includes(p.name))))
          .map((p) => ({ p, qty: p.lowStockThreshold * 5 }));
        buy(sup, lines, at(dayStart, 10, Math.floor(rand() * 50)), 0.5 + rand() * 0.5, `INV-${invoiceNo++}`);
      }
    }

    // Supplier payments.
    if (d % 10 === 5) {
      for (const sup of suppliers.filter((s) => s.payable > 0)) {
        const amount = Math.max(10000, Math.round((sup.payable * (0.6 + rand() * 0.4)) / 10000) * 10000);
        const pay = Math.min(amount, sup.payable);
        const date = at(dayStart, 17, Math.floor(rand() * 50));
        supplierPayments.push({ _id: new Types.ObjectId(), shopId, supplierId: sup._id, amount: pay, mode: pick(['cash', 'upi', 'bank']), date, note: '', source: 'manual', createdAt: date, updatedAt: date });
        sup.payable -= pay;
        sup.last = date;
      }
    }

    // Daily sales.
    const nSales = isToday ? 5 + Math.floor(rand() * 4) : 6 + Math.floor(rand() * 8) + (weekend ? 4 : 0);
    for (let s = 0; s < nSales; s++) {
      const hour = 8 + Math.floor(rand() * 13);
      const date = at(dayStart, hour, Math.floor(rand() * 60));
      const lines: { p: (typeof products)[number]; qty: number }[] = [];
      const nLines = 1 + Math.floor(rand() * 4);
      for (let l = 0; l < nLines; l++) {
        const p = weighted(products, (x) => x.popularity);
        if (lines.some((x) => x.p === p)) continue;
        const qty = p.unit === 'kg' ? pick([0.5, 1, 1, 2, 5]) : p.unit === 'litre' ? pick([1, 1, 2]) : p.unit === 'dozen' ? pick([0.5, 1]) : 1 + Math.floor(rand() * 3);
        if (p.stock >= qty) lines.push({ p, qty });
      }
      if (!lines.length) continue;

      const r = rand();
      const mode = r < 0.55 ? 'cash' : r < 0.8 ? 'upi' : r < 0.95 ? 'udhaar' : 'partial';
      const needsCustomer = mode === 'udhaar' || mode === 'partial';
      const customer = needsCustomer || rand() < 0.2 ? weighted(customers, (c) => c.weight) : undefined;

      const items = lines.map(({ p, qty }) => ({ productId: p._id, name: p.name, unit: p.unit, qty, rate: p.sellingPrice, total: lineTotal(qty, p.sellingPrice), costRate: p.purchasePrice }));
      const subtotal = items.reduce((sum, i) => sum + i.total, 0);
      const discount = subtotal > 30000 && rand() < 0.15 ? rs(5 + Math.floor(rand() * 4) * 5) : 0;
      const total = subtotal - discount;
      let paid = total;
      let credit = 0;
      if (mode === 'udhaar') {
        paid = 0;
        credit = total;
      } else if (mode === 'partial') {
        paid = Math.max(1000, Math.round((total * 0.5) / 1000) * 1000);
        if (paid >= total) paid = Math.floor(total / 2);
        credit = total - paid;
      }

      const id = new Types.ObjectId();
      billNumber++;
      sales.push({
        _id: id, shopId, billNumber, customerId: customer?._id, customerName: customer?.name ?? '', items, subtotal, discount,
        totalAmount: total, paymentMode: mode, paidAmount: paid, creditAmount: credit, date, note: '', source: 'manual', createdAt: date, updatedAt: date,
      });
      for (const { p, qty } of lines) move(p, -qty, 'sale', date, { type: 'sale', id }, `Bill #${billNumber}`);
      if (customer) {
        if (credit > 0) {
          addLedger(customer, 'credit', credit, date, {
            items: items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, rate: i.rate })),
            note: `Bill #${billNumber}${paid > 0 ? ' (partly paid)' : ''}`,
            source: 'sale',
            saleId: id,
          });
        } else {
          customer.last = !customer.last || date > customer.last ? date : customer.last;
        }
      }
    }

    // Manual udhaar ("saman le gaye, baad mein likh dena").
    if (rand() < 0.3) {
      const c = weighted(customers, (x) => x.weight);
      addLedger(c, 'credit', rs(100 + Math.floor(rand() * 8) * 50), at(dayStart, 11 + Math.floor(rand() * 8), Math.floor(rand() * 60)), {
        note: pick(['Monthly ration', 'Saman le gaye', 'Ghar ka saman', 'Party ka saman']),
      });
    }

    // Customers paying back.
    for (const c of customers) {
      if (c.balance > 20000 && rand() < 0.1) {
        const amount = Math.min(c.balance, Math.max(10000, Math.round((c.balance * (0.3 + rand() * 0.7)) / 5000) * 5000));
        const mode = pick(['cash', 'cash', 'upi']);
        addLedger(c, 'payment', amount, at(dayStart, 18 + Math.floor(rand() * 3), Math.floor(rand() * 60)), { mode, note: mode === 'upi' ? 'Paid by UPI' : 'Cash received' });
      }
    }
  }

  // Bring the chosen products to out-of-stock / low levels with a recorded stock count.
  const correction = new Date(Math.min(now.getTime() - 30 * 60_000, at(startOfIstDay(now), 9).getTime()));
  for (const p of products) {
    const target = END_OUT.includes(p.name) ? 0 : END_LOW.includes(p.name) ? Math.max(1, Math.floor(p.lowStockThreshold * 0.6)) : null;
    if (target !== null && p.stock !== target) move(p, Math.round((target - p.stock) * 1000) / 1000, 'adjustment', correction, undefined, 'Stock count correction');
  }

  // ---------- persist ----------
  const productDocs = products.map((p) => ({
    _id: p._id, shopId, name: p.name, nameHindi: p.nameHindi, aliases: p.aliases, category: p.category, unit: p.unit,
    purchasePrice: p.purchasePrice, sellingPrice: p.sellingPrice, mrp: p.mrp, currentStock: p.stock,
    lowStockThreshold: p.lowStockThreshold, supplierId: p.supplier._id, isActive: true, isDeleted: false,
    createdAt: firstDay, updatedAt: now,
  }));
  const supplierDocs = suppliers.map(({ payable, last, ...s }) => ({ ...s, shopId, currentPayable: payable, lastTransactionAt: last, isDeleted: false, createdAt: firstDay, updatedAt: now }));
  const customerDocs = customers.map(({ balance, last, weight: _w, ...c }) => ({ ...c, shopId, currentBalance: balance, lastTransactionAt: last, isDeleted: false, createdAt: firstDay, updatedAt: now }));

  await Supplier.insertMany(supplierDocs);
  await Product.insertMany(productDocs);
  await Customer.insertMany(customerDocs);
  await Purchase.insertMany(purchases);
  await SupplierPayment.insertMany(supplierPayments);
  await Sale.insertMany(sales);
  await CustomerLedger.insertMany(ledger);
  await StockMovement.insertMany(movements);
  await User.updateOne({ _id: shopId }, { $max: { billCounter: billNumber } });

  return {
    products: productDocs.length,
    customers: customerDocs.length,
    suppliers: supplierDocs.length,
    sales: sales.length,
    purchases: purchases.length,
    ledgerEntries: ledger.length,
    stockMovements: movements.length,
  };
}
