import { Types } from 'mongoose';
import { parseVoiceCommand, setAiProvider } from '../ai/ai.service';
import { EntityMatcher } from '../ai/matcher';
import { connectDb, disconnectDb } from '../config/db';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product } from '../models/product.model';
import { Purchase } from '../models/purchase.model';
import { Sale } from '../models/sale.model';
import { StockMovement } from '../models/stockMovement.model';
import { Supplier } from '../models/supplier.model';
import { SupplierPayment } from '../models/supplierPayment.model';
import { User } from '../models/user.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { learnAlias } from '../services/aliasLearning.service';
import { addCredit, addPayment, createCustomer } from '../services/customer.service';
import { adjustStock, createProduct } from '../services/product.service';
import { createSale } from '../services/sale.service';
import { createPurchase, createSupplier, createSupplierPayment } from '../services/supplier.service';
import { lastUndoableVoiceLog, undoVoiceCommand } from '../services/voiceUndo.service';

/** toJSON() adds `id` at runtime; the inferred types do not know it. */
const idOf = (doc: unknown): string => (doc as { id: string }).id;

/** Undo of voice entries + alias learning + auto-save, against an in-memory replica set. */
describe('voice undo / aliases / auto-save (integration)', () => {
  let shopId: Types.ObjectId;
  let sugarId: string;
  let riceId: string;
  let sharmaId: string;
  let supplierId: string;

  const product = (id: string) => Product.findOne({ _id: id, shopId });
  const balance = async (id: string) => (await Customer.findOne({ _id: id, shopId }))!.currentBalance;
  const payable = async (id: string) => (await Supplier.findOne({ _id: id, shopId }))!.currentPayable;
  const newLog = async (rawText = 'voice') => String((await VoiceCommandLog.create({ shopId, rawText, status: 'pending' }))._id);
  const credit = (customerId: string, amount: number, voiceLogId?: string) =>
    addCredit(shopId, customerId, { amount, items: [], note: '', source: 'voice', voiceLogId });

  beforeAll(async () => {
    await connectDb('memory');
    shopId = (await User.create({ name: 'Test', phone: '9000000077', passwordHash: 'x', shopName: 'Undo Shop' }))._id;
    const base = { nameHindi: '', category: 'Grocery', mrp: 0, isActive: true };
    sugarId = String((await createProduct(shopId, { ...base, name: 'Sugar', aliases: ['cheeni'], unit: 'kg', purchasePrice: 4000, sellingPrice: 4500, openingStock: 50 }))._id);
    riceId = String((await createProduct(shopId, { ...base, name: 'Basmati Rice', aliases: ['chawal'], unit: 'kg', purchasePrice: 7000, sellingPrice: 8500, openingStock: 20 }))._id);
    sharmaId = String((await createCustomer(shopId, { name: 'Rakesh Sharma', aliases: ['Sharma ji'], phone: '', address: '' }))._id);
    await createCustomer(shopId, { name: 'Mohan Sharma', aliases: [], phone: '', address: '' });
    supplierId = String((await createSupplier(shopId, { name: 'Ramesh Traders', aliases: [], phone: '', company: '', address: '', gstNumber: '' }))._id);
  });

  afterAll(async () => {
    setAiProvider({ name: 'none', isAvailable: () => false, parseCommand: async () => ({}) });
    await disconnectDb();
  });

  // ------------------------------------------------------------------ undo
  it('udhaar credit: undo removes the entry and restores the balance', async () => {
    const before = await balance(sharmaId);
    const logId = await newLog('Sharma ji ke 500 add karo');
    const { entry } = await credit(sharmaId, 50000, logId);
    expect(await balance(sharmaId)).toBe(before + 50000);

    const log = await undoVoiceCommand(shopId, logId);
    expect(log.status).toBe('undone');
    expect(await balance(sharmaId)).toBe(before);
    expect(await CustomerLedger.exists({ _id: idOf(entry), shopId })).toBeNull();
  });

  it('payment received: undo puts the udhaar back', async () => {
    await credit(sharmaId, 30000);
    const before = await balance(sharmaId);
    const logId = await newLog();
    await addPayment(shopId, sharmaId, { amount: 10000, mode: 'cash', note: '', source: 'voice', voiceLogId: logId });
    await undoVoiceCommand(shopId, logId);
    expect(await balance(sharmaId)).toBe(before);
  });

  it('udhaar bill: undo restores stock (via reversal movements), ledger and balance, and removes the bill', async () => {
    const [stock0, bal0] = [(await product(sugarId))!.currentStock, await balance(sharmaId)];
    const logId = await newLog();
    const sale = await createSale(shopId, {
      customerId: sharmaId, items: [{ productId: sugarId, qty: 2 }], discount: 0, paymentMode: 'udhaar', note: '', allowOversell: false, source: 'voice', voiceLogId: logId,
    });
    expect((await product(sugarId))!.currentStock).toBe(stock0 - 2);

    await undoVoiceCommand(shopId, logId);
    expect((await product(sugarId))!.currentStock).toBe(stock0);
    expect(await balance(sharmaId)).toBe(bal0);
    expect(await Sale.exists({ _id: idOf(sale), shopId })).toBeNull();
    expect(await CustomerLedger.exists({ shopId, saleId: idOf(sale) })).toBeNull();
    const moves = await StockMovement.find({ shopId, referenceId: idOf(sale) }).sort({ createdAt: 1 });
    expect(moves.map((m) => [m.type, m.quantity])).toEqual([['sale', -2], ['reversal', 2]]);
  });

  it('cash bill with two items: undo restores both stocks', async () => {
    const [s0, r0] = [(await product(sugarId))!.currentStock, (await product(riceId))!.currentStock];
    const logId = await newLog();
    await createSale(shopId, {
      items: [{ productId: sugarId, qty: 1 }, { productId: riceId, qty: 0.5 }], discount: 0, paymentMode: 'cash', note: '', allowOversell: false, source: 'voice', voiceLogId: logId,
    });
    await undoVoiceCommand(shopId, logId);
    expect((await product(sugarId))!.currentStock).toBe(s0);
    expect((await product(riceId))!.currentStock).toBe(r0);
  });

  it('purchase: undo restores stock, supplier due, old cost price, and removes products it created', async () => {
    const [stock0, due0] = [(await product(sugarId))!.currentStock, await payable(supplierId)];
    const logId = await newLog();
    const purchase = await createPurchase(shopId, {
      supplierId,
      items: [{ productId: sugarId, qty: 10, rate: 3900 }, { newProduct: { name: 'Tata Salt', unit: 'packet', category: 'Grocery', sellingPrice: 2800 }, qty: 5, rate: 2200 }],
      paidAmount: 10000, paymentMode: 'cash', invoiceNumber: '', note: '', updatePurchasePrice: true, source: 'voice', voiceLogId: logId,
    });
    expect((await product(sugarId))!.purchasePrice).toBe(3900);

    await undoVoiceCommand(shopId, logId);
    const sugar = await product(sugarId);
    expect(sugar!.currentStock).toBe(stock0);
    expect(sugar!.purchasePrice).toBe(4000);
    expect(await payable(supplierId)).toBe(due0);
    expect(await Purchase.exists({ _id: idOf(purchase), shopId })).toBeNull();
    expect(await Product.exists({ shopId, name: 'Tata Salt', isDeleted: false })).toBeNull();
  });

  it('purchase whose goods were already sold cannot be undone, and nothing changes', async () => {
    const logId = await newLog();
    const tea = await createProduct(shopId, { name: 'Tea', nameHindi: '', aliases: [], category: 'Grocery', unit: 'packet', purchasePrice: 0, sellingPrice: 5000, mrp: 0, openingStock: 0, isActive: true });
    await createPurchase(shopId, {
      supplierId, items: [{ productId: String(tea._id), qty: 3, rate: 4000 }], paidAmount: 0, paymentMode: 'cash', invoiceNumber: '', note: '', updatePurchasePrice: true, source: 'voice', voiceLogId: logId,
    });
    await createSale(shopId, { items: [{ productId: String(tea._id), qty: 2 }], discount: 0, paymentMode: 'cash', note: '', allowOversell: false, source: 'manual' });
    const due = await payable(supplierId);

    await expect(undoVoiceCommand(shopId, logId)).rejects.toMatchObject({ statusCode: 409 });
    expect((await product(String(tea._id)))!.currentStock).toBe(1);
    expect(await payable(supplierId)).toBe(due);
    expect((await VoiceCommandLog.findOne({ _id: logId, shopId }))!.status).toBe('confirmed');
  });

  it('supplier payment: undo puts the due back', async () => {
    const due0 = await payable(supplierId);
    const logId = await newLog();
    const { payment } = await createSupplierPayment(shopId, { supplierId, amount: 5000, mode: 'cash', note: '', source: 'voice', voiceLogId: logId });
    await undoVoiceCommand(shopId, logId);
    expect(await payable(supplierId)).toBe(due0);
    expect(await SupplierPayment.exists({ _id: idOf(payment), shopId })).toBeNull();
  });

  it('stock adjustment: undo applies the opposite change', async () => {
    const s0 = (await product(riceId))!.currentStock;
    const logId = await newLog();
    await adjustStock(shopId, { productId: riceId, quantity: 25, type: 'adjustment', note: '', voiceLogId: logId });
    await undoVoiceCommand(shopId, logId);
    expect((await product(riceId))!.currentStock).toBe(s0);
  });

  it('new customer created for udhaar: undo removes the udhaar and the new khata', async () => {
    const logId = await newLog('Anil Gupta ne 12000 ka udhaar liya');
    const anil = await createCustomer(shopId, { name: 'Anil Gupta', aliases: [], phone: '', address: '', voiceLogId: logId });
    await credit(String(anil._id), 1200000, logId);
    await undoVoiceCommand(shopId, logId);
    const c = await Customer.findOne({ _id: anil._id, shopId });
    expect(c).toMatchObject({ isDeleted: true, currentBalance: 0 });
  });

  it('refuses: twice, after the window, another shop, nothing saved', async () => {
    const logId = await newLog();
    await credit(sharmaId, 1000, logId);
    await undoVoiceCommand(shopId, logId);
    await expect(undoVoiceCommand(shopId, logId)).rejects.toMatchObject({ statusCode: 409 });

    const old = await newLog();
    await credit(sharmaId, 1000, old);
    await VoiceCommandLog.updateOne({ _id: old, shopId }, { executedAt: new Date(Date.now() - 10 * 60_000) });
    await expect(undoVoiceCommand(shopId, old)).rejects.toMatchObject({ statusCode: 409 });

    const other = (await User.create({ name: 'Other', phone: '9000000076', passwordHash: 'x', shopName: 'Other' }))._id;
    const mine = await newLog();
    await credit(sharmaId, 1000, mine);
    await expect(undoVoiceCommand(other, mine)).rejects.toMatchObject({ statusCode: 404 });

    const empty = await newLog();
    await expect(undoVoiceCommand(shopId, empty)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('undo-last finds the most recent saved voice entry; form entries are never touched', async () => {
    const before = await balance(sharmaId);
    await credit(sharmaId, 7000); // from a form: no log
    const a = await newLog('first');
    await credit(sharmaId, 100, a);
    const b = await newLog('second');
    await credit(sharmaId, 200, b);
    expect(String((await lastUndoableVoiceLog(shopId))!._id)).toBe(b);
    await undoVoiceCommand(shopId, b);
    expect(String((await lastUndoableVoiceLog(shopId))!._id)).toBe(a);
    expect(await balance(sharmaId)).toBe(before + 7000 + 100);
  });

  // ------------------------------------------------------------------ aliases
  it('learns a spoken name once, case-insensitively, and never one that belongs to someone else', async () => {
    expect(await learnAlias(shopId, { kind: 'customer', id: sharmaId, alias: 'Sharma' })).toMatchObject({ added: true });
    expect(await learnAlias(shopId, { kind: 'customer', id: sharmaId, alias: 'SHARMA' })).toMatchObject({ added: false, reason: 'exists' });
    expect(await learnAlias(shopId, { kind: 'customer', id: sharmaId, alias: 'rakesh sharma' })).toMatchObject({ added: false, reason: 'exists' });
    expect(await learnAlias(shopId, { kind: 'customer', id: sharmaId, alias: 'Mohan Sharma' })).toMatchObject({ added: false, reason: 'conflict' });
    expect(await learnAlias(shopId, { kind: 'product', id: sugarId, alias: 'चीनी' })).toMatchObject({ added: false, reason: 'exists' });
    expect(await learnAlias(shopId, { kind: 'product', id: sugarId, alias: 'shakkar' })).toMatchObject({ added: true });
    const c = await Customer.findOne({ _id: sharmaId, shopId });
    expect(c!.aliases.filter((a) => a.toLowerCase() === 'sharma')).toHaveLength(1);
  });

  it('a learned alias makes the next match unambiguous', async () => {
    const customers = await Customer.find({ shopId, isDeleted: false });
    const m = new EntityMatcher(customers.map((c) => ({ id: String(c._id), name: c.name, aliases: c.aliases })), true);
    expect(m.match('Sharma')).toMatchObject({ status: 'matched', best: { id: sharmaId } });
    const products = await Product.find({ shopId, isDeleted: false });
    const p = new EntityMatcher(products.map((x) => ({ id: String(x._id), name: x.name, aliases: x.aliases })));
    expect(p.match('shakkar')).toMatchObject({ status: 'matched', best: { id: sugarId } });
  });

  // ------------------------------------------------------------------ auto-save
  it('auto-save only when "always ask" is off and the command is clear', async () => {
    // A stand-in for Claude: returns whatever command the test sets, at 0.95 confidence.
    let next: Record<string, unknown> = {};
    const command = (c: Record<string, unknown>) => ({
      intent: 'add_credit', customerName: null, supplierName: null, productName: null, amount: null, paidAmount: null, items: [], quantity: null,
      unit: null, sellingPrice: null, paymentMode: null, date: null, period: null, queryType: null, settleFull: false, note: null, confidence: 0.95, ...c,
    });
    setAiProvider({ name: 'fake-ai', isAvailable: () => true, parseCommand: async () => next });
    const say = (c: Record<string, unknown>) => ((next = command(c)), parseVoiceCommand(shopId, 'test', 'hi'));
    const clear = { customerName: 'Sharma ji', amount: 50000 };

    expect((await say(clear)).autoSave).toBe(false); // default setting: always ask

    await User.updateOne({ _id: shopId }, { $set: { 'settings.voiceAlwaysConfirm': false } });
    const r = await say(clear);
    expect(r.autoSaveConfidence).toBe(0.95);
    expect(r.autoSave).toBe(true);

    expect((await say({ customerName: 'Mohan', amount: 50000 })).autoSave).toBe(false); // weak match: card
    expect((await say({ customerName: 'Deepak Chauhan', amount: 50000 })).autoSave).toBe(false); // new person
    expect((await say({ customerName: 'Sharma ji', amount: null })).autoSave).toBe(false); // amount unclear
    expect((await say({ intent: 'query_balance', customerName: 'Sharma ji' })).autoSave).toBe(false); // a question

    await User.updateOne({ _id: shopId }, { $set: { 'settings.voiceAutoSaveThreshold': 0.97 } });
    expect((await say(clear)).autoSave).toBe(false); // below the threshold

    // The offline parser tops out at 0.8 confidence, so it never auto-saves at the default threshold.
    await User.updateOne({ _id: shopId }, { $set: { 'settings.voiceAutoSaveThreshold': 0.85 } });
    setAiProvider({ name: 'none', isAvailable: () => false, parseCommand: async () => ({}) });
    expect((await parseVoiceCommand(shopId, 'Sharma ji ke 500 rupay udhaar likh do', 'hi')).autoSave).toBe(false);
    await User.updateOne({ _id: shopId }, { $set: { 'settings.voiceAlwaysConfirm': true } });
  });

  it('"galti ho gayi" points at the last undoable entry', async () => {
    const logId = await newLog('Sharma ji ke 300 likh do');
    await credit(sharmaId, 30000, logId);
    const r = await parseVoiceCommand(shopId, 'galti ho gayi, pichhla wala hatao', 'hi');
    expect(r.intent).toBe('undo_last');
    expect(r.needsConfirmation).toBe(false);
    expect(r.answerData).toMatchObject({ kind: 'undo', logId });
  });
});
