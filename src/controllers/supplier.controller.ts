import type { Request, Response } from 'express';
import { shopIdOf } from '../middlewares/auth';
import * as suppliers from '../services/supplier.service';
import { created, ok } from '../utils/apiResponse';

export async function list(req: Request, res: Response) {
  const { items, meta } = await suppliers.listSuppliers(shopIdOf(req), req.query);
  return ok(res, items, 'OK', meta);
}

export async function get(req: Request, res: Response) {
  return ok(res, await suppliers.supplierDetail(shopIdOf(req), req.params.id!));
}

export async function create(req: Request, res: Response) {
  const doc = await suppliers.createSupplier(shopIdOf(req), req.body);
  return created(res, doc.toJSON(), 'Supplier added');
}

export async function update(req: Request, res: Response) {
  const doc = await suppliers.updateSupplier(shopIdOf(req), req.params.id!, req.body);
  return ok(res, doc.toJSON(), 'Supplier updated');
}

export async function remove(req: Request, res: Response) {
  await suppliers.deleteSupplier(shopIdOf(req), req.params.id!);
  return ok(res, null, 'Supplier deleted');
}

export async function history(req: Request, res: Response) {
  return ok(res, await suppliers.supplierHistory(shopIdOf(req), req.params.id!));
}

export async function listPurchases(req: Request, res: Response) {
  const { items, meta } = await suppliers.listPurchases(shopIdOf(req), req.query);
  return ok(res, items, 'OK', meta);
}

export async function getPurchase(req: Request, res: Response) {
  return ok(res, await suppliers.getPurchase(shopIdOf(req), req.params.id!));
}

export async function createPurchase(req: Request, res: Response) {
  return created(res, await suppliers.createPurchase(shopIdOf(req), req.body, req.auth?.userId), 'Purchase saved');
}

export async function listPayments(req: Request, res: Response) {
  const { items, meta } = await suppliers.listSupplierPayments(shopIdOf(req), req.query);
  return ok(res, items, 'OK', meta);
}

export async function createPayment(req: Request, res: Response) {
  return created(res, await suppliers.createSupplierPayment(shopIdOf(req), req.body), 'Payment recorded');
}
