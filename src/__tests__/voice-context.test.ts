import {
  CONTEXT_IDLE_MS,
  applyContext,
  conversationFromLogs,
  describeTurn,
  isPronounName,
  isResetCommand,
  rewriteFollowUp,
  type ConversationTurn,
} from '../ai/conversation';
import { emptyCommand, validateParsedBatch } from '../ai/intentSchema';
import { EntityMatcher } from '../ai/matcher';
import { buildUserMessage } from '../ai/prompt';
import { ruleParse, ruleParseMany } from '../ai/ruleParser';

const customers = new EntityMatcher(
  [
    { id: 'c1', name: 'Rakesh Sharma', aliases: ['Sharma ji'] },
    { id: 'c2', name: 'Anil Gupta', aliases: ['Gupta ji'] },
  ],
  true,
);
const suppliers = new EntityMatcher([{ id: 's1', name: 'Ramesh Traders', aliases: [] }], true);
const products = new EntityMatcher([
  { id: 'p1', name: 'Sugar', aliases: ['cheeni'] },
  { id: 'p2', name: 'Sarson Tel', aliases: ['tel'] },
  { id: 'p3', name: 'Basmati Rice', aliases: ['chawal'] },
]);
const ctx = { customers, suppliers, products };

const sharmaTurn: ConversationTurn = { text: 'Sharma ji ke 500 likho', intent: 'add_credit', customer: { id: 'c1', name: 'Rakesh Sharma' }, amount: 50000 };
const guptaPaid: ConversationTurn = { text: 'Gupta ji ne 300 diye', intent: 'receive_payment', customer: { id: 'c2', name: 'Anil Gupta' }, amount: 30000 };

describe('validateParsedBatch (multi-action AI output)', () => {
  it('accepts a list of actions and validates each one', () => {
    const r = validateParsedBatch({
      actions: [
        { ...emptyCommand('add_credit'), customerName: 'Sharma ji', amount: 50000.4, confidence: 0.9 },
        { ...emptyCommand('receive_payment'), customerName: 'Gupta ji', amount: 20000, confidence: 0.9 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((a) => a.intent)).toEqual(['add_credit', 'receive_payment']);
      expect(r.value[0]!.amount).toBe(50000);
    }
  });

  it('still accepts a single command object (old shape)', () => {
    const r = validateParsedBatch({ ...emptyCommand('query_balance'), customerName: 'Sharma ji', confidence: 0.9 });
    expect(r.ok && r.value.length).toBe(1);
  });

  it('rejects an empty list or a bad action, and keeps at most 5', () => {
    expect(validateParsedBatch({ actions: [] }).ok).toBe(false);
    expect(validateParsedBatch({ actions: [{ intent: 'add_credit' }] }).ok).toBe(false);
    const many = validateParsedBatch({ actions: Array.from({ length: 8 }, () => ({ ...emptyCommand('add_credit'), amount: 100, confidence: 1 })) });
    expect(many.ok && many.value.length).toBe(5);
  });
});

describe('ruleParseMany (offline, several actions in one sentence)', () => {
  it('splits "X ke 500 likho aur Y ne 200 de diye" into two actions', () => {
    const r = ruleParseMany('Sharma ji ke 500 likho aur Gupta ji ne 200 de diye', ctx);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ intent: 'add_credit', customerName: 'Sharma ji', amount: 50000 });
    expect(r[1]).toMatchObject({ intent: 'receive_payment', customerName: 'Gupta ji', amount: 20000 });
  });

  it('splits a supplier payment and a stock change', () => {
    const r = ruleParseMany('Ramesh Traders ko 2000 rupay diye aur chawal ka stock 10 kilo badhao', ctx);
    expect(r.map((a) => a.intent)).toEqual(['supplier_payment', 'adjust_stock']);
    expect(r[0]!.amount).toBe(200000);
    expect(r[1]).toMatchObject({ productName: 'Basmati Rice', quantity: 10 });
  });

  it('keeps goods joined by "aur" as ONE action', () => {
    const r = ruleParseMany('Sharma ji ko 2 kilo cheeni aur 1 litre tel udhaar diya', ctx);
    expect(r).toHaveLength(1);
    expect(r[0]!.intent).toBe('add_credit');
    expect(r[0]!.items.map((i) => i.name)).toEqual(['Sugar', 'Sarson Tel']);
  });

  it('does not split when one side has no amount', () => {
    expect(ruleParseMany('Sharma ji aur Gupta ji ne 200 diye', ctx)).toHaveLength(1);
  });

  it('a plain single command parses exactly as before', () => {
    const text = 'Sharma ji ke 500 rupay ka saman gaya';
    expect(ruleParseMany(text, ctx)).toEqual([ruleParse(text, ctx)]);
  });
});

