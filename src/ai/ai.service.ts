import type { Types } from 'mongoose';
import { logger } from '../config/logger';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product } from '../models/product.model';
import { Sale } from '../models/sale.model';
import { Supplier } from '../models/supplier.model';
import { User } from '../models/user.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { runOutList } from '../services/prediction.service';
import { stockAlerts, stockStatusOf } from '../services/product.service';
import { creditWarningFor, type CreditWarning } from '../services/creditScore.service';
import { runAnalytics } from '../services/voiceAnalytics.service';
import { lastUndoableVoiceLog } from '../services/voiceUndo.service';
import { addDays, endOfIstDay, istDayKey, parseIstDay, startOfIstDay } from '../utils/istDate';
import { formatInr, lineTotal } from '../utils/money';
import { detectAnalytics } from './analyticsRules';
import { ClaudeProvider } from './claude.provider';
import { applyContext, describeTurn, isResetCommand, loadConversation, rewriteFollowUp, type ConversationTurn } from './conversation';
import { detectReplyLang } from './detectLang';
import { fastParse } from './fastParse';
import { emptyCommand, validateParsedBatch, type Intent, type ParsedCommand } from './intentSchema';
import { EntityMatcher, type EntityMatch, type MatchTarget } from './matcher';
import { AiProviderError, type AiProvider, type ShopContext } from './provider';
import { ruleParseMany, titleCase } from './ruleParser';
import { getSttProvider } from './stt';
import { devanagariToRoman } from './transliterate';

/** Swap the provider here (or inject one in tests). */
let provider: AiProvider = new ClaudeProvider();
export const setAiProvider = (p: AiProvider) => {
  provider = p;
};

export type Lang = 'hi' | 'en';
/** How a command was parsed: the local fast rules, the AI, or the offline parser (no AI / AI failed). */
export type ParsePath = 'rule' | 'ai' | 'offline';

export interface ResolvedItem {
  spokenName: string;
  qty: number;
  unit: string | null;
  rate: number | null;
  total: number | null;
  match: EntityMatch;
}

export interface VoiceParseResult {
  logId: string;
  text: string;
  engine: 'ai' | 'rules';
  engineNote?: string;
  parsePath: ParsePath;
  /** Language the command was spoken in; answers and spoken replies use it. */
  replyLang: Lang;
  intent: Intent;
  confidence: number;
  parsed: ParsedCommand;
  customer?: EntityMatch;
  supplier?: EntityMatch;
  product?: EntityMatch;
  items: ResolvedItem[];
  amount: number | null;
  paidAmount: number | null;
  quantity: number | null;
  paymentMode: ParsedCommand['paymentMode'];
  date: string | null;
  /** "Sara udhaar de diya": amount is the matched party's whole balance. */
  settleFull: boolean;
  /** Customer not in the khata (or only a weak/ambiguous match): suggested name for a new entry. */
  newCustomerName?: string;
  /** Pending balance (paise) of each candidate customer/supplier, so the card can refill the amount when the user picks another. */
  balances?: Record<string, number>;
  /** For query intents: the spoken/displayed answer. Nothing is saved. */
  answer?: string;
  answerData?: unknown;
  needsConfirmation: boolean;
  missing: string[];
  /** 0-1: parser confidence x the weakest name match the command relies on. */
  autoSaveConfidence: number;
  /** Save straight away (shop turned "always ask" off, and the command is clear enough). */
  autoSave: boolean;
  /** New udhaar would cross the customer's credit limit, or the customer is "Risky": warn, never auto-save. */
  creditWarning?: CreditWarning;
  /**
   * Only when one sentence held several entries to save: each resolved on its own (the
   * top-level fields repeat the first). They share `logId` and are saved together.
   */
  actions?: VoiceParseResult[];
}

