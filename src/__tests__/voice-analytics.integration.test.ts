import { Types } from 'mongoose';
import request from 'supertest';
import { parseVoiceCommand, setAiProvider } from '../ai/ai.service';
import { emptyCommand, type ParsedCommand } from '../ai/intentSchema';
import type { ParseRequest } from '../ai/provider';
import { setSttProvider, type TranscribeRequest } from '../ai/stt';
import { createApp } from '../app';
import { connectDb, disconnectDb } from '../config/db';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Sale } from '../models/sale.model';
import { User } from '../models/user.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { addCredit, addPayment, createCustomer } from '../services/customer.service';
import { createProduct } from '../services/product.service';
import { createSale } from '../services/sale.service';
import { signAccessToken } from '../services/token.service';
import { compareSales, inactiveDebtors, profit, runAnalytics, topDebtors, topProducts } from '../services/voiceAnalytics.service';
import { addDays, startOfIstDay } from '../utils/istDate';

const offline = { name: 'none', isAvailable: () => false, parseCommand: async () => ({}) };
const daysAgo = (n: number) => addDays(startOfIstDay(), -n);
/** Midday of a past IST day, so the entry sits well inside that day. */
const at = (n: number) => new Date(daysAgo(n).getTime() + 6 * 3600 * 1000);

