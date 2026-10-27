import { Router } from 'express';
import * as billScan from '../controllers/billScan.controller';
import * as customers from '../controllers/customer.controller';
import * as misc from '../controllers/misc.controller';
import * as products from '../controllers/product.controller';
import * as suppliers from '../controllers/supplier.controller';
import { requireAuth } from '../middlewares/auth';
import { aiLimiter, publicLimiter, scanLimiter, sttLimiter } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import { asyncHandler as h } from '../utils/asyncHandler';
import { dateRangeQuery, idParams, listQuery, objectId } from '../validators/common';
import {
  addCreditSchema,
  addPaymentSchema,
  createCustomerSchema,
  customerListQuery,
  ledgerQuery,
  updateCustomerSchema,
} from '../validators/customer.validators';
import {
  adjustStockSchema,
  createProductSchema,
  importProductsSchema,
  productListQuery,
  stockHistoryQuery,
  updateProductSchema,
} from '../validators/product.validators';
import { createSaleSchema, saleListQuery } from '../validators/sale.validators';
import {
  createPurchaseSchema,
  createSupplierPaymentSchema,
  createSupplierSchema,
  purchaseListQuery,
  supplierListQuery,
  supplierPaymentListQuery,
  updateSupplierSchema,
} from '../validators/supplier.validators';
import authRoutes from './auth.routes';
import { z } from 'zod';

const router = Router();
const id = validate(idParams, 'params');

router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() }, message: 'OK' });
});

router.use('/auth', authRoutes);

// Customer's read-only khata page: no login, the unguessable token is the key.
router.get('/public/khata/:token', publicLimiter, h(customers.publicKhataView));

// Everything below is tenant data: login required, and services scope every query by shopId.
router.use(requireAuth);

// Products
router.get('/products', validate(productListQuery, 'query'), h(products.list));
router.get('/products/categories', h(products.categories));
router.get('/products/alerts', h(products.alerts));
router.get('/products/export', validate(productListQuery, 'query'), h(products.exportCsv));
router.post('/products/import', validate(importProductsSchema), h(products.importRows));
router.post('/products', validate(createProductSchema), h(products.create));
router.get('/products/:id', id, h(products.get));
router.patch('/products/:id', id, validate(updateProductSchema), h(products.update));
router.delete('/products/:id', id, h(products.remove));

// Stock
router.post('/stock/adjust', validate(adjustStockSchema), h(products.adjust));
router.get('/stock/history/:productId', validate(z.object({ productId: objectId }), 'params'), validate(stockHistoryQuery, 'query'), h(products.history));

// Customers + udhaar ledger
router.get('/customers', validate(customerListQuery, 'query'), h(customers.list));
router.post('/customers', validate(createCustomerSchema), h(customers.create));
router.get('/customers/:id', id, h(customers.get));
router.patch('/customers/:id', id, validate(updateCustomerSchema), h(customers.update));
router.delete('/customers/:id', id, h(customers.remove));
router.get('/customers/:id/ledger', id, validate(ledgerQuery, 'query'), h(customers.ledger));
router.post('/customers/:id/ledger/credit', id, validate(addCreditSchema), h(customers.addCredit));
router.post('/customers/:id/ledger/payment', id, validate(addPaymentSchema), h(customers.addPayment));
router.post('/customers/:id/reminder-sent', id, h(customers.reminderSent));
router.get('/customers/:id/share-link', id, h(customers.shareLinkStatus));
router.post('/customers/:id/share-link', id, h(customers.shareLinkCreate));
router.delete('/customers/:id/share-link', id, h(customers.shareLinkRevoke));
router.get('/reminders/today', h(customers.remindersToday));

// Suppliers, purchases, payments
router.get('/suppliers', validate(supplierListQuery, 'query'), h(suppliers.list));
router.post('/suppliers', validate(createSupplierSchema), h(suppliers.create));
router.get('/suppliers/:id', id, h(suppliers.get));
router.patch('/suppliers/:id', id, validate(updateSupplierSchema), h(suppliers.update));
router.delete('/suppliers/:id', id, h(suppliers.remove));
router.get('/suppliers/:id/history', id, h(suppliers.history));
router.get('/purchases', validate(purchaseListQuery, 'query'), h(suppliers.listPurchases));
router.post('/purchases', validate(createPurchaseSchema), h(suppliers.createPurchase));
router.get('/purchases/:id', id, h(suppliers.getPurchase));
router.get('/supplier-payments', validate(supplierPaymentListQuery, 'query'), h(suppliers.listPayments));
router.post('/supplier-payments', validate(createSupplierPaymentSchema), h(suppliers.createPayment));

// Sales / billing
router.get('/sales', validate(saleListQuery, 'query'), h(misc.listSales));
router.post('/sales', validate(createSaleSchema), h(misc.createSale));
router.get('/sales/:id', id, h(misc.getSale));

// Dashboard + reports
router.get('/dashboard/summary', h(misc.summary));
router.get('/dashboard/charts', h(misc.charts));
router.get('/reports/:name', validate(dateRangeQuery.extend({ format: z.enum(['json', 'csv']).optional() }), 'query'), h(misc.report));

// AI voice assistant
router.get('/ai/status', h(misc.aiStatus));
router.post('/ai/parse-command', aiLimiter, validate(misc.parseCommandSchema), h(misc.parseCommand));
router.post('/ai/transcribe', sttLimiter, misc.audioBody, h(misc.transcribe));

// Bill photo -> purchase draft (Claude vision); the photo is kept and shown with the purchase.
router.post('/ai/scan-bill', scanLimiter, billScan.imageBody, h(billScan.scanBill));
router.get('/bill-images/:id', id, h(billScan.image));
router.post('/bill-images/:id/attach', id, validate(billScan.attachSchema), h(billScan.attach));
router.get('/purchases/:id/bill-image', id, h(billScan.purchaseImage));
router.get('/voice-logs', validate(listQuery.extend({ status: z.string().optional() }), 'query'), h(misc.listLogs));
router.patch('/voice-logs/:id', id, validate(misc.voiceLogPatchSchema), h(misc.patchLog));
router.post('/ai/execute-batch', validate(misc.executeBatchSchema), h(misc.executeBatch));
router.post('/ai/undo-last', h(misc.undoLast));
router.post('/ai/undo/:id', id, h(misc.undoLog));
router.post('/ai/learn-aliases', validate(misc.learnAliasesSchema), h(misc.learnAliasesHandler));

// Settings
router.get('/settings/backup', h(misc.backup));
router.get('/settings/data-counts', h(misc.dataCounts));
router.post('/settings/sample-data', h(misc.sampleData));

export default router;
