import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

export const MOVEMENT_TYPES = ['purchase', 'sale', 'adjustment', 'return', 'damage'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const stockMovementSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    /** Signed: + adds stock, - removes stock. */
    quantity: { type: Number, required: true },
    /** Stock level right after this movement, for an easy history view. */
    balanceAfter: { type: Number, required: true },
    referenceType: { type: String, enum: ['sale', 'purchase', 'manual', null], default: 'manual' },
    referenceId: { type: Schema.Types.ObjectId },
    note: { type: String, trim: true, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

stockMovementSchema.index({ shopId: 1, productId: 1, createdAt: -1 });
stockMovementSchema.index({ shopId: 1, createdAt: -1 });

tenantModel(stockMovementSchema);

export type StockMovementAttrs = InferSchemaType<typeof stockMovementSchema>;
export const StockMovement = model('StockMovement', stockMovementSchema);
