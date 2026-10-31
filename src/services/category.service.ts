import type { Types } from 'mongoose';
import { Category } from '../models/category.model';
import { Product } from '../models/product.model';
import { AppError } from '../utils/AppError';
import { escapeRegex } from '../utils/pagination';
import type { CreateCategoryInput, UpdateCategoryInput } from '../validators/category.validators';

const keyOf = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const tidy = (name: string) => name.trim().replace(/\s+/g, ' ');

/**
 * Categories already used by products (typed in before this module existed, or on the product
 * form) get a managed entry, active by default, so the shop can see and manage all of them.
 */
async function syncFromProducts(shopId: Types.ObjectId): Promise<void> {
  const used = ((await Product.distinct('category', { shopId, isDeleted: false })) as string[]).filter((c) => c && c.trim());
  if (!used.length) return;
  const known = new Set((await Category.find({ shopId }).select('key')).map((c) => c.key));
  const missing = new Map<string, string>();
  for (const name of used) {
    const key = keyOf(name);
    if (!known.has(key) && !missing.has(key)) missing.set(key, tidy(name));
  }
  if (!missing.size) return;
  // Upserts: two requests syncing at once must not create duplicates.
  await Category.bulkWrite(
    [...missing].map(([key, name]) => ({
      updateOne: { filter: { shopId, key }, update: { $setOnInsert: { shopId, key, name, isActive: true } }, upsert: true },
    })),
  );
}

/** All categories with how many products use each (case-insensitive). */
export async function listCategories(shopId: Types.ObjectId) {
  await syncFromProducts(shopId);
  const [cats, counts] = await Promise.all([
    Category.find({ shopId }).sort({ isActive: -1, name: 1 }),
    Product.aggregate<{ _id: string; n: number }>([
      { $match: { shopId, isDeleted: false } },
      { $group: { _id: { $toLower: { $trim: { input: '$category' } } }, n: { $sum: 1 } } },
    ]),
  ]);
  const byKey = new Map(counts.map((c) => [c._id, c.n]));
  return cats.map((c) => ({ ...(c.toJSON() as Record<string, unknown>), productCount: byKey.get(c.key) ?? 0 }));
}

/** Names for the product form's dropdown: active categories only. */
export async function activeCategoryNames(shopId: Types.ObjectId): Promise<string[]> {
  await syncFromProducts(shopId);
  const cats = await Category.find({ shopId, isActive: true }).select('name').sort({ name: 1 });
  return cats.map((c) => c.name);
}

export async function createCategory(shopId: Types.ObjectId, input: CreateCategoryInput) {
  const name = tidy(input.name);
  const key = keyOf(name);
  if (await Category.exists({ shopId, key })) throw AppError.conflict(`Category "${name}" already exists`);
  try {
    const doc = await Category.create({ shopId, name, key, isActive: input.isActive });
    return { ...(doc.toJSON() as Record<string, unknown>), productCount: 0 };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw AppError.conflict(`Category "${name}" already exists`);
    throw err;
  }
}

/**
 * Rename and/or switch active. A rename also renames the category on its products, so they stay
 * in it. Deactivating only hides it from the dropdown; products keep their category.
 */
export async function updateCategory(shopId: Types.ObjectId, id: string, input: UpdateCategoryInput) {
  const doc = await Category.findOne({ _id: id, shopId });
  if (!doc) throw AppError.notFound('Category not found');

  if (input.name !== undefined) {
    const name = tidy(input.name);
    const key = keyOf(name);
    if (key !== doc.key && (await Category.exists({ shopId, key, _id: { $ne: doc._id } }))) {
      throw AppError.conflict(`Category "${name}" already exists`);
    }
    if (name !== doc.name) {
      await Product.updateMany({ shopId, category: new RegExp(`^\\s*${escapeRegex(doc.name)}\\s*$`, 'i') }, { $set: { category: name } });
      doc.name = name;
      doc.key = key;
    }
  }
  if (input.isActive !== undefined) doc.isActive = input.isActive;
  await doc.save();
  // Same case/space-insensitive count as the list.
  const productCount = await Product.countDocuments({ shopId, isDeleted: false, category: new RegExp(`^\\s*${escapeRegex(doc.name)}\\s*$`, 'i') });
  return { ...(doc.toJSON() as Record<string, unknown>), productCount };
}
