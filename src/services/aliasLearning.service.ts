import type { Types } from 'mongoose';
import { cleanName } from '../ai/matcher';
import { devanagariToRoman } from '../ai/transliterate';
import { Customer } from '../models/customer.model';
import { Product } from '../models/product.model';
import { Supplier } from '../models/supplier.model';
import { AppError } from '../utils/AppError';

export type AliasKind = 'customer' | 'product' | 'supplier';

export interface LearnAliasInput {
  kind: AliasKind;
  id: string;
  alias: string;
}

export type LearnAliasResult = { kind: AliasKind; id: string; alias: string; added: boolean; reason?: 'exists' | 'conflict' | 'invalid' };

type Named = { _id: Types.ObjectId; name: string; aliases: string[]; nameHindi?: string };

const MODELS = { customer: Customer, product: Product, supplier: Supplier } as const;

/** Every spelling a record already answers to, normalised (Hindi names also in Roman letters). */
function keysOf(doc: Named): Set<string> {
  const keys = new Set<string>();
  for (const s of [doc.name, doc.nameHindi ?? '', ...doc.aliases]) {
    if (!s) continue;
    keys.add(cleanName(s));
    if (/[ऀ-ॿ]/.test(s)) keys.add(cleanName(devanagariToRoman(s)));
  }
  return keys;
}

/**
 * Remembers a spoken name for a record the user picked ("Sharma" -> Rakesh Sharma), so the
 * matcher finds it directly next time. Skipped when the record already answers to it, or when
 * another record of the same kind does (that would make the name ambiguous, not smarter).
 */
export async function learnAlias(shopId: Types.ObjectId, input: LearnAliasInput): Promise<LearnAliasResult> {
  const alias = input.alias.trim().replace(/\s+/g, ' ');
  const base = { kind: input.kind, id: input.id, alias };
  const key = cleanName(alias);
  if (key.length < 2 || alias.length > 60) return { ...base, added: false, reason: 'invalid' };

  const Model = MODELS[input.kind] as unknown as typeof Customer;
  const fields = input.kind === 'product' ? 'name nameHindi aliases' : 'name aliases';
  const doc = (await Model.findOne({ _id: input.id, shopId, isDeleted: false }).select(fields)) as unknown as Named | null;
  if (!doc) throw AppError.notFound(`${input.kind[0]!.toUpperCase()}${input.kind.slice(1)} not found`);

  const romanKey = /[ऀ-ॿ]/.test(alias) ? cleanName(devanagariToRoman(alias)) : key;
  const own = keysOf(doc);
  if (own.has(key) || own.has(romanKey)) return { ...base, added: false, reason: 'exists' };

  const others = (await Model.find({ shopId, isDeleted: false, _id: { $ne: doc._id } }).select(fields).limit(3000)) as unknown as Named[];
  if (others.some((o) => { const k = keysOf(o); return k.has(key) || k.has(romanKey); })) return { ...base, added: false, reason: 'conflict' };

  await Model.updateOne({ _id: doc._id, shopId }, { $push: { aliases: alias } });
  return { ...base, added: true };
}

export async function learnAliases(shopId: Types.ObjectId, items: LearnAliasInput[]): Promise<LearnAliasResult[]> {
  const out: LearnAliasResult[] = [];
  // Sequential: two items may teach the same record.
  for (const item of items) out.push(await learnAlias(shopId, item));
  return out;
}
