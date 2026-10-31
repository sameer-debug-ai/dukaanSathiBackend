import { lineTotal } from '../utils/money';

/**
 * Bill maths, pure and in paise. The backend is the source of truth: the billing screen's
 * preview (/sales/quote) and the saved bill both come from here.
 *
 * - 'none' (not GST registered) and 'composition' (Bill of Supply): items, discount, total.
 *   Exactly the numbers the app always produced; no tax, no round-off.
 * - 'gst' (Tax Invoice): the bill discount is shared across lines by value, then each line's
 *   taxable value and tax are worked out (inclusive or exclusive price), split CGST+SGST
 *   (same state) or IGST (other state), and the total is rounded to the nearest rupee.
 */

export type TaxMode = 'none' | 'composition' | 'gst';

export interface BillLineIn {
  qty: number;
  /** Paise per unit, as charged. */
  rate: number;
  /** Percent, e.g. 5, 18, 0.25. */
  gstRate: number;
  /** Rate already includes GST (MRP style). */
  inclusive: boolean;
}

export interface BillLineOut {
  /** qty x rate, before the bill discount (this is the line "total" shown on the bill). */
  gross: number;
  /** This line's share of the bill discount. */
  discount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
}

export interface TaxRow {
  rate: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface BillTotals {
  lines: BillLineOut[];
  subtotal: number;
  discount: number;
  taxableTotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  /** Tax charged on top of exclusive prices (inclusive prices already hold theirs). */
  taxAdded: number;
  roundOff: number;
  totalAmount: number;
  taxSummary: TaxRow[];
}

/** Shares `amount` across `weights` in whole paise, largest remainder first, so the parts add up exactly. */
export function allocate(amount: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!amount || !sum) return weights.map(() => 0);
  const exact = weights.map((w) => (amount * w) / sum);
  const parts = exact.map(Math.floor);
  let left = amount - parts.reduce((s, p) => s + p, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}

export function computeBill(lines: BillLineIn[], discount: number, opts: { mode: TaxMode; interState?: boolean }): BillTotals {
  const gross = lines.map((l) => lineTotal(l.qty, l.rate));
  const subtotal = gross.reduce((s, g) => s + g, 0);
  const shares = allocate(discount, gross);

  if (opts.mode !== 'gst') {
    const out = gross.map((g, i) => ({ gross: g, discount: shares[i]!, taxable: g - shares[i]!, cgst: 0, sgst: 0, igst: 0, tax: 0 }));
    return {
      lines: out,
      subtotal,
      discount,
      taxableTotal: subtotal - discount,
      cgst: 0,
      sgst: 0,
      igst: 0,
      taxTotal: 0,
      taxAdded: 0,
      roundOff: 0,
      totalAmount: subtotal - discount,
      taxSummary: [],
    };
  }

  const out: BillLineOut[] = lines.map((l, i) => {
    const value = gross[i]! - shares[i]!;
    const rate = Math.max(0, l.gstRate);
    const taxable = l.inclusive ? Math.round((value * 100) / (100 + rate)) : value;
    const tax = l.inclusive ? value - taxable : Math.round((taxable * rate) / 100);
    if (opts.interState) return { gross: gross[i]!, discount: shares[i]!, taxable, cgst: 0, sgst: 0, igst: tax, tax };
    const cgst = Math.round(tax / 2);
    return { gross: gross[i]!, discount: shares[i]!, taxable, cgst, sgst: tax - cgst, igst: 0, tax };
  });

  const sum = (k: keyof BillLineOut) => out.reduce((s, l) => s + l[k], 0);
  const taxAdded = out.reduce((s, l, i) => s + (lines[i]!.inclusive ? 0 : l.tax), 0);
  const beforeRound = subtotal - discount + taxAdded;
  const totalAmount = Math.round(beforeRound / 100) * 100;

  const byRate = new Map<number, TaxRow>();
  out.forEach((l, i) => {
    const rate = Math.max(0, lines[i]!.gstRate);
    const row = byRate.get(rate) ?? { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxable += l.taxable;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.igst += l.igst;
    byRate.set(rate, row);
  });

  return {
    lines: out,
    subtotal,
    discount,
    taxableTotal: sum('taxable'),
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    igst: sum('igst'),
    taxTotal: sum('tax'),
    taxAdded,
    roundOff: totalAmount - beforeRound,
    totalAmount,
    taxSummary: [...byRate.values()].sort((a, b) => a.rate - b.rate),
  };
}
