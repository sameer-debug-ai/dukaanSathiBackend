import { Types } from 'mongoose';
import { parseVoiceCommand, setAiProvider } from '../ai/ai.service';
import { emptyCommand } from '../ai/intentSchema';
import type { ParseRequest } from '../ai/provider';
import { connectDb, disconnectDb } from '../config/db';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product } from '../models/product.model';
import { Supplier } from '../models/supplier.model';
import { User } from '../models/user.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { addCredit, createCustomer } from '../services/customer.service';
import { createProduct } from '../services/product.service';
import { createSupplier } from '../services/supplier.service';
import { executeBatchSchema, executeVoiceBatch } from '../services/voiceBatch.service';
import { undoVoiceCommand } from '../services/voiceUndo.service';

const offline = { name: 'none', isAvailable: () => false, parseCommand: async () => ({}) };

/** Multi-action voice commands, saved in one transaction, plus conversation context. */
describe('voice multi-action + context (integration)', () => {
  let shopId: Types.ObjectId;
  let sharmaId: string;
  let guptaId: string;
  let supplierId: string;
  let sugarId: string;

  const balance = async (id: string) => (await Customer.findOne({ _id: id, shopId }))!.currentBalance;
  const say = (text: string) => parseVoiceCommand(shopId, text, 'en');
  const batch = (logId: string, actions: unknown[]) => executeVoiceBatch(shopId, executeBatchSchema.parse({ logId, text: 'voice', note: 'Voice entry', actions }));

  beforeAll(async () => {
    await connectDb('memory');
    setAiProvider(offline);
    shopId = (await User.create({ name: 'Test', phone: '9000000088', passwordHash: 'x', shopName: 'Batch Shop' }))._id;
    sharmaId = String((await createCustomer(shopId, { name: 'Rakesh Sharma', aliases: ['Sharma ji'], phone: '', address: '' }))._id);
    guptaId = String((await createCustomer(shopId, { name: 'Anil Gupta', aliases: ['Gupta ji'], phone: '', address: '' }))._id);
    supplierId = String((await createSupplier(shopId, { name: 'Ramesh Traders', aliases: [], phone: '', company: '', address: '', gstNumber: '' }))._id);
    sugarId = String(
      (await createProduct(shopId, { name: 'Sugar', nameHindi: '', aliases: ['cheeni'], category: 'Grocery', unit: 'kg', purchasePrice: 4000, sellingPrice: 4500, mrp: 0, isActive: true, openingStock: 50 }))._id,
    );
    await addCredit(shopId, guptaId, { amount: 100000, items: [], note: '', source: 'manual' });
  });

  afterAll(async () => {
    setAiProvider(offline);
    await disconnectDb();
  });

  beforeEach(async () => {
    setAiProvider(offline);
    // Each test starts a fresh conversation.
    await say('naya');
  });

  // ------------------------------------------------------------------ parsing
  it('one sentence with two actions comes back as two resolved actions on one log', async () => {
    const r = await say('Sharma ji ke 500 likho aur Gupta ji ne 200 de diye');
    expect(r.actions).toHaveLength(2);
    expect(r.actions![0]).toMatchObject({ intent: 'add_credit', amount: 50000, logId: r.logId });
    expect(r.actions![0]!.customer?.best?.id).toBe(sharmaId);
    expect(r.actions![1]).toMatchObject({ intent: 'receive_payment', amount: 20000, logId: r.logId });
    expect(r.actions![1]!.customer?.best?.id).toBe(guptaId);
    // Top level mirrors the first action, so single-action clients keep working.
    expect(r.intent).toBe('add_credit');
    const log = await VoiceCommandLog.findOne({ _id: r.logId, shopId });
    expect((log!.parsedJson as { actions: unknown[] }).actions).toHaveLength(2);
  });

  it('a single action has no `actions` list (unchanged shape)', async () => {
    const r = await say('Sharma ji ke 500 likho');
    expect(r.actions).toBeUndefined();
    expect(r.intent).toBe('add_credit');
  });

  it('auto-save applies only when EVERY action qualifies', async () => {
    await User.updateOne({ _id: shopId }, { $set: { 'settings.voiceAlwaysConfirm': false, 'settings.voiceAutoSaveThreshold': 0.5 } });
    try {
      const clean = await say('Sharma ji ke 500 likho aur Gupta ji ne 200 de diye');
      expect(clean.autoSave).toBe(true);
      // The second person is new (not in the khata): never auto-saved.
      setAiProvider({
        name: 'fake',
        isAvailable: () => true,
        parseCommand: async () => ({
          actions: [
            { ...emptyCommand('add_credit'), customerName: 'Sharma ji', amount: 50000, confidence: 0.95 },
            { ...emptyCommand('add_credit'), customerName: 'Pappu Yadav', amount: 20000, confidence: 0.95 },
          ],
        }),
      });
      const mixed = await say('Sharma ji ke 500 likho aur Pappu Yadav ke 200 likho');
      expect(mixed.actions).toHaveLength(2);
      expect(mixed.autoSave).toBe(false);
    } finally {
      await User.updateOne({ _id: shopId }, { $set: { 'settings.voiceAlwaysConfirm': true, 'settings.voiceAutoSaveThreshold': 0.85 } });
    }
  });

  it('passes the AI a list of actions and the recent conversation', async () => {
    let seen: ParseRequest | undefined;
    setAiProvider({
      name: 'fake',
      isAvailable: () => true,
      parseCommand: async (req) => {
        seen = req;
        return {
          actions: [
            { ...emptyCommand('add_credit'), customerName: 'Sharma ji', amount: 50000, confidence: 0.95 },
            { ...emptyCommand('supplier_payment'), supplierName: 'Ramesh Traders', amount: 10000, confidence: 0.95 },
          ],
        };
      },
    });
    const r = await say('Sharma ji ke 500 likho aur Ramesh Traders ko 100 diye');
    expect(r.engine).toBe('ai');
    expect(r.actions!.map((a) => a.intent)).toEqual(['add_credit', 'supplier_payment']);
    expect(r.actions![1]!.supplier?.best?.id).toBe(supplierId);

    await say('aur 200 jodo');
    expect(seen!.history!.join('\n')).toContain('customer: Rakesh Sharma');
  });

  // ------------------------------------------------------------------ context
  it('"aur 200 jodo" and "unka kitna udhaar hai" refer to the last customer', async () => {
    await say('Sharma ji ke 500 likho');
    const more = await say('aur 200 jodo');
    expect(more).toMatchObject({ intent: 'add_credit', amount: 20000 });
    expect(more.customer?.best?.id).toBe(sharmaId);

    const q = await say('unka kitna udhaar hai');
    expect(q.intent).toBe('query_balance');
    expect(q.customer?.best?.id).toBe(sharmaId);
  });

  it('"unhone 100 aur diye" is another payment by the same person', async () => {
    await say('Gupta ji ne 300 diye');
    const r = await say('unhone 100 aur diye');
    expect(r).toMatchObject({ intent: 'receive_payment', amount: 10000 });
    expect(r.customer?.best?.id).toBe(guptaId);
  });

  it('"naya" forgets who was being talked about', async () => {
    await say('Sharma ji ke 500 likho');
    const reset = await say('naya');
    expect(reset).toMatchObject({ intent: 'reset_context', needsConfirmation: false });
    const r = await say('aur 200 jodo');
    expect(r.customer?.best).toBeFalsy();
  });

  it('context expires after 10 minutes of inactivity', async () => {
    await say('Sharma ji ke 500 likho');
    // createdAt is immutable through mongoose, so age the logs directly.
    await VoiceCommandLog.collection.updateMany({ shopId }, { $set: { createdAt: new Date(Date.now() - 11 * 60 * 1000) } });
    const r = await say('aur 200 jodo');
    expect(r.customer?.best).toBeFalsy();
  });

  // ------------------------------------------------------------------ saving
  it('saves every action together, and Undo reverses the whole group', async () => {
    const [s0, g0] = [await balance(sharmaId), await balance(guptaId)];
    const r = await say('Sharma ji ke 500 likho aur Gupta ji ne 200 de diye');
    const out = await batch(r.logId, [
      { intent: 'add_credit', customerId: sharmaId, amount: 50000 },
      { intent: 'receive_payment', customerId: guptaId, amount: 20000, paymentMode: 'cash' },
    ]);
    expect(out).toEqual([
      expect.objectContaining({ intent: 'add_credit', name: 'Rakesh Sharma', amount: 50000, balance: s0 + 50000 }),
      expect.objectContaining({ intent: 'receive_payment', name: 'Anil Gupta', amount: 20000, balance: g0 - 20000 }),
    ]);
    const log = await VoiceCommandLog.findOne({ _id: r.logId, shopId });
    expect(log!.status).toBe('confirmed');
    expect(log!.effects).toHaveLength(2);

    await undoVoiceCommand(shopId, r.logId);
    expect(await balance(sharmaId)).toBe(s0);
    expect(await balance(guptaId)).toBe(g0);
    expect(await CustomerLedger.countDocuments({ shopId, source: 'voice', customerId: { $in: [sharmaId, guptaId] }, amount: { $in: [50000, 20000] } })).toBe(0);
  });

  it('if one action fails nothing is saved (single transaction)', async () => {
    const s0 = await balance(sharmaId);
    const stock0 = (await Product.findOne({ _id: sugarId, shopId }))!.currentStock;
    const r = await say('Sharma ji ke 500 likho aur Ramesh Traders ko 5000 diye');
    // Nothing is due to the supplier, so the payment is rejected.
    await expect(
      batch(r.logId, [
        { intent: 'add_credit', customerId: sharmaId, items: [{ productId: sugarId, name: 'Sugar', qty: 2, unit: 'kg', rate: 4500 }] },
        { intent: 'supplier_payment', supplierId, amount: 500000 },
      ]),
    ).rejects.toThrow(/^2: /);
    expect(await balance(sharmaId)).toBe(s0);
    expect((await Product.findOne({ _id: sugarId, shopId }))!.currentStock).toBe(stock0);
    expect((await Supplier.findOne({ _id: supplierId, shopId }))!.currentPayable).toBe(0);
    const log = await VoiceCommandLog.findOne({ _id: r.logId, shopId });
    expect(log!.effects).toHaveLength(0);
    expect(log!.status).toBe('pending');
  });

  it('adds a new customer inside the batch and refuses to save the same command twice', async () => {
    const r = await say('Pappu Yadav ke 300 likho aur Sharma ji ke 100 likho');
    await batch(r.logId, [
      { intent: 'add_credit', newCustomerName: 'Pappu Yadav', amount: 30000 },
      { intent: 'add_credit', customerId: sharmaId, amount: 10000 },
    ]);
    const pappu = await Customer.findOne({ shopId, name: 'Pappu Yadav' });
    expect(pappu!.currentBalance).toBe(30000);
    await expect(batch(r.logId, [{ intent: 'add_credit', customerId: sharmaId, amount: 10000 }])).rejects.toThrow('already saved');

    // Undo also removes the person it added.
    await undoVoiceCommand(shopId, r.logId);
    expect((await Customer.findOne({ _id: pappu!._id, shopId }))!.isDeleted).toBe(true);
  });
});
