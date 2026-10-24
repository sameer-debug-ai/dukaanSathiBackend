import type { Schema } from 'mongoose';

/**
 * Shared JSON shape for every model: expose `id`, hide `_id`/`__v`.
 * Applied per-schema so each model opts in explicitly.
 */
export function applyJsonTransform(schema: Schema): void {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.passwordHash;
      delete ret.refreshTokenHash;
      return ret;
    },
  });
}

const GUARDED_QUERIES = [
  'find',
  'findOne',
  'countDocuments',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
] as const;

/**
 * Multi-tenancy safety net: any query on a tenant collection that does not filter
 * by shopId throws, so one shop can never read or modify another shop's data by
 * accident (e.g. a forgotten filter or a findById).
 */
export function tenantGuard(schema: Schema): void {
  for (const op of GUARDED_QUERIES) {
    schema.pre(op, function (this: { getFilter: () => Record<string, unknown>; model: { modelName: string } }) {
      const filter = this.getFilter();
      if (!filter || filter.shopId === undefined) {
        throw new Error(`Tenant guard: ${this.model.modelName}.${op} must filter by shopId`);
      }
    });
  }
  schema.pre('aggregate', function () {
    const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
    if (!first?.$match || first.$match.shopId === undefined) {
      throw new Error('Tenant guard: aggregate pipelines must start with $match on shopId');
    }
  });
}

/** Applies the standard plugins for a tenant-owned collection. */
export function tenantModel(schema: Schema): void {
  applyJsonTransform(schema);
  tenantGuard(schema);
}