interface ShopData {
  customers: (MatchTarget & { balance: number })[];
  suppliers: (MatchTarget & { balance: number })[];
  products: (MatchTarget & { unit: string; sellingPrice: number; purchasePrice: number; currentStock: number; lowStockThreshold: number })[];
}

async function loadShopData(shopId: Types.ObjectId): Promise<ShopData> {
  const [customers, suppliers, products] = await Promise.all([
    Customer.find({ shopId, isDeleted: false }).select('name aliases phone currentBalance').limit(2000),
    Supplier.find({ shopId, isDeleted: false }).select('name aliases company currentPayable').limit(500),
    Product.find({ shopId, isDeleted: false }).select('name nameHindi aliases unit sellingPrice purchasePrice currentStock lowStockThreshold').limit(3000),
  ]);
  return {
    customers: customers.map((c) => ({
      id: String(c._id),
      name: c.name,
      aliases: c.aliases,
      subtitle: [c.phone, c.currentBalance > 0 ? `owes ${formatInr(c.currentBalance)}` : ''].filter(Boolean).join(' · '),
      balance: c.currentBalance,
    })),
    suppliers: suppliers.map((s) => ({
      id: String(s._id),
      name: s.name,
      aliases: [...s.aliases, s.company].filter(Boolean),
      subtitle: [s.company, s.currentPayable > 0 ? `due ${formatInr(s.currentPayable)}` : ''].filter(Boolean).join(' · '),
      balance: s.currentPayable,
    })),
    products: products.map((p) => ({
      id: String(p._id),
      name: p.name,
      aliases: [p.nameHindi, ...p.aliases].filter(Boolean),
      subtitle: `${formatInr(p.sellingPrice)}/${p.unit} · stock ${p.currentStock}`,
      unit: p.unit,
      sellingPrice: p.sellingPrice,
      purchasePrice: p.purchasePrice,
      currentStock: p.currentStock,
      lowStockThreshold: p.lowStockThreshold,
    })),
  };
}

function toContext(data: ShopData): ShopContext {
  const withAliases = (t: MatchTarget) => (t.aliases.length ? `${t.name} (${t.aliases.join(', ')})` : t.name);
  return {
    customers: data.customers.map(withAliases),
    suppliers: data.suppliers.map(withAliases),
    products: data.products.map((p) => `${withAliases(p)} [${p.unit}]`),
  };
}

/** Calls the AI provider; validates; retries once on invalid output. */
async function parseWithAi(text: string, context: ShopContext, history: string[]): Promise<ParsedCommand[]> {
  const todayIst = istDayKey(new Date());
  let previousError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await provider.parseCommand({ text, context, todayIst, history, previousError });
      const result = validateParsedBatch(raw);
      if (result.ok) return result.value;
      previousError = result.error;
    } catch (err) {
      if (err instanceof AiProviderError && err.retryable && attempt === 0) {
        previousError = err.message;
        continue;
      }
      throw err;
    }
  }
  throw new AiProviderError(`AI output failed validation twice: ${previousError}`, false);
}

const t = (lang: Lang, en: string, hi: string) => (lang === 'hi' ? hi : en);

