import { normalizeSpokenNumbers, parseNumberTokens } from '../ai/hindiNumbers';
import { emptyCommand, validateParsedCommand } from '../ai/intentSchema';
import { EntityMatcher } from '../ai/matcher';
import { ruleParse } from '../ai/ruleParser';

describe('Hindi number words', () => {
  it.each([
    [['paanch', 'sau'], 500],
    [['dedh', 'sau'], 150],
    [['dhai', 'hazaar'], 2500],
    [['saade', 'teen', 'sau'], 350],
    [['sawa', 'sau'], 125],
    [['do', 'hazaar', 'paanch', 'sau'], 2500],
    [['पांच', 'सौ'], 500],
    [['डेढ़', 'सौ'], 150],
    [['2', 'hazaar'], 2000],
  ])('%j -> %d', (tokens, expected) => {
    expect(parseNumberTokens(tokens)).toBe(expected);
  });

  it('rewrites numbers inside a sentence and keeps other words', () => {
    expect(normalizeSpokenNumbers('Sharma ji ke paanch sau rupay')).toBe('Sharma ji ke 500 rupay');
    expect(normalizeSpokenNumbers('Gupta ji ko do kilo cheeni')).toBe('Gupta ji ko 2 kilo cheeni');
    expect(normalizeSpokenNumbers('१२०० ka saman')).toBe('1200 ka saman');
  });

  it('does not turn verbs like "de do" into numbers', () => {
    expect(normalizeSpokenNumbers('paise de do')).toBe('paise de do');
  });
});

