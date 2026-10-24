import { normalizeSpokenNumbers } from './hindiNumbers';
import { devanagariToRoman } from './transliterate';
import { emptyCommand, type Intent, type ParsedCommand, type ParsedItem } from './intentSchema';
import { HONORIFIC_SUFFIX, type EntityMatcher } from './matcher';
import { addDays, istDayKey, startOfIstDay } from '../utils/istDate';

/**
 * Offline, rule-based parser used when no AI key is configured or the AI fails.
 * It is deliberately conservative: it relies on the shop's own catalogue and
 * customer list to find names, and leaves anything unclear for the user to edit
 * on the confirmation card.
 */

const UNIT_WORDS: Record<string, ParsedItem['unit']> = {
  kilo: 'kg', kg: 'kg', kilogram: 'kg', kgs: 'kg',
  gram: 'g', gm: 'g', g: 'g', grams: 'g',
  litre: 'litre', liter: 'litre', ltr: 'litre', l: 'litre', litres: 'litre',
  ml: 'ml',
  packet: 'packet', packets: 'packet', pkt: 'packet', packat: 'packet', paket: 'packet',
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', nag: 'piece',
  dozen: 'dozen', darjan: 'dozen', darjun: 'dozen',
  box: 'box', dabba: 'box', dabbe: 'box', carton: 'box',
};

const has = (text: string, ...words: string[]) => words.some((w) => new RegExp(`(^|\\s)${w}(\\s|$|\\?)`, 'i').test(text));

function detectIntent(t: string, hasCustomer: boolean, hasSupplier: boolean, hasProducts: boolean): Intent {
  if (has(t, 'naya product', 'new product', 'product jodo', 'product add')) return 'add_product';
  if (t.includes('?') || has(t, 'kitna', 'kitni', 'kitne', 'how much', 'kya kya', 'khatam', 'baaki', 'baki', 'bacha', 'bachi')) {
    if (has(t, 'bikri', 'sale', 'sales', 'kamai', 'bika', 'biki')) return 'query_summary';
    if (has(t, 'udhaar', 'udhar', 'baaki', 'baki', 'balance', 'dena') && hasCustomer) return 'query_balance';
    if (has(t, 'stock', 'bachi', 'bacha', 'bache', 'khatam', 'kya kya')) return 'query_stock';
    if (hasCustomer) return 'query_balance';
    if (hasProducts) return 'query_stock';
  }
  if (has(t, 'stock') && has(t, 'badhao', 'badha', 'ghatao', 'ghata', 'kam', 'add', 'jodo', 'increase', 'decrease', 'reduce')) return 'adjust_stock';
  if (hasSupplier) {
    if (has(t, 'liya', 'liye', 'li', 'kharida', 'kharide', 'mangaya', 'aaya', 'aya', 'purchase', 'bought')) return 'add_purchase';
    if (has(t, 'diye', 'diya', 'de', 'payment', 'paid', 'chukaya', 'bheje')) return 'supplier_payment';
  }
  if (has(t, 'becha', 'beche', 'bechi', 'bech', 'sold', 'sale', 'bill')) return 'add_sale';
  if (hasCustomer) {
    if (has(t, 'ne') && has(t, 'diye', 'diya', 'de', 'diye', 'lauta', 'lautaye', 'paid', 'jama')) return 'receive_payment';
    if (has(t, 'jama', 'payment', 'mila', 'mile', 'wapas', 'vapas', 'received')) return 'receive_payment';
    if (has(t, 'udhaar', 'udhar', 'saman', 'samaan', 'gaya', 'gaye', 'le gaye', 'liya', 'diya', 'credit', 'khate', 'khata')) return 'add_credit';
    // "Sharma ji ke 500 add kar do / jod do / likh do".
    if (has(t, 'add', 'jod', 'jodo', 'jod do', 'jodna', 'daal', 'dal', 'dalo', 'likh', 'likho', 'likh do', 'chadha', 'chadhao')) return 'add_credit';
  }
  if (has(t, 'udhaar', 'udhar')) return 'add_credit';
  return 'unknown';
}