export async function parseVoiceCommand(shopId: Types.ObjectId, rawText: string, lang: Lang): Promise<VoiceParseResult> {
  const text = rawText.trim().slice(0, 500);
  const data = await loadShopData(shopId);
  const matchers = {
    customers: new EntityMatcher(data.customers, true),
    suppliers: new EntityMatcher(data.suppliers, true),
    products: new EntityMatcher(data.products),
  };

  // Recent commands, so "unke" / "aur 200 jodo" know who is meant.
  const turns = await loadConversation(shopId);

  let actions: ParsedCommand[];
  let engine: 'ai' | 'rules' = 'rules';
  let engineNote: string | undefined;
  let parsePath: ParsePath = 'offline';
  const fast = provider.isAvailable() ? fastParse(text, matchers) : null;
  if (isResetCommand(text)) {
    // "naya" / "reset": nothing to parse, just start a fresh conversation.
    actions = [{ ...emptyCommand('reset_context'), confidence: 1 }];
    parsePath = 'rule';
  } else if (fast) {
    // "Sharma ji 500 udhaar": simple and certain, no AI call needed.
    actions = [fast];
    parsePath = 'rule';
  } else if (provider.isAvailable()) {
    try {
      actions = await parseWithAi(text, toContext(data), turns.map(describeTurn));
      engine = 'ai';
      parsePath = 'ai';
    } catch (err) {
      logger.warn('AI parse failed, using offline parser', err instanceof Error ? err.message : err);
      engineNote = err instanceof Error ? err.message : 'AI unavailable';
      actions = offlineParse(text, matchers, turns);
    }
  } else {
    engineNote = 'ANTHROPIC_API_KEY not set - using the offline parser';
    actions = offlineParse(text, matchers, turns);
  }
  actions = pickActions(actions.map((a) => applyContext(a, text, turns)));

  // Answer in the language that was spoken; the app's UI language is only the fallback.
  const replyLang = detectReplyLang(text, lang);
  const resolved: VoiceParseResult[] = [];
  for (const a of actions) resolved.push(await resolve(shopId, text, a, data, matchers, replyLang));
  for (const r of resolved) {
    r.replyLang = replyLang;
    r.engine = engine;
    r.engineNote = engineNote;
    r.parsePath = parsePath;
  }
  // A copy, so the first action is not nested inside itself.
  const result: VoiceParseResult = { ...resolved[0]! };
  const parsed = result.parsed;
  if (resolved.length > 1 && resolved.every((r) => r.answer !== undefined && !r.needsConfirmation)) {
    // Several questions ("Sharma ji aur Gupta ji ka kitna udhaar hai"): one combined answer.
    result.answer = resolved.map((r) => r.answer).join(' ');
    result.answerData = undefined;
  } else if (resolved.length > 1) {
    result.actions = resolved;
  }

  // Save without the card only when the shop opted in and the command is unambiguous;
  // with several actions, every one of them has to qualify.
  const settings = (await User.findById(shopId).select('settings'))?.settings;
  const scores = resolved.map((r) => {
    const s = scoreCommand(r);
    r.autoSaveConfidence = s.confidence;
    return s;
  });
  result.autoSaveConfidence = Math.min(...scores.map((s) => s.confidence));
  result.autoSave =
    scores.every((s) => s.eligible) && settings?.voiceAlwaysConfirm === false && result.autoSaveConfidence >= (settings?.voiceAutoSaveThreshold ?? 0.85);

  const isQuery = parsed.intent.startsWith('query_') || parsed.intent === 'undo_last' || parsed.intent === 'reset_context';
  const stored = (r: VoiceParseResult) => ({ ...r.parsed, resolved: { customer: r.customer?.best, supplier: r.supplier?.best, product: r.product?.best } });
  const log = await VoiceCommandLog.create({
    shopId,
    rawText: text,
    intent: parsed.intent,
    parsedJson: result.actions ? { ...stored(result), actions: resolved.map(stored) } : stored(result),
    engine,
    parsePath,
    status: parsed.intent === 'unknown' ? 'failed' : isQuery ? 'confirmed' : 'pending',
    resultMessage: result.answer ?? '',
  });
  result.logId = String(log._id);
  for (const r of resolved) r.logId = result.logId;
  return result;
}

/** Intents that save something (and so can be grouped into one multi-action entry). */
const SAVE_INTENTS = new Set<Intent>(['add_credit', 'receive_payment', 'add_sale', 'adjust_stock', 'add_purchase', 'supplier_payment', 'add_product']);

/**
 * Which parsed actions to act on. Entries to save win (a question mixed in is dropped);
 * "undo" / "reset" stand alone; otherwise every question is answered. Unclear parts are
 * dropped when something else was understood.
 */