/** Voice analytics functions, the rule-based fast path, and the speech-to-text endpoint. */
describe('voice phase 1C (integration)', () => {
  let shopId: Types.ObjectId;
  let otherShop: Types.ObjectId;
  let sugar: string;
  let milk: string;
  let ids: Record<string, string>;

  const sell = (productId: string, qty: number, daysBack: number) =>
    createSale(shopId, { items: [{ productId, qty }], discount: 0, paymentMode: 'cash', note: '', allowOversell: false, source: 'manual', date: daysBack ? at(daysBack) : new Date() });

  beforeAll(async () => {
    await connectDb('memory');
    setAiProvider(offline);
    shopId = (await User.create({ name: 'Test', phone: '9000000071', passwordHash: 'x', shopName: 'Analytics Shop' }))._id;
    otherShop = (await User.create({ name: 'Other', phone: '9000000072', passwordHash: 'x', shopName: 'Other Shop' }))._id;

    const product = (name: string, unit: string, purchasePrice: number, sellingPrice: number) =>
      createProduct(shopId, { name, nameHindi: '', aliases: [], category: 'Grocery', unit: unit as 'kg', purchasePrice, sellingPrice, mrp: 0, isActive: true, openingStock: 500 });
    sugar = String((await product('Sugar', 'kg', 4000, 4500))._id);
    milk = String((await product('Milk', 'litre', 5000, 6000))._id);

    // Yesterday: 2 kg sugar + 10 litre milk (₹690). Today: 2 kg sugar (₹90). Earlier this week: 1 kg sugar.
    await sell(sugar, 2, 1);
    await sell(milk, 10, 1);
    await sell(sugar, 2, 0);
    await sell(sugar, 1, 3);

    const customer = async (shop: Types.ObjectId, name: string) => String((await createCustomer(shop, { name, aliases: [], phone: '', address: '' }))._id);
    ids = {
      sharma: await customer(shopId, 'Rakesh Sharma'),
      gupta: await customer(shopId, 'Anil Gupta'),
      verma: await customer(shopId, 'Mohan Verma'),
      newbie: await customer(shopId, 'Naya Grahak'),
      rich: await customer(otherShop, 'Other Shop Customer'),
    };
    await Customer.updateOne({ _id: ids.sharma, shopId }, { $set: { aliases: ['Sharma ji'] } });
    // Sharma: udhaar 90 days ago, last paid 70 days ago -> late for 60 days.
    await addCredit(shopId, ids.sharma, { amount: 300000, items: [], note: '', source: 'manual', date: at(90) });
    await addPayment(shopId, ids.sharma, { amount: 50000, mode: 'cash', note: '', source: 'manual', date: at(70) });
    // Gupta: old udhaar but paid 10 days ago -> fine.
    await addCredit(shopId, ids.gupta, { amount: 100000, items: [], note: '', source: 'manual', date: at(90) });
    await addPayment(shopId, ids.gupta, { amount: 20000, mode: 'cash', note: '', source: 'manual', date: at(10) });
    // Verma: never paid, udhaar 80 days ago -> late.
    await addCredit(shopId, ids.verma, { amount: 40000, items: [], note: '', source: 'manual', date: at(80) });
    // New customer: udhaar 5 days ago, not late yet.
    await addCredit(shopId, ids.newbie, { amount: 900000, items: [], note: '', source: 'manual', date: at(5) });
    // Another shop's huge debtor must never show up.
    await addCredit(otherShop, ids.rich, { amount: 99900000, items: [], note: '', source: 'manual', date: at(200) });
  });

  afterAll(async () => {
    setAiProvider(offline);
    await disconnectDb();
  });

  beforeEach(() => setAiProvider(offline));

  // ------------------------------------------------------------ query functions
  it('top_products ranks by sales value in the period', async () => {
    const r = await topProducts(shopId, { period: 'this_week', limit: null }, 'en');
    expect(r.data.rows.map((x) => [x.name, x.qty, x.revenue])).toEqual([
      ['Milk', 10, 60000],
      ['Sugar', 5, 22500],
    ]);
    expect(r.answer).toMatch(/best seller was Milk/);
    expect(r.data.chart?.data).toEqual([60000, 22500]);
    const today = await topProducts(shopId, { period: 'today', limit: 1 }, 'hi');
    expect(today.data.rows).toEqual([{ name: 'Sugar', qty: 2, unit: 'kg', revenue: 9000 }]);
    expect(today.answer).toContain('सबसे ज़्यादा Sugar बिका');
  });

  it('compare_sales explains a drop with the products that fell', async () => {
    const r = await compareSales(shopId, { period: 'today' }, 'en');
    expect(r.data.totals).toMatchObject({ current: 9000, previous: 69000, change: -60000, currentBills: 1, previousBills: 2 });
    expect(r.data.rows[0]).toMatchObject({ name: 'Milk', current: 0, previous: 60000, change: -60000 });
    expect(r.answer).toMatch(/less than yesterday/);
    expect(r.answer).toMatch(/Milk ₹600/);
  });

  it('profit uses purchase cost (paise)', async () => {
    const r = await profit(shopId, { period: 'today' }, 'en');
    // 2 kg sugar: sold 9000, cost 8000.
    expect(r.data.totals).toMatchObject({ revenue: 9000, cost: 8000, profit: 1000 });
    expect(r.answer).toContain('₹10');
  });

  it('top_debtors lists only this shop, highest first', async () => {
    const r = await topDebtors(shopId, { limit: null }, 'en');
    expect(r.data.rows.map((x) => x.name)).toEqual(['Naya Grahak', 'Rakesh Sharma', 'Anil Gupta', 'Mohan Verma']);
    expect(r.data.totals).toEqual({ count: 4, balance: 900000 + 250000 + 80000 + 40000 });
    expect(JSON.stringify(r)).not.toContain('Other Shop Customer');
  });

  it('inactive_debtors: has udhaar, no payment in N days, and owed for longer than N days', async () => {
    const r = await inactiveDebtors(shopId, { days: 60, limit: null }, 'en');
    expect(r.data.rows.map((x) => x.name)).toEqual(['Rakesh Sharma', 'Mohan Verma']);
    expect(r.data.rows[1]!.lastPayment).toBeNull();
    expect(r.data.totals).toEqual({ count: 2, balance: 290000 });
    const all = await inactiveDebtors(shopId, { days: 7, limit: null }, 'en');
    expect(all.data.rows.map((x) => x.name)).toEqual(['Rakesh Sharma', 'Anil Gupta', 'Mohan Verma']);
  });

  it('runAnalytics clamps parameters again', async () => {
    const r = await runAnalytics(shopId, { fn: 'inactive_debtors', period: null, days: -5, limit: 500 }, 'en');
    expect(r.data.days).toBe(7);
  });

  // ------------------------------------------------------------ through the voice parser
  it('offline: an analytics question is answered, logged as confirmed, and saves nothing', async () => {
    const before = await Promise.all([Sale.countDocuments({ shopId }), CustomerLedger.countDocuments({ shopId })]);
    const r = await parseVoiceCommand(shopId, 'Sabse zyada udhaar kiska hai?', 'hi');
    expect(r).toMatchObject({ intent: 'query_analytics', needsConfirmation: false, parsePath: 'offline', autoSave: false });
    expect(r.answerData).toMatchObject({ kind: 'analytics', fn: 'top_debtors' });
    expect(r.answer).toContain('Naya Grahak');
    const log = await VoiceCommandLog.findOne({ _id: r.logId, shopId });
    expect(log).toMatchObject({ status: 'confirmed', intent: 'query_analytics', parsePath: 'offline' });
    expect(await Promise.all([Sale.countDocuments({ shopId }), CustomerLedger.countDocuments({ shopId })])).toEqual(before);
  });

  it('the AI picks the function and parameters; the server runs it', async () => {
    setAiProvider({
      name: 'fake',
      isAvailable: () => true,
      parseCommand: async (): Promise<{ actions: ParsedCommand[] }> => ({
        actions: [{ ...emptyCommand('query_analytics'), analytics: { fn: 'inactive_debtors', period: null, days: 60, limit: null }, confidence: 0.9 }],
      }),
    });
    const r = await parseVoiceCommand(shopId, 'Kaun 2 mahine se paisa nahi de raha?', 'en');
    expect(r).toMatchObject({ intent: 'query_analytics', parsePath: 'ai' });
    expect(r.answerData).toMatchObject({ fn: 'inactive_debtors', days: 60 });
    expect(r.answer).toMatch(/^2 ग्राहकों/); // Hinglish question, Hindi answer
  });

  // ------------------------------------------------------------ fast path
  it('a simple command skips the AI and is logged as parsePath "rule"', async () => {
    const calls: ParseRequest[] = [];
    setAiProvider({
      name: 'fake',
      isAvailable: () => true,
      parseCommand: async (req: ParseRequest) => {
        calls.push(req);
        return { actions: [{ ...emptyCommand('add_credit'), customerName: 'Sharma ji', amount: 20000, confidence: 0.9 }] };
      },
    });
    const r = await parseVoiceCommand(shopId, 'Sharma ji ke paanch sau udhaar likho', 'hi');
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ intent: 'add_credit', amount: 50000, parsePath: 'rule', engine: 'rules', needsConfirmation: true });
    expect(r.customer).toMatchObject({ status: 'matched', best: { id: ids.sharma } });
    expect((await VoiceCommandLog.findOne({ _id: r.logId, shopId }))?.parsePath).toBe('rule');

    // A follow-up needs the conversation, so it goes to the AI.
    const follow = await parseVoiceCommand(shopId, 'unke 200 aur jodo', 'hi');
    expect(calls).toHaveLength(1);
    expect(follow).toMatchObject({ parsePath: 'ai', engine: 'ai', amount: 20000 });
    expect((await VoiceCommandLog.findOne({ _id: follow.logId, shopId }))?.parsePath).toBe('ai');
  });

  it('without an AI key the offline parser is used as before (no fast path)', async () => {
    const r = await parseVoiceCommand(shopId, 'Sharma ji ke 500 udhaar likho', 'hi');
    expect(r).toMatchObject({ intent: 'add_credit', amount: 50000, parsePath: 'offline', engine: 'rules' });
  });

  // ------------------------------------------------------------ speech-to-text endpoint
  describe('POST /api/ai/transcribe', () => {
    const app = createApp();
    let token: string;
    const received: TranscribeRequest[] = [];
    const audio = Buffer.alloc(4000, 1);

    beforeAll(() => {
      token = signAccessToken(String(shopId), String(shopId));
    });
    const post = (body: Buffer | object, type = 'audio/webm;codecs=opus', lang = 'hi') =>
      request(app).post(`/api/ai/transcribe?lang=${lang}`).set('Authorization', `Bearer ${token}`).set('Content-Type', type).send(body);

    it('needs login', async () => {
      await request(app).post('/api/ai/transcribe').set('Content-Type', 'audio/webm').send(audio).expect(401);
    });

    it('503 when no STT provider is configured', async () => {
      setSttProvider({ name: 'none', isAvailable: () => false, transcribe: async () => '' });
      const res = await post(audio).expect(503);
      expect(res.body.message).toMatch(/STT_PROVIDER/);
    });

    it('returns the text from the provider', async () => {
      setSttProvider({
        name: 'fake',
        isAvailable: () => true,
        transcribe: async (req) => {
          received.push(req);
          return '  शर्मा जी के 500 उधार लिखो  ';
        },
      });
      const res = await post(audio, 'audio/mp4', 'en').expect(200);
      expect(res.body.data).toEqual({ text: 'शर्मा जी के 500 उधार लिखो', provider: 'fake' });
      expect(received[0]).toMatchObject({ mimeType: 'audio/mp4', lang: 'en' });
      expect(received[0]!.audio.length).toBe(4000);
    });

    it('rejects non-audio, empty and too-large uploads', async () => {
      await post({ text: 'hi' }, 'application/json').expect(415);
      await post(Buffer.from('x'), 'audio/webm').expect(400);
      const res = await post(Buffer.alloc(1024 * 1024 + 10, 1)).expect(413);
      expect(res.body.message).toMatch(/30 seconds/);
    });

    it('is rate limited per shop', async () => {
      let status = 200;
      for (let i = 0; i < 12 && status !== 429; i++) status = (await post(audio)).status;
      expect(status).toBe(429);
    });

    it('GET /api/ai/status reports whether speech-to-text is available', async () => {
      const res = await request(app).get('/api/ai/status').set('Authorization', `Bearer ${token}`).expect(200);
      expect(res.body.data.stt).toEqual({ provider: 'fake', available: true });
    });
  });
});
