import { z } from 'zod';

/** Indian mobile: 10 digits starting 6-9. Accepts +91 / 0 prefixes and strips them. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

const passwordSchema = z.string().min(6, 'Password must be at least 6 characters').max(100);

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(100),
  shopName: z.string().trim().min(2, 'Shop name is required').max(120),
  phone: phoneSchema,
  password: passwordSchema,
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  preferredLanguage: z.enum(['hi', 'en']).default('en'),
});

export const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    shopName: z.string().trim().min(2).max(120),
    shopAddress: z.string().trim().max(300),
    email: z.string().trim().email().or(z.literal('')),
    gstNumber: z.string().trim().max(20),
    preferredLanguage: z.enum(['hi', 'en']),
    settings: z
      .object({
        lowStockDefault: z.number().min(0).max(100000),
        allowOversell: z.boolean(),
        darkMode: z.boolean(),
      })
      .partial(),
  })
  .partial();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