function pickActions(list: ParsedCommand[]): ParsedCommand[] {
  const known = list.filter((a) => a.intent !== 'unknown');
  if (!known.length) return [list[0] ?? emptyCommand()];
  const saving = known.filter((a) => SAVE_INTENTS.has(a.intent));
  if (saving.length) return saving;
  const special = known.find((a) => a.intent === 'undo_last' || a.intent === 'reset_context');
  return special ? [special] : known;
}

/** Offline parser with the conversation: a follow-up ("unhone 100 aur diye") is spelled out in full first. */
function offlineParse(
  text: string,
  matchers: { customers: EntityMatcher; suppliers: EntityMatcher; products: EntityMatcher },
  turns: ConversationTurn[],
): ParsedCommand[] {
  // "Sabse zyada udhaar kiska hai?": one of the predefined analytics questions.
  const analytics = detectAnalytics(text);
  if (analytics) return [{ ...emptyCommand('query_analytics'), analytics, confidence: 0.8 }];
  const rewritten = rewriteFollowUp(text, turns, matchers);
  if (rewritten !== text) {
    const parsed = ruleParseMany(rewritten, matchers);
    if (parsed.some((a) => a.intent !== 'unknown')) return parsed;
  }
  return ruleParseMany(text, matchers);
}

async function resolve(
  shopId: Types.ObjectId,
  text: string,
  parsed: ParsedCommand,
  data: ShopData,
  m: { customers: EntityMatcher; suppliers: EntityMatcher; products: EntityMatcher },
  lang: Lang,
): Promise<VoiceParseResult> {
  const productById = new Map(data.products.map((p) => [p.id, p]));
  const forPurchase = parsed.intent === 'add_purchase';

  const items: ResolvedItem[] = parsed.items.map((i) => {
    const match = m.products.match(i.name);
    const product = match.best ? productById.get(match.best.id) : undefined;
    let rate = i.rate;
    if (rate === null && i.total !== null && i.qty > 0) rate = Math.round(i.total / i.qty);
    if (rate === null && product) rate = forPurchase ? product.purchasePrice || product.sellingPrice : product.sellingPrice;
    const total = i.total ?? (rate !== null ? lineTotal(i.qty, rate) : null);
    return { spokenName: i.name, qty: i.qty, unit: i.unit ?? product?.unit ?? null, rate, total, match };
  });
  const itemsTotal = items.every((i) => i.total !== null) && items.length ? items.reduce((s, i) => s + (i.total ?? 0), 0) : null;

  const res: VoiceParseResult = {
    logId: '',
    text,
    engine: 'rules',
    parsePath: 'offline',
    replyLang: lang,
    intent: parsed.intent,
    confidence: parsed.confidence,
    parsed,
    items,
    amount: parsed.amount ?? (['add_credit', 'add_purchase', 'add_sale'].includes(parsed.intent) ? itemsTotal : null),
    paidAmount: parsed.paidAmount,
    quantity: parsed.quantity,
    paymentMode: parsed.paymentMode,
    date: parsed.date,
    settleFull: false,
    needsConfirmation: !parsed.intent.startsWith('query_') && parsed.intent !== 'unknown',
    missing: [],
    autoSaveConfidence: 0,
    autoSave: false,
  };

  if (parsed.customerName) res.customer = m.customers.match(parsed.customerName);
  // Udhaar for someone not in the khata yet ("Anil Gupta ne 500 ka udhaar liya"): offer to add them,
  // with the name in Roman letters like the rest of the list. A confident match is never replaced.
  const givesCredit = parsed.intent === 'add_credit' || (parsed.intent === 'add_sale' && parsed.paymentMode === 'udhaar');
  // Two customers with exactly this name means "pick one of them", not "add a third".
  const strongMatch = (res.customer?.best?.score ?? 0) >= 0.8;
  if (givesCredit && parsed.customerName && !strongMatch) {
    res.newCustomerName = titleCase(devanagariToRoman(parsed.customerName).replace(/\s+/g, ' ').trim());
  }
  if (parsed.supplierName) res.supplier = m.suppliers.match(parsed.supplierName);
  if (parsed.productName) res.product = m.products.match(parsed.productName);

  if (parsed.settleFull && (parsed.intent === 'receive_payment' || parsed.intent === 'supplier_payment')) {
    settleFullBalance(res, parsed.intent === 'receive_payment' ? res.customer : res.supplier, parsed.intent === 'receive_payment' ? data.customers : data.suppliers, lang);
  }

  const need = (cond: boolean, field: string) => {
    if (cond) res.missing.push(field);
  };
  switch (parsed.intent) {
    case 'add_credit':
    case 'receive_payment':
      need(!parsed.customerName, 'customer');
      need(!res.amount && !res.settleFull, 'amount');
      break;
    case 'add_purchase':
      need(!parsed.supplierName, 'supplier');
      need(!items.length, 'items');
      break;
    case 'supplier_payment':
      need(!parsed.supplierName, 'supplier');
      need(!res.amount && !res.settleFull, 'amount');
      break;
    case 'add_sale':
      need(!items.length, 'items');
      need(items.some((i) => i.match.status === 'not_found'), 'products');
      break;
    case 'adjust_stock':
      need(!parsed.productName, 'product');
      need(!parsed.quantity, 'quantity');
      break;
    case 'add_product':
      need(!parsed.productName, 'productName');
      need(!parsed.sellingPrice, 'sellingPrice');
      break;
    case 'query_balance':
    case 'query_stock':
    case 'query_summary':
      await answerQuery(shopId, parsed, res, data, lang);
      break;
    case 'query_analytics': {
      // Read-only: one predefined, shop-scoped query function with clamped parameters.
      const req = parsed.analytics ?? detectAnalytics(text);
      if (!req) {
        res.answer = t(lang, "Sorry, I can't answer that question yet.", 'माफ़ कीजिए, इस सवाल का जवाब अभी नहीं दे सकता।');
        break;
      }
      const out = await runAnalytics(shopId, req, lang);
      res.answer = out.answer;
      res.answerData = out.data;
      break;
    }
    case 'undo_last': {
      // "galti ho gayi": point the app at the entry to reverse; it calls /ai/undo/:logId.
      res.needsConfirmation = false;
      const last = await lastUndoableVoiceLog(shopId);
      res.answerData = { kind: 'undo', logId: last ? String(last._id) : null, text: last?.rawText ?? '' };
      res.answer = last
        ? t(lang, `Undoing: "${last.rawText}"`, `हटा रहे हैं: "${last.rawText}"`)
        : t(lang, 'There is no recent voice entry to undo.', 'हटाने के लिए कोई हाल की आवाज़ वाली एंट्री नहीं है।');
      break;
    }
    case 'reset_context':
      res.needsConfirmation = false;
      res.answer = t(lang, 'Okay, starting fresh. Go ahead.', 'ठीक है, नई शुरुआत। बोलिए।');
      break;
    case 'unknown':
      res.answer = t(
        lang,
        "Sorry, I didn't understand that. Please say it again or type it.",
        'माफ़ कीजिए, समझ नहीं आया। कृपया दोबारा बोलें या टाइप करें।',
      );
      break;
  }
  // Udhaar for a known customer: warn when it crosses their limit or they are "Risky".
  if (givesCredit && res.needsConfirmation && res.customer?.best && res.customer.status !== 'not_found') {
    const warning = await creditWarningFor(shopId, res.customer.best.id, res.amount ?? 0);
    if (warning) res.creditWarning = warning;
  }
  return res;
}

