// zod/v4 because the Anthropic SDK's zodOutputFormat helper expects v4 schemas.
import { z } from 'zod/v4';

export const INTENTS = [
  'add_credit',
  'receive_payment',
  'add_purchase',
  'supplier_payment',
  'add_sale',
  'adjust_stock',
  'add_product',
  'query_balance',
  'query_stock',
  'query_summary',
  'undo_last',
  'reset_context',
  'unknown',
] as const;
export type Intent = (typeof INTENTS)[number];

export const SPOKEN_UNITS = ['kg', 'g', 'litre', 'ml', 'piece', 'packet', 'dozen', 'box'] as const;

const ParsedItem = z.object({
  name: z.string().describe('Product name exactly as spoken (e.g. "cheeni", "Parle-G")'),
  qty: z.number().describe('Quantity in the given unit'),
  unit: z.enum(SPOKEN_UNITS).nullable(),
  rate: z.number().nullable().describe('Price per unit in paise, if spoken'),
  total: z.number().nullable().describe('Line total in paise, if spoken (e.g. "50 kilo aata 1500 ka" -> 150000)'),
});

/**
 * Flat, all-fields-present shape so structured outputs can guarantee it.
 * Every money value is integer paise.
 */
export const ParsedCommandSchema = z.object({
  intent: z.enum(INTENTS),
  customerName: z.string().nullable().describe('Customer name as spoken, keep honorific (e.g. "Sharma ji")'),
  supplierName: z.string().nullable(),
  productName: z.string().nullable().describe('Single product for adjust_stock / add_product / query_stock'),
  amount: z.number().nullable().describe('Main amount in paise'),
  paidAmount: z.number().nullable().describe('Amount paid now in paise (purchases and partial sales)'),
  items: z.array(ParsedItem),
  quantity: z.number().nullable().describe('Signed stock change for adjust_stock (+ add, - remove)'),
  unit: z.enum(SPOKEN_UNITS).nullable(),
  sellingPrice: z.number().nullable().describe('Selling price in paise for add_product'),
  paymentMode: z.enum(['cash', 'upi', 'udhaar', 'bank']).nullable(),
  date: z.string().nullable().describe('YYYY-MM-DD if a day was mentioned (aaj/kal/parso), else null'),
  period: z.enum(['today', 'yesterday', 'week', 'month']).nullable(),
  queryType: z.enum(['product', 'low_stock', 'out_of_stock']).nullable(),
  settleFull: z
    .boolean()
    .describe('true when the WHOLE pending balance was paid/cleared ("sara udhaar de diya", "hisaab clear"); amount is then null'),
  note: z.string().nullable(),
  confidence: z.number().describe('0 to 1: how sure you are about the intent and values'),
});

export type ParsedCommand = z.infer<typeof ParsedCommandSchema>;

/** Most actions one sentence may carry ("Sharma ji ke 500 likho aur Gupta ji ne 200 de diye"). */
export const MAX_ACTIONS = 5;

/** What the AI returns: one entry per action in the sentence, in the order spoken. */
export const ParsedBatchSchema = z.object({
  actions: z.array(ParsedCommandSchema).describe('One entry per separate action in the command, in spoken order. Usually exactly one.'),
});
export type ParsedItem = z.infer<typeof ParsedItem>;

export const emptyCommand = (intent: Intent = 'unknown'): ParsedCommand => ({
  intent,
  customerName: null,
  supplierName: null,
  productName: null,
  amount: null,
  paidAmount: null,
  items: [],
  quantity: null,
  unit: null,
  sellingPrice: null,
  paymentMode: null,
  date: null,
  period: null,
  queryType: null,
  settleFull: false,
  note: null,
  confidence: 0,
});

/** Validates provider output and enforces invariants JSON schema can't express. */
export function validateParsedCommand(raw: unknown): { ok: true; value: ParsedCommand } | { ok: false; error: string } {
  const result = ParsedCommandSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const v = result.data;
  const money = (n: number | null) => (n === null ? null : Math.max(0, Math.round(n)));
  return {
    ok: true,
    value: {
      ...v,
      amount: money(v.amount),
      paidAmount: money(v.paidAmount),
      sellingPrice: money(v.sellingPrice),
      items: v.items
        .filter((i) => i.name.trim() && i.qty > 0)
        .map((i) => ({ ...i, rate: money(i.rate), total: money(i.total), qty: Math.round(i.qty * 1000) / 1000 })),
      date: v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : null,
      confidence: Math.min(1, Math.max(0, v.confidence)),
    },
  };
}

/**
 * Validates the AI's list of actions. A bare single command (older shape) is accepted too.
 * Extra actions beyond MAX_ACTIONS are dropped; an empty list is invalid.
 */
export function validateParsedBatch(raw: unknown): { ok: true; value: ParsedCommand[] } | { ok: false; error: string } {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { actions?: unknown }).actions) ? (raw as { actions: unknown[] }).actions : [raw];
  if (!list.length) return { ok: false, error: 'actions: expected at least one action' };
  const out: ParsedCommand[] = [];
  for (const [i, item] of list.slice(0, MAX_ACTIONS).entries()) {
    const r = validateParsedCommand(item);
    if (!r.ok) return { ok: false, error: list.length > 1 ? `actions.${i}: ${r.error}` : r.error };
    out.push(r.value);
  }
  return { ok: true, value: out };
}
