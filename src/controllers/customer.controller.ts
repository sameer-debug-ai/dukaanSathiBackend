import type { Request, Response } from 'express';
import { shopIdOf } from '../middlewares/auth';
import * as customers from '../services/customer.service';
import { createKhataLink, khataLinkStatus, publicKhata, revokeKhataLink } from '../services/khataLink.service';
import { markReminderSent, todayReminders } from '../services/reminder.service';
import { created, ok } from '../utils/apiResponse';

export async function list(req: Request, res: Response) {
  const { items, meta } = await customers.listCustomers(shopIdOf(req), req.query);
  return ok(res, items, 'OK', meta);
}

export async function get(req: Request, res: Response) {
  return ok(res, await customers.customerDetail(shopIdOf(req), req.params.id!));
}

export async function create(req: Request, res: Response) {
  const doc = await customers.createCustomer(shopIdOf(req), req.body);
  return created(res, doc.toJSON(), 'Customer added');
}

export async function update(req: Request, res: Response) {
  const doc = await customers.updateCustomer(shopIdOf(req), req.params.id!, req.body);
  return ok(res, doc.toJSON(), 'Customer updated');
}

export async function remove(req: Request, res: Response) {
  await customers.deleteCustomer(shopIdOf(req), req.params.id!);
  return ok(res, null, 'Customer deleted');
}

export async function ledger(req: Request, res: Response) {
  return ok(res, await customers.customerLedger(shopIdOf(req), req.params.id!, req.query));
}

export async function addCredit(req: Request, res: Response) {
  return created(res, await customers.addCredit(shopIdOf(req), req.params.id!, req.body), 'Udhaar added');
}

export async function addPayment(req: Request, res: Response) {
  return created(res, await customers.addPayment(shopIdOf(req), req.params.id!, req.body), 'Payment received');
}

// ---------- Reminders ----------
export async function remindersToday(req: Request, res: Response) {
  return ok(res, await todayReminders(shopIdOf(req)));
}
export async function reminderSent(req: Request, res: Response) {
  return ok(res, await markReminderSent(shopIdOf(req), req.params.id!), 'Reminder noted');
}

// ---------- Public khata link ----------
export async function shareLinkStatus(req: Request, res: Response) {
  return ok(res, await khataLinkStatus(shopIdOf(req), req.params.id!));
}
export async function shareLinkCreate(req: Request, res: Response) {
  return created(res, await createKhataLink(shopIdOf(req), req.params.id!), 'Link created');
}
export async function shareLinkRevoke(req: Request, res: Response) {
  return ok(res, await revokeKhataLink(shopIdOf(req), req.params.id!), 'Link disabled');
}
/** No login: the token is the only key. Never cached by browsers or proxies. */
export async function publicKhataView(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return ok(res, await publicKhata(String(req.params.token ?? '')));
}