/** Intents that save something, and which of them may be auto-saved without the card. */
const AUTO_SAVE_INTENTS = new Set(['add_credit', 'receive_payment', 'add_sale', 'adjust_stock', 'add_purchase', 'supplier_payment']);

/**
 * How sure we are about the whole command: the parser's confidence times the weakest name
 * match it depends on. Only "clean" commands qualify at all: every name matched to exactly one
 * record, an amount/quantity present, nothing missing and nobody new to create.
 */
export function scoreCommand(res: VoiceParseResult): { confidence: number; eligible: boolean } {
  const scores: number[] = [];
  let clean = AUTO_SAVE_INTENTS.has(res.intent) && res.needsConfirmation && res.missing.length === 0 && !res.newCustomerName && !res.creditWarning;
  const requireMatch = (m: EntityMatch | undefined) => {
    if (!m || m.status !== 'matched' || !m.best) clean = false;
    else scores.push(m.best.score);
  };
  const requireItems = () => {
    if (!res.items.length) clean = false;
    for (const i of res.items) {
      requireMatch(i.match);
      if (i.rate === null || i.qty <= 0) clean = false;
    }
  };
  switch (res.intent) {
    case 'add_credit':
      requireMatch(res.customer);
      if (res.items.length) requireItems();
      if (!res.amount) clean = false;
      break;
    case 'receive_payment':
      requireMatch(res.customer);
      if (!res.amount) clean = false;
      break;
    case 'supplier_payment':
      requireMatch(res.supplier);
      if (!res.amount) clean = false;
      break;
    case 'add_purchase':
      requireMatch(res.supplier);
      requireItems();
      break;
    case 'add_sale':
      requireItems();
      if (res.paymentMode === 'udhaar') requireMatch(res.customer);
      break;
    case 'adjust_stock':
      requireMatch(res.product);
      if (!res.quantity) clean = false;
      break;
    default:
      clean = false;
  }
  const matchScore = scores.length ? Math.min(...scores) : 0;
  const confidence = Math.round(Math.max(0, Math.min(1, res.parsed.confidence * matchScore)) * 100) / 100;
  return { confidence, eligible: clean };
}

