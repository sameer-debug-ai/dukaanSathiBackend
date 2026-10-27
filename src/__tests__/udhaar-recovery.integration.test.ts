import { Types } from 'mongoose';
import request from 'supertest';
import { parseVoiceCommand, setAiProvider } from '../ai/ai.service';
import { createApp } from '../app';
import { connectDb, disconnectDb } from '../config/db';
import { Customer } from '../models/customer.model';
import { KhataLink } from '../models/khataLink.model';
import { User } from '../models/user.model';
import { addCredit, addPayment, createCustomer } from '../services/customer.service';
import { createKhataLink, revokeKhataLink } from '../services/khataLink.service';
import { agingReport } from '../services/report.service';
import { todayReminders } from '../services/reminder.service';
import { signAccessToken } from '../services/token.service';
import { addDays, startOfIstDay } from '../utils/istDate';

const offline = { name: 'none', isAvailable: () => false, parseCommand: async () => ({}) };
const at = (daysBack: number) => new Date(addDays(startOfIstDay(), -daysBack).getTime() + 6 * 3600 * 1000);

/** Udhaar recovery: public khata links, reminders, aging report, credit warnings. */
describe('udhaar recovery (integration)', () => {
  const app = createApp();
  let shopId: Types.ObjectId;
  let otherShop: Types.ObjectId;
  let token: string;
  let otherToken: string;
  let ids: Record<string, string>;

  const customer = async (shop: Types.ObjectId, name: string, extra: Record<string, unknown> = {}) =>
    String((await createCustomer(shop, { name, aliases: [], phone: '', address: '', ...extra }))._id);

  beforeAll(async () => {
    await connectDb('memory');
    setAiProvider(offline);
    shopId = (await User.create({ name: 'Owner', phone: '9000000061', passwordHash: 'x', shopName: 'Sharma Store', settings: { upiId: 'sharmastore@okaxis', upiPayeeName: 'Sharma Store' } }))._id;
    otherShop = (await User.create({ name: 'Other', phone: '9000000062', passwordHash: 'x', shopName: 'Other Store' }))._id;
    token = signAccessToken(String(shopId), String(shopId));
    otherToken = signAccessToken(String(otherShop), String(otherShop));
    ids = {
      rakesh: await customer(shopId, 'Rakesh Sharma', { creditLimit: 100000 }),
      anil: await customer(shopId, 'Anil Gupta'),
      mohan: await customer(shopId, 'Mohan Verma'),
      other: await customer(otherShop, 'Other Customer'),
    };
    await Customer.updateOne({ _id: ids.rakesh, shopId }, { $set: { aliases: ['Sharma ji'] } });
    // Rakesh: 2,000 udhaar 100 days ago, paid 500 after 40 days, 400 more 10 days ago.
    await addCredit(shopId, ids.rakesh, { amount: 200000, items: [{ name: 'Sugar', qty: 2, rate: 4500 }], note: 'Diwali saman', source: 'manual', date: at(100) });
    await addPayment(shopId, ids.rakesh, { amount: 50000, mode: 'cash', note: '', source: 'manual', date: at(60) });
    await addCredit(shopId, ids.rakesh, { amount: 40000, items: [], note: '', source: 'manual', date: at(10) });
    // Anil: old udhaar never paid -> risky.
    await addCredit(shopId, ids.anil, { amount: 30000, items: [], note: '', source: 'manual', date: at(150) });
    await addCredit(shopId, ids.anil, { amount: 10000, items: [], note: '', source: 'manual', date: at(130) });
    await addCredit(otherShop, ids.other, { amount: 999900, items: [], note: 'secret', source: 'manual', date: at(5) });
  });

  afterAll(async () => {
    await disconnectDb();
  });

  // ------------------------------------------------------------ public khata link
  describe('public khata link access control', () => {
    const view = (t: string) => request(app).get(`/api/public/khata/${t}`);

    it('owner creates a link; anyone with it sees only this customer\'s khata, without login', async () => {
      const res = await request(app).post(`/api/customers/${ids.rakesh}/share-link`).set('Authorization', `Bearer ${token}`).expect(201);
      const t = res.body.data.token as string;
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const page = await view(t).expect(200);
      expect(page.headers['cache-control']).toBe('no-store');
      const d = page.body.data;
      expect(d.shop).toEqual({ name: 'Sharma Store', phone: '9000000061', address: '' });
      expect(d.customer).toEqual({ name: 'Rakesh Sharma' });
      expect(d.balance).toBe(190000);
      expect(d.entries.map((e: { type: string; amount: number; balance: number }) => [e.type, e.amount, e.balance])).toEqual([
        ['credit', 40000, 190000],
        ['payment', 50000, 150000],
        ['credit', 200000, 200000],
      ]);
      expect(d.entries[2].items).toEqual([{ name: 'Sugar', qty: 2 }]);
      expect(d.upiLink).toBe('upi://pay?pa=sharmastore@okaxis&pn=Sharma%20Store&am=1900.00&cu=INR');

      // Nothing internal: no ids, no other customers, no shop settings.
      const json = JSON.stringify(d);
      for (const secret of [ids.rakesh, ids.anil, String(shopId), 'Anil Gupta', 'Other Customer', 'secret', 'creditLimit', 'voice', '_id', '"id"']) {
        expect(json).not.toContain(secret);
      }
      // Only a hash is stored.
      const stored = await KhataLink.findOne({ shopId, customerId: ids.rakesh, revokedAt: null });
      expect(stored!.tokenHash).not.toContain(t);
      expect(stored!.views).toBe(1);
    });

    it('unknown, malformed and revoked tokens all get the same 404', async () => {
      const { token: t } = await createKhataLink(shopId, ids.mohan);
      await view(t).expect(200);
      await revokeKhataLink(shopId, ids.mohan);
      const revoked = await view(t).expect(404);
      const unknown = await view('A'.repeat(43)).expect(404);
      const malformed = await view('..%2F..%2Fcustomers').expect(404);
      const short = await view('abc').expect(404);
      expect(new Set([revoked, unknown, short].map((r) => r.body.message)).size).toBe(1);
      expect(malformed.status).toBe(404);
    });

    it('regenerating disables the old link', async () => {
      const first = await createKhataLink(shopId, ids.anil);
      const second = await createKhataLink(shopId, ids.anil);
      await view(first.token).expect(404);
      await view(second.token).expect(200);
      expect(await KhataLink.countDocuments({ shopId, customerId: ids.anil, revokedAt: null })).toBe(1);
    });

    it('a deleted customer\'s link stops working', async () => {
      const id = await customer(shopId, 'Temp Customer');
      const { token: t } = await createKhataLink(shopId, id);
      await Customer.updateOne({ _id: id, shopId }, { $set: { isDeleted: true } });
      await view(t).expect(404);
    });

    it('owner endpoints need login and are scoped to the owner\'s shop', async () => {
      await request(app).post(`/api/customers/${ids.rakesh}/share-link`).expect(401);
      await request(app).post(`/api/customers/${ids.rakesh}/share-link`).set('Authorization', `Bearer ${otherToken}`).expect(404);
      await request(app).delete(`/api/customers/${ids.rakesh}/share-link`).set('Authorization', `Bearer ${otherToken}`).expect(404);
      const status = await request(app).get(`/api/customers/${ids.rakesh}/share-link`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(status.body.data).toMatchObject({ active: true, views: 1 });
      expect(status.body.data.token).toBeUndefined();
      const off = await request(app).delete(`/api/customers/${ids.rakesh}/share-link`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(off.body.data.active).toBe(false);
    });

    it('is rate limited per IP', async () => {
      let status = 0;
      for (let i = 0; i < 40 && status !== 429; i++) status = (await view('B'.repeat(43))).status;
      expect(status).toBe(429);
    });
  });

  // ------------------------------------------------------------ credit score in the API
  it('customer list and detail include the credit score', async () => {
    const list = await request(app).get('/api/customers').set('Authorization', `Bearer ${token}`).expect(200);
    const byName = Object.fromEntries(list.body.data.map((c: { name: string; credit: { badge: string } }) => [c.name, c.credit.badge]));
    expect(byName).toMatchObject({ 'Anil Gupta': 'risky', 'Mohan Verma': 'new' });
    const detail = await request(app).get(`/api/customers/${ids.anil}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(detail.body.data.credit).toMatchObject({ badge: 'risky', recoveredPct: 0, oldestDueDays: 150 });
  });

  // ------------------------------------------------------------ credit warning on voice udhaar
  it('voice udhaar over the limit or for a risky customer warns and never auto-saves', async () => {
    await User.updateOne({ _id: shopId }, { $set: { 'settings.voiceAlwaysConfirm': false, 'settings.voiceAutoSaveThreshold': 0.5 } });
    const over = await parseVoiceCommand(shopId, 'Sharma ji ke 500 udhaar likho', 'en');
    expect(over.creditWarning).toMatchObject({ customerId: ids.rakesh, overLimit: true, limit: 100000, balance: 190000, newBalance: 240000 });
    expect(over.autoSave).toBe(false);

    const risky = await parseVoiceCommand(shopId, 'Anil Gupta ke 100 udhaar likho', 'en');
    expect(risky.creditWarning).toMatchObject({ customerId: ids.anil, overLimit: false, badge: 'risky' });
    expect(risky.autoSave).toBe(false);

    // A payment is never warned about.
    const payment = await parseVoiceCommand(shopId, 'Anil Gupta ne 100 diye', 'en');
    expect(payment.creditWarning).toBeUndefined();
  });

  // ------------------------------------------------------------ reminders
  it('"Aaj ke reminders": due customers with a UPI link; sent ones drop off', async () => {
    await Customer.updateOne({ _id: ids.rakesh, shopId }, { $set: { reminderEveryDays: 30 } });
    await Customer.updateOne({ _id: ids.anil, shopId }, { $set: { dueDate: at(1) } });
    await Customer.updateOne({ _id: ids.other, shopId: otherShop }, { $set: { reminderEveryDays: 7 } });

    const r = await request(app).get('/api/reminders/today').set('Authorization', `Bearer ${token}`).expect(200);
    expect(r.body.data.items.map((i: { name: string; reason: string }) => [i.name, i.reason])).toEqual([
      ['Rakesh Sharma', 'every'],
      ['Anil Gupta', 'due_date'],
    ]);
    expect(r.body.data.items[0].upiLink).toContain('am=1900.00');

    await request(app).post(`/api/customers/${ids.rakesh}/reminder-sent`).set('Authorization', `Bearer ${token}`).expect(200);
    const after = await todayReminders(shopId);
    expect(after.items.map((i) => i.name)).toEqual(['Anil Gupta']);
    expect(after.sentToday).toBe(1);
    await request(app).post(`/api/customers/${ids.rakesh}/reminder-sent`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  });

  // ------------------------------------------------------------ aging report
  it('"Purana udhaar" splits the pending balance by age (FIFO)', async () => {
    const r = await agingReport(shopId);
    const rakesh = r.rows.find((x) => x.name === 'Rakesh Sharma')!;
    // 2,000 (100 days) - 500 paid = 1,500 in 90+; 400 (10 days) in 0-30.
    expect(rakesh).toMatchObject({ d0_30: 40000, d31_60: 0, d61_90: 0, d90_plus: 150000 });
    expect(r.rows.map((x) => x.name)).not.toContain('Other Customer');
    const api = await request(app).get('/api/reports/aging').set('Authorization', `Bearer ${token}`).expect(200);
    expect(api.body.data.totals.d90_plus).toBe(150000 + 40000);
  });

  it('settings accept a valid UPI ID only', async () => {
    await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ settings: { upiId: 'not a vpa' } }).expect(400);
    const ok = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ settings: { upiId: 'new@ybl', upiPayeeName: 'Sharma Ji Store' } }).expect(200);
    expect(ok.body.data.settings).toMatchObject({ upiId: 'new@ybl', upiPayeeName: 'Sharma Ji Store' });
  });
});
