import type { Types } from 'mongoose';
import { logger } from '../config/logger';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product } from '../models/product.model';
import { Sale } from '../models/sale.model';
import { Supplier } from '../models/supplier.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { stockAlerts, stockStatusOf } from '../services/product.service';
import { addDays, endOfIstDay, istDayKey, parseIstDay, startOfIstDay } from '../utils/istDate';
import { formatInr, lineTotal } from '../utils/money';
import { ClaudeProvider } from './claude.provider';
import { validateParsedCommand, type Intent, type ParsedCommand } from './intentSchema';
import { EntityMatcher, type EntityMatch, type MatchTarget } from './matcher';
import { AiProviderError, type AiProvider, type ShopContext } from './provider';
import { ruleParse } from './ruleParser';

/** Swap the provider here (or inject one in tests). */
let provider: AiProvider = new ClaudeProvider();
export const setAiProvider = (p: AiProvider) => {
  provider = p;
};

export type Lang = 'hi' | 'en';

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
  /** For query intents: the spoken/displayed answer. Nothing is saved. */
  answer?: string;
  answerData?: unknown;
  needsConfirmation: boolean;
  missing: string[];
}

interface ShopData {
  customers: MatchTarget[];
  suppliers: MatchTarget[];
  products: (MatchTarget & { unit: string; sellingPrice: number; purchasePrice: number; currentStock: number; lowStockThreshold: number })[];
}

async function loadShopData(shopId: Types.ObjectId): Promise<ShopData> {
  const [customers, suppliers, products] = await Promise.all([
    Customer.find({ shopId, isDeleted: false }).select('name aliases phone currentBalance').limit(2000),
    Supplier.find({ shopId, isDeleted: false }).select('name aliases company').limit(500),
    Product.find({ shopId, isDeleted: false }).select('name nameHindi aliases unit sellingPrice purchasePrice currentStock lowStockThreshold').limit(3000),
  ]);
  return {
    customers: customers.map((c) => ({
      id: String(c._id),
      name: c.name,
      aliases: c.aliases,
      subtitle: [c.phone, c.currentBalance > 0 ? `owes ${formatInr(c.currentBalance)}` : ''].filter(Boolean).join(' · '),
    })),
    suppliers: suppliers.map((s) => ({ id: String(s._id), name: s.name, aliases: [...s.aliases, s.company].filter(Boolean), subtitle: s.company })),
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
async function parseWithAi(text: string, context: ShopContext): Promise<ParsedCommand> {
  const todayIst = istDayKey(new Date());
  let previousError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await provider.parseCommand({ text, context, todayIst, previousError });
      const result = validateParsedCommand(raw);
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
    customers: new EntityMatcher(data.customers),
    suppliers: new EntityMatcher(data.suppliers),
    products: new EntityMatcher(data.products),
  };

  let parsed: ParsedCommand;
  let engine: 'ai' | 'rules' = 'rules';
  let engineNote: string | undefined;
  if (provider.isAvailable()) {
    try {
      parsed = await parseWithAi(text, toContext(data));
      engine = 'ai';
    } catch (err) {
      logger.warn('AI parse failed, using offline parser', err instanceof Error ? err.message : err);
      engineNote = err instanceof Error ? err.message : 'AI unavailable';
      parsed = ruleParse(text, matchers);
    }
  } else {
    engineNote = 'ANTHROPIC_API_KEY not set - using the offline parser';
    parsed = ruleParse(text, matchers);
  }

  const result = await resolve(shopId, text, parsed, data, matchers, lang);
  result.engine = engine;
  result.engineNote = engineNote;

  const isQuery = parsed.intent.startsWith('query_');
  const log = await VoiceCommandLog.create({
    shopId,
    rawText: text,
    intent: parsed.intent,
    parsedJson: { ...parsed, resolved: { customer: result.customer?.best, supplier: result.supplier?.best, product: result.product?.best } },
    engine,
    status: parsed.intent === 'unknown' ? 'failed' : isQuery ? 'confirmed' : 'pending',
    resultMessage: result.answer ?? '',
  });
  result.logId = String(log._id);
  return result;
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
    intent: parsed.intent,
    confidence: parsed.confidence,
    parsed,
    items,
    amount: parsed.amount ?? (['add_credit', 'add_purchase', 'add_sale'].includes(parsed.intent) ? itemsTotal : null),
    paidAmount: parsed.paidAmount,
    quantity: parsed.quantity,
    paymentMode: parsed.paymentMode,
    date: parsed.date,
    needsConfirmation: !parsed.intent.startsWith('query_') && parsed.intent !== 'unknown',
    missing: [],
  };

  if (parsed.customerName) res.customer = m.customers.match(parsed.customerName);
  if (parsed.supplierName) res.supplier = m.suppliers.match(parsed.supplierName);
  if (parsed.productName) res.product = m.products.match(parsed.productName);

  const need = (cond: boolean, field: string) => {
    if (cond) res.missing.push(field);
  };
  switch (parsed.intent) {
    case 'add_credit':
    case 'receive_payment':
      need(!parsed.customerName, 'customer');
      need(!res.amount, 'amount');
      break;
    case 'add_purchase':
      need(!parsed.supplierName, 'supplier');
      need(!items.length, 'items');
      break;
    case 'supplier_payment':
      need(!parsed.supplierName, 'supplier');
      need(!res.amount, 'amount');
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
    case 'unknown':
      res.answer = t(
        lang,
        "Sorry, I didn't understand that. Please say it again or type it.",
        'माफ़ कीजिए, समझ नहीं आया। कृपया दोबारा बोलें या टाइप करें।',
      );
      break;
  }
  return res;
}

