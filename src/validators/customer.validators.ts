import { z } from 'zod';
import { dateRangeQuery, indianPhoneOptional, listQuery, objectId, optionalDate, paise, positivePaise, qty, stringList, trimmed } from './common';

const customerBase = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(100),
  aliases: stringList,
  phone: indianPhoneOptional,
  address: trimmed(300).default(''),
  creditLimit: paise.optional(),
});

export const createCustomerSchema = customerBase.extend({
  /** Created by the voice assistant for a new person taking udhaar; undo removes them again. */
  voiceLogId: objectId.optional(),
});

export const updateCustomerSchema = customerBase.partial();

export const customerListQuery = listQuery.extend({
  filter: z.enum(['all', 'due', 'clear']).optional(),
});

const ledgerItem = z.object({
  productId: objectId.optional(),
  name: z.string().trim().min(1).max(120),
  qty,
  rate: paise,
});

export const addCreditSchema = z.object({
  amount: positivePaise,
  items: z.array(ledgerItem).default([]),
  note: trimmed(300).default(''),
  date: optionalDate,
  source: z.enum(['manual', 'voice']).default('manual'),
  /** Set when the voice assistant saves this; lets the entry be undone. */
  voiceLogId: objectId.optional(),
  rawVoiceText: trimmed(1000).optional(),
});

export const addPaymentSchema = z.object({
  amount: positivePaise,
  mode: z.enum(['cash', 'upi', 'bank']).default('cash'),
  note: trimmed(300).default(''),
  date: optionalDate,
  source: z.enum(['manual', 'voice']).default('manual'),
  /** Set when the voice assistant saves this; lets the entry be undone. */
  voiceLogId: objectId.optional(),
  rawVoiceText: trimmed(1000).optional(),
});

export const ledgerQuery = dateRangeQuery;

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuery>;
export type AddCreditInput = z.infer<typeof addCreditSchema>;
export type AddPaymentInput = z.infer<typeof addPaymentSchema>;