/**
 * "Sharma ji ne sara udhaar de diya": the amount is whatever they owe right now.
 * Nothing owed -> answer that instead of asking to save a zero payment.
 */
function settleFullBalance(res: VoiceParseResult, match: EntityMatch | undefined, parties: { id: string; name: string; balance: number }[], lang: Lang) {
  const byId = new Map(parties.map((p) => [p.id, p]));
  res.settleFull = true;
  res.balances = Object.fromEntries((match?.candidates ?? []).map((c) => [c.id, Math.max(0, byId.get(c.id)?.balance ?? 0)]));
  if (match?.status !== 'matched' || !match.best) return;
  const party = byId.get(match.best.id);
  if (!party) return;
  if (party.balance > 0) {
    res.amount = party.balance;
    return;
  }
  const isCustomer = res.intent === 'receive_payment';
  res.needsConfirmation = false;
  res.answerData = isCustomer ? { kind: 'balance', customerId: party.id, name: party.name, balance: 0 } : undefined;
  res.answer = isCustomer
    ? t(lang, `${party.name} has no pending udhaar. Nothing to clear.`, `${party.name} का कोई उधार बाकी नहीं है।`)
    : t(lang, `Nothing is due to ${party.name}.`, `${party.name} का कोई बकाया नहीं है।`);
}

