import type { Types } from 'mongoose';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { formatInr } from '../utils/money';
import type { Intent, ParsedCommand } from './intentSchema';
import type { EntityMatcher } from './matcher';
import { devanagariToRoman } from './transliterate';

/**
 * Short-term memory for the voice assistant, so "unke", "usi ko" or "aur 200 jodo" refer to
 * whoever was just mentioned. It is read from the shop's recent voice logs (which already hold
 * the resolved customer / supplier / product), so it survives server restarts and needs no store.
 */

/** Context is forgotten after this long without a command. */
export const CONTEXT_IDLE_MS = 10 * 60 * 1000;
/** How many earlier actions are remembered. */
export const CONTEXT_TURNS = 5;

export interface ContextEntity {
  id: string;
  name: string;
}

export interface ConversationTurn {
  text: string;
  intent: Intent;
  customer?: ContextEntity;
  supplier?: ContextEntity;
  product?: ContextEntity;
  amount: number | null;
}

interface LogLike {
  rawText: string;
  intent?: string | null;
  status?: string | null;
  parsedJson?: unknown;
  createdAt: Date;
}

type StoredAction = Partial<ParsedCommand> & { resolved?: { customer?: ContextEntity | null; supplier?: ContextEntity | null; product?: ContextEntity | null } };

const entity = (e: ContextEntity | null | undefined): ContextEntity | undefined => (e?.id && e.name ? { id: String(e.id), name: e.name } : undefined);

/**
 * Turns recent logs (newest first) into the conversation, oldest first. Walks back until a gap
 * longer than CONTEXT_IDLE_MS or a "naya / reset" command. Unparsed (failed) commands are skipped.
 */
export function conversationFromLogs(logs: LogLike[], now = new Date()): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let newer = now.getTime();
  for (const log of logs) {
    const at = new Date(log.createdAt).getTime();
    if (newer - at > CONTEXT_IDLE_MS) break;
    if (log.intent === 'reset_context') break;
    newer = at;
    if (log.status === 'failed') continue;
    const json = (log.parsedJson ?? {}) as StoredAction & { actions?: StoredAction[] };
    const actions = Array.isArray(json.actions) && json.actions.length ? json.actions : [json];
    // Within one sentence the last action is the most recent.
    for (const a of [...actions].reverse()) {
      turns.push({
        text: log.rawText,
        intent: (a.intent ?? log.intent ?? 'unknown') as Intent,
        customer: entity(a.resolved?.customer),
        supplier: entity(a.resolved?.supplier),
        product: entity(a.resolved?.product),
        amount: typeof a.amount === 'number' ? a.amount : null,
      });
    }
    if (turns.length >= CONTEXT_TURNS) break;
  }
  return turns.slice(0, CONTEXT_TURNS).reverse();
}

export async function loadConversation(shopId: Types.ObjectId, now = new Date()): Promise<ConversationTurn[]> {
  const logs = await VoiceCommandLog.find({ shopId, createdAt: { $gte: new Date(now.getTime() - CONTEXT_IDLE_MS * CONTEXT_TURNS) } })
    .sort({ createdAt: -1 })
    .limit(CONTEXT_TURNS)
    .select('rawText intent status parsedJson createdAt')
    .lean();
  return conversationFromLogs(logs as LogLike[], now);
}

/** One line per turn for the AI prompt. */
export function describeTurn(t: ConversationTurn): string {
  const parts = [`"${t.text}" -> ${t.intent}`];
  if (t.customer) parts.push(`customer: ${t.customer.name}`);
  if (t.supplier) parts.push(`supplier: ${t.supplier.name}`);
  if (t.product) parts.push(`product: ${t.product.name}`);
  if (t.amount) parts.push(`amount ${formatInr(t.amount)}`);
  return parts.join(', ');
}

const roman = (s: string) => devanagariToRoman(s).toLowerCase().replace(/[.,!?।]/g, ' ').replace(/\s+/g, ' ').trim();

/** "naya", "nayi shuruaat", "reset karo", "start over": forget the conversation. */
const RESET_RX =
  /^(naya|nayi|new|reset|fresh|start over|sab bhool jao|context clear)( (shuru|shuruat|shuruaat|baat|start|conversation|session|se))*( (karo|kro|kar do|kardo|karen|kijiye|kare))?$/;

export const isResetCommand = (text: string): boolean => RESET_RX.test(roman(text));

/** Words pointing back at someone already mentioned. */
const PRONOUN = '(unke|unka|unki|unko|unhe|unhen|unhone|unhonne|inke|inka|inki|inko|inhone|uske|uska|uski|usko|usne|usi|unhi|inhi|wahi|vahi|wohi|vohi)';
const PRONOUN_RX = new RegExp(`(^|\\s)${PRONOUN}(\\s|$)`);
const PRONOUN_NAME_RX = new RegExp(`^${PRONOUN}( (ko|ka|ke|ki|ne|se|wala|wale|wali|vala|vale|ji|bhai))*$`);
/** "aur 200 jodo", "ek aur 100", "phir 50": continues the previous action. */
const FOLLOW_UP_RX = /(^|\s)(aur|or|and|phir|fir|ek aur|bhi)(\s|$)/;

export const hasBackReference = (text: string): boolean => {
  const r = roman(text);
  return PRONOUN_RX.test(r) || FOLLOW_UP_RX.test(r);
};

