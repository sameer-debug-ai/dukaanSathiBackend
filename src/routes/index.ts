import { Router } from 'express';
import * as customers from '../controllers/customer.controller';
import * as misc from '../controllers/misc.controller';
import * as products from '../controllers/product.controller';
import * as suppliers from '../controllers/supplier.controller';
import { requireAuth } from '../middlewares/auth';
import { aiLimiter } from '../middlewares/rateLimit';
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
router.get('/voice-logs', validate(listQuery.extend({ status: z.string().optional() }), 'query'), h(misc.listLogs));
router.patch('/voice-logs/:id', id, validate(misc.voiceLogPatchSchema), h(misc.patchLog));

// Settings
router.get('/settings/backup', h(misc.backup));
router.get('/settings/data-counts', h(misc.dataCounts));
router.post('/settings/sample-data', h(misc.sampleData));

export default router;
