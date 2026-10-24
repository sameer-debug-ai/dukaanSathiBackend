import type { Request, Response } from 'express';
import { shopIdOf } from '../middlewares/auth';
import * as products from '../services/product.service';
import { stockHistory } from '../services/stock.service';
import { created, ok } from '../utils/apiResponse';
import { istDayKey } from '../utils/istDate';

export async function list(req: Request, res: Response) {
  const { items, meta } = await products.listProducts(shopIdOf(req), req.query);
  return ok(res, items, 'OK', meta);
}

export async function get(req: Request, res: Response) {
  const doc = await products.getProduct(shopIdOf(req), req.params.id!);
  return ok(res, products.serializeProduct(doc));
}

export async function create(req: Request, res: Response) {
  const doc = await products.createProduct(shopIdOf(req), req.body, req.auth?.userId);
  return created(res, products.serializeProduct(doc), 'Product added');
}

export async function update(req: Request, res: Response) {
  const doc = await products.updateProduct(shopIdOf(req), req.params.id!, req.body);
  return ok(res, products.serializeProduct(doc), 'Product updated');
}

export async function remove(req: Request, res: Response) {
  await products.deleteProduct(shopIdOf(req), req.params.id!);
  return ok(res, null, 'Product deleted');
}

export async function categories(req: Request, res: Response) {
  return ok(res, await products.listCategories(shopIdOf(req)));
}

export async function alerts(req: Request, res: Response) {
  return ok(res, await products.stockAlerts(shopIdOf(req)));
}

export async function importRows(req: Request, res: Response) {
  const result = await products.importProducts(shopIdOf(req), req.body, req.auth?.userId);
  return ok(res, result, `Imported: ${result.created} new, ${result.updated} updated, ${result.failed} failed`);
}

export async function exportCsv(req: Request, res: Response) {
  const csv = await products.exportProductsCsv(shopIdOf(req), req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products-${istDayKey(new Date())}.csv"`);
  return res.send('﻿' + csv);
}

export async function adjust(req: Request, res: Response) {
  const product = await products.adjustStock(shopIdOf(req), req.body, req.auth?.userId);
  return ok(res, product, 'Stock updated');
}

export async function history(req: Request, res: Response) {
  const { items, meta, product } = await stockHistory(shopIdOf(req), req.params.productId!, req.query);
  return ok(res, items, 'OK', { ...meta, product });
}
