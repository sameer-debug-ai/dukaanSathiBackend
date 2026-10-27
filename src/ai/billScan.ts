// zod/v4 because the Anthropic SDK's zodOutputFormat helper expects v4 schemas.
import { z } from 'zod/v4';
import { SPOKEN_UNITS } from './intentSchema';
import { EntityMatcher, type EntityMatch, type MatchTarget } from './matcher';

/* ------------------------------------------------------------------------------------------
 * 1. What Claude must return for a bill photo. Amounts are RUPEES as printed on the bill; the
 *    server converts them to paise. All fields are present so structured output can enforce it.
 * ---------------------------------------------------------------------------------------- */
export const BillScanOutputSchema = z.object({
  readable: z.boolean().describe('false if this is not a bill/invoice, or too blurry, dark or cut off to read'),
  problem: z.string().nullable().describe('When not readable: a short reason (blurry, dark, not a bill, cut off)'),
  supplierName: z.string().nullable().describe('Seller / shop / firm name printed on the bill'),
  invoiceNumber: z.string().nullable(),
  date: z.string().nullable().describe('Bill date as YYYY-MM-DD, null if not printed'),
  items: z.array(
    z.object({
      name: z.string().describe('Item name exactly as printed'),
      qty: z.number().nullable(),
      unit: z.enum(SPOKEN_UNITS).nullable(),
      rate: z.number().nullable().describe('Price per unit in rupees'),
      total: z.number().nullable().describe('Line amount in rupees'),
      legible: z.boolean().describe('false when this line could not be read reliably'),
    }),
  ),
  total: z.number().nullable().describe('Grand total / net payable in rupees'),
});
export type BillScanOutput = z.infer<typeof BillScanOutputSchema>;

export const BILL_SCAN_PROMPT = `You read photos of purchase bills (invoices) that an Indian kirana shop got from its supplier.
Bills may be printed or handwritten, in English, Hindi or Hinglish, and photographed on a phone.

Return ONLY the JSON object for the schema:
- readable=false (with a short problem) if the photo is not a bill, or is too blurry, dark or cut off to read the items. Then items=[].
- supplierName: the seller's firm/shop name (not the buyer). invoiceNumber and date (YYYY-MM-DD) if printed.
- One entry per product line. Copy the item name as printed. qty and unit (kg, g, litre, ml, piece, packet, dozen, box; null if unclear).
  rate = price per unit in rupees, total = line amount in rupees. Leave a number null rather than guessing.
- Do NOT include tax, discount, round-off, freight or subtotal lines as items.
- Set legible=false on any line you are not sure about.
- total = the grand total / net amount payable in rupees.`;

/* ------------------------------------------------------------------------------------------
 * 2. Validation + normalisation (pure, tested): rupees -> paise, sane numbers, derived fields.
 * ---------------------------------------------------------------------------------------- */
export interface ScannedItem {
  name: string;
  qty: number | null;
  unit: (typeof SPOKEN_UNITS)[number] | null;
  /** Paise per unit. */
  rate: number | null;
  /** Paise. */
  total: number | null;
  legible: boolean;
}
export interface ScannedBill {
  readable: boolean;
  problem: string | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  date: string | null;
  items: ScannedItem[];
  /** Paise. */
  total: number | null;
}

const MAX_ITEMS = 100;
const toPaise = (rupees: number | null | undefined): number | null =>
  typeof rupees === 'number' && Number.isFinite(rupees) && rupees >= 0 ? Math.round(rupees * 100) : null;
const clean = (s: string | null | undefined, max: number) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return v || null;
};

export function validateBillScan(raw: unknown, todayIst: string): { ok: true; value: ScannedBill } | { ok: false; error: string } {
  const result = BillScanOutputSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const v = result.data;

  const items: ScannedItem[] = [];
  for (const it of v.items.slice(0, MAX_ITEMS)) {
    const name = clean(it.name, 120);
    if (!name) continue;
    const qty = typeof it.qty === 'number' && Number.isFinite(it.qty) && it.qty > 0 ? Math.round(it.qty * 1000) / 1000 : null;
    let rate = toPaise(it.rate);
    let total = toPaise(it.total);
    // Fill in whichever of rate / total is missing from the other two.
    if (rate === null && total !== null && qty) rate = Math.round(total / qty);
    if (total === null && rate !== null && qty) total = Math.round(rate * qty);
    items.push({ name, qty, unit: it.unit, rate, total, legible: it.legible && qty !== null && rate !== null });
  }

  // A date in the future (or malformed) is a misread; leave it for the user.
  const date = v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date) && v.date <= todayIst ? v.date : null;
  const readable = v.readable && items.length > 0;
  return {
    ok: true,
    value: {
      readable,
      problem: readable ? null : clean(v.problem, 200) ?? (v.readable ? 'No items found on the bill' : null),
      supplierName: clean(v.supplierName, 120),
      invoiceNumber: clean(v.invoiceNumber, 60),
      date,
      items: readable ? items : [],
      total: toPaise(v.total),
    },
  };
}

/* ------------------------------------------------------------------------------------------
 * 3. Matching against the shop's suppliers and products (names, aliases, Hindi names).
 * ---------------------------------------------------------------------------------------- */
export type ScanItemStatus = 'matched' | 'check' | 'new' | 'unreadable';

export interface MatchedBillItem extends ScannedItem {
  status: ScanItemStatus;
  match: EntityMatch;
}
export interface MatchedBill {
  readable: boolean;
  problem: string | null;
  supplier: { name: string; match: EntityMatch } | null;
  invoiceNumber: string | null;
  date: string | null;
  items: MatchedBillItem[];
  /** Bill's printed total (paise). */
  billTotal: number | null;
  /** Sum of the readable item lines (paise). */
  itemsTotal: number;
  /** Items don't add up to the bill total (beyond ₹1 of rounding). */
  mismatch: boolean;
}

/** Rupee rounding on bills: differences up to ₹1 are not a mismatch. */
const ROUNDING_PAISE = 100;

export function matchBill(scan: ScannedBill, suppliers: MatchTarget[], products: MatchTarget[]): MatchedBill {
  const supplierMatcher = new EntityMatcher(suppliers, true);
  const productMatcher = new EntityMatcher(products);

  const items = scan.items.map((it): MatchedBillItem => {
    const match = productMatcher.match(it.name);
    const status: ScanItemStatus = !it.legible ? 'unreadable' : match.status === 'matched' ? 'matched' : match.status === 'ambiguous' ? 'check' : 'new';
    return { ...it, status, match };
  });
  const itemsTotal = items.reduce((s, i) => s + (i.total ?? 0), 0);
  const mismatch = scan.total !== null && items.length > 0 && Math.abs(scan.total - itemsTotal) > ROUNDING_PAISE;

  return {
    readable: scan.readable,
    problem: scan.problem,
    supplier: scan.supplierName ? { name: scan.supplierName, match: supplierMatcher.match(scan.supplierName) } : null,
    invoiceNumber: scan.invoiceNumber,
    date: scan.date,
    items,
    billTotal: scan.total,
    itemsTotal,
    mismatch,
  };
}
