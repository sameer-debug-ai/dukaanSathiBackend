import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { shopIdOf } from '../middlewares/auth';
import { attachBillImage, readBillImage, readPurchaseBillImage, scanBillPhoto } from '../services/billScan.service';
import { ok } from '../utils/apiResponse';
import { AppError } from '../utils/AppError';
import { objectId } from '../validators/common';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const maxBytes = Math.round(env.BILL_SCAN_MAX_MB * 1024 * 1024);

/** Raw image body for /ai/scan-bill only (everything else stays JSON), with friendly limit errors. */
const rawImage = express.raw({ type: (req) => IMAGE_TYPES.includes(String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()), limit: maxBytes });
export function imageBody(req: Request, res: Response, next: NextFunction) {
  rawImage(req, res, (err?: unknown) => {
    if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
      return next(new AppError(413, `The photo is too large. Please keep it under ${env.BILL_SCAN_MAX_MB} MB.`));
    }
    next(err);
  });
}

/** Bill photo -> purchase draft for review. Saves nothing except the photo itself. */
export async function scanBill(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(415, 'Please send a photo (JPG, PNG or WebP)');
  return ok(res, await scanBillPhoto(shopIdOf(req), req.body));
}

export const attachSchema = z.object({ purchaseId: objectId });
export async function attach(req: Request, res: Response) {
  const { purchaseId } = req.body as z.infer<typeof attachSchema>;
  return ok(res, await attachBillImage(shopIdOf(req), req.params.id!, purchaseId), 'Bill photo saved with the purchase');
}

function sendImage(res: Response, img: { data: Buffer; contentType: string }) {
  res.setHeader('Content-Type', img.contentType);
  // The photo belongs to one shop: never cache it in shared caches.
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.send(img.data);
}

export async function image(req: Request, res: Response) {
  return sendImage(res, await readBillImage(shopIdOf(req), req.params.id!));
}

export async function purchaseImage(req: Request, res: Response) {
  return sendImage(res, await readPurchaseBillImage(shopIdOf(req), req.params.id!));
}