function detectDate(t: string): string | null {
  const today = startOfIstDay();
  if (has(t, 'parso', 'parson')) return istDayKey(addDays(today, -2));
  if (has(t, 'kal', 'yesterday')) return istDayKey(addDays(today, -1));
  if (has(t, 'aaj', 'today', 'abhi')) return istDayKey(today);
  return null;
}

/** Money: "500 rupay", "₹ 500", "rs 500", "500 ka", "1000 jama". */
function moneyMentions(t: string): number[] {
  const out: number[] = [];
  const rx =
    /(?:₹|\brs\.?|\brupees?)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:rupay|rupaye|rupaiye|rupees?|rs\.?|₹|ka|ki|ke|jama|wale|de|diye|diya|paid)(?=[\s,.?!]|$)/gi;
  for (const m of t.matchAll(rx)) out.push(Math.round(Number(m[1] ?? m[2]) * 100));
  return out;
}

interface ProductMention {
  name: string;
  index: number;
}

/** Items: product names found in the catalogue, with the quantity/unit spoken just before them. */
function extractItems(t: string, products: ProductMention[]): ParsedItem[] {
  return products.map((p, i) => {
    const segmentEnd = products[i + 1]?.index ?? t.length;
    const before = t.slice(Math.max(0, p.index - 24), p.index).trim().split(/\s+/);
    let qty = 1;
    let unit: ParsedItem['unit'] = null;
    const last = before[before.length - 1]?.toLowerCase();
    const prev = before[before.length - 2];
    if (last && UNIT_WORDS[last] !== undefined) {
      unit = UNIT_WORDS[last] ?? null;
      if (prev && /^\d+(\.\d+)?$/.test(prev)) qty = Number(prev);
    } else if (last && /^\d+(\.\d+)?$/.test(last)) {
      qty = Number(last);
    }
    const after = t.slice(p.index, segmentEnd).match(/^\S+(?:\s\S+)*?\s+(\d+(?:\.\d+)?)\s*(?:rupay|rupaye|rs|ka|ki|ke)\b/i);
    return { name: p.name, qty, unit, rate: null, total: after ? Math.round(Number(after[1]) * 100) : null };
  });
}

/** Spoken name when no known customer matched: the words before "ke/ko/ne/ka". */
function guessName(t: string): string | null {
  const m = t.match(/^(?:aaj|kal|parso|abhi)?\s*([a-zऀ-ॿ][a-zऀ-ॿ.\s]{1,40}?)\s+(?:ke|ko|ne|ka|ki|se)\s/i);
  if (!m) return null;
  const name = m[1]!.trim();
  return /^(\d|stock|naya|aaj|kitna|kitni)/i.test(name) ? null : titleCase(name);
}

/** "sharma ji" -> "Sharma ji": capitalise names, keep honorifics lowercase. */
const titleCase = (s: string) =>
  s.replace(/\S+/g, (w) => (/^(ji|jee|bhaiya|bhai|aunty|uncle|seth|sahab|saab|didi|bhabhi)$/i.test(w) ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1)));

export interface RuleParserContext {
  customers: EntityMatcher;
  suppliers: EntityMatcher;
  products: EntityMatcher;
}

