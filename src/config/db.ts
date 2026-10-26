import mongoose, { type ClientSession } from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { env } from './env';
import { logger } from './logger';

let memoryServer: MongoMemoryReplSet | null = null;
let transactionsSupported = false;

/** True when the server is running against the throwaway in-memory replica set. */
export const isMemoryDb = (): boolean => memoryServer !== null;
/** False on a standalone mongod: multi-document writes then cannot roll back. */
export const transactionsEnabled = (): boolean => transactionsSupported;

export async function connectDb(uri: string = env.MONGODB_URI): Promise<void> {
  let connectionUri = uri;

  if (uri === 'memory') {
    // Lazy import so production builds never touch the memory server binary.
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    connectionUri = memoryServer.getUri('dukaansathi');
    logger.warn('Using in-memory MongoDB replica set - data will be lost on restart');
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(connectionUri);
  transactionsSupported = await detectTransactionSupport();
  logger.info(`MongoDB connected (${mongoose.connection.name}), transactions: ${transactionsSupported ? 'on' : 'OFF'}`);
  if (!transactionsSupported) {
    logger.warn(
      'MongoDB is standalone: multi-collection writes will run WITHOUT transactions. ' +
        'Run scripts/enable-mongo-replica.ps1 as Administrator to enable them.',
    );
  }
}

/** Transactions need a replica set member or mongos. */
async function detectTransactionSupport(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (!db) return false;
  const hello = (await db.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
  return Boolean(hello.setName) || hello.msg === 'isdbgrid';
}

/**
 * Runs `fn` inside a transaction when the server supports it. On a standalone
 * dev server it runs without a session so the app still works (no atomicity).
 */
export async function runInTransaction<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  if (!transactionsSupported) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
