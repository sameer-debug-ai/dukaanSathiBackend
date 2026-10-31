import { Types } from 'mongoose';
import { parseVoiceCommand, setAiProvider } from '../ai/ai.service';
import { connectDb, disconnectDb } from '../config/db';
import { User } from '../models/user.model';
import { addCredit, createCustomer } from '../services/customer.service';

/** Several customers share a name ("Sameer"): voice lists them all and lets the shopkeeper pick. */
describe('same-name customers (voice)', () => {
  let shopId: Types.ObjectId;
  const ids: string[] = [];
  const names = ['Sameer', 'Sameer Khan', 'Sameer Ali', 'Sameer Ansari', 'Sameer Shaikh', 'Sameer Malik'];

  beforeAll(async () => {
    await connectDb('memory');
    setAiProvider({ name: 'none', isAvailable: () => false, parseCommand: async () => ({}) });
    shopId = (await User.create({ name: 'Test', phone: '9000000088', passwordHash: 'x', shopName: 'Same Name Shop' }))._id;
    for (const [i, name] of names.entries()) {
      const c = await createCustomer(shopId, { name, aliases: [], phone: '', address: '' });
      ids.push(String(c._id));
      await addCredit(shopId, String(c._id), { amount: (i + 1) * 10000, items: [], note: '', source: 'manual' });
    }
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it('"sameer ka udhaar kitna hai": a list of all 6 with balances, nothing auto-picked', async () => {
    const r = await parseVoiceCommand(shopId, 'sameer ka udhaar kitna hai', 'hi');
    expect(r.intent).toBe('query_balance');
    expect(r.customer?.status).toBe('ambiguous');
    const choose = (r.answerData as { kind: string; choose: { id: string }[] }).choose;
    expect((r.answerData as { kind: string }).kind).toBe('choose');
    expect(choose.map((c) => c.id).sort()).toEqual([...ids].sort());
  });

  it('"sameer ne sara udhaar de diya": the card asks which Sameer; each one\'s balance is ready for the pick', async () => {
    const r = await parseVoiceCommand(shopId, 'sameer ne sara udhaar de diya', 'hi');
    expect(r.intent).toBe('receive_payment');
    expect(r.customer?.status).toBe('ambiguous');
    expect(r.customer?.candidates).toHaveLength(6);
    expect(r.needsConfirmation).toBe(true);
    expect(r.autoSave).toBe(false);
    expect(r.balances?.[ids[2]!]).toBe(30000);
  });

  it('the full name still picks exactly one', async () => {
    const r = await parseVoiceCommand(shopId, 'sameer khan ka udhaar kitna hai', 'hi');
    expect(r.customer?.status).toBe('matched');
    expect(r.customer?.best?.id).toBe(ids[1]);
  });
});