export function ruleParse(rawText: string, ctx: RuleParserContext): ParsedCommand {
  const text = normalizeSpokenNumbers(devanagariToRoman(rawText)).replace(/\s+/g, ' ').trim();
  const t = text.toLowerCase();
  const cmd = emptyCommand();

  const customerHits = ctx.customers.findMentions(text);
  const supplierHits = ctx.suppliers.findMentions(text);
  const productHits = ctx.products.findMentions(text);
  const productMentions = productHits
    .map((h) => ({ name: h.target.name, index: Math.max(0, t.indexOf(h.key)) }))
    .sort((a, b) => a.index - b.index);

  cmd.intent = detectIntent(t, customerHits.length > 0 || guessName(t) !== null, supplierHits.length > 0, productHits.length > 0);
  cmd.date = detectDate(t);
  // Keep the words as spoken (plus any honorific that follows) so the matcher can tell
  // "Sharma ji" (an exact alias) from a bare "Sharma" shared by two customers.
  const spoken = (key: string) => {
    const i = t.indexOf(key);
    if (i === -1) return key;
    const suffix = t.slice(i + key.length).match(HONORIFIC_SUFFIX);
    return titleCase(key + (suffix ? ` ${suffix[1]}` : ''));
  };
  cmd.customerName = customerHits[0] ? spoken(customerHits[0].key) : null;
  cmd.supplierName = supplierHits[0] ? spoken(supplierHits[0].key) : null;

  const money = moneyMentions(t);
  const items = extractItems(t, productMentions);

  switch (cmd.intent) {
    case 'add_credit':
    case 'receive_payment':
      cmd.customerName ??= guessName(t);
      cmd.amount = money[0] ?? null;
      if (cmd.intent === 'add_credit') cmd.items = items;
      // "500 add kar do": no money word, so take the first number spoken.
      if (cmd.amount === null && !(cmd.intent === 'add_credit' && items.length)) {
        const n = t.match(/(\d+(?:\.\d+)?)/);
        if (n) cmd.amount = Math.round(Number(n[1]) * 100);
      }
      break;
    case 'add_purchase':
      cmd.items = items;
      cmd.amount = money[0] ?? null;
      cmd.paidAmount = money[1] ?? null;
      if (items.length === 1 && items[0]!.total === null && cmd.amount !== null) items[0]!.total = cmd.amount;
      break;
    case 'supplier_payment': {
      cmd.amount = money[0] ?? null;
      if (cmd.amount === null) {
        const n = t.match(/(\d+(?:\.\d+)?)/);
        if (n) cmd.amount = Math.round(Number(n[1]) * 100);
      }
      break;
    }
    case 'add_sale':
      cmd.items = items;
      cmd.paymentMode = has(t, 'upi', 'gpay', 'phonepe', 'paytm', 'online') ? 'upi' : has(t, 'udhaar', 'udhar') ? 'udhaar' : 'cash';
      break;
    case 'adjust_stock': {
      cmd.productName = productHits[0]?.target.name ?? null;
      // "chawal ka stock 25 kilo badhao": the quantity usually follows the product name.
      const q = t.match(/(\d+(?:\.\d+)?)\s*([a-z]+)?/);
      const n = q ? Number(q[1]) : 0;
      const negative = has(t, 'ghatao', 'ghata', 'kam', 'decrease', 'reduce', 'nikalo', 'hatao');
      cmd.quantity = n ? (negative ? -n : n) : null;
      cmd.unit = (q?.[2] && UNIT_WORDS[q[2]]) || items[0]?.unit || null;
      break;
    }
    case 'add_product': {
      const m = text.match(/(?:product|jodo|add)\s*,?\s*(.+?)(?:,|\s)\s*(\d+(?:\.\d+)?)\s*(?:rupay|rupaye|rs|₹)/i);
      cmd.productName = m?.[1]?.replace(/^(jodo|add)\s+/i, '').trim() ?? null;
      cmd.sellingPrice = money[money.length - 1] ?? null;
      break;
    }
    case 'query_balance':
      cmd.customerName ??= guessName(t);
      break;
    case 'query_stock':
      cmd.queryType = productHits.length ? 'product' : 'low_stock';
      cmd.productName = productHits[0]?.target.name ?? null;
      break;
    case 'query_summary':
      cmd.period = has(t, 'hafte', 'week', 'saptah') ? 'week' : has(t, 'mahine', 'month') ? 'month' : has(t, 'kal', 'yesterday') ? 'yesterday' : 'today';
      break;
    default:
      break;
  }

  // Rough confidence: intent found + the key values present.
  let confidence = cmd.intent === 'unknown' ? 0.1 : 0.55;
  if ((cmd.customerName || cmd.supplierName || cmd.productName || cmd.items.length) && cmd.intent !== 'unknown') confidence += 0.15;
  if (cmd.amount !== null || cmd.quantity !== null || cmd.items.length) confidence += 0.1;
  cmd.confidence = Math.min(0.85, confidence);
  return cmd;
}
