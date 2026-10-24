import { connectDb, disconnectDb } from '../config/db';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { seedDemoShop } from './seedData';

/** Recreates the demo shop (phone 9876543210). Other shops are not touched. */
async function run(): Promise<void> {
  if (env.MONGODB_URI === 'memory') {
    logger.warn('MONGODB_URI=memory: the in-memory server seeds itself on startup (AUTO_SEED=true). Nothing to do.');
    return;
  }
  await connectDb();
  await seedDemoShop();
  await disconnectDb();
}

run().catch((err) => {
  logger.error('Seed failed', err);
  process.exit(1);
});
