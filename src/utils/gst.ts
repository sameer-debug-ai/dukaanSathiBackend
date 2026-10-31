import { istDayKey } from './istDate';

/** GST state codes (first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

const GSTIN_RX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check character (15th) computed from the first 14 (GSTN's mod-36 scheme). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

/** Format, known state code and check character. */
export function isValidGstin(value: string): boolean {
  const v = value.trim().toUpperCase();
  return GSTIN_RX.test(v) && v.slice(0, 2) in GST_STATES && gstinCheckChar(v.slice(0, 14)) === v[14];
}

export const stateOfGstin = (gstin: string | null | undefined): string => (gstin && gstin.length >= 2 ? gstin.slice(0, 2) : '');

/** Indian financial year (Apr-Mar) of a date, in IST: 2026-04-01 -> "2026-27". */
export function financialYear(date: Date): string {
  const [y, m] = istDayKey(date).split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** "KGS/2026-27/0001" (GST allows at most 16 characters: letters, digits, "/" and "-"). */
export const formatInvoiceNo = (prefix: string, fy: string, seq: number): string =>
  [prefix, fy, String(seq).padStart(4, '0')].filter(Boolean).join('/');

/** Default invoice prefix from the shop name: "Kumar General Store" -> "KGS". */
export function defaultInvoicePrefix(shopName: string): string {
  const initials = shopName
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, '')[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 4);
  return initials || 'INV';
}
