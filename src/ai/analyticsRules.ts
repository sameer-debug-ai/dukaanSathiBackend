import { normalizeSpokenNumbers } from './hindiNumbers';
import type { AnalyticsPeriod, AnalyticsRequest } from './intentSchema';
import { devanagariToRoman } from './transliterate';

/**
 * Offline recognition of the analytics questions (used when the AI is not available), so
 * "Sabse zyada udhaar kiska hai?" still gets an answer. Only clear phrasings are recognised;
 * anything else falls through to the normal offline parser.
 */

const any = (t: string, rx: RegExp) => rx.test(t);
const MOST = /(^|\s)(sabse|sab se)\s+(zyada|jyada|jada|zada|adhik|badha|bada)|(^|\s)(most|top|highest|best|maximum)(\s|$)/;
const SOLD = /(^|\s)(bika|biki|bike|bikta|bikti|bikne|bikaa|becha|beche|selling|seller|sold|sell)(\s|$|\?)/;
const UDHAAR = /(^|\s)(udhaar|udhar|udhari|baaki|baki|owes?|due|credit)(\s|$|\?)/;
const PROFIT = /(^|\s)(munafa|munafaa|munaafa|munafe|fayda|faayda|faida|profit|margin)(\s|$|\?)/;
const NOT_PAID = /(paisa|paise|payment|pement|kuch)\s+(nahi|nahin|nhi|na)\s+(de|di|diya|diye|dete|dena|kiya|kar|aaya|aya)|(nahi|nahin|nhi)\s+(de\s+raha|de\s+rahe|de\s+rahi|diya|diye|chukaya)|not\s+paid|(have|has)\s*n[o']t\s+paid|haven't paid|hasn't paid/;
const WHO = /(^|\s)(kaun|kon|koun|kin|kis|kisne|kinhone|who|which|list|batao|bataiye|dikhao)(\s|$|\?)/;
const WHY = /(^|\s)(kyun|kyu|kyon|kyoon|why)(\s|$|\?)/;
const SALES = /(^|\s)(bikri|bikree|sale|sales|dhanda|dhandha|kamai)(\s|$|\?)/;
const COMPARE = /(se|than)\s+(kam|zyada|jyada|kum|less|more)|(kam|zyada|jyada|less|more)\s+(bikri|sale|sales|hui|hua)|compare|mukable|muqable|mukabale/;

function periodOf(t: string): AnalyticsPeriod | null {
  if (/(pichh?le|pichh?la|last|previous)\s+(mahine|mahina|month)/.test(t)) return 'last_month';
  if (/(mahine|mahina|month)/.test(t)) return 'this_month';
  if (/(pichh?le|pichh?la|last|previous)\s+(hafte|hafta|week)/.test(t)) return 'last_week';
  if (/(hafte|hafta|week|saptah)/.test(t)) return 'this_week';
  if (/(^|\s)(aaj|aj|today)(\s|$|\?)/.test(t)) return 'today';
  if (/(^|\s)(kal|yesterday)(\s|$|\?)/.test(t)) return 'yesterday';
  return null;
}

/** "2 mahine se" -> 60, "3 hafte" -> 21, "45 din" -> 45. */
/** Short number words the spoken-number pass leaves alone before "mahine" ("do mahine"). */
const SMALL: Record<string, number> = { ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, dedh: 1.5, dhai: 2.5, one: 1, two: 2, three: 3, six: 6 };

function daysOf(rawT: string): number | null {
  const t = rawT.replace(/(^|\s)(ek|do|teen|tin|char|chaar|paanch|panch|chhe|saat|dedh|dhai|one|two|three|six)(?=\s+(mahine|mahina|month|months|hafte|hafta|week|weeks|din|day|days))/g, (_m, pre: string, w: string) => `${pre}${SMALL[w]}`);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(mahine|mahina|month|months|hafte|hafta|week|weeks|din|day|days)/);
  if (m) {
    const n = Number(m[1]);
    return Math.round(/^m/.test(m[2]!) ? n * 30 : /^(h|w)/.test(m[2]!) ? n * 7 : n);
  }
  if (/(ek|1)?\s*(mahine|mahina|month)/.test(t)) return 30;
  if (/(hafte|hafta|week)/.test(t)) return 7;
  return null;
}

const limitOf = (t: string): number | null => {
  const m = t.match(/(?:top|pehle|first)\s+(\d+)|(\d+)\s+(?:sabse|top|best)/);
  return m ? Number(m[1] ?? m[2]) : null;
};

export function detectAnalytics(rawText: string): AnalyticsRequest | null {
  const t = normalizeSpokenNumbers(devanagariToRoman(rawText)).toLowerCase().replace(/\s+/g, ' ').trim();
  const req = (fn: AnalyticsRequest['fn'], extra: Partial<AnalyticsRequest> = {}): AnalyticsRequest => ({ fn, period: null, days: null, limit: limitOf(t), ...extra });

  if (any(t, PROFIT) && !any(t, UDHAAR)) return req('profit', { period: periodOf(t) });
  if (any(t, NOT_PAID) && any(t, WHO)) return req('inactive_debtors', { days: daysOf(t) });
  if (any(t, WHY) && any(t, SALES)) return req('compare_sales', { period: periodOf(t) === 'yesterday' ? 'today' : periodOf(t) });
  if (any(t, SALES) && any(t, COMPARE)) return req('compare_sales', { period: periodOf(t) === 'yesterday' ? 'today' : periodOf(t) });
  if (any(t, MOST) && any(t, UDHAAR)) return req('top_debtors');
  if (any(t, MOST) && any(t, SOLD)) return req('top_products', { period: periodOf(t) });
  return null;
}
