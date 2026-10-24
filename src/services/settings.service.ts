import type { Types } from 'mongoose';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { Product } from '../models/product.model';
import { Purchase } from '../models/purchase.model';
import { Sale } from '../models/sale.model';
import { StockMovement } from '../models/stockMovement.model';
import { Supplier } from '../models/supplier.model';
import { SupplierPayment } from '../models/supplierPayment.model';
import { User } from '../models/user.model';
import { VoiceCommandLog } from '../models/voiceCommandLog.model';
import { generateSampleData } from '../scripts/sampleData';
import { AppError } from '../utils/AppError';

export async function shopDataCounts(shopId: Types.ObjectId) {
  const [products, customers, suppliers, sales, purchases] = await Promise.all([
    Product.countDocuments({ shopId, isDeleted: false }),
    Customer.countDocuments({ shopId, isDeleted: false }),
    Supplier.countDocuments({ shopId, isDeleted: false }),
    Sale.countDocuments({ shopId }),
    Purchase.countDocuments({ shopId }),
  ]);
  return { products, customers, suppliers, sales, purchases, isEmpty: products + customers + suppliers + sales + purchases === 0 };
}

/** Fills an EMPTY shop with demo data. Refuses if the shop already has records, so real data is never mixed. */
export async function loadSampleData(shopId: Types.ObjectId) {
  const counts = await shopDataCounts(shopId);
  if (!counts.isEmpty) {
    throw AppError.conflict('Sample data can only be loaded into an empty shop. Your shop already has data.');
  }
  return generateSampleData(shopId);
}

/** Everything the shop owns, as plain JSON. */
export async function exportBackup(shopId: Types.ObjectId) {
  const q = { shopId };
  const [shop, products, stockMovements, customers, customerLedger, suppliers, purchases, supplierPayments, sales, voiceLogs] =
    await Promise.all([
      User.findById(shopId),
      Product.find(q),
      StockMovement.find(q),
      Customer.find(q),
      CustomerLedger.find(q),
      Supplier.find(q),
      Purchase.find(q),
      SupplierPayment.find(q),
      Sale.find(q),
      VoiceCommandLog.find(q),
    ]);
  const json = (docs: { toJSON: () => unknown }[]) => docs.map((d) => d.toJSON());
  return {
    format: 'dukaansathi-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    note: 'All money values are in paise (₹1 = 100).',
    shop: shop?.toJSON(),
    products: json(products),
    stockMovements: json(stockMovements),
    customers: json(customers),
    customerLedger: json(customerLedger),
    suppliers: json(suppliers),
    purchases: json(purchases),
    supplierPayments: json(supplierPayments),
    sales: json(sales),
    voiceLogs: json(voiceLogs),
  };
}
