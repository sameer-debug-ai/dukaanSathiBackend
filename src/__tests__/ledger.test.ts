import { computeRunningBalance, ledgerDelta, sumLedger } from '../services/ledger.service';
import { splitPayment } from '../services/sale.service';
import { formatInr, lineTotal } from '../utils/money';

describe('ledger balance', () => {
  const entries = [
    { type: 'credit' as const, amount: 50000, date: '2026-10-01' },
    { type: 'credit' as const, amount: 25000, date: '2026-10-03' },
    { type: 'payment' as const, amount: 30000, date: '2026-10-05' },
    { type: 'payment' as const, amount: 45000, date: '2026-10-09' },
  ];

  it('credit increases and payment decreases what the customer owes', () => {
    expect(ledgerDelta({ type: 'credit', amount: 100 })).toBe(100);
    expect(ledgerDelta({ type: 'payment', amount: 100 })).toBe(-100);
  });

  it('computes the running balance row by row', () => {
    const rows = computeRunningBalance(entries);
    expect(rows.map((r) => r.balance)).toEqual([50000, 75000, 45000, 0]);
    expect(rows[0]).toMatchObject({ credit: 50000, payment: 0 });
    expect(rows[2]).toMatchObject({ credit: 0, payment: 30000 });
  });

  it('carries an opening balance for date-filtered statements', () => {
    const rows = computeRunningBalance(entries.slice(2), 75000);
    expect(rows.map((r) => r.balance)).toEqual([45000, 0]);
  });

  it('supports an advance (negative balance)', () => {
    expect(sumLedger([{ type: 'payment', amount: 10000 }])).toBe(-10000);
  });

  it('sum matches the last running balance', () => {
    const rows = computeRunningBalance(entries);
    expect(sumLedger(entries)).toBe(rows[rows.length - 1]!.balance);
  });
});

describe('sale payment split', () => {
  it('cash and upi are fully paid', () => {
    expect(splitPayment('cash', 12000)).toEqual({ paid: 12000, credit: 0 });
    expect(splitPayment('upi', 12000)).toEqual({ paid: 12000, credit: 0 });
  });
  it('udhaar is fully on credit', () => {
    expect(splitPayment('udhaar', 12000)).toEqual({ paid: 0, credit: 12000 });
  });
  it('partial splits the bill', () => {
    expect(splitPayment('partial', 12000, 5000)).toEqual({ paid: 5000, credit: 7000 });
  });
  it('partial rejects 0 or full payment', () => {
    expect(() => splitPayment('partial', 12000, 0)).toThrow();
    expect(() => splitPayment('partial', 12000, 12000)).toThrow();
  });
});

describe('money helpers', () => {
  it('line totals handle fractional quantities', () => {
    expect(lineTotal(0.5, 4500)).toBe(2250);
    expect(lineTotal(3, 1400)).toBe(4200);
  });
  it('formats with Indian grouping', () => {
    expect(formatInr(12500000)).toBe('₹1,25,000');
    expect(formatInr(5050)).toBe('₹50.50');
  });
});
