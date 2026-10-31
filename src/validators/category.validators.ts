import { z } from 'zod';

const name = z.string().trim().min(1, 'Category name is required').max(60, 'Keep the name under 60 characters');

export const createCategorySchema = z.object({ name, isActive: z.boolean().default(true) });

export const updateCategorySchema = z
  .object({ name, isActive: z.boolean() })
  .partial()
  .refine((v) => v.name !== undefined || v.isActive !== undefined, 'Nothing to update');

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