describe('conversation context', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo);
  const log = (rawText: string, msAgo: number, parsedJson: unknown, extra: Record<string, unknown> = {}) => ({
    rawText,
    intent: (parsedJson as { intent?: string }).intent ?? 'unknown',
    status: 'confirmed',
    parsedJson,
    createdAt: at(msAgo),
    ...extra,
  });

  it('builds turns oldest-first from recent logs, with resolved names', () => {
    const turns = conversationFromLogs([
      log('Gupta ji ne 300 diye', 60_000, { intent: 'receive_payment', amount: 30000, resolved: { customer: { id: 'c2', name: 'Anil Gupta' } } }),
      log('Sharma ji ke 500 likho', 120_000, { intent: 'add_credit', amount: 50000, resolved: { customer: { id: 'c1', name: 'Rakesh Sharma' } } }),
    ]);
    expect(turns.map((t) => t.customer?.name)).toEqual(['Rakesh Sharma', 'Anil Gupta']);
    expect(describeTurn(turns[1]!)).toContain('customer: Anil Gupta');
  });

  it('forgets everything after 10 minutes of silence', () => {
    expect(conversationFromLogs([log('Sharma ji ke 500 likho', CONTEXT_IDLE_MS + 1000, { intent: 'add_credit' })])).toEqual([]);
  });

  it('stops at a gap of more than 10 minutes between commands', () => {
    const turns = conversationFromLogs([
      log('Gupta ji ne 300 diye', 60_000, { intent: 'receive_payment', resolved: { customer: { id: 'c2', name: 'Anil Gupta' } } }),
      log('Sharma ji ke 500 likho', 60_000 + CONTEXT_IDLE_MS + 1000, { intent: 'add_credit', resolved: { customer: { id: 'c1', name: 'Rakesh Sharma' } } }),
    ]);
    expect(turns.map((t) => t.customer?.name)).toEqual(['Anil Gupta']);
  });

  it('"naya" / "reset" clears the context', () => {
    expect(isResetCommand('naya')).toBe(true);
    expect(isResetCommand('Reset karo')).toBe(true);
    expect(isResetCommand('नया')).toBe(true);
    expect(isResetCommand('naya product jodo, Surf 120 rupay')).toBe(false);
    const turns = conversationFromLogs([
      log('naya', 30_000, { intent: 'reset_context' }),
      log('Sharma ji ke 500 likho', 60_000, { intent: 'add_credit', resolved: { customer: { id: 'c1', name: 'Rakesh Sharma' } } }),
    ]);
    expect(turns).toEqual([]);
  });

  it('skips failed commands and reads every action of a multi-action log', () => {
    const turns = conversationFromLogs([
      log('kuch bhi', 10_000, { intent: 'unknown' }, { status: 'failed' }),
      log('Sharma ji ke 500 aur Gupta ji ne 200', 20_000, {
        intent: 'add_credit',
        actions: [
          { intent: 'add_credit', resolved: { customer: { id: 'c1', name: 'Rakesh Sharma' } } },
          { intent: 'receive_payment', resolved: { customer: { id: 'c2', name: 'Anil Gupta' } } },
        ],
      }),
    ]);
    expect(turns.map((t) => t.intent)).toEqual(['add_credit', 'receive_payment']);
  });

  it('recognises pronoun-only names', () => {
    expect(isPronounName('unke')).toBe(true);
    expect(isPronounName('usi ko')).toBe(true);
    expect(isPronounName('wahi wala')).toBe(true);
    expect(isPronounName('उनके')).toBe(true);
    expect(isPronounName('Sharma ji')).toBe(false);
  });

  it('applyContext fills "unke" / a missing name from the last person, never a spoken name', () => {
    const cmd = { ...emptyCommand('add_credit'), customerName: 'unke', amount: 20000 };
    expect(applyContext(cmd, 'unke 200 aur likho', [sharmaTurn]).customerName).toBe('Rakesh Sharma');
    const bare = { ...emptyCommand('add_credit'), amount: 20000 };
    expect(applyContext(bare, 'aur 200 jodo', [sharmaTurn]).customerName).toBe('Rakesh Sharma');
    const named = { ...emptyCommand('add_credit'), customerName: 'Gupta ji', amount: 20000 };
    expect(applyContext(named, 'Gupta ji ke 200 aur likho', [sharmaTurn]).customerName).toBe('Gupta ji');
    expect(applyContext(bare, 'aur 200 jodo', []).customerName).toBeNull();
  });

  it('applyContext resolves "wahi wala" to the last product', () => {
    const turns: ConversationTurn[] = [{ text: 'cheeni kitni bachi hai', intent: 'query_stock', product: { id: 'p1', name: 'Sugar' }, amount: null }];
    const cmd = { ...emptyCommand('adjust_stock'), productName: 'wahi wala', quantity: 5 };
    expect(applyContext(cmd, 'wahi wala 5 kilo badhao', turns).productName).toBe('Sugar');
  });

  it('rewriteFollowUp spells out follow-ups for the offline parser', () => {
    const m = { customers, suppliers };
    expect(rewriteFollowUp('unhone 100 aur diye', [guptaPaid], m)).toBe('Anil Gupta ne 100 aur diye');
    expect(rewriteFollowUp('aur 200 jodo', [sharmaTurn], m)).toBe('Rakesh Sharma ke aur 200 jodo');
    expect(rewriteFollowUp('unka kitna udhaar hai', [sharmaTurn], m)).toBe('Rakesh Sharma ka kitna udhaar hai');
    expect(rewriteFollowUp('usi ko 300 aur likho', [sharmaTurn], m)).toBe('Rakesh Sharma ko 300 aur likho');
    // Names its own person, or nothing to go on: unchanged.
    expect(rewriteFollowUp('Gupta ji ke 200 aur likho', [sharmaTurn], m)).toBe('Gupta ji ke 200 aur likho');
    expect(rewriteFollowUp('aur 200 jodo', [], m)).toBe('aur 200 jodo');
  });

  it('offline parser reads the rewritten follow-ups correctly', () => {
    const m = { customers, suppliers };
    expect(ruleParse(rewriteFollowUp('unhone 100 aur diye', [guptaPaid], m), ctx)).toMatchObject({ intent: 'receive_payment', customerName: 'Anil Gupta', amount: 10000 });
    expect(ruleParse(rewriteFollowUp('aur 200 jodo', [sharmaTurn], m), ctx)).toMatchObject({ intent: 'add_credit', customerName: 'Rakesh Sharma', amount: 20000 });
    expect(ruleParse(rewriteFollowUp('unka kitna udhaar hai', [sharmaTurn], m), ctx)).toMatchObject({ intent: 'query_balance', customerName: 'Rakesh Sharma' });
  });

  it('sends the conversation to the AI', () => {
    const msg = buildUserMessage('aur 200 jodo', { customers: [], suppliers: [], products: [] }, '2026-10-27', [describeTurn(sharmaTurn)]);
    expect(msg).toContain('Recent conversation (oldest first): \n- "Sharma ji ke 500 likho" -> add_credit, customer: Rakesh Sharma');
    expect(buildUserMessage('x', { customers: [], suppliers: [], products: [] }, '2026-10-27')).toContain('Recent conversation (oldest first): (none)');
  });
});
