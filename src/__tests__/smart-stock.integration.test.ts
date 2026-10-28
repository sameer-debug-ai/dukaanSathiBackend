import { Types } from 'mongoose';
import request from 'supertest';
import { parseVoiceCommand, setAiProvider } from '../ai/ai.service';
import { createApp } from '../app';
import { connectDb, disconnectDb } from '../config/db';
import { Product } from '../models/product.model';
import { ProductBatch } from '../models/productBatch.model';
import { User } from '../models/user.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { expiryAlerts, listBatches } from '../services/batch.service';
import { reorderSuggestions, runOutList } from '../services/prediction.service';
import { adjustStock, createProduct, updateProduct } from '../services/product.service';
import { createSale } from '../services/sale.service';
import { createPurchase, createSupplier } from '../services/supplier.service';
import { signAccessToken } from '../services/token.service';
import { undoVoiceCommand } from '../services/voiceUndo.service';
import { addDays, startOfIstDay } from '../utils/istDate';

const offline = { name: 'none', isAvailable: () => false, parseCommand: async () => ({}) };
const dayAt = (daysFromToday: number) => new Date(addDays(startOfIstDay(), daysFromToday).getTime() + 6 * 3600 * 1000);

/** Smart stock: run-out forecast, reorder list, expiry batches (FEFO), barcode lookup. */
describe('smart stock (integration)', () => {
  const app = createApp();
  let shopId: Types.ObjectId;
  let otherShop: Types.ObjectId;
  let token: string;
  let supplierId: string;

  const product = (shop: Types.ObjectId, name: string, extra: Record<string, unknown> = {}) =>
    createProduct(shop, { name, nameHindi: '', aliases: [], category: 'Grocery', unit: 'packet', purchasePrice: 2000, sellingPrice: 2500, mrp: 0, openingStock: 0, isActive: true, ...extra });
  const sell = (productId: string, qty: number, date?: Date) =>
    createSale(shopId, { items: [{ productId, qty }], discount: 0, paymentMode: 'cash', note: '', allowOversell: false, source: 'manual', date });
  const buy = (items: { productId: string; qty: number; expiryDate?: Date | null }[]) =>
    createPurchase(shopId, { supplierId, items: items.map((i) => ({ ...i, rate: 2000 })), paidAmount: 0, paymentMode: 'cash', invoiceNumber: '', note: '', updatePurchasePrice: true, source: 'manual' });
  const batchQtys = async (productId: string) => (await listBatches(shopId, productId)).map((b) => b.qty);

  beforeAll(async () => {
    await connectDb('memory');
    setAiProvider(offline);
    shopId = (await User.create({ name: 'Owner', phone: '9000000071', passwordHash: 'x', shopName: 'Sharma Store' }))._id;
    otherShop = (await User.create({ name: 'Other', phone: '9000000072', passwordHash: 'x', shopName: 'Other Store' }))._id;
    token = signAccessToken(String(shopId), String(shopId));
    supplierId = String((await createSupplier(shopId, { name: 'Ramesh Traders', aliases: [], phone: '9839012345', company: '', address: '', gstNumber: '' }))._id);
  });

  afterAll(async () => {
    await disconnectDb();
  });

  describe('expiry batches (FEFO)', () => {
    let milk: string;

    it('products without tracking never get batches', async () => {
      const salt = String((await product(shopId, 'Salt', { openingStock: 10 }))._id);
      await buy([{ productId: salt, qty: 5, expiryDate: dayAt(30) }]);
      await sell(salt, 3);
      expect(await ProductBatch.countDocuments({ shopId, productId: salt })).toBe(0);
      expect((await Product.findOne({ _id: salt, shopId }))!.currentStock).toBe(12);
    });

    it('turning tracking on puts the current stock in a no-expiry batch', async () => {
      milk = String((await product(shopId, 'Amul Milk', { openingStock: 4 }))._id);
      await updateProduct(shopId, milk, { trackExpiry: true });
      expect(await listBatches(shopId, milk)).toMatchObject([{ qty: 4, expiryDate: null }]);
    });

    it('purchases add dated batches; sales take the earliest expiry first', async () => {
      await buy([{ productId: milk, qty: 10, expiryDate: dayAt(20) }]);
      await buy([{ productId: milk, qty: 6, expiryDate: dayAt(3) }]);
      // FEFO order: 6 (3 days), 10 (20 days), 4 (no expiry).
      expect(await batchQtys(milk)).toEqual([6, 10, 4]);

      await sell(milk, 8);
      expect(await batchQtys(milk)).toEqual([8, 4]);
      const p = await Product.findOne({ _id: milk, shopId });
      expect(p!.currentStock).toBe(12);
      expect((await listBatches(shopId, milk)).reduce((s, b) => s + b.qty, 0)).toBe(p!.currentStock);
    });

    it('expired batches show on the alert and can be written off from that batch', async () => {
      const bread = String((await product(shopId, 'Bread', { trackExpiry: true }))._id);
      await buy([{ productId: bread, qty: 5, expiryDate: dayAt(-2) }]);
      await buy([{ productId: bread, qty: 5, expiryDate: dayAt(2) }]);
      await buy([{ productId: bread, qty: 5, expiryDate: dayAt(40) }]);

      const alerts = await expiryAlerts(shopId, 7);
      expect(alerts.expired.map((i) => [i.name, i.qty, i.daysLeft])).toEqual([['Bread', 5, -2]]);
      expect(alerts.expiringSoon.map((i) => [i.name, i.daysLeft])).toContainEqual(['Bread', 2]);
      expect(alerts.expiringSoon.some((i) => i.daysLeft > 7)).toBe(false);

      // Writing off the 2-days-left lot must not touch the expired one picked by FEFO.
      const soonLot = alerts.expiringSoon.find((i) => i.name === 'Bread')!;
      await adjustStock(shopId, { productId: bread, quantity: 5, type: 'damage', note: 'Expired', batchId: soonLot.batchId });
      expect(await batchQtys(bread)).toEqual([5, 5]);
      expect((await listBatches(shopId, bread)).map((b) => b.expiryDate!.getTime())).toEqual([dayAt(-2).getTime(), dayAt(40).getTime()]);
      expect((await Product.findOne({ _id: bread, shopId }))!.currentStock).toBe(10);
    });

    it('undoing a voice purchase removes that purchase\'s batch', async () => {
      const dahi = String((await product(shopId, 'Dahi', { trackExpiry: true }))._id);
      await buy([{ productId: dahi, qty: 4, expiryDate: dayAt(1) }]);
      const log = (await VoiceCommandLog.create({ shopId, rawText: 'dahi kharida', status: 'pending' }))._id;
      await createPurchase(shopId, { supplierId, items: [{ productId: dahi, qty: 6, rate: 2000, expiryDate: dayAt(30) }], paidAmount: 0, paymentMode: 'cash', invoiceNumber: '', note: '', updatePurchasePrice: true, source: 'voice', voiceLogId: String(log) });
      expect(await batchQtys(dahi)).toEqual([4, 6]);
      await undoVoiceCommand(shopId, String(log));
      expect(await batchQtys(dahi)).toEqual([4]);
    });

    it('turning tracking off drops the batches', async () => {
      await updateProduct(shopId, milk, { trackExpiry: false });
      expect(await ProductBatch.countDocuments({ shopId, productId: milk })).toBe(0);
    });
  });

  describe('forecast and reorder', () => {
    let sugar: string;
    let tea: string;

    beforeAll(async () => {
      sugar = String((await product(shopId, 'Sugar', { unit: 'kg', openingStock: 100, supplierId, purchasePrice: 4000 }))._id);
      tea = String((await product(shopId, 'Tata Tea', { openingStock: 50 }))._id);
      // Backdate creation so the full 30-day window counts.
      await Product.updateMany({ shopId, _id: { $in: [sugar, tea] } }, { $set: { createdAt: dayAt(-40) } }, { timestamps: false });
      // Sugar: 5 kg a day for the last 10 days -> ~50 kg left of 100.
      for (let i = 0; i < 10; i++) await sell(sugar, 5, dayAt(-i));
    });

    it('lists items that will run out soon with ~days left', async () => {
      const r = await runOutList(shopId, 30);
      const s = r.items.find((i) => i.name === 'Sugar')!;
      expect(s.currentStock).toBe(50);
      expect(s.dailyRate).toBeGreaterThan(2);
      expect(s.daysLeft).toBe(Math.floor(50 / s.dailyRate));
      // Tea never sold: no forecast.
      expect(r.items.some((i) => i.name === 'Tata Tea')).toBe(false);
    });

    it('suggests an order grouped by supplier for N days', async () => {
      const r = await reorderSuggestions(shopId, 30);
      expect(r.days).toBe(30);
      const g = r.groups.find((x) => x.supplier?.name === 'Ramesh Traders')!;
      const line = g.items.find((i) => i.name === 'Sugar')!;
      expect(line.qty).toBe(Math.ceil((line.dailyRate * 30 - 50) * 2) / 2);
      expect(line.rate).toBe(4000);
      expect(g.total).toBe(g.items.reduce((s, i) => s + Math.round(i.qty * i.rate), 0));
      expect(r.groups.flatMap((x) => x.items).some((i) => i.name === 'Tata Tea')).toBe(false);
    });

    it('uses the shop setting for days by default', async () => {
      await User.updateOne({ _id: shopId }, { $set: { 'settings.reorderDays': 7 } });
      expect((await reorderSuggestions(shopId)).days).toBe(7);
    });

    it('product list and detail include the forecast', async () => {
      const list = await request(app).get('/api/products?search=Sugar').set('Authorization', `Bearer ${token}`).expect(200);
      expect(list.body.data[0].forecast.daysLeft).toEqual(expect.any(Number));
      const one = await request(app).get(`/api/products/${tea}`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(one.body.data.forecast).toEqual({ dailyRate: 0, daysLeft: null });
    });

    it('voice "kya kya khatam hone wala hai" also names items running out', async () => {
      // A big sale today: 10 kg left at ~5 kg/day -> runs out within the week.
      await sell(sugar, 40);
      const r = await parseVoiceCommand(shopId, 'kya kya khatam hone wala hai', 'en');
      expect(r.intent).toBe('query_stock');
      const data = r.answerData as { kind: string; soon?: { name: string; daysLeft: number }[] };
      expect(data.kind).toBe('stock_list');
      expect(data.soon?.map((i) => i.name)).toContain('Sugar');
      expect(r.answer).toMatch(/हफ़्ते भर में खत्म होंगे: Sugar \((आज ही|~\d दिन)\)/);
    });

    it('stock API endpoints answer for the logged-in shop', async () => {
      const auth = { Authorization: `Bearer ${token}` };
      await request(app).get('/api/stock/runout?days=30').set(auth).expect(200);
      const reorder = await request(app).get('/api/stock/reorder?days=15').set(auth).expect(200);
      expect(reorder.body.data.days).toBe(15);
      await request(app).get('/api/stock/reorder?days=1').set(auth).expect(400);
      const exp = await request(app).get('/api/stock/expiry').set(auth).expect(200);
      expect(exp.body.data.expired.length).toBeGreaterThan(0);
    });
  });

  describe('barcode lookup', () => {
    it('finds the product by barcode only within the shop', async () => {
      await product(shopId, 'Parle-G', { barcode: '8901719110054' });
      await product(otherShop, 'Secret Biscuit', { barcode: '8900000000001' });
      const auth = { Authorization: `Bearer ${token}` };
      const res = await request(app).get('/api/products/barcode/8901719110054').set(auth).expect(200);
      expect(res.body.data).toMatchObject({ name: 'Parle-G', forecast: { daysLeft: null } });
      await request(app).get('/api/products/barcode/8900000000001').set(auth).expect(404);
      await request(app).get('/api/products/barcode/8901719110054').expect(401);
    });
  });
});
