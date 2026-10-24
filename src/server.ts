import { createApp } from './app';
import { connectDb, disconnectDb } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { User } from './models/user.model';

async function main(): Promise<void> {
  await connectDb();

  // Only seeds an empty database, so real shop data is never touched.
  if (env.AUTO_SEED && (await User.estimatedDocumentCount()) === 0) {
    try {
      const { seedDemoShop } = await import('./scripts/seedData');
      await seedDemoShop();
    } catch (err) {
      logger.warn('Auto-seed skipped', err);
    }
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`DukaanSathi API listening on http://localhost:${env.PORT}/api`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
