import { detectAnalytics } from '../ai/analyticsRules';
import { FAST_CONFIDENCE, fastParse } from '../ai/fastParse';
import { normalizeSpokenNumbers } from '../ai/hindiNumbers';
import { validateParsedCommand, emptyCommand } from '../ai/intentSchema';
import { EntityMatcher } from '../ai/matcher';
import { devanagariToRoman } from '../ai/transliterate';
import { periodRange, previousRange } from '../services/voiceAnalytics.service';
import { istDayKey } from '../utils/istDate';

const ctx = {
  customers: new EntityMatcher(
    [
      { id: 'c1', name: 'Rakesh Sharma', aliases: ['Sharma ji'] },
      { id: 'c2', name: 'Anil Gupta', aliases: ['Gupta ji'] },
      { id: 'c3', name: 'Mohan Verma', aliases: [] },
      { id: 'c4', name: 'Suresh Verma', aliases: [] },
    ],
    true,
  ),
  suppliers: new EntityMatcher([{ id: 's1', name: 'Ramesh Traders', aliases: [] }], true),
  products: new EntityMatcher([{ id: 'p1', name: 'Sugar', aliases: ['cheeni'] }]),
};

describe('Hindi number words (Roman and Devanagari)', () => {
  const n = (s: string) => normalizeSpokenNumbers(devanagariToRoman(s));
  it.each([
    ['ek sau', '100'],
    ['paanch sau', '500'],
    ['dedh sau', '150'],
    ['dhai sau', '250'],
    ['hazaar', '1000'],
    ['dhai hazaar', '2500'],
    ['ek lakh', '100000'],
    ['dedh lakh', '150000'],
    ['पाँच सौ', '500'],
    ['डेढ़ सौ', '150'],
    ['ढाई सौ', '250'],
    ['ढाई हज़ार', '2500'],
    ['दो लाख', '200000'],
    ['साढ़े तीन सौ', '350'],
  ])('%s -> %s', (spoken, digits) => {
    expect(n(spoken)).toBe(digits);
  });
});

describe('fastParse (local fast path before the AI)', () => {
  it.each([
    ['Sharma ji 500 udhaar', 'add_credit', 'c1', 50000],
    ['Sharma ji ke 500 udhaar likho', 'add_credit', 'c1', 50000],
    ['Sharma ji ka paanch sau likh do', 'add_credit', 'c1', 50000],
    ['Sharma ji ke 500 rupay ka saman gaya', 'add_credit', 'c1', 50000],
    ['Gupta ji ne 200 diye', 'receive_payment', 'c2', 20000],
    ['Gupta ji ne dhai sau de diye', 'receive_payment', 'c2', 25000],
    ['Gupta ji ne dedh hazaar jama kiye', 'receive_payment', 'c2', 150000],
    ['Ramesh traders ko 2000 diye', 'supplier_payment', 's1', 200000],
    ['Ramesh traders ko ek lakh diye', 'supplier_payment', 's1', 10000000],
  ])('"%s" -> %s', (text, intent, id, amount) => {
    const cmd = fastParse(text, ctx);
    expect(cmd).not.toBeNull();
    expect(cmd).toMatchObject({ intent, amount, confidence: FAST_CONFIDENCE });
    const name = intent === 'supplier_payment' ? cmd!.supplierName : cmd!.customerName;
    expect((intent === 'supplier_payment' ? ctx.suppliers : ctx.customers).match(name).best?.id).toBe(id);
  });

  it('handles Devanagari speech', () => {
    expect(fastParse('शर्मा जी के पाँच सौ उधार लिखो', ctx)).toMatchObject({ intent: 'add_credit', amount: 50000 });
    expect(fastParse('गुप्ता जी ने ढाई हज़ार दिए', ctx)).toMatchObject({ intent: 'receive_payment', amount: 250000 });
  });

  it('keeps the spoken day', () => {
    expect(fastParse('kal Gupta ji ne 200 diye', ctx)?.date).not.toBeNull();
  });

  it.each([
    ['unknown person', 'Pappu Yadav ke 500 udhaar likho'],
    ['ambiguous name (two Vermas)', 'Verma ne 300 diye'],
    ['pronoun / follow-up', 'unhone 100 diye'],
    ['two actions', 'Sharma ji ke 500 likho aur Gupta ji ne 200 de diye'],
    ['items with quantities', 'Sharma ji ko 2 kilo cheeni udhaar diya'],
    ['question', 'Sharma ji ka kitna udhaar hai?'],
    ['full settlement', 'Gupta ji ne sara udhaar de diya'],
    ['customer named with "ko diye"', 'Sharma ji ko 500 diye'],
    ['no amount', 'Sharma ji udhaar likho'],
    ['extra words', 'Sharma ji ke 500 udhaar likho aur kal yaad dilana'],
    ['purchase', 'Ramesh traders se 50 kilo aata liya 1500 ka'],
  ])('is not confident for %s -> null (goes to the AI)', (_label, text) => {
    expect(fastParse(text, ctx)).toBeNull();
  });
});

