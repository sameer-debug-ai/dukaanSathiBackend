import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { matchBill, validateBillScan, type ScannedBill } from '../ai/billScan';
import type { BillScanRequest } from '../ai/billVision.provider';
import { AiProviderError } from '../ai/provider';
import { createApp } from '../app';
import { connectDb, disconnectDb } from '../config/db';
import { BillImage } from '../models/billImage.model';
import { detectImageType, setBillVisionProvider } from '../services/billScan.service';
import { LocalStorage, setStorage } from '../storage/storage';

const TODAY = '2026-10-27';

/** What a valid model reply looks like (rupees, as printed). */
const reply = (over: Record<string, unknown> = {}) => ({
  readable: true,
  problem: null,
  supplierName: 'Ramesh Traders',
  invoiceNumber: 'RT-1042',
  date: '2026-10-25',
  items: [
    { name: 'Aashirvaad Atta 10kg', qty: 5, unit: 'packet', rate: 420, total: 2100, legible: true },
    { name: 'Tata Salt 1kg', qty: 20, unit: 'packet', rate: 22, total: 440, legible: true },
  ],
  total: 2540,
  ...over,
});

// ------------------------------------------------------------------------------------------
describe('validateBillScan (model output -> clean draft)', () => {
  it('converts rupees to paise and keeps the printed fields', () => {
    const r = validateBillScan(reply(), TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ readable: true, supplierName: 'Ramesh Traders', invoiceNumber: 'RT-1042', date: '2026-10-25', total: 254000 });
    expect(r.value.items[0]).toEqual({ name: 'Aashirvaad Atta 10kg', qty: 5, unit: 'packet', rate: 42000, total: 210000, legible: true });
  });

  it('fills a missing rate or total from the other two', () => {
    const r = validateBillScan(reply({ items: [
      { name: 'Sugar', qty: 10, unit: 'kg', rate: null, total: 400, legible: true },
      { name: 'Oil', qty: 2, unit: 'litre', rate: 150.5, total: null, legible: true },
    ] }), TODAY);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.items.map((i) => [i.rate, i.total])).toEqual([[4000, 40000], [15050, 30100]]);
  });

  it('marks lines with no usable qty / rate as unreadable, and drops nameless lines', () => {
    const r = validateBillScan(reply({ items: [
      { name: 'Haldi', qty: -3, unit: null, rate: 30, total: null, legible: true },
      { name: 'Jeera', qty: 1, unit: null, rate: null, total: null, legible: true },
      { name: '   ', qty: 1, unit: null, rate: 10, total: 10, legible: true },
    ] }), TODAY);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.items.map((i) => [i.name, i.legible])).toEqual([['Haldi', false], ['Jeera', false]]);
  });

  it('a future or malformed date is dropped (a misread), not trusted', () => {
    for (const date of ['2027-01-01', '25/10/2026']) {
      const r = validateBillScan(reply({ date }), TODAY);
      expect(r.ok && r.value.date).toBeNull();
    }
  });

  it('blurry / not a bill -> readable=false with no items', () => {
    const r = validateBillScan(reply({ readable: false, problem: 'too blurry', items: [{ name: 'x', qty: 1, unit: null, rate: 1, total: 1, legible: false }] }), TODAY);
    expect(r).toMatchObject({ ok: true, value: { readable: false, problem: 'too blurry', items: [] } });
    const empty = validateBillScan(reply({ items: [] }), TODAY);
    expect(empty).toMatchObject({ ok: true, value: { readable: false } });
  });

  it('rejects output that does not match the schema', () => {
    expect(validateBillScan({ readable: 'yes' }, TODAY).ok).toBe(false);
    expect(validateBillScan(reply({ items: [{ name: 'x', qty: '2', unit: 'kg', rate: 1, total: 2, legible: true }] }), TODAY).ok).toBe(false);
    expect(validateBillScan(reply({ items: [{ name: 'x', qty: 2, unit: 'bori', rate: 1, total: 2, legible: true }] }), TODAY).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------
describe('matchBill (supplier + products by name, alias, Hindi name)', () => {
  const suppliers = [
    { id: 's1', name: 'Ramesh Traders', aliases: ['RT Wholesale'] },
    { id: 's2', name: 'Gupta Agencies', aliases: [] },
  ];
  const products = [
    { id: 'p1', name: 'Aata 10kg', aliases: ['Aashirvaad Atta 10kg'] },
    { id: 'p2', name: 'Salt', aliases: ['नमक', 'Tata Salt 1kg'] },
    { id: 'p3', name: 'Basmati Rice 1kg', aliases: [] },
    { id: 'p4', name: 'Basmati Rice 5kg', aliases: [] },
  ];
  const bill = (items: ScannedBill['items'], total: number | null, supplierName = 'RT Wholesale'): ScannedBill => ({
    readable: true, problem: null, supplierName, invoiceNumber: null, date: null, items, total,
  });
  const line = (name: string, total: number, legible = true) => ({ name, qty: 1, unit: null, rate: total, total, legible });

  it('matches the supplier through an alias and products through aliases / Hindi names', () => {
    const m = matchBill(bill([line('Aashirvaad Atta 10kg', 42000), line('नमक', 2200)], 44200), suppliers, products);
    expect(m.supplier?.match).toMatchObject({ status: 'matched', best: { id: 's1' } });
    expect(m.items.map((i) => [i.status, i.match.best?.id])).toEqual([['matched', 'p1'], ['matched', 'p2']]);
    expect(m.mismatch).toBe(false);
  });

  it('suggests a new product for an unknown name, "check" for close look-alikes, keeps unreadable lines', () => {
    const m = matchBill(bill([line('Fortune Soyabean Oil', 15000), line('Basmati Rice', 9000), line('Hld', 3000, false)], 27000), suppliers, products);
    expect(m.items.map((i) => i.status)).toEqual(['new', 'check', 'unreadable']);
    expect(m.items[1]!.match.candidates.map((c) => c.id).sort()).toEqual(['p3', 'p4']);
  });

  it('flags when the items do not add up to the bill total (beyond ₹1 rounding)', () => {
    expect(matchBill(bill([line('Salt', 2200), line('Aata 10kg', 42000)], 44250), suppliers, products).mismatch).toBe(false); // 50 paise
    const m = matchBill(bill([line('Salt', 2200), line('Aata 10kg', 42000)], 47200), suppliers, products);
    expect(m).toMatchObject({ mismatch: true, itemsTotal: 44200, billTotal: 47200 });
  });

  it('an unknown supplier is reported as not found (the app offers to add it)', () => {
    expect(matchBill(bill([line('Salt', 100)], 100, 'Sharma Distributors'), suppliers, products).supplier?.match.status).toBe('not_found');
  });
});

// ------------------------------------------------------------------------------------------
describe('POST /api/ai/scan-bill (fake vision, in-memory DB, temp upload folder)', () => {
  const app = createApp();
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-bills-'));
  let token = '';
  let other = '';
  let shopNo = 10;
  /** Registers a new shop with one supplier + product; returns its token and id. */
  async function freshShop() {
    const res = await request(app).post('/api/auth/register').send({ name: 'Test', shopName: 'Shop', phone: `98444000${shopNo++}`, password: 'secret1' });
    const t = res.body.data.accessToken as string;
    const auth = { Authorization: `Bearer ${t}` };
    await request(app).post('/api/suppliers').set(auth).send({ name: 'Ramesh Traders' });
    await request(app).post('/api/products').set(auth).send({ name: 'Aata 10kg', aliases: ['Aashirvaad Atta 10kg'], sellingPrice: 45000, unit: 'packet' });
    return { token: t, shopId: res.body.data.user.id as string };
  }
  let replies: unknown[] = [];
  let calls: BillScanRequest[] = [];
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 7)]);

  beforeAll(async () => {
    await connectDb('memory');
    setStorage(new LocalStorage(dir));
    setBillVisionProvider({
      name: 'fake',
      isAvailable: () => true,
      scan: async (req) => {
        calls.push(req);
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    const reg = (phone: string) => request(app).post('/api/auth/register').send({ name: 'Test', shopName: 'Shop', phone, password: 'secret1' });
    token = (await reg('9844400001')).body.data.accessToken;
    other = (await reg('9844400002')).body.data.accessToken;
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).post('/api/suppliers').set(auth).send({ name: 'Ramesh Traders' });
    await request(app).post('/api/products').set(auth).send({ name: 'Aata 10kg', aliases: ['Aashirvaad Atta 10kg'], sellingPrice: 45000, unit: 'packet' });
  });
  afterAll(async () => {
    setStorage(null);
    await disconnectDb();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    calls = [];
    ({ token } = await freshShop());
  });

  const scan = (body: Buffer, type = 'image/jpeg', t = token) =>
    request(app).post('/api/ai/scan-bill').set('Authorization', `Bearer ${t}`).set('Content-Type', type).send(body);

  it('returns a matched draft, keeps the photo, saves no purchase', async () => {
    replies = [reply()];
    const res = await scan(jpeg);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ readable: true, invoiceNumber: 'RT-1042', billTotal: 254000, itemsTotal: 254000, mismatch: false });
    expect(d.supplier.match.status).toBe('matched');
    expect(d.items.map((i: { status: string }) => i.status)).toEqual(['matched', 'new']);
    expect(d.scanId).toBeTruthy();
    expect(calls[0]!.contentType).toBe('image/jpeg');
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(await BillImage.countDocuments({ _id: d.scanId, shopId: me.body.data.id, purchaseId: null })).toBe(1);
    const purchases = await request(app).get('/api/purchases').set('Authorization', `Bearer ${token}`);
    expect(purchases.body.data).toHaveLength(0);
  });

  it('retries once on invalid model output, then succeeds', async () => {
    replies = [{ readable: 'maybe' }, reply()];
    const res = await scan(jpeg);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.previousError).toMatch(/readable/);
  });

  it('gives up with 502 after two invalid replies', async () => {
    replies = [{}, {}];
    expect((await scan(jpeg)).status).toBe(502);
  });

  it('retries a retryable AI error once', async () => {
    replies = [new AiProviderError('cut off', true), reply()];
    expect((await scan(jpeg)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('blurry photo: readable=false, nothing stored', async () => {
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    replies = [reply({ readable: false, problem: 'blurry', items: [] })];
    const res = await scan(jpeg);
    expect(res.body.data).toMatchObject({ readable: false, scanId: null });
    expect(await BillImage.countDocuments({ shopId: me.body.data.id })).toBe(0);
  });

  it('rejects non-images (checked by content, not the header) and oversize files', async () => {
    expect((await scan(Buffer.from('not really a jpeg at all '.repeat(200)))).status).toBe(415);
    expect((await scan(jpeg, 'application/pdf')).status).toBe(415);
    // Over the limit the server answers 413 and stops reading, so the client may instead see the socket close.
    const big = await scan(Buffer.concat([jpeg, Buffer.alloc(5 * 1024 * 1024)])).then((r) => r.status, (e: NodeJS.ErrnoException) => e.code);
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(big);
  });

  it('photo is linked to the saved purchase and only its shop can see it', async () => {
    replies = [reply()];
    const scanId = (await scan(jpeg)).body.data.scanId as string;
    const auth = { Authorization: `Bearer ${token}` };
    const supplierId = (await request(app).get('/api/suppliers').set(auth)).body.data[0].id;
    const productId = (await request(app).get('/api/products').set(auth)).body.data[0].id;
    const purchase = await request(app).post('/api/purchases').set(auth).send({ supplierId, items: [{ productId, qty: 5, rate: 42000 }] });
    expect(purchase.status).toBe(201);

    const att = await request(app).post(`/api/bill-images/${scanId}/attach`).set(auth).send({ purchaseId: purchase.body.data.id });
    expect(att.status).toBe(200);
    const img = await request(app).get(`/api/purchases/${purchase.body.data.id}/bill-image`).set(auth);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(img.body as Buffer, jpeg)).toBe(0);

    expect((await request(app).get(`/api/bill-images/${scanId}`).set('Authorization', `Bearer ${other}`)).status).toBe(404);
    expect((await request(app).get(`/api/purchases/${purchase.body.data.id}/bill-image`).set('Authorization', `Bearer ${other}`)).status).toBe(404);
    expect((await request(app).post(`/api/bill-images/${scanId}/attach`).set('Authorization', `Bearer ${other}`).send({ purchaseId: purchase.body.data.id })).status).toBe(404);
  });

  it('detects real image types from their bytes', () => {
    expect(detectImageType(jpeg)).toBe('image/jpeg');
    expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(detectImageType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(detectImageType(Buffer.from('%PDF-1.7 ...'))).toBeNull();
  });

  it('is rate-limited per shop', async () => {
    replies = Array.from({ length: 10 }, () => reply());
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await scan(jpeg, 'image/jpeg', other)).status);
    expect(statuses).toContain(429);
  });
});
