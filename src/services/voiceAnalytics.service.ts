import type { Types } from 'mongoose';
import type { AnalyticsFn, AnalyticsPeriod, AnalyticsRequest } from '../ai/intentSchema';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Sale } from '../models/sale.model';
import { addDays, endOfIstDay, istDayKey, parseIstDay, startOfIstDay } from '../utils/istDate';
import { formatInr } from '../utils/money';
import { profitReport } from './report.service';

/**
 * Voice analytics ("Is mahine sabse zyada kya bika?"): a fixed set of read-only, shop-scoped
 * query functions. The AI (or the offline rules) only chooses one and fills its parameters;
 * parameters are clamped here again, and nothing is ever written.
 */

type Lang = 'hi' | 'en';
const t = (lang: Lang, en: string, hi: string) => (lang === 'hi' ? hi : en);

export interface AnalyticsColumn {
  key: string;
  type: 'text' | 'money' | 'number' | 'date';
}

/** Shape of `answerData` for an analytics answer; column/title labels are translated by the app. */
export interface AnalyticsAnswer {
  kind: 'analytics';
  fn: AnalyticsFn;
  period?: AnalyticsPeriod;
  from?: string;
  to?: string;
  days?: number;
  columns: AnalyticsColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
  /** Small bar chart; values are paise when `money`. */
  chart?: { labels: string[]; data: number[]; money: boolean };
}

export interface AnalyticsOutcome {
  answer: string;
  data: AnalyticsAnswer;
}

export interface DateRange {
  from: Date;
  to: Date;
}

const monthStart = (d: Date) => parseIstDay(`${istDayKey(d).slice(0, 7)}-01`);

/** IST date range of a period, relative to `now`. "this_week" = the last 7 days, like the daily summary. */
export function periodRange(period: AnalyticsPeriod, now = new Date()): DateRange {
  const today = startOfIstDay(now);
  switch (period) {
    case 'today':
      return { from: today, to: endOfIstDay(now) };
    case 'yesterday':
      return { from: addDays(today, -1), to: endOfIstDay(addDays(today, -1)) };
    case 'this_week':
      return { from: addDays(today, -6), to: endOfIstDay(now) };
    case 'last_week':
      return { from: addDays(today, -13), to: endOfIstDay(addDays(today, -7)) };
    case 'this_month':
      return { from: monthStart(now), to: endOfIstDay(now) };
    case 'last_month': {
      const start = monthStart(addDays(monthStart(now), -1));
      return { from: start, to: new Date(monthStart(now).getTime() - 1) };
    }
  }
}

/** The period just before, for comparisons: today vs yesterday, this week vs last week... */
export function previousRange(period: AnalyticsPeriod, now = new Date()): DateRange {
  switch (period) {
    case 'today':
      return periodRange('yesterday', now);
    case 'yesterday':
      return periodRange('yesterday', addDays(now, -1));
    case 'this_week':
      return periodRange('last_week', now);
    case 'last_week':
      return periodRange('last_week', addDays(now, -7));
    case 'this_month': {
      // Same number of days at the start of last month (1st-27th vs 1st-27th).
      const cur = periodRange('this_month', now);
      const start = monthStart(addDays(cur.from, -1));
      const span = cur.to.getTime() - cur.from.getTime();
      return { from: start, to: new Date(Math.min(start.getTime() + span, cur.from.getTime() - 1)) };
    }
    case 'last_month':
      return periodRange('last_month', addDays(monthStart(now), -1));
  }
}

const PERIOD_LABEL: Record<AnalyticsPeriod, { en: string; hi: string }> = {
  today: { en: 'Today', hi: 'आज' },
  yesterday: { en: 'Yesterday', hi: 'कल' },
  this_week: { en: 'In the last 7 days', hi: 'पिछले 7 दिनों में' },
  last_week: { en: 'In the week before', hi: 'उससे पिछले हफ़्ते' },
  this_month: { en: 'This month', hi: 'इस महीने' },
  last_month: { en: 'Last month', hi: 'पिछले महीने' },
};
const PREVIOUS_LABEL: Record<AnalyticsPeriod, { en: string; hi: string }> = {
  today: { en: 'yesterday', hi: 'कल' },
  yesterday: { en: 'the day before', hi: 'परसों' },
  this_week: { en: 'the week before', hi: 'पिछले हफ़्ते' },
  last_week: { en: 'the week before that', hi: 'उससे पहले के हफ़्ते' },
  this_month: { en: 'the same days last month', hi: 'पिछले महीने के इन्हीं दिनों' },
  last_month: { en: 'the month before', hi: 'उससे पिछले महीने' },
};
const periodLabel = (p: AnalyticsPeriod, lang: Lang) => PERIOD_LABEL[p][lang];

