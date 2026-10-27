import { hasBackReference } from './conversation';
import { normalizeSpokenNumbers } from './hindiNumbers';
import type { Intent, ParsedCommand } from './intentSchema';
import { ruleParse, type RuleParserContext } from './ruleParser';
import { devanagariToRoman } from './transliterate';

/**
 * Fast path in front of the AI: the handful of everyday sentences ("Sharma ji 500 udhaar",
 * "Gupta ji ne 200 diye", "Ramesh traders ko 2000 diye") are parsed locally, saving an AI call.
 * It only answers when the WHOLE sentence fits one pattern, the name is exactly one known
 * customer/supplier and one amount was said; anything else returns null and goes to the AI.
 */

/** Rule results that pass every check below are trusted about as much as a clean AI parse. */
export const FAST_CONFIDENCE = 0.95;

const DAY = '(?:(?:aaj|abhi|kal|parso|parson)\\s+)?';
const AMOUNT = '(?:₹\\s*|rs\\.?\\s*)?(\\d+(?:\\.\\d+)?)(?:\\s*(?:rupay|rupaye|rupaiye|rupees?|rs\\.?|₹))?';
const NAME = '([a-z][a-z.\\s]{1,40}?)';

const PATTERNS: { intent: Intent; party: 'customer' | 'supplier'; rx: RegExp }[] = [
  // "Sharma ji 500 udhaar", "Sharma ji ke 500 udhaar likho", "Sharma ji ka 500 likh do"
  {
    intent: 'add_credit',
    party: 'customer',
    rx: new RegExp(
      `^${DAY}${NAME}\\s+(?:(?:ke|ka|ki|ko)\\s+)?${AMOUNT}(?:\\s+(?:ka|ki|ke))?\\s+(?:(?:udhaar|udhar)(?:\\s+(?:likho|likh do|likh lo|likhna|daalo|daal do|dal do|jodo|jod do|karo|kar do|kardo|diya|de diya|gaya|liya|le gaye))?|likho|likh do|likh lo|jodo|jod do)$`,
    ),
  },
  // "Sharma ji ke 500 ka saman gaya"
  {
    intent: 'add_credit',
    party: 'customer',
    rx: new RegExp(`^${DAY}${NAME}\\s+(?:ke|ka|ko)\\s+${AMOUNT}\\s+(?:ka|ki|ke)\\s+(?:saman|samaan|maal)\\s+(?:gaya|gaye|le gaye|le gaya|liya|liye|diya)$`),
  },
  // "Gupta ji ne 200 diye / de diye / jama kiye"
  {
    intent: 'receive_payment',
    party: 'customer',
    rx: new RegExp(`^${DAY}${NAME}\\s+ne\\s+${AMOUNT}\\s+(?:diye|diya|de diye|de diya|de die|jama|jama kiye|jama kiya|jama kar diye|jama kar diya|lautaye|lauta diye|wapas diye|vapas diye)$`),
  },
  // "Ramesh traders ko 2000 diye"
  {
    intent: 'supplier_payment',
    party: 'supplier',
    rx: new RegExp(`^${DAY}${NAME}\\s+ko\\s+${AMOUNT}\\s+(?:diye|diya|de diye|de diya|bheje|bhej diye|chukaye|payment kiya|payment kar diya)$`),
  },
];

/** Same normalisation as the offline parser: Roman script, digits, single spaces. */
export const fastNormalize = (text: string) =>
  normalizeSpokenNumbers(devanagariToRoman(text))
    .toLowerCase()
    .replace(/[।!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Returns the parsed command when a simple sentence is certain, otherwise null (ask the AI). */
export function fastParse(rawText: string, ctx: RuleParserContext): ParsedCommand | null {
  const t = fastNormalize(rawText);
  if (!t || t.includes('?') || t.includes(',') || hasBackReference(rawText)) return null;
  // Exactly one number: a second one means items, a quantity or a split payment.
  if ((t.match(/\d+(?:\.\d+)?/g) ?? []).length !== 1) return null;

  for (const p of PATTERNS) {
    const m = t.match(p.rx);
    if (!m) continue;
    const name = m[1]!.trim();
    const amount = Math.round(Number(m[2]) * 100);
    if (!amount || /(^|\s)(aur|and|phir|fir)(\s|$)/.test(name)) return null;

    // The name must be one known record, and not also a name of the other kind.
    const own = (p.party === 'customer' ? ctx.customers : ctx.suppliers).match(name);
    const other = (p.party === 'customer' ? ctx.suppliers : ctx.customers).match(name);
    if (own.status !== 'matched' || !own.best || own.best.score < 0.85) return null;
    if (other.best && other.best.score >= 0.8) return null;

    // The offline parser fills the rest (date, spoken name); it must agree with the pattern.
    const cmd = ruleParse(rawText, ctx);
    const parsedName = p.party === 'customer' ? cmd.customerName : cmd.supplierName;
    if (cmd.intent !== p.intent || cmd.amount !== amount || cmd.items.length || cmd.settleFull || !parsedName) return null;
    const check = (p.party === 'customer' ? ctx.customers : ctx.suppliers).match(parsedName);
    if (check.best?.id !== own.best.id) return null;
    return { ...cmd, confidence: FAST_CONFIDENCE };
  }
  return null;
}
