/** All money is stored as integer paise. These helpers keep conversions in one place. */

export const rupeesToPaise = (rupees: number): number => Math.round(rupees * 100);

export const paiseToRupees = (paise: number): number => paise / 100;

/** Line total in paise for a quantity (may be fractional, e.g. 0.5 kg) at a per-unit rate in paise. */
export const lineTotal = (qty: number, ratePaise: number): number => Math.round(qty * ratePaise);

/** Formats paise as ₹ with Indian digit grouping, e.g. 12500000 -> "₹1,25,000". */
export function formatInr(paise: number): string {
  const rupees = paise / 100;
  const hasFraction = Math.round(rupees * 100) % 100 !== 0;
  return (
    '₹' +
    rupees.toLocaleString('en-IN', {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}