async function answerQuery(shopId: Types.ObjectId, parsed: ParsedCommand, res: VoiceParseResult, data: ShopData, lang: Lang) {
  if (parsed.intent === 'query_balance') {
    const match = res.customer;
    if (!match?.best || match.status === 'not_found') {
      res.answer = t(lang, `No customer found for "${parsed.customerName ?? ''}".`, `"${parsed.customerName ?? ''}" नाम का कोई ग्राहक नहीं मिला।`);
      return;
    }
    if (match.status === 'ambiguous') {
      res.answer = t(lang, 'Several customers match. Please pick one.', 'कई ग्राहक मिले, एक चुनें।');
      res.needsConfirmation = false;
      res.answerData = { choose: match.candidates };
      return;
    }
    const c = await Customer.findOne({ _id: match.best.id, shopId }).select('name currentBalance lastTransactionAt');
    if (!c) return;
    res.answerData = { customerId: String(c._id), balance: c.currentBalance };
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
      res.answerData = { productId: p.id, stock: p.currentStock, unit: p.unit, status };
      res.answer = t(
        lang,
        `${p.name}: ${p.currentStock} ${p.unit} left${status === 'out' ? ' (out of stock)' : status === 'low' ? ' (running low)' : ''}.`,
        `${p.name}: ${p.currentStock} ${p.unit} बचा है${status === 'out' ? ' (खत्म हो गया)' : status === 'low' ? ' (कम है)' : ''}।`,
      );
      return;
    }
    const alerts = await stockAlerts(shopId, 10);
    res.answerData = { items: alerts.items.map((i) => ({ id: i.id, name: i.name, stock: i.currentStock, unit: i.unit, status: i.stockStatus })) };
    const names = alerts.items.slice(0, 6).map((i) => `${String(i.name)} (${String(i.currentStock)})`).join(', ');
    res.answer = alerts.total
      ? t(lang, `${alerts.total} items are low or out of stock: ${names}.`, `${alerts.total} सामान कम या खत्म हैं: ${names}।`)
      : t(lang, 'All items are well stocked.', 'सभी सामान का स्टॉक ठीक है।');
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
  res.answerData = { period, from: istDayKey(from), to: istDayKey(parseIstDay(istDayKey(to))), sales: total, bills: count, udhaarGiven: given, paymentsReceived: got };
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
  const doc = await VoiceCommandLog.findOneAndUpdate({ _id: id, shopId }, { $set: patch }, { new: true });
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

export const aiEngineStatus = () => ({ provider: provider.name, available: provider.isAvailable() });
