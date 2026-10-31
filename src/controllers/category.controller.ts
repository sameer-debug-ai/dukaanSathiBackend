import type { Request, Response } from 'express';
import { shopIdOf } from '../middlewares/auth';
import * as categories from '../services/category.service';
import { created, ok } from '../utils/apiResponse';

export async function list(req: Request, res: Response) {
  return ok(res, await categories.listCategories(shopIdOf(req)));
}

export async function active(req: Request, res: Response) {
  return ok(res, await categories.activeCategoryNames(shopIdOf(req)));
}

export async function create(req: Request, res: Response) {
  return created(res, await categories.createCategory(shopIdOf(req), req.body), 'Category added');
}

export async function update(req: Request, res: Response) {
  return ok(res, await categories.updateCategory(shopIdOf(req), req.params.id!, req.body), 'Category updated');
}