async function answerQuery(shopId: Types.ObjectId, parsed: ParsedCommand, res: VoiceParseResult, data: ShopData, lang: Lang) {
  if (parsed.intent === 'query_balance') {
    const match = res.customer;
    if (!match?.best || match.status === 'not_found') {
      res.answer = t(lang, `No customer found for "${parsed.customerName ?? ''}".`, `"${parsed.customerName ?? ''}" नाम का कोई ग्राहक नहीं मिला।`);
      return;
    }
    if (match.status === 'ambiguous') {
      // Two customers with the same/similar name: answer with every one's balance instead of a dead end.
      const balanceOf = new Map(data.customers.map((c) => [c.id, c.balance]));
      const lines = match.candidates.map((c) => `${c.name}: ${formatInr(Math.max(0, balanceOf.get(c.id) ?? 0))}`).join(', ');
      res.answer = t(
        lang,
        `${match.candidates.length} customers match "${parsed.customerName ?? ''}". ${lines}. Tap one to open their khata.`,
        `"${parsed.customerName ?? ''}" नाम के ${match.candidates.length} ग्राहक मिले। ${lines}। खाता खोलने के लिए एक चुनें।`,
      );
      res.needsConfirmation = false;
      res.answerData = { kind: 'choose', choose: match.candidates };
      return;
    }
    const c = await Customer.findOne({ _id: match.best.id, shopId }).select('name currentBalance lastTransactionAt');
    if (!c) return;
    res.answerData = { kind: 'balance', customerId: String(c._id), name: c.name, balance: c.currentBalance };
    res.answer =
      c.currentBalance > 0
        ? t(lang, `${c.name} owes ${formatInr(c.currentBalance)}.`, `${c.name} का ${formatInr(c.currentBalance)} उधार बाकी है।`)
        : t(lang, `${c.name} has no pending udhaar.`, `${c.name} का कोई उधार बाकी नहीं है।`);
    return;
  }

  if (parsed.intent === 'query_stock') {
    if (parsed.queryType === 'product' && res.product?.best) {
      const p = data.products.find((x) => x.id === res.product!.best!.id)!;
      const status = stockStatusOf(p.currentStock, p.lowStockThreshold);
      res.answerData = { kind: 'stock_item', productId: p.id, name: p.name, stock: p.currentStock, unit: p.unit, status, lowStockThreshold: p.lowStockThreshold };
      res.answer = t(
        lang,
        `${p.name}: ${p.currentStock} ${p.unit} left${status === 'out' ? ' (out of stock)' : status === 'low' ? ' (running low)' : ''}.`,
        `${p.name}: ${p.currentStock} ${p.unit} बचा है${status === 'out' ? ' (खत्म हो गया)' : status === 'low' ? ' (कम है)' : ''}।`,
      );
      return;
    }
    // The panel shows the full list; the spoken answer is just the counts and a few names.
    const onlyOut = parsed.queryType === 'out_of_stock';
    const alerts = await stockAlerts(shopId, 200);
    const items = alerts.items
      .filter((i) => !onlyOut || i.stockStatus === 'out')
      .map((i) => ({ id: i.id, name: i.name, stock: i.currentStock, unit: i.unit, status: i.stockStatus, lowStockThreshold: i.lowStockThreshold }));
    res.answerData = { kind: 'stock_list', onlyOut, outCount: alerts.outCount, lowCount: alerts.lowCount, items };
    const names = items.slice(0, 3).map((i) => String(i.name)).join(', ');
    if (onlyOut) {
      res.answer = alerts.outCount
        ? t(lang, `${alerts.outCount} items are out of stock: ${names}${alerts.outCount > 3 ? ' and more' : ''}.`, `${alerts.outCount} सामान खत्म हो गए हैं: ${names}${alerts.outCount > 3 ? ' और भी' : ''}।`)
        : t(lang, 'Nothing is out of stock.', 'कोई सामान खत्म नहीं हुआ है।');
    } else {
      res.answer = alerts.total
        ? t(lang, `${alerts.outCount} out of stock, ${alerts.lowCount} running low.`, `${alerts.outCount} सामान खत्म, ${alerts.lowCount} कम हैं।`)
        : t(lang, 'All items are well stocked.', 'सभी सामान का स्टॉक ठीक है।');
      // Smart stock: items still in stock that will run out within a week at the current selling rate.
      const soon = await runOutList(shopId, 7);
      if (soon.items.length) {
        res.answerData = {
          ...(res.answerData as Record<string, unknown>),
          soon: soon.items.slice(0, 20).map((i) => ({ id: i.id, name: i.name, stock: i.currentStock, unit: i.unit, daysLeft: i.daysLeft })),
        };
        const top = soon.items.slice(0, 3);
        const more = soon.items.length > 3;
        res.answer +=
          ' ' +
          t(
            lang,
            `${soon.items.length} will run out within a week: ${top.map((i) => `${i.name} (${i.daysLeft ? `~${i.daysLeft} days` : 'today'})`).join(', ')}${more ? ' and more' : ''}.`,
            `${soon.items.length} सामान हफ़्ते भर में खत्म होंगे: ${top.map((i) => `${i.nameHindi || i.name} (${i.daysLeft ? `~${i.daysLeft} दिन` : 'आज ही'})`).join(', ')}${more ? ' और भी' : ''}।`,
          );
      }
    }
    return;
  }

  // query_summary
  const period = parsed.period ?? 'today';
  const today = startOfIstDay();
  const from = period === 'yesterday' ? addDays(today, -1) : period === 'week' ? addDays(today, -6) : period === 'month' ? addDays(today, -29) : today;
  const to = period === 'yesterday' ? endOfIstDay(addDays(today, -1)) : endOfIstDay();
  const range = { $gte: from, $lte: to };
  const [sales, ledger] = await Promise.all([
    Sale.aggregate<{ total: number; count: number }>([
      { $match: { shopId, date: range } },
      { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]),
    CustomerLedger.aggregate<{ _id: string; total: number }>([
      { $match: { shopId, date: range } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]),
  ]);
  const total = sales[0]?.total ?? 0;
  const count = sales[0]?.count ?? 0;
  const given = ledger.find((l) => l._id === 'credit')?.total ?? 0;
  const got = ledger.find((l) => l._id === 'payment')?.total ?? 0;
  const label = {
    today: t(lang, 'Today', 'आज'),
    yesterday: t(lang, 'Yesterday', 'कल'),
    week: t(lang, 'In the last 7 days', 'पिछले 7 दिनों में'),
    month: t(lang, 'In the last 30 days', 'पिछले 30 दिनों में'),
  }[period];
  res.answerData = { kind: 'summary', period, from: istDayKey(from), to: istDayKey(parseIstDay(istDayKey(to))), sales: total, bills: count, udhaarGiven: given, paymentsReceived: got };
  res.answer = t(
    lang,
    `${label}: sales ${formatInr(total)} from ${count} bills. Udhaar given ${formatInr(given)}, received ${formatInr(got)}.`,
    `${label}: ${count} बिल से ${formatInr(total)} की बिक्री। ${formatInr(given)} उधार दिया, ${formatInr(got)} वापस मिला।`,
  );
}

export async function updateVoiceLog(
  shopId: Types.ObjectId,
  id: string,
  patch: { status: 'confirmed' | 'cancelled' | 'failed'; resultMessage?: string; error?: string; parsedJson?: unknown },
) {
  const current = await VoiceCommandLog.findOne({ _id: id, shopId }).select('status');
  if (!current) return null;
  // An undone entry stays undone even if the client reports "saved" a moment later.
  const { status: _status, ...rest } = patch;
  const doc = await VoiceCommandLog.findOneAndUpdate({ _id: id, shopId }, { $set: current.status === 'undone' ? rest : patch }, { new: true });
  return doc?.toJSON() ?? null;
}

export async function listVoiceLogs(shopId: Types.ObjectId, q: { page: number; limit: number; skip: number; status?: string }) {
  const filter: Record<string, unknown> = { shopId };
  if (q.status) filter.status = q.status;
  const [docs, total] = await Promise.all([
    VoiceCommandLog.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit),
    VoiceCommandLog.countDocuments(filter),
  ]);
  return { items: docs.map((d) => d.toJSON()), total };
}

export const aiEngineStatus = () => {
  const stt = getSttProvider();
  return { provider: provider.name, available: provider.isAvailable(), stt: { provider: stt.name, available: stt.isAvailable() } };
};