const clampInt = (n: number | null | undefined, min: number, max: number, dflt: number) =>
  n === null || n === undefined || !Number.isFinite(n) ? dflt : Math.min(max, Math.max(min, Math.round(n)));
const range = (r: DateRange) => ({ $gte: r.from, $lte: r.to });
const rangeKeys = (r: DateRange) => ({ from: istDayKey(r.from), to: istDayKey(r.to) });
const qty = (n: number) => Math.round(n * 1000) / 1000;

async function productSales(shopId: Types.ObjectId, r: DateRange) {
  return Sale.aggregate<{ _id: Types.ObjectId; name: string; unit: string; qty: number; revenue: number }>([
    { $match: { shopId, date: range(r) } },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', name: { $first: '$items.name' }, unit: { $first: '$items.unit' }, qty: { $sum: '$items.qty' }, revenue: { $sum: '$items.total' } } },
    { $sort: { revenue: -1, name: 1 } },
  ]);
}

async function salesTotal(shopId: Types.ObjectId, r: DateRange) {
  const [s] = await Sale.aggregate<{ total: number; bills: number }>([
    { $match: { shopId, date: range(r) } },
    { $group: { _id: null, total: { $sum: '$totalAmount' }, bills: { $sum: 1 } } },
  ]);
  return { total: s?.total ?? 0, bills: s?.bills ?? 0 };
}

/** "Is mahine sabse zyada kya bika?": best sellers by sales value. */
export async function topProducts(shopId: Types.ObjectId, q: { period?: AnalyticsPeriod | null; limit?: number | null }, lang: Lang, now = new Date()): Promise<AnalyticsOutcome> {
  const period = q.period ?? 'this_month';
  const r = periodRange(period, now);
  const limit = clampInt(q.limit, 1, 10, 5);
  const rows = (await productSales(shopId, r)).slice(0, limit).map((p) => ({ name: p.name, qty: qty(p.qty), unit: p.unit, revenue: p.revenue }));
  const label = periodLabel(period, lang);
  const top = rows[0];
  const answer = top
    ? t(
        lang,
        `${label} the best seller was ${top.name}: ${top.qty} ${top.unit} for ${formatInr(top.revenue)}.${rows.length > 1 ? ` Then ${rows.slice(1, 3).map((x) => x.name).join(', ')}.` : ''}`,
        `${label} सबसे ज़्यादा ${top.name} बिका: ${top.qty} ${top.unit}, ${formatInr(top.revenue)} का।${rows.length > 1 ? ` उसके बाद ${rows.slice(1, 3).map((x) => x.name).join(', ')}।` : ''}`,
      )
    : t(lang, `${label} nothing was sold.`, `${label} कोई बिक्री नहीं हुई।`);
  return {
    answer,
    data: {
      kind: 'analytics',
      fn: 'top_products',
      period,
      ...rangeKeys(r),
      columns: [
        { key: 'name', type: 'text' },
        { key: 'qty', type: 'number' },
        { key: 'unit', type: 'text' },
        { key: 'revenue', type: 'money' },
      ],
      rows,
      chart: rows.length > 1 ? { labels: rows.map((x) => x.name), data: rows.map((x) => x.revenue), money: true } : undefined,
    },
  };
}

/**
 * "Kaun 2 mahine se paisa nahi de raha?": customers with udhaar who have paid nothing for `days`
 * days. Someone whose first udhaar is more recent than that is not counted (they are not late yet).
 */
