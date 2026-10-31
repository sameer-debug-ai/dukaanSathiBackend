import { allocate, computeBill } from '../services/billCalc';
import { amountInWordsEn, amountInWordsHi } from '../utils/amountWords';
import { defaultInvoicePrefix, financialYear, formatInvoiceNo, gstinCheckChar, isValidGstin } from '../utils/gst';

const line = (qty: number, rate: number, gstRate = 0, inclusive = true) => ({ qty, rate, gstRate, inclusive });

describe('computeBill: shops without GST (unchanged maths)', () => {
  it('total = items - discount, no tax, no round-off', () => {
    const b = computeBill([line(2, 4500), line(0.5, 6000)], 500, { mode: 'none' });
    expect(b).toMatchObject({ subtotal: 12000, discount: 500, totalAmount: 11500, taxTotal: 0, roundOff: 0, taxSummary: [] });
    expect(b.lines.map((l) => l.gross)).toEqual([9000, 3000]);
  });

  it('composition (Bill of Supply) is the same: no tax shown or added, no rounding', () => {
    const b = computeBill([line(1, 10050, 5)], 0, { mode: 'composition' });
    expect(b).toMatchObject({ totalAmount: 10050, taxTotal: 0, roundOff: 0, cgst: 0, sgst: 0, igst: 0 });
  });
});

describe('computeBill: GST', () => {
  it('inclusive price, same state: tax is inside the price, split CGST + SGST', () => {
    // Rs 105 incl. 5% -> taxable 100, tax 5 (2.50 + 2.50)
    const b = computeBill([line(1, 10500, 5)], 0, { mode: 'gst' });
    expect(b.lines[0]).toMatchObject({ gross: 10500, taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500 });
    expect(b).toMatchObject({ subtotal: 10500, taxAdded: 0, totalAmount: 10500, roundOff: 0 });
  });

  it('exclusive price: tax is added on top', () => {
    // Rs 100 + 18% = 118
    const b = computeBill([line(1, 10000, 18, false)], 0, { mode: 'gst' });
    expect(b.lines[0]).toMatchObject({ taxable: 10000, cgst: 900, sgst: 900, tax: 1800 });
    expect(b).toMatchObject({ subtotal: 10000, taxAdded: 1800, totalAmount: 11800, taxTotal: 1800 });
  });

  it('other state: the whole tax is IGST', () => {
    const b = computeBill([line(1, 10000, 18, false)], 0, { mode: 'gst', interState: true });
    expect(b).toMatchObject({ cgst: 0, sgst: 0, igst: 1800, totalAmount: 11800 });
  });

  it('odd tax paise: CGST and SGST still add up to the tax', () => {
    const b = computeBill([line(1, 10001, 5)], 0, { mode: 'gst' });
    const l = b.lines[0]!;
    expect(l.cgst + l.sgst).toBe(l.tax);
    expect(l.taxable + l.tax).toBe(10001);
  });

  it('rounds the bill to the nearest rupee and shows the round-off', () => {
    // 3 x Rs 33.33 exclusive @ 5% = 99.99 + 5.00 = 104.99 -> 105.00 (+0.01)
    const b = computeBill([line(3, 3333, 5, false)], 0, { mode: 'gst' });
    expect(b.subtotal).toBe(9999);
    expect(b.taxTotal).toBe(500);
    expect(b.roundOff).toBe(1);
    expect(b.totalAmount).toBe(10500);
    // 50 paise rounds up, 49 paise rounds down
    expect(computeBill([line(1, 10050, 0)], 0, { mode: 'gst' })).toMatchObject({ totalAmount: 10100, roundOff: 50 });
    expect(computeBill([line(1, 10049, 0)], 0, { mode: 'gst' })).toMatchObject({ totalAmount: 10000, roundOff: -49 });
  });

  it('bill discount is shared by value before tax, and the shares add up exactly', () => {
    const b = computeBill([line(1, 20000, 5), line(1, 10000, 18)], 3000, { mode: 'gst' });
    expect(b.lines.map((l) => l.discount)).toEqual([2000, 1000]);
    // 180 incl 5% -> 171.43 taxable; 90 incl 18% -> 76.27 taxable
    expect(b.lines[0]).toMatchObject({ taxable: 17143, tax: 857 });
    expect(b.lines[1]).toMatchObject({ taxable: 7627, tax: 1373 });
    expect(b.totalAmount).toBe(27000);
  });

  it('tax summary groups lines by rate', () => {
    const b = computeBill([line(1, 10500, 5), line(2, 10500, 5), line(1, 11800, 18)], 0, { mode: 'gst' });
    expect(b.taxSummary).toEqual([
      { rate: 5, taxable: 30000, cgst: 750, sgst: 750, igst: 0 },
      { rate: 18, taxable: 10000, cgst: 900, sgst: 900, igst: 0 },
    ]);
    expect(b.taxTotal).toBe(3300);
  });

  it('allocate keeps every paisa', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
  });
});

describe('amount in words', () => {
  it('English, Indian grouping', () => {
    expect(amountInWordsEn(123450)).toBe('Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only');
    expect(amountInWordsEn(1234567800)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
    expect(amountInWordsEn(0)).toBe('Rupees Zero Only');
  });

  it('Hindi', () => {
    expect(amountInWordsHi(123450)).toBe('एक हज़ार दो सौ चौंतीस रुपये पचास पैसे मात्र');
    expect(amountInWordsHi(9999900)).toBe('निन्यानबे हज़ार नौ सौ निन्यानबे रुपये मात्र');
    expect(amountInWordsHi(10000000)).toBe('एक लाख रुपये मात्र');
  });
});

describe('GST helpers', () => {
  it('GSTIN: format, state and check character', () => {
    const valid = `27AAPFU0939F1Z${gstinCheckChar('27AAPFU0939F1Z')}`;
    expect(isValidGstin(valid)).toBe(true);
    expect(isValidGstin(valid.toLowerCase())).toBe(true);
    expect(isValidGstin(valid.slice(0, 14) + (valid[14] === 'A' ? 'B' : 'A'))).toBe(false);
    expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1')).toBe(false);
  });

  it('financial year runs April to March (IST)', () => {
    expect(financialYear(new Date('2026-03-31T18:30:00Z'))).toBe('2026-27'); // 1 Apr 2026, 00:00 IST
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('2025-26'); // 31 Mar 2026, 23:59 IST
    expect(financialYear(new Date('2026-10-31T06:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2099-12-01T06:00:00Z'))).toBe('2099-00');
  });

  it('invoice number format and default prefix', () => {
    expect(formatInvoiceNo('KGS', '2026-27', 1)).toBe('KGS/2026-27/0001');
    expect(formatInvoiceNo('', '2026-27', 12)).toBe('2026-27/0012');
    expect(defaultInvoicePrefix('Kumar General Store')).toBe('KGS');
    expect(defaultInvoicePrefix('  ')).toBe('INV');
  });
});
