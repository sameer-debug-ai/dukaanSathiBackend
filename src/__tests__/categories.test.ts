import request from 'supertest';
import { createApp } from '../app';
import { connectDb, disconnectDb } from '../config/db';

describe('category management (/api/categories)', () => {
  const app = createApp();
  let auth: { Authorization: string };
  let other: { Authorization: string };

  const reg = async (phone: string) => ({
    Authorization: `Bearer ${(await request(app).post('/api/auth/register').send({ name: 'Test', shopName: 'Shop', phone, password: 'secret1' })).body.data.accessToken}`,
  });
  const product = (name: string, category: string) => request(app).post('/api/products').set(auth).send({ name, category, sellingPrice: 1000 });
  const list = async (h = auth) => (await request(app).get('/api/categories').set(h)).body.data as { id: string; name: string; isActive: boolean; productCount: number }[];
  const active = async (h = auth) => (await request(app).get('/api/categories/active').set(h)).body.data as string[];

  beforeAll(async () => {
    await connectDb('memory');
    auth = await reg('9866600001');
    other = await reg('9866600002');
    await product('Amul Milk', 'Dairy');
    await product('Amul Dahi', 'dairy '); // same category, different spelling
    await product('Sugar', 'Grocery');
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it('lists the categories products already use, once each, with product counts', async () => {
    const cats = await list();
    expect(cats.map((c) => [c.name, c.isActive, c.productCount])).toEqual([
      ['Dairy', true, 2],
      ['Grocery', true, 1],
    ]);
  });

  it('adds a category; the same name in any case is refused', async () => {
    const res = await request(app).post('/api/categories').set(auth).send({ name: '  Personal   Care ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Personal Care', isActive: true, productCount: 0 });
    expect((await request(app).post('/api/categories').set(auth).send({ name: 'personal care' })).status).toBe(409);
    expect((await request(app).post('/api/categories').set(auth).send({ name: '' })).status).toBe(400);
    expect(await active()).toEqual(['Dairy', 'Grocery', 'Personal Care']);
  });

  it('an inactive category disappears from the dropdown list but keeps its products', async () => {
    const dairy = (await list()).find((c) => c.name === 'Dairy')!;
    const res = await request(app).patch(`/api/categories/${dairy.id}`).set(auth).send({ isActive: false });
    expect(res.body.data).toMatchObject({ isActive: false, productCount: 2 });
    expect(await active()).toEqual(['Grocery', 'Personal Care']);
    const products = (await request(app).get('/api/products?category=Dairy').set(auth)).body.data;
    expect(products).toHaveLength(1); // "Dairy" exactly; "dairy " stays as it was until renamed
    await request(app).patch(`/api/categories/${dairy.id}`).set(auth).send({ isActive: true });
    expect(await active()).toContain('Dairy');
  });

  it('renaming moves its products along (any spelling), and cannot clash with another category', async () => {
    const dairy = (await list()).find((c) => c.name === 'Dairy')!;
    expect((await request(app).patch(`/api/categories/${dairy.id}`).set(auth).send({ name: 'GROCERY' })).status).toBe(409);
    const res = await request(app).patch(`/api/categories/${dairy.id}`).set(auth).send({ name: 'Dairy & Milk' });
    expect(res.status).toBe(200);
    const cats = await list();
    expect(cats.find((c) => c.id === dairy.id)).toMatchObject({ name: 'Dairy & Milk', productCount: 2 });
    expect(cats.some((c) => c.name.toLowerCase() === 'dairy')).toBe(false); // not re-created from old products
  });

  it('the old /products/categories endpoint still works as before', async () => {
    const res = await request(app).get('/api/products/categories').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(['Dairy & Milk', 'Grocery']);
  });

  it('each shop sees only its own categories', async () => {
    expect(await list(other)).toEqual([]);
    const mine = (await list())[0]!;
    expect((await request(app).patch(`/api/categories/${mine.id}`).set(other).send({ isActive: false })).status).toBe(404);
  });
});
