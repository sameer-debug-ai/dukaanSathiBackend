import request from 'supertest';
import { createApp } from '../app';
import { connectDb, disconnectDb } from '../config/db';
import { gstinCheckChar } from '../utils/gst';

/** Bill settings, GST bills, invoice numbers, cancellation and GST reports through the API. */
describe('bill printing + GST (/api)', () => {
  const app = createApp();
  const gstin = (first14: string) => first14 + gstinCheckChar(first14);
  const SHOP_GSTIN = gstin('27AAPFU0939F1Z'); // Maharashtra
  const OTHER_STATE_GSTIN = gstin('29AABCT1332L1Z'); // Karnataka

  const reg = async (phone: string, shopName = 'Kumar General Store') => ({
    Authorization: `Bearer ${(await request(app).post('/api/auth/register').send({ name: 'Ramesh', shopName, phone, password: 'secret1' })).body.data.accessToken}`,
  });
  const api = (auth: { Authorization: string }) => ({
    get: (url: string) => request(app).get(url).set(auth),
    post: (url: string, body: object = {}) => request(app).post(url).set(auth).send(body),
    patch: (url: string, body: object) => request(app).patch(url).set(auth).send(body),
  });
  const product = async (a: ReturnType<typeof api>, body: object) => (await a.post('/api/products', { category: 'Grocery', openingStock: 100, ...body })).body.data;
  const stockOf = async (a: ReturnType<typeof api>, id: string) => (await a.get(`/api/products/${id}`)).body.data.currentStock as number;

  beforeAll(async () => {
    await connectDb('memory');
  });
  afterAll(async () => {
    await disconnectDb();
  });

  describe('shop without GST', () => {
    let a: ReturnType<typeof api>;
    beforeAll(async () => {
      a = api(await reg('9877100001'));
    });

    it('bills keep the old maths and get an invoice number KGS/<FY>/0001, 0002 ...', async () => {
      const p = await product(a, { name: 'Sugar', sellingPrice: 4500, gstRate: 18, priceIncludesGst: false });
      const s1 = (await a.post('/api/sales', { items: [{ productId: p.id, qty: 2 }], discount: 500, paymentMode: 'cash' })).body.data;
      // GST rate on the product is ignored while the shop has GST off.
      expect(s1).toMatchObject({ subtotal: 9000, discount: 500, totalAmount: 8500, paidAmount: 8500, docType: 'bill', billNumber: 1 });
      expect(s1.cgst).toBeUndefined();
      expect(s1.invoiceNo).toMatch(/^KGS\/\d{4}-\d{2}\/0001$/);
      expect(s1.amountInWords.en).toBe('Rupees Eighty Five Only');
      const s2 = (await a.post('/api/sales', { items: [{ productId: p.id, qty: 1 }], paymentMode: 'upi' })).body.data;
      expect(s2.invoiceNo).toMatch(/\/0002$/);
    });

    it('20 bills at the same moment all get different, gap-free numbers', async () => {
      const p = await product(a, { name: 'Salt', sellingPrice: 2000, openingStock: 500 });
      const res = await Promise.all(Array.from({ length: 20 }, () => a.post('/api/sales', { items: [{ productId: p.id, qty: 1 }], paymentMode: 'cash' })));
      expect(res.every((r) => r.status === 201)).toBe(true);
      const seqs = res.map((r) => Number(String(r.body.data.invoiceNo).split('/')[2])).sort((x, y) => x - y);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    });

    it('numbering starts again at 0001 in a new financial year', async () => {
      const p = await product(a, { name: 'Tea', sellingPrice: 5000 });
      const march = (await a.post('/api/sales', { items: [{ productId: p.id, qty: 1 }], paymentMode: 'cash', date: '2025-03-20T06:00:00Z' })).body.data;
      const april = (await a.post('/api/sales', { items: [{ productId: p.id, qty: 1 }], paymentMode: 'cash', date: '2025-04-02T06:00:00Z' })).body.data;
      expect(march.invoiceNo).toBe('KGS/2024-25/0001');
      expect(april.invoiceNo).toBe('KGS/2025-26/0001');
    });

    it('custom prefix from bill settings', async () => {
      await a.patch('/api/billing/settings', { invoicePrefix: 'ks1' });
      const p = await product(a, { name: 'Dal', sellingPrice: 9000 });
      const s = (await a.post('/api/sales', { items: [{ productId: p.id, qty: 1 }], paymentMode: 'cash' })).body.data;
      expect(s.invoiceNo).toMatch(/^KS1\//);
      expect((await a.patch('/api/billing/settings', { invoicePrefix: 'TOO-LONG' })).status).toBe(400);
    });
  });

  describe('bill settings validation', () => {
    it('GST needs a valid GSTIN; the state comes from it', async () => {
      const a = api(await reg('9877100002'));
      expect((await a.patch('/api/billing/settings', { gstEnabled: true })).status).toBe(400);
      expect((await a.patch('/api/billing/settings', { gstEnabled: true, gstin: '27AAPFU0939F1ZZ' })).status).toBe(400);
      const ok = await a.patch('/api/billing/settings', { gstEnabled: true, gstin: SHOP_GSTIN.toLowerCase(), paperSize: '58mm', footerNote: 'Dhanyavaad, phir aayiye' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ gstEnabled: true, gstin: SHOP_GSTIN, stateCode: '27', paperSize: '58mm', composition: false });
      expect(ok.body.data.states.length).toBeGreaterThan(30);
      expect((await a.patch('/api/billing/settings', { logo: 'data:text/html;base64,AAAA' })).status).toBe(400);
    });
  });

  describe('GST shop', () => {
    let a: ReturnType<typeof api>;
    let rice: { id: string };
    let oil: { id: string };
    beforeAll(async () => {
      a = api(await reg('9877100003'));
      await a.patch('/api/billing/settings', { gstEnabled: true, gstin: SHOP_GSTIN });
      rice = await product(a, { name: 'Basmati Rice', unit: 'kg', sellingPrice: 10500, gstRate: 5, hsnCode: '1006', priceIncludesGst: true });
      oil = await product(a, { name: 'Sunflower Oil', unit: 'litre', sellingPrice: 10000, gstRate: 18, hsnCode: '1512', priceIncludesGst: false });
    });

    it('same state: CGST + SGST per line, rate summary, round-off; quote matches the saved bill', async () => {
      const body = { items: [{ productId: rice.id, qty: 2 }, { productId: oil.id, qty: 1 }], discount: 0 };
      const quote = (await a.post('/api/sales/quote', body)).body.data;
      const s = (await a.post('/api/sales', { ...body, paymentMode: 'cash' })).body.data;
      expect(s).toMatchObject({ docType: 'tax_invoice', interState: false, subtotal: 31000, taxableTotal: 30000, cgst: 1400, sgst: 1400, igst: 0, taxAdded: 1800, totalAmount: 32800 });
      expect(s.taxSummary).toEqual([
        { rate: 5, taxable: 20000, cgst: 500, sgst: 500, igst: 0 },
        { rate: 18, taxable: 10000, cgst: 900, sgst: 900, igst: 0 },
      ]);
      expect(s.items[0]).toMatchObject({ hsnCode: '1006', gstRate: 5, taxable: 20000, cgst: 500, sgst: 500, total: 21000 });
      expect(s.seller).toMatchObject({ gstin: SHOP_GSTIN, stateCode: '27', name: 'Kumar General Store' });
      expect(quote).toMatchObject({ totalAmount: s.totalAmount, cgst: s.cgst, taxSummary: s.taxSummary });
    });

    it('B2B buyer from another state: IGST, buyer kept on the bill', async () => {
      const s = (await a.post('/api/sales', { items: [{ productId: oil.id, qty: 1 }], paymentMode: 'cash', buyerName: 'Tata Traders', buyerGstin: OTHER_STATE_GSTIN })).body.data;
      expect(s).toMatchObject({ interState: true, cgst: 0, sgst: 0, igst: 1800, totalAmount: 11800 });
      expect(s.buyer).toMatchObject({ name: 'Tata Traders', gstin: OTHER_STATE_GSTIN, stateCode: '29' });
      expect((await a.post('/api/sales', { items: [{ productId: oil.id, qty: 1 }], paymentMode: 'cash', buyerGstin: 'BAD' })).status).toBe(400);
    });

    it('customer saved with a GSTIN is billed as B2B automatically', async () => {
      const c = (await a.post('/api/customers', { name: 'Bangalore Mart', gstin: OTHER_STATE_GSTIN })).body.data;
      const s = (await a.post('/api/sales', { customerId: c.id, items: [{ productId: rice.id, qty: 1 }], paymentMode: 'udhaar' })).body.data;
      expect(s).toMatchObject({ interState: true, igst: 500, creditAmount: 10500 });
    });

    it('composition scheme: Bill of Supply, no tax', async () => {
      const b = api(await reg('9877100004'));
      await b.patch('/api/billing/settings', { gstEnabled: true, gstin: SHOP_GSTIN, composition: true });
      const p = await product(b, { name: 'Oil', sellingPrice: 10000, gstRate: 18, priceIncludesGst: false });
      const s = (await b.post('/api/sales', { items: [{ productId: p.id, qty: 1 }], paymentMode: 'cash' })).body.data;
      expect(s).toMatchObject({ docType: 'bill_of_supply', totalAmount: 10000 });
      expect(s.cgst).toBeUndefined();
    });

    it('GST rate for a whole category at once', async () => {
      await product(a, { name: 'Soap', category: 'Personal Care', sellingPrice: 4000 });
      await product(a, { name: 'Shampoo', category: 'personal care ', sellingPrice: 9000 });
      const res = await a.post('/api/billing/gst-by-category', { category: 'Personal Care', gstRate: 18, hsnCode: '3401' });
      expect(res.body.data).toMatchObject({ matched: 2, updated: 2 });
      const soap = (await a.get('/api/products?search=Soap')).body.data[0];
      expect(soap).toMatchObject({ gstRate: 18, hsnCode: '3401' });
    });

    it('GST register and HSN summary (JSON + CSV)', async () => {
      const reg1 = (await a.get('/api/reports/gst-register')).body.data;
      const first = reg1.rows.find((r: { rate: number; type: string }) => r.rate === 5 && r.type === 'B2C');
      expect(first).toMatchObject({ taxable: 20000, cgst: 500, sgst: 500, pos: '27-Maharashtra' });
      expect(reg1.rows.some((r: { type: string; igst: number }) => r.type === 'B2B' && r.igst === 1800)).toBe(true);
      const hsn = (await a.get('/api/reports/gst-hsn')).body.data;
      expect(hsn.rows.find((r: { hsn: string }) => r.hsn === '1006')).toMatchObject({ uqc: 'KGS-KILOGRAMS', qty: 3, rate: 5 });
      const csv = await a.get('/api/reports/gst-register?format=csv');
      expect(csv.text).toContain('GSTIN/UIN of Recipient');
    });
  });

  describe('cancel bill', () => {
    it('keeps the bill and its number, gives back stock and udhaar, and drops it from sales totals', async () => {
      const a = api(await reg('9877100005'));
      const p = await product(a, { name: 'Atta', sellingPrice: 5000, openingStock: 10 });
      const c = (await a.post('/api/customers', { name: 'Sharma ji' })).body.data;
      const sale = (await a.post('/api/sales', { customerId: c.id, items: [{ productId: p.id, qty: 4 }], paymentMode: 'partial', paidAmount: 5000 })).body.data;
      expect(await stockOf(a, p.id)).toBe(6);
      expect((await a.get(`/api/customers/${c.id}`)).body.data.currentBalance).toBe(15000);
      const salesBefore = (await a.get('/api/reports/sales')).body.data.totals.total;

      expect((await a.post(`/api/sales/${sale.id}/cancel`, { reason: '' })).status).toBe(400);
      const res = await a.post(`/api/sales/${sale.id}/cancel`, { reason: 'Customer returned everything' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', invoiceNo: sale.invoiceNo, cancelReason: 'Customer returned everything' });

      expect(await stockOf(a, p.id)).toBe(10);
      const cust = (await a.get(`/api/customers/${c.id}`)).body.data;
      expect(cust.currentBalance).toBe(0);
      // Taking back udhaar is not money received.
      expect(cust.stats).toMatchObject({ totalCredit: 0, totalPaid: 0 });
      expect((await a.get('/api/reports/sales')).body.data.totals.total).toBe(salesBefore - 20000);
      expect((await a.get('/api/reports/udhaar')).body.data.totals).toMatchObject({ given: 0, received: 0 });

      // Still in history (with its number), but not counted.
      const list = (await a.get(`/api/sales?search=${encodeURIComponent(sale.invoiceNo)}`)).body;
      expect(list.data).toHaveLength(1);
      expect(list.meta.totalAmount).toBe(0);
      expect((await a.get('/api/sales?status=cancelled')).body.data).toHaveLength(1);

      expect((await a.post(`/api/sales/${sale.id}/cancel`, { reason: 'again' })).status).toBe(409);
      expect(await stockOf(a, p.id)).toBe(10);
    });

    it('another shop cannot cancel it', async () => {
      const a = api(await reg('9877100006'));
      const b = api(await reg('9877100007'));
      const p = await product(a, { name: 'Atta', sellingPrice: 5000 });
      const sale = (await a.post('/api/sales', { items: [{ productId: p.id, qty: 1 }], paymentMode: 'cash' })).body.data;
      expect((await b.post(`/api/sales/${sale.id}/cancel`, { reason: 'not mine' })).status).toBe(404);
    });
  });
});