describe('validateParsedCommand (AI output validation)', () => {
  it('accepts a well-formed command and rounds money to whole paise', () => {
    const raw = { ...emptyCommand('add_credit'), customerName: 'Sharma ji', amount: 50000.4, confidence: 0.9 };
    const r = validateParsedCommand(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.amount).toBe(50000);
      expect(r.value.intent).toBe('add_credit');
    }
  });

  it('rejects an unknown intent', () => {
    const r = validateParsedCommand({ ...emptyCommand(), intent: 'buy_car' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed output (missing fields / wrong types)', () => {
    expect(validateParsedCommand({ intent: 'add_credit' }).ok).toBe(false);
    expect(validateParsedCommand('not json').ok).toBe(false);
    expect(validateParsedCommand({ ...emptyCommand(), amount: '500' }).ok).toBe(false);
  });

  it('clamps confidence, drops empty items and invalid dates', () => {
    const r = validateParsedCommand({
      ...emptyCommand('add_sale'),
      confidence: 3,
      date: 'kal',
      items: [
        { name: 'maggi', qty: 2, unit: 'packet', rate: null, total: null },
        { name: '  ', qty: 1, unit: null, rate: null, total: null },
        { name: 'chips', qty: 0, unit: null, rate: null, total: null },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.confidence).toBe(1);
      expect(r.value.date).toBeNull();
      expect(r.value.items).toHaveLength(1);
    }
  });
});

describe('EntityMatcher', () => {
  const customers = new EntityMatcher([
    { id: '1', name: 'Rakesh Sharma', aliases: ['Sharma ji'] },
    { id: '2', name: 'Mohan Sharma', aliases: ['Mohan'] },
    { id: '3', name: 'Anil Gupta', aliases: ['Gupta ji'] },
  ]);

  it('matches an alias with honorific exactly', () => {
    const m = customers.match('Gupta ji');
    expect(m.status).toBe('matched');
    expect(m.best?.id).toBe('3');
  });

  it('reports ambiguity when two customers share a surname', () => {
    const m = customers.match('Sharma');
    expect(m.status).toBe('ambiguous');
    expect(m.candidates.map((c) => c.id).sort()).toEqual(['1', '2']);
  });

  it('an exact alias with honorific beats a shared surname', () => {
    expect(customers.match('Sharma ji')).toMatchObject({ status: 'matched', best: { id: '1' } });
  });

  it('returns not_found for unknown names', () => {
    expect(customers.match('Chaurasia').status).toBe('not_found');
  });
});

describe('ruleParse (offline fallback)', () => {
  const ctx = {
    customers: new EntityMatcher([
      { id: 'c1', name: 'Rakesh Sharma', aliases: ['Sharma ji'] },
      { id: 'c2', name: 'Anil Gupta', aliases: ['Gupta ji'] },
      { id: 'c3', name: 'Suresh Verma', aliases: ['Verma ji'] },
    ]),
    suppliers: new EntityMatcher([{ id: 's1', name: 'Ramesh Traders', aliases: ['Ramesh'] }]),
    products: new EntityMatcher([
      { id: 'p1', name: 'Sugar', aliases: ['cheeni'] },
      { id: 'p2', name: 'Mustard Oil', aliases: ['tel'] },
      { id: 'p3', name: 'Maggi Noodles', aliases: ['maggi'] },
      { id: 'p4', name: 'Parle-G', aliases: ['parle g'] },
      { id: 'p5', name: 'Atta', aliases: ['aata'] },
      { id: 'p6', name: 'Rice', aliases: ['chawal'] },
    ]),
  };

  it('add_credit with amount', () => {
    const c = ruleParse('aaj Sharma ji ke 500 rupay ka saman gaya', ctx);
    expect(c.intent).toBe('add_credit');
    expect(c.customerName).toBe('Sharma ji');
    expect(c.amount).toBe(50000);
    expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('add_credit with items and Hindi numbers', () => {
    const c = ruleParse('Gupta ji ko do kilo cheeni aur ek litre tel udhaar diya', ctx);
    expect(c.intent).toBe('add_credit');
    expect(c.customerName).toBe('Gupta ji');
    expect(c.items).toEqual([
      expect.objectContaining({ name: 'Sugar', qty: 2, unit: 'kg' }),
      expect.objectContaining({ name: 'Mustard Oil', qty: 1, unit: 'litre' }),
    ]);
  });

  it('receive_payment', () => {
    const c = ruleParse('Sharma ji ne teen sau rupay de diye', ctx);
    expect(c.intent).toBe('receive_payment');
    expect(c.amount).toBe(30000);
    expect(ruleParse('Verma ji ka 1000 jama karo', ctx)).toMatchObject({ intent: 'receive_payment', amount: 100000, customerName: 'Verma ji' });
  });

  it('add_purchase with total and paid amount', () => {
    const c = ruleParse('Ramesh traders se 50 kilo aata liya 1500 ka, 1000 de diye', ctx);
    expect(c.intent).toBe('add_purchase');
    expect(c.supplierName).toBe('Ramesh Traders');
    expect(c.items[0]).toMatchObject({ name: 'Atta', qty: 50, unit: 'kg', total: 150000 });
    expect(c.amount).toBe(150000);
    expect(c.paidAmount).toBe(100000);
  });

  it('supplier_payment', () => {
    expect(ruleParse('Ramesh traders ko 2000 rupay diye', ctx)).toMatchObject({ intent: 'supplier_payment', amount: 200000 });
  });

  it('add_sale with payment mode', () => {
    const c = ruleParse('2 packet maggi aur 1 parle g becha cash mein', ctx);
    expect(c.intent).toBe('add_sale');
    expect(c.paymentMode).toBe('cash');
    expect(c.items.map((i) => [i.name, i.qty])).toEqual([
      ['Maggi Noodles', 2],
      ['Parle-G', 1],
    ]);
  });

  it('adjust_stock up and down', () => {
    expect(ruleParse('chawal ka stock 25 kilo badhao', ctx)).toMatchObject({ intent: 'adjust_stock', productName: 'Rice', quantity: 25 });
    expect(ruleParse('cheeni ka stock 5 kilo kam karo', ctx)).toMatchObject({ intent: 'adjust_stock', quantity: -5 });
  });

  it('queries', () => {
    expect(ruleParse('Sharma ji ka kitna udhaar baaki hai?', ctx).intent).toBe('query_balance');
    expect(ruleParse('cheeni kitni bachi hai?', ctx)).toMatchObject({ intent: 'query_stock', queryType: 'product', productName: 'Sugar' });
    expect(ruleParse('kya kya khatam hone wala hai?', ctx)).toMatchObject({ intent: 'query_stock', queryType: 'low_stock' });
    expect(ruleParse('aaj kitni bikri hui?', ctx)).toMatchObject({ intent: 'query_summary', period: 'today' });
  });

  it('add_product', () => {
    expect(ruleParse('naya product jodo, Surf Excel 1kg, 120 rupay', ctx)).toMatchObject({ intent: 'add_product', sellingPrice: 12000 });
  });

  it('unknown', () => {
    expect(ruleParse('mausam kaisa hai', ctx).intent).toBe('unknown');
  });
});
