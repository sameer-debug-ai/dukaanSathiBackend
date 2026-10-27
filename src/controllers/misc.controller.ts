import type { Request, Response } from 'express';
import { z } from 'zod';
import { aiEngineStatus, listVoiceLogs, parseVoiceCommand, updateVoiceLog } from '../ai/ai.service';
import { env } from '../config/env';
import { shopIdOf } from '../middlewares/auth';
import { dashboardCharts, dashboardSummary } from '../services/dashboard.service';
import { REPORTS, reportToCsv, type ReportName } from '../services/report.service';
import * as sales from '../services/sale.service';
import { exportBackup, loadSampleData, shopDataCounts } from '../services/settings.service';
import { learnAliases } from '../services/aliasLearning.service';
import { executeVoiceBatch, type ExecuteBatchInput } from '../services/voiceBatch.service';
import { lastUndoableVoiceLog, undoVoiceCommand } from '../services/voiceUndo.service';
import { objectId } from '../validators/common';
import { created, ok } from '../utils/apiResponse';
import { AppError } from '../utils/AppError';
import { istDayKey } from '../utils/istDate';
import { getPageParams, pageMeta } from '../utils/pagination';

// ---------- Sales ----------
export async function listSales(req: Request, res: Response) {
  const { items, meta } = await sales.listSales(shopIdOf(req), req.query);
  return ok(res, items, 'OK', meta);
}
export async function getSale(req: Request, res: Response) {
  return ok(res, await sales.getSale(shopIdOf(req), req.params.id!));
}
export async function createSale(req: Request, res: Response) {
  return created(res, await sales.createSale(shopIdOf(req), req.body, req.auth?.userId), 'Bill saved');
}

// ---------- Dashboard ----------
export async function summary(req: Request, res: Response) {
  return ok(res, await dashboardSummary(shopIdOf(req)));
}
export async function charts(req: Request, res: Response) {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 7));
  return ok(res, await dashboardCharts(shopIdOf(req), days));
}

// ---------- Reports ----------
export async function report(req: Request, res: Response) {
  const name = req.params.name as ReportName;
  const fn = REPORTS[name];
  if (!fn) throw AppError.notFound(`Unknown report: ${name}`);
  const { from, to, format } = req.query as { from?: string; to?: string; format?: string };
  const data = await fn(shopIdOf(req), { from, to });
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${from ?? 'start'}-to-${to ?? istDayKey(new Date())}.csv"`);
    return res.send('﻿' + reportToCsv(data));
  }
  return ok(res, data);
}

// ---------- Voice / AI ----------
export const parseCommandSchema = z.object({
  text: z.string().trim().min(1, 'Say or type a command').max(500),
  lang: z.enum(['hi', 'en']).default('en'),
});
export async function parseCommand(req: Request, res: Response) {
  const { text, lang } = req.body as z.infer<typeof parseCommandSchema>;
  return ok(res, await parseVoiceCommand(shopIdOf(req), text, lang));
}
export async function aiStatus(_req: Request, res: Response) {
  return ok(res, aiEngineStatus());
}

export const voiceLogPatchSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'failed']),
  resultMessage: z.string().trim().max(500).optional(),
  error: z.string().trim().max(500).optional(),
});
export async function listLogs(req: Request, res: Response) {
  const page = getPageParams(req.query, 30);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const { items, total } = await listVoiceLogs(shopIdOf(req), { ...page, status });
  return ok(res, items, 'OK', pageMeta(page, total));
}
export async function patchLog(req: Request, res: Response) {
  const doc = await updateVoiceLog(shopIdOf(req), req.params.id!, req.body);
  if (!doc) throw AppError.notFound('Voice log not found');
  return ok(res, doc);
}

/** Undo a saved voice command (within the shop's undo window). */
export async function undoLog(req: Request, res: Response) {
  return ok(res, await undoVoiceCommand(shopIdOf(req), req.params.id!, req.auth?.userId), 'Undone');
}
/** Undo the most recent saved voice command ("galti ho gayi"). */
export async function undoLast(req: Request, res: Response) {
  const last = await lastUndoableVoiceLog(shopIdOf(req));
  if (!last) throw AppError.badRequest('Nothing recent to undo');
  return ok(res, await undoVoiceCommand(shopIdOf(req), String(last._id), req.auth?.userId), 'Undone');
}

export { executeBatchSchema } from '../services/voiceBatch.service';
/** Save every action of a multi-action voice command together ("Sab save karo"). */
export async function executeBatch(req: Request, res: Response) {
  return created(res, await executeVoiceBatch(shopIdOf(req), req.body as ExecuteBatchInput, req.auth?.userId), 'Saved');
}

export const learnAliasesSchema = z.object({
  items: z
    .array(z.object({ kind: z.enum(['customer', 'product', 'supplier']), id: objectId, alias: z.string().trim().min(1).max(60) }))
    .min(1)
    .max(20),
});
export async function learnAliasesHandler(req: Request, res: Response) {
  const { items } = req.body as z.infer<typeof learnAliasesSchema>;
  return ok(res, await learnAliases(shopIdOf(req), items));
}

// ---------- Settings ----------
export async function backup(req: Request, res: Response) {
  const data = await exportBackup(shopIdOf(req));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dukaansathi-backup-${istDayKey(new Date())}.json"`);
  return res.send(JSON.stringify(data, null, 2));
}
export async function sampleData(req: Request, res: Response) {
  // Demo products/customers are for trying the app locally, never for a live shop.
  if (env.isProd) throw new AppError(403, 'Sample data is not available on this server');
  return created(res, await loadSampleData(shopIdOf(req)), 'Sample data loaded');
}
export async function dataCounts(req: Request, res: Response) {
  return ok(res, await shopDataCounts(shopIdOf(req)));
}
