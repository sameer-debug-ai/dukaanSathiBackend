/* Minimal leveled logger. Swap for pino/winston later without touching call sites. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const silent = process.env.NODE_ENV === 'test';

function log(level: Level, message: string, meta?: unknown): void {
  if (silent && level !== 'error') return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) out(line, meta);
  else out(line);
}

export const logger = {
  debug: (m: string, meta?: unknown) => log('debug', m, meta),
  info: (m: string, meta?: unknown) => log('info', m, meta),
  warn: (m: string, meta?: unknown) => log('warn', m, meta),
  error: (m: string, meta?: unknown) => log('error', m, meta),
};