/** A "name" that is really just a pronoun ("unke", "usi ko", "wahi wala"). */
export const isPronounName = (name: string | null | undefined): boolean => !!name && PRONOUN_NAME_RX.test(roman(name));

const CUSTOMER_INTENTS = new Set<Intent>(['add_credit', 'receive_payment', 'query_balance']);
const SUPPLIER_INTENTS = new Set<Intent>(['add_purchase', 'supplier_payment']);
const PRODUCT_INTENTS = new Set<Intent>(['adjust_stock', 'query_stock']);

function latest<K extends 'customer' | 'supplier' | 'product'>(turns: ConversationTurn[], key: K): ContextEntity | undefined {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]![key]) return turns[i]![key];
  return undefined;
}

/**
 * Fills a name the command only points at ("unke", or none in "aur 200 jodo") from the
 * conversation. Names that were actually spoken are never replaced.
 */
export function applyContext(cmd: ParsedCommand, text: string, turns: ConversationTurn[]): ParsedCommand {
  if (!turns.length) return cmd;
  const refers = hasBackReference(text);
  const fill = (name: string | null, entity: ContextEntity | undefined) =>
    entity && (isPronounName(name) || (!name && refers)) ? entity.name : name;
  const out = { ...cmd };
  const wantsCustomer = CUSTOMER_INTENTS.has(cmd.intent) || (cmd.intent === 'add_sale' && cmd.paymentMode === 'udhaar');
  if (wantsCustomer) out.customerName = fill(cmd.customerName, latest(turns, 'customer'));
  if (SUPPLIER_INTENTS.has(cmd.intent)) out.supplierName = fill(cmd.supplierName, latest(turns, 'supplier'));
  if (PRODUCT_INTENTS.has(cmd.intent) && cmd.queryType !== 'low_stock' && cmd.queryType !== 'out_of_stock') {
    out.productName = fill(cmd.productName, latest(turns, 'product'));
    if (cmd.intent === 'query_stock' && out.productName && !cmd.productName) out.queryType = 'product';
  }
  return out;
}

/** Hindi postposition after a pronoun, used when spelling the name back in. */
const POSTPOSITION: Record<string, string> = {
  unhone: 'ne', unhonne: 'ne', inhone: 'ne', usne: 'ne',
  unka: 'ka', inka: 'ka', uska: 'ka',
  unki: 'ki', inki: 'ki', uski: 'ki',
  unke: 'ke', inke: 'ke', uske: 'ke',
  unko: 'ko', inko: 'ko', usko: 'ko', unhe: 'ko', unhen: 'ko',
};

/** How the previous action is phrased, so a bare follow-up parses as the same kind of entry. */
const FOLLOW_UP_PHRASE: Partial<Record<Intent, { join: string; verb: RegExp; add: string }>> = {
  add_credit: { join: 'ke', verb: /(^|\s)(likh|likho|jod|jodo|add|udhaar|udhar|daal|dalo|chadhao)(\s|$)/, add: 'likho' },
  receive_payment: { join: 'ne', verb: /(^|\s)(diye|diya|de|jama|paid|lautaye)(\s|$)/, add: 'diye' },
  supplier_payment: { join: 'ko', verb: /(^|\s)(diye|diya|de|bheje|paid|chukaya)(\s|$)/, add: 'diye' },
  add_purchase: { join: 'se', verb: /(^|\s)(liya|liye|kharida|mangaya)(\s|$)/, add: 'liya' },
};

/**
 * For the offline parser: rewrites a follow-up into a full sentence it can read.
 * "unhone 100 aur diye" -> "Rakesh Sharma ne 100 aur diye"; "aur 200 jodo" -> "Rakesh Sharma ke aur 200 jodo".
 * Returns the original text when the command names someone itself or nothing applies.
 */
export function rewriteFollowUp(text: string, turns: ConversationTurn[], m: { customers: EntityMatcher; suppliers: EntityMatcher }): string {
  if (!turns.length) return text;
  const r = roman(text);
  if (m.customers.findMentions(r).length || m.suppliers.findMentions(r).length) return text;
  const last = turns[turns.length - 1]!;
  const person = last.customer ?? last.supplier ?? latest(turns, 'customer') ?? latest(turns, 'supplier');
  if (!person) return text;

  if (PRONOUN_RX.test(r)) {
    const rewritten = r.replace(new RegExp(`(^|\\s)${PRONOUN}(?=\\s|$)(\\s(ko|ka|ke|ki|ne)(?=\\s|$))?`),(_m, pre: string, p: string, post?: string) => {
      const pp = post?.trim() ?? POSTPOSITION[p] ?? '';
      return `${pre}${person.name}${pp ? ` ${pp}` : ''}`;
    });
    const phrase = FOLLOW_UP_PHRASE[last.intent];
    return phrase && !phrase.verb.test(r) && /\d|sau|hazaar|hazar/.test(r) ? `${rewritten} ${phrase.add}` : rewritten;
  }

  const phrase = FOLLOW_UP_PHRASE[last.intent];
  if (!phrase || !FOLLOW_UP_RX.test(r) || !/\d|sau|hazaar|hazar|\s(ek|do|teen|chaar|paanch|das|bees|pachaas)\s/.test(` ${r} `)) return text;
  return `${person.name} ${phrase.join} ${r}${phrase.verb.test(r) ? '' : ` ${phrase.add}`}`;
}
