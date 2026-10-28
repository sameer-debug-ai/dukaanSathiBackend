import { fefoCompare, planFefo, type BatchLike } from '../services/batch.service';
import { daysLeftFor, reorderQtyFor, roundOrderQty, weightedDailyRate } from '../services/prediction.service';

describe('weightedDailyRate', () => {
  it('equals the plain average when sales are steady', () => {
    expect(weightedDailyRate(Array(30).fill(4), 30)).toBe(4);
  });

  it('weights recent days more than old ones', () => {
    const recent = Array(30).fill(0).map((_, i) => (i < 5 ? 10 : 0));
    const old = Array(30).fill(0).map((_, i) => (i >= 25 ? 10 : 0));
    // Same 50 units sold, but recently sold stock moves faster.
    expect(weightedDailyRate(recent, 30)).toBeGreaterThan(50 / 30);
    expect(weightedDailyRate(old, 30)).toBeLessThan(50 / 30);
  });

  it('counts days without sales as 0 and ignores days older than the window', () => {
    expect(weightedDailyRate([], 30)).toBe(0);
    const longer = Array(40).fill(1);
    expect(weightedDailyRate(longer, 40)).toBe(1);
  });

  it('a product added 2 days ago averages over at least 7 days', () => {
    // 14 sold in 2 days must not read as 7 per day.
    const r = weightedDailyRate([7, 7], 2);
    expect(r).toBeLessThan(7);
    expect(r).toBeGreaterThan(14 / 7);
  });

  it('ignores negative days (more undone than sold)', () => {
    expect(weightedDailyRate([-5, ...Array(29).fill(0)], 30)).toBe(0);
  });
});

describe('daysLeftFor', () => {
  it('floors stock / rate', () => {
    expect(daysLeftFor(10, 4)).toBe(2);
    expect(daysLeftFor(12, 4)).toBe(3);
  });
  it('is null when nothing sells and 0 when out of stock', () => {
    expect(daysLeftFor(10, 0)).toBeNull();
    expect(daysLeftFor(0, 2)).toBe(0);
    expect(daysLeftFor(-3, 2)).toBe(0);
  });
});

describe('reorder quantity', () => {
  it('rounds to what a supplier sells', () => {
    expect(roundOrderQty(3.2, 'packet')).toBe(4);
    expect(roundOrderQty(3.2, 'kg')).toBe(3.5);
    expect(roundOrderQty(120, 'g')).toBe(150);
    expect(roundOrderQty(0, 'kg')).toBe(0);
  });

  it('orders N days of sales minus the stock on hand', () => {
    expect(reorderQtyFor({ dailyRate: 2, currentStock: 10, lowStockThreshold: 5, unit: 'kg' }, 15)).toBe(20);
    expect(reorderQtyFor({ dailyRate: 2, currentStock: 40, lowStockThreshold: 5, unit: 'kg' }, 15)).toBe(0);
    // Oversold (negative) stock counts as zero.
    expect(reorderQtyFor({ dailyRate: 1, currentStock: -2, lowStockThreshold: 5, unit: 'piece' }, 15)).toBe(15);
  });

  it('refills items that stopped selling because they ran out', () => {
    expect(reorderQtyFor({ dailyRate: 0, currentStock: 0, lowStockThreshold: 5, unit: 'packet' }, 15)).toBe(10);
    expect(reorderQtyFor({ dailyRate: 0, currentStock: 8, lowStockThreshold: 5, unit: 'packet' }, 15)).toBe(0);
  });
});

describe('FEFO batch planning', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const batches: BatchLike[] = [
    { id: 'late', qty: 10, expiryDate: d('2026-12-31'), createdAt: d('2026-10-01') },
    { id: 'none', qty: 5, expiryDate: null, createdAt: d('2026-09-01') },
    { id: 'early', qty: 4, expiryDate: d('2026-11-05'), createdAt: d('2026-10-10') },
    { id: 'empty', qty: 0, expiryDate: d('2026-10-01'), createdAt: d('2026-09-01') },
  ];

  it('orders by earliest expiry, no-expiry last', () => {
    expect([...batches].sort(fefoCompare).map((b) => b.id)).toEqual(['empty', 'early', 'late', 'none']);
  });

  it('takes from the earliest-expiry batch first and spills over', () => {
    expect(planFefo(batches, 3)).toEqual({ take: [{ id: 'early', qty: 3 }], short: 0 });
    expect(planFefo(batches, 7)).toEqual({ take: [{ id: 'early', qty: 4 }, { id: 'late', qty: 3 }], short: 0 });
  });

  it('uses no-expiry stock only after dated batches, and reports what it could not cover', () => {
    expect(planFefo(batches, 22)).toEqual({ take: [{ id: 'early', qty: 4 }, { id: 'late', qty: 10 }, { id: 'none', qty: 5 }], short: 3 });
  });

  it('same expiry: older batch first', () => {
    const same: BatchLike[] = [
      { id: 'new', qty: 5, expiryDate: d('2026-11-01'), createdAt: d('2026-10-20') },
      { id: 'old', qty: 5, expiryDate: d('2026-11-01'), createdAt: d('2026-10-01') },
    ];
    expect(planFefo(same, 6).take).toEqual([{ id: 'old', qty: 5 }, { id: 'new', qty: 1 }]);
  });

  it('a preferred batch (write-off of an expired lot) goes first', () => {
    expect(planFefo(batches, 6, (b) => b.id === 'late').take).toEqual([{ id: 'late', qty: 6 }]);
  });

  it('handles fractional quantities without float dust', () => {
    const kg: BatchLike[] = [{ id: 'a', qty: 0.3, expiryDate: d('2026-11-01') }, { id: 'b', qty: 1, expiryDate: d('2026-12-01') }];
    expect(planFefo(kg, 0.5)).toEqual({ take: [{ id: 'a', qty: 0.3 }, { id: 'b', qty: 0.2 }], short: 0 });
  });
});
