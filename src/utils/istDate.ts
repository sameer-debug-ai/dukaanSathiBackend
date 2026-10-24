/**
 * Asia/Kolkata date helpers. IST is a fixed UTC+05:30 offset (no DST),
 * so day boundaries can be computed with plain arithmetic.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC instant of 00:00 IST on the IST calendar day containing `date`. */
export function startOfIstDay(date: Date = new Date()): Date {
  const istMs = date.getTime() + IST_OFFSET_MS;
  const istMidnight = Math.floor(istMs / DAY_MS) * DAY_MS;
  return new Date(istMidnight - IST_OFFSET_MS);
}

export function endOfIstDay(date: Date = new Date()): Date {
  return new Date(startOfIstDay(date).getTime() + DAY_MS - 1);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** "YYYY-MM-DD" key for the IST calendar day, handy for grouping chart data. */
export function istDayKey(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Parses "YYYY-MM-DD" as an IST calendar day and returns its start instant. */
export function parseIstDay(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}

/** Resolves a from/to query range (IST days) with sensible defaults. */
export function resolveRange(from?: string, to?: string, defaultDays = 30): { from: Date; to: Date } {
  const end = to ? endOfIstDay(parseIstDay(to)) : endOfIstDay();
  const start = from ? parseIstDay(from) : startOfIstDay(addDays(end, -(defaultDays - 1)));
  return { from: start, to: end };
}

export const IST_TIMEZONE = 'Asia/Kolkata';