export async function inactiveDebtors(shopId: Types.ObjectId, q: { days?: number | null; limit?: number | null }, lang: Lang, now = new Date()): Promise<AnalyticsOutcome> {
  const days = clampInt(q.days, 7, 365, 30);
  const limit = clampInt(q.limit, 1, 10, 10);
  const cutoff = addDays(now, -days);
  const customers = await Customer.find({ shopId, isDeleted: false, currentBalance: { $gt: 0 } }).select('name phone currentBalance createdAt').limit(2000);
  const stats = customers.length
    ? await CustomerLedger.aggregate<{ _id: Types.ObjectId; lastPayment: Date | null; firstEntry: Date }>([
        { $match: { shopId, customerId: { $in: customers.map((c) => c._id) } } },
        {
          $group: {
            _id: '$customerId',
            lastPayment: { $max: { $cond: [{ $eq: ['$type', 'payment'] }, '$date', null] } },
            firstEntry: { $min: '$date' },
          },
        },
      ])
    : [];
  const byId = new Map(stats.map((s) => [String(s._id), s]));
  const late = customers
    .map((c) => {
      const s = byId.get(String(c._id));
      const since = s?.firstEntry ?? (c as unknown as { createdAt: Date }).createdAt;
      return { c, lastPayment: s?.lastPayment ?? null, since };
    })
    .filter((x) => x.since <= cutoff && (!x.lastPayment || x.lastPayment < cutoff))
    .sort((a, b) => b.c.currentBalance - a.c.currentBalance);
  const total = late.reduce((s, x) => s + x.c.currentBalance, 0);
  const rows = late.slice(0, limit).map((x) => ({
    id: String(x.c._id),
    name: x.c.name,
    phone: x.c.phone,
    balance: x.c.currentBalance,
    lastPayment: x.lastPayment ? istDayKey(x.lastPayment) : null,
  }));
  const names = rows.slice(0, 3).map((r) => `${r.name} (${formatInr(r.balance)})`).join(', ');
  const answer = late.length
    ? t(
        lang,
        `${late.length} customer${late.length > 1 ? 's have' : ' has'} not paid anything in ${days} days, ${formatInr(total)} pending: ${names}${late.length > 3 ? ' and more' : ''}.`,
        `${late.length} ग्राहकों ने ${days} दिन से कुछ नहीं दिया, कुल ${formatInr(total)} बाकी: ${names}${late.length > 3 ? ' और भी' : ''}।`,
      )
    : t(lang, `Everyone with udhaar has paid something in the last ${days} days.`, `पिछले ${days} दिनों में उधार वाले सभी ग्राहकों ने कुछ न कुछ दिया है।`);
  return {
    answer,
    data: {
      kind: 'analytics',
      fn: 'inactive_debtors',
      days,
      columns: [
        { key: 'name', type: 'text' },
        { key: 'balance', type: 'money' },
        { key: 'lastPayment', type: 'date' },
      ],
      rows,
      totals: { count: late.length, balance: total },
    },
  };
}

/** "Aaj kal se kam bikri kyun hui?": this period vs the one before, and which products changed most. */
export async function compareSales(shopId: Types.ObjectId, q: { period?: AnalyticsPeriod | null; limit?: number | null }, lang: Lang, now = new Date()): Promise<AnalyticsOutcome> {
  const period = q.period ?? 'today';
  const cur = periodRange(period, now);
  const prev = previousRange(period, now);
  const limit = clampInt(q.limit, 1, 10, 5);
  const [a, b, pa, pb] = await Promise.all([salesTotal(shopId, cur), salesTotal(shopId, prev), productSales(shopId, cur), productSales(shopId, prev)]);

  const byProduct = new Map<string, { name: string; current: number; previous: number }>();
  for (const p of pb) byProduct.set(String(p._id), { name: p.name, current: 0, previous: p.revenue });
  for (const p of pa) {
    const row = byProduct.get(String(p._id)) ?? { name: p.name, current: 0, previous: 0 };
    row.current = p.revenue;
    byProduct.set(String(p._id), row);
  }
  const diff = a.total - b.total;
  // The biggest movers in the direction of the change explain it ("doodh ₹500 kam bika").
  const movers = [...byProduct.values()]
    .map((r) => ({ ...r, change: r.current - r.previous }))
    .filter((r) => r.change !== 0)
    .sort((x, y) => (diff < 0 ? x.change - y.change : y.change - x.change));
  const rows = movers.slice(0, limit);
  const label = periodLabel(period, lang);
  const before = PREVIOUS_LABEL[period][lang];
  const reasons = movers
    .filter((r) => (diff < 0 ? r.change < 0 : r.change > 0))
    .slice(0, 3)
    .map((r) => `${r.name} ${formatInr(Math.abs(r.change))}`)
    .join(', ');

  let answer: string;
  if (!a.total && !b.total) answer = t(lang, `No sales ${label.toLowerCase()} or ${before}.`, `${label} और ${before} कोई बिक्री नहीं हुई।`);
  else if (diff === 0) answer = t(lang, `${label} sales were ${formatInr(a.total)}, the same as ${before}.`, `${label} ${formatInr(a.total)} की बिक्री हुई, ${before} जितनी ही।`);
  else {
    const more = diff > 0;
    answer = t(
      lang,
      `${label} sales were ${formatInr(a.total)} from ${a.bills} bills, ${formatInr(Math.abs(diff))} ${more ? 'more' : 'less'} than ${before} (${formatInr(b.total)}, ${b.bills} bills).${reasons ? ` ${more ? 'Selling more' : 'Selling less'}: ${reasons}.` : ''}`,
      `${label} ${a.bills} बिल से ${formatInr(a.total)} की बिक्री हुई, ${before} (${formatInr(b.total)}, ${b.bills} बिल) से ${formatInr(Math.abs(diff))} ${more ? 'ज़्यादा' : 'कम'}।${reasons ? ` सबसे ज़्यादा ${more ? 'बढ़त' : 'कमी'}: ${reasons}।` : ''}`,
    );
  }
  return {
    answer,
    data: {
      kind: 'analytics',
      fn: 'compare_sales',
      period,
      ...rangeKeys(cur),
      columns: [
        { key: 'name', type: 'text' },
        { key: 'current', type: 'money' },
        { key: 'previous', type: 'money' },
        { key: 'change', type: 'money' },
      ],
      rows,
      totals: { current: a.total, previous: b.total, change: diff, currentBills: a.bills, previousBills: b.bills },
      chart: { labels: [before, label], data: [b.total, a.total], money: true },
    },
  };
}

