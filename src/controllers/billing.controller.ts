import type { Request, Response } from 'express';
import { shopIdOf } from '../middlewares/auth';
import { cancelSale, getBillingSettings, setGstByCategory, updateBillingSettings } from '../services/billing.service';
import { quoteSale } from '../services/sale.service';
import { ok } from '../utils/apiResponse';

export async function getSettings(req: Request, res: Response) {
  return ok(res, await getBillingSettings(shopIdOf(req)));
}

export async function updateSettings(req: Request, res: Response) {
  return ok(res, await updateBillingSettings(shopIdOf(req), req.body), 'Bill settings saved');
}

export async function quote(req: Request, res: Response) {
  return ok(res, await quoteSale(shopIdOf(req), req.body));
}

export async function cancel(req: Request, res: Response) {
  return ok(res, await cancelSale(shopIdOf(req), req.params.id!, req.body, req.auth?.userId), 'Bill cancelled');
}

export async function gstByCategory(req: Request, res: Response) {
  return ok(res, await setGstByCategory(shopIdOf(req), req.body), 'GST rate updated');
}
