import bcrypt from 'bcryptjs';
import { logger } from '../config/logger';
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
import { generateSampleData } from './sampleData';

export const DEMO_PHONE = '9876543210';
export const DEMO_PASSWORD = 'demo123';

/** Recreates the demo shop with 60 days of sample data. Only the demo shop is touched. */
export async function seedDemoShop(): Promise<void> {
  const existing = await User.findOne({ phone: DEMO_PHONE });
  if (existing) {
    const shopId = existing._id;
    await Promise.all(
      [Product, StockMovement, Customer, CustomerLedger, Supplier, Purchase, SupplierPayment, Sale, VoiceCommandLog].map((m) =>
        (m as typeof Product).deleteMany({ shopId }),
      ),
    );
    await User.deleteOne({ _id: shopId });
  }

  const user = await User.create({
    name: 'Ramesh Kumar',
    phone: DEMO_PHONE,
    passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
    shopName: 'Kumar General Store',
    shopAddress: 'Main Bazaar, Lucknow, Uttar Pradesh',
    preferredLanguage: 'en',
  });
  const counts = await generateSampleData(user._id);
  logger.info(`Demo shop seeded (${JSON.stringify(counts)}) - login with ${DEMO_PHONE} / ${DEMO_PASSWORD}`);
}
