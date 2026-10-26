import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product } from '../models/product.model';
import { StockMovement } from '../models/stockMovement.model';
import { User } from '../models/user.model';
import { addCredit, addPayment, createCustomer, deleteCustomer } from '../services/customer.service';
import { recalculateBalance } from '../services/ledger.service';
import { adjustStock, createProduct, importProducts } from '../services/product.service';
import { createSale } from '../services/sale.service';
import { createPurchase, createSupplier, createSupplierPayment, deleteSupplier } from '../services/supplier.service';
import { importProductsSchema } from '../validators/product.validators';

/** Exercises the real services against an in-memory replica set (transactions on). */
describe('sale -> stock + udhaar (integration)', () => {
  let shopId: Types.ObjectId;

  beforeAll(async () => {
    await connectDb('memory');
    const user = await User.create({ name: 'Test', phone: '9000000099', passwordHash: 'x', shopName: 'Test Shop' });
    shopId = user._id;
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('reduces stock, writes movements and adds udhaar in one transaction', async () => {
    const sugar = await createProduct(shopId, {
      name: 'Sugar', nameHindi: '', aliases: ['cheeni'], category: 'Grocery', unit: 'kg',
      purchasePrice: 4000, sellingPrice: 4500, mrp: 4800, openingStock: 10, isActive: true,
    });
    const customer = await createCustomer(shopId, { name: 'Rakesh Sharma', aliases: ['Sharma ji'], phone: '', address: '' });

    const sale = await createSale(shopId, {
      customerId: String(customer._id),
      items: [{ productId: String(sugar._id), qty: 2 }],
      discount: 0,
      paymentMode: 'udhaar',
      note: '',
      allowOversell: false,
      source: 'manual',
    });

    expect(sale.totalAmount).toBe(9000);
    expect(sale.creditAmount).toBe(9000);
    expect(sale.billNumber).toBe(1);

    const product = await Product.findOne({ _id: sugar._id, shopId });
    expect(product?.currentStock).toBe(8);
    const moves = await StockMovement.find({ shopId, productId: sugar._id }).sort({ createdAt: 1 });
    expect(moves.map((m) => [m.type, m.quantity, m.balanceAfter])).toEqual([
      ['adjustment', 10, 10],
      ['sale', -2, 8],
    ]);

    const c = await Customer.findOne({ _id: customer._id, shopId });
    expect(c?.currentBalance).toBe(9000);
    const ledger = await CustomerLedger.find({ shopId, customerId: customer._id });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.source).toBe('sale');
  });

  it('blocks selling more than available stock', async () => {
    const p = await createProduct(shopId, {
      name: 'Eggs', nameHindi: '', aliases: [], category: 'Dairy', unit: 'dozen',
      purchasePrice: 7200, sellingPrice: 8400, mrp: 9000, openingStock: 1, isActive: true,
    });
    await expect(
      createSale(shopId, { items: [{ productId: String(p._id), qty: 3 }], discount: 0, paymentMode: 'cash', note: '', allowOversell: false, source: 'manual' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const after = await Product.findOne({ _id: p._id, shopId });
    expect(after?.currentStock).toBe(1);
  });

  it('requires a customer for udhaar', async () => {
    const p = await Product.findOne({ shopId, name: 'Sugar' });
    await expect(
      createSale(shopId, { items: [{ productId: String(p!._id), qty: 1 }], discount: 0, paymentMode: 'udhaar', note: '', allowOversell: false, source: 'manual' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('payment reduces balance and the cache matches the ledger', async () => {
    const c = await Customer.findOne({ shopId, name: 'Rakesh Sharma' });
    await addPayment(shopId, String(c!._id), { amount: 4000, mode: 'cash', note: '', source: 'manual' });
    const updated = await Customer.findOne({ _id: c!._id, shopId });
    expect(updated?.currentBalance).toBe(5000);
    expect(await recalculateBalance(shopId, c!._id)).toBe(5000);
  });

  it('damage adjustments always remove stock and cannot go negative', async () => {
    const p = await Product.findOne({ shopId, name: 'Sugar' });
    const r = await adjustStock(shopId, { productId: String(p!._id), quantity: 1, type: 'damage', note: 'torn bag' });
    expect(r.currentStock).toBe(7);
    await expect(adjustStock(shopId, { productId: String(p!._id), quantity: -100, type: 'adjustment', note: '' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('tenant guard rejects queries without shopId', async () => {
    await expect(Product.find({ name: 'Sugar' })).rejects.toThrow(/Tenant guard/);
    await expect(Customer.findById(new Types.ObjectId())).rejects.toThrow(/Tenant guard/);
  });

  it('another shop cannot see this shop’s products', async () => {
    const other = await User.create({ name: 'Other', phone: '9000000098', passwordHash: 'x', shopName: 'Other Shop' });
    expect(await Product.countDocuments({ shopId: other._id })).toBe(0);
    expect(await Product.countDocuments({ shopId })).toBeGreaterThan(0);
  });

  it('import updating a price keeps the product’s aliases, Hindi name, category and cost', async () => {
    const { rows } = importProductsSchema.parse({ rows: [{ name: 'Sugar', sellingPrice: 4700 }] });
    const res = await importProducts(shopId, { rows, updateExisting: true });
    expect(res).toMatchObject({ created: 0, updated: 1, failed: 0 });
    const p = await Product.findOne({ shopId, name: 'Sugar' });
    expect(p).toMatchObject({ sellingPrice: 4700, purchasePrice: 4000, category: 'Grocery', unit: 'kg' });
    expect(p?.aliases).toEqual(['cheeni']);
  });

  it('cannot delete a customer who still owes udhaar', async () => {
    const c = await createCustomer(shopId, { name: 'Owes Money', aliases: [], phone: '', address: '' });
    await addCredit(shopId, String(c._id), { amount: 5000, items: [], note: '', source: 'manual' });
    await expect(deleteCustomer(shopId, String(c._id))).rejects.toMatchObject({ statusCode: 409 });
    await addPayment(shopId, String(c._id), { amount: 5000, mode: 'cash', note: '', source: 'manual' });
    await expect(deleteCustomer(shopId, String(c._id))).resolves.toBeUndefined();
  });

  it('supplier payment cannot exceed what is due', async () => {
    const s = await createSupplier(shopId, { name: 'Test Traders', aliases: [], phone: '', company: '', address: '', gstNumber: '' });
    const salt = await createProduct(shopId, { name: 'Salt', nameHindi: '', aliases: [], category: 'Grocery', unit: 'packet', purchasePrice: 2000, sellingPrice: 2500, mrp: 0, openingStock: 0, isActive: true });
    await createPurchase(shopId, { supplierId: String(s._id), items: [{ productId: String(salt._id), qty: 5, rate: 2000 }], paidAmount: 0, paymentMode: 'cash', invoiceNumber: '', note: '', updatePurchasePrice: true, source: 'manual' });
    await expect(createSupplierPayment(shopId, { supplierId: String(s._id), amount: 20000, mode: 'cash', note: '', source: 'manual' })).rejects.toMatchObject({ statusCode: 400 });
    await createSupplierPayment(shopId, { supplierId: String(s._id), amount: 10000, mode: 'cash', note: '', source: 'manual' });
    await expect(deleteSupplier(shopId, String(s._id))).resolves.toBeUndefined();
  });
});