describe('analytics question detection (offline)', () => {
  it.each([
    ['Is mahine sabse zyada kya bika?', { fn: 'top_products', period: 'this_month' }],
    ['pichhle hafte sabse zyada kya bika', { fn: 'top_products', period: 'last_week' }],
    ['Kaun 2 mahine se paisa nahi de raha?', { fn: 'inactive_debtors', days: 60 }],
    ['kaun do mahine se paisa nahi de raha', { fn: 'inactive_debtors', days: 60 }],
    ['kisne 3 hafte se payment nahi kiya', { fn: 'inactive_debtors', days: 21 }],
    ['Aaj kal se kam bikri kyun hui?', { fn: 'compare_sales', period: 'today' }],
    ['is hafte bikri kam kyun hai', { fn: 'compare_sales', period: 'this_week' }],
    ['Is hafte kitna munafa hua?', { fn: 'profit', period: 'this_week' }],
    ['aaj kitna profit hua', { fn: 'profit', period: 'today' }],
    ['Sabse zyada udhaar kiska hai?', { fn: 'top_debtors' }],
    ['सबसे ज़्यादा उधार किसका है?', { fn: 'top_debtors' }],
    ['इस महीने सबसे ज़्यादा क्या बिका?', { fn: 'top_products', period: 'this_month' }],
  ])('"%s"', (text, expected) => {
    expect(detectAnalytics(text)).toMatchObject(expected);
  });

  it.each(['aaj kitni bikri hui?', 'Sharma ji ka kitna udhaar hai?', 'Sharma ji ke 500 likho', 'kya kya khatam hone wala hai?'])('leaves "%s" to the normal parser', (text) => {
    expect(detectAnalytics(text)).toBeNull();
  });
});

describe('analytics parameters are validated, never trusted', () => {
  it('clamps days/limit and drops analytics on other intents', () => {
    const raw = { ...emptyCommand('query_analytics'), analytics: { fn: 'inactive_debtors', period: null, days: 5000, limit: 999 }, confidence: 0.9 };
    const r = validateParsedCommand(raw);
    expect(r.ok && r.value.analytics).toEqual({ fn: 'inactive_debtors', period: null, days: 365, limit: 10 });
    const other = validateParsedCommand({ ...raw, intent: 'add_credit' });
    expect(other.ok && other.value.analytics).toBeNull();
  });

  it('rejects an unknown function name', () => {
    const raw = { ...emptyCommand('query_analytics'), analytics: { fn: 'drop_database', period: null, days: null, limit: null } };
    expect(validateParsedCommand(raw).ok).toBe(false);
  });

  it('accepts older output without the analytics field', () => {
    const { analytics: _a, ...old } = { ...emptyCommand('add_credit'), customerName: 'Sharma ji', amount: 50000, confidence: 0.9 };
    const r = validateParsedCommand(old);
    expect(r.ok && r.value.analytics).toBeNull();
  });
});

describe('analytics period ranges (IST)', () => {
  const now = new Date('2026-10-27T10:00:00+05:30');
  const keys = (r: { from: Date; to: Date }) => [istDayKey(r.from), istDayKey(r.to)];
  it.each([
    ['today', ['2026-10-27', '2026-10-27'], ['2026-10-26', '2026-10-26']],
    ['yesterday', ['2026-10-26', '2026-10-26'], ['2026-10-25', '2026-10-25']],
    ['this_week', ['2026-10-21', '2026-10-27'], ['2026-10-14', '2026-10-20']],
    ['this_month', ['2026-10-01', '2026-10-27'], ['2026-09-01', '2026-09-27']],
    ['last_month', ['2026-09-01', '2026-09-30'], ['2026-08-01', '2026-08-31']],
  ] as const)('%s', (period, cur, prev) => {
    expect(keys(periodRange(period, now))).toEqual(cur);
    expect(keys(previousRange(period, now))).toEqual(prev);
  });
});
