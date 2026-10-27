import { computeCreditScore, fifo, type ScoreEntry } from '../services/creditScore.service';
import { reminderDue } from '../services/reminder.service';
import { upiLink, shopUpiLink, VPA_RX } from '../utils/upi';

const NOW = new Date('2026-10-27T12:00:00+05:30');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const credit = (amount: number, daysAgo: number): ScoreEntry => ({ type: 'credit', amount, date: ago(daysAgo) });
const pay = (amount: number, daysAgo: number): ScoreEntry => ({ type: 'payment', amount, date: ago(daysAgo) });

describe('fifo (payments settle the oldest udhaar first)', () => {
  it('matches a payment to the oldest credit and weights days by amount', () => {
    const r = fifo([credit(1000, 40), credit(1000, 20), pay(1500, 10)]);
    // 1000 paid after 30 days, 500 after 10 days -> (1000*30 + 500*10) / 1500
    expect(r.avgDaysToPay).toBeCloseTo(23.33, 1);
    expect(r.open).toEqual([{ date: ago(20), remaining: 500 }]);
    expect([r.totalCredit, r.totalPaid]).toEqual([2000, 1500]);
  });

  it('ignores an advance beyond the udhaar and handles entries out of order', () => {
    const r = fifo([pay(3000, 5), credit(1000, 10)]);
    expect(r.open).toEqual([]);
    expect(r.avgDaysToPay).toBe(5);
  });

  it('nothing paid -> no average', () => {
    expect(fifo([credit(1000, 3)]).avgDaysToPay).toBeNull();
  });
});

describe('computeCreditScore', () => {
  it('Good: pays everything back within a week', () => {
    const s = computeCreditScore([credit(50000, 100), pay(50000, 95), credit(30000, 40), pay(30000, 35)], NOW);
    expect(s).toMatchObject({ score: 100, badge: 'good', recoveredPct: 100, avgDaysToPay: 5, oldestDueDays: null });
  });

  it('Risky: little recovered and the udhaar is months old', () => {
    const s = computeCreditScore([credit(100000, 150), credit(50000, 130), pay(10000, 100)], NOW);
    // recovered 10000/150000 = 6.7% (window 180d) -> 2.7 pts; speed 50d -> 16 pts; oldest due 150d -> 0 pts
    expect(s.badge).toBe('risky');
    expect(s.score).toBe(19);
    expect(s.oldestDueDays).toBe(150);
  });

  it('Average: pays, but slowly', () => {
    const s = computeCreditScore([credit(100000, 90), pay(60000, 30), credit(20000, 20)], NOW);
    // recovered 60000/120000 = 50% -> 20; speed 60d -> 12; oldest open = the 90-day credit (40000 left) -> 10
    expect(s).toMatchObject({ badge: 'average', score: 42, recoveredPct: 50, avgDaysToPay: 60, oldestDueDays: 90 });
  });

  it('never paid anything: speed is judged by how long the oldest udhaar waits', () => {
    const s = computeCreditScore([credit(20000, 45), credit(10000, 35)], NOW);
    // recovered 0; speed 45d -> 18; oldest due 45d -> 25
    expect(s).toMatchObject({ score: 43, badge: 'average', avgDaysToPay: null });
  });

  it('uses the last 180 days for "% recovered", lifetime when there was no recent udhaar', () => {
    const old = computeCreditScore([credit(100000, 400), pay(100000, 390), credit(50000, 300), pay(25000, 200)], NOW);
    // no credit in the window -> lifetime 125000/150000 = 83%
    expect(old.recoveredPct).toBe(83);
  });

  it('New: no history, or one recent udhaar', () => {
    expect(computeCreditScore([], NOW)).toMatchObject({ score: null, badge: 'new' });
    expect(computeCreditScore([credit(50000, 5)], NOW)).toMatchObject({ score: null, badge: 'new', oldestDueDays: 5 });
    // One udhaar, but 60 days unpaid: no longer "new".
    expect(computeCreditScore([credit(50000, 60)], NOW).badge).not.toBe('new');
  });

  it('score stays within 0..100', () => {
    for (const entries of [[credit(1, 1000)], [credit(100, 10), pay(1000000, 1)]]) {
      const s = computeCreditScore(entries, NOW);
      if (s.score !== null) expect(s.score >= 0 && s.score <= 100).toBe(true);
    }
  });
});

describe('reminderDue', () => {
  const base = { currentBalance: 50000, reminderEveryDays: 0, dueDate: null, lastReminderAt: null, oldestDueAt: ago(3) };
  it('nothing owed or no schedule -> no reminder', () => {
    expect(reminderDue({ ...base, currentBalance: 0, reminderEveryDays: 7, oldestDueAt: ago(30) }, NOW)).toBeNull();
    expect(reminderDue(base, NOW)).toBeNull();
  });
  it('every N days counts from the oldest unpaid udhaar, then from the last reminder', () => {
    expect(reminderDue({ ...base, reminderEveryDays: 7, oldestDueAt: ago(6) }, NOW)).toBeNull();
    expect(reminderDue({ ...base, reminderEveryDays: 7, oldestDueAt: ago(7) }, NOW)).toBe('every');
    expect(reminderDue({ ...base, reminderEveryDays: 15, oldestDueAt: ago(90), lastReminderAt: ago(10) }, NOW)).toBeNull();
    expect(reminderDue({ ...base, reminderEveryDays: 15, oldestDueAt: ago(90), lastReminderAt: ago(15) }, NOW)).toBe('every');
  });
  it('due date: on or after the day, once', () => {
    expect(reminderDue({ ...base, dueDate: ago(-1) }, NOW)).toBeNull();
    expect(reminderDue({ ...base, dueDate: NOW }, NOW)).toBe('due_date');
    expect(reminderDue({ ...base, dueDate: ago(5), lastReminderAt: ago(2) }, NOW)).toBeNull();
  });
  it('never twice on the same day', () => {
    expect(reminderDue({ ...base, dueDate: ago(5), reminderEveryDays: 7, lastReminderAt: new Date(NOW.getTime() - 3600_000) }, NOW)).toBeNull();
  });
});

describe('UPI links', () => {
  it('builds a plain P2P link: rupees, encoded name, no note', () => {
    expect(upiLink({ vpa: 'sharmastore@okaxis', name: 'Sharma General Store', amount: 123450, note: 'Udhaar Rakesh' })).toBe(
      'upi://pay?pa=sharmastore@okaxis&pn=Sharma%20General%20Store&am=1234.50&cu=INR',
    );
    expect(upiLink({ vpa: 'a@ybl', name: 'A', amount: 0 })).toBe('upi://pay?pa=a@ybl&pn=A&cu=INR');
  });
  it('validates the VPA and falls back to the shop name', () => {
    expect(VPA_RX.test('9876543210@ybl')).toBe(true);
    expect(VPA_RX.test('not a vpa')).toBe(false);
    expect(shopUpiLink({ upiId: 'bad', upiPayeeName: '' }, 'Shop', 100, '')).toBeNull();
    expect(shopUpiLink({ upiId: 'shop@upi', upiPayeeName: '' }, 'My Shop', 5000, '')).toBe('upi://pay?pa=shop@upi&pn=My%20Shop&am=50.00&cu=INR');
  });
});
