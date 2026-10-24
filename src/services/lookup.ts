import type { Model, Types } from 'mongoose';

/**
 * Shop-scoped replacement for populate(): populate's internal find has no shopId
 * and would (correctly) be rejected by the tenant guard.
 */
export async function attachRef<T extends Record<string, unknown>>(
  rows: T[],
  field: keyof T & string,
  model: Model<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  shopId: Types.ObjectId,
  select: string,
): Promise<T[]> {
  const ids = [...new Set(rows.map((r) => r[field]).filter(Boolean).map(String))];
  if (!ids.length) return rows;
  const docs = await model.find({ shopId, _id: { $in: ids } }).select(select);
  const byId = new Map(docs.map((d) => [String(d._id), d.toJSON() as Record<string, unknown>]));
  return rows.map((r) => {
    const ref = r[field] ? byId.get(String(r[field])) : undefined;
    return { ...r, [field]: ref ? String(r[field]) : r[field], [field.replace(/Id$/, '')]: ref ?? null };
  });
}