/** "Is hafte kitna munafa hua?": the existing profit estimate (sales after discount minus purchase cost). */
export async function profit(shopId: Types.ObjectId, q: { period?: AnalyticsPeriod | null }, lang: Lang, now = new Date()): Promise<AnalyticsOutcome> {
  const period = q.period ?? 'today';
  const r = periodRange(period, now);
  const report = await profitReport(shopId, rangeKeys(r));
  const { revenue = 0, profit: p = 0, margin = 0 } = report.totals;
  const label = periodLabel(period, lang);
  const answer = revenue
    ? t(
        lang,
        `${label} the estimated profit is ${formatInr(p)} on sales of ${formatInr(revenue)} (${margin}% margin).`,
        `${label} लगभग ${formatInr(p)} का मुनाफ़ा हुआ, ${formatInr(revenue)} की बिक्री पर (${margin}% मार्जिन)।`,
      )
    : t(lang, `${label} there were no sales, so no profit yet.`, `${label} कोई बिक्री नहीं हुई, इसलिए अभी कोई मुनाफ़ा नहीं।`);
  return {
    answer,
    data: {
      kind: 'analytics',
      fn: 'profit',
      period,
      ...rangeKeys(r),
      columns: [
        { key: 'day', type: 'date' },
        { key: 'revenue', type: 'money' },
        { key: 'cost', type: 'money' },
        { key: 'profit', type: 'money' },
      ],
      rows: report.rows,
      totals: { revenue, cost: report.totals.cost ?? 0, profit: p, margin },
      chart: report.rows.length > 1 ? { labels: report.rows.map((x) => String(x.day)), data: report.rows.map((x) => Number(x.profit) || 0), money: true } : undefined,
    },
  };
}

/** "Sabse zyada udhaar kiska hai?" */
export async function topDebtors(shopId: Types.ObjectId, q: { limit?: number | null }, lang: Lang): Promise<AnalyticsOutcome> {
  const limit = clampInt(q.limit, 1, 10, 5);
  const [list, [sum]] = await Promise.all([
    Customer.find({ shopId, isDeleted: false, currentBalance: { $gt: 0 } }).sort({ currentBalance: -1, name: 1 }).limit(limit).select('name phone currentBalance'),
    Customer.aggregate<{ total: number; count: number }>([
      { $match: { shopId, isDeleted: false, currentBalance: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$currentBalance' }, count: { $sum: 1 } } },
    ]),
  ]);
  const rows = list.map((c) => ({ id: String(c._id), name: c.name, phone: c.phone, balance: c.currentBalance }));
  const top = rows[0];
  const answer = top
    ? t(
        lang,
        `${top.name} owes the most: ${formatInr(top.balance)}.${rows.length > 1 ? ` Then ${rows.slice(1, 3).map((r) => `${r.name} (${formatInr(r.balance)})`).join(', ')}.` : ''} Total udhaar ${formatInr(sum?.total ?? 0)}.`,
        `सबसे ज़्यादा उधार ${top.name} का है: ${formatInr(top.balance)}।${rows.length > 1 ? ` उसके बाद ${rows.slice(1, 3).map((r) => `${r.name} (${formatInr(r.balance)})`).join(', ')}।` : ''} कुल उधार ${formatInr(sum?.total ?? 0)}।`,
      )
    : t(lang, 'Nobody has pending udhaar.', 'किसी का कोई उधार बाकी नहीं है।');
  return {
    answer,
    data: {
      kind: 'analytics',
      fn: 'top_debtors',
      columns: [
        { key: 'name', type: 'text' },
        { key: 'balance', type: 'money' },
      ],
      rows,
      totals: { count: sum?.count ?? 0, balance: sum?.total ?? 0 },
      chart: rows.length > 1 ? { labels: rows.map((r) => r.name), data: rows.map((r) => r.balance), money: true } : undefined,
    },
  };
}

/** The only entry point voice uses: dispatches to one of the predefined functions above. */
export function runAnalytics(shopId: Types.ObjectId, req: AnalyticsRequest, lang: Lang, now = new Date()): Promise<AnalyticsOutcome> {
  switch (req.fn) {
    case 'top_products':
      return topProducts(shopId, req, lang, now);
    case 'inactive_debtors':
      return inactiveDebtors(shopId, req, lang, now);
    case 'compare_sales':
      return compareSales(shopId, req, lang, now);
    case 'profit':
      return profit(shopId, req, lang, now);
    case 'top_debtors':
      return topDebtors(shopId, req, lang);
  }
}
