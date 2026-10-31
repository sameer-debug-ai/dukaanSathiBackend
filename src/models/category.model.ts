import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantModel } from './plugins';

/**
 * A product category the shop manages (name + active). Products still store the category
 * name as text; inactive categories are just hidden from the product form's dropdown.
 */
const categorySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** Lower-cased name, so "Dairy" and "dairy" are the same category. */
    key: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

categorySchema.index({ shopId: 1, key: 1 }, { unique: true });

tenantModel(categorySchema);

export type CategoryAttrs = InferSchemaType<typeof categorySchema>;
export const Category = model('Category', categorySchema);
