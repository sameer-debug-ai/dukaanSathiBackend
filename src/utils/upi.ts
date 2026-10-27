/**
 * UPI deep links (NPCI "upi://pay" format) so a customer can pay the pending udhaar from any
 * UPI app. Amounts are paise internally and rupees with two decimals in the link.
 */

/** Virtual payment address, e.g. "sharmastore@okaxis", "9876543210@ybl". */
export const VPA_RX = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

export interface UpiLinkInput {
  vpa: string;
  name: string;
  /** Paise; omitted or 0 lets the payer type the amount. */
  amount?: number | null;
  /** Kept for callers; not put in the link (see below). */
  note?: string;
}

// encodeURIComponent, not URLSearchParams: some UPI apps show a "+" for spaces literally.
const enc = (s: string) => encodeURIComponent(s.trim());

/**
 * Plain person-to-person link: only pa, pn, am, cu. A transaction note (tn) on a personal
 * (non-merchant) UPI ID made some receiver banks decline QR payments ("duplicate RRN"), so it is
 * left out; the payer can still add a note in their app.
 */
export function upiLink({ vpa, name, amount }: UpiLinkInput): string {
  const parts = [`pa=${vpa.trim()}`, `pn=${enc(name || vpa)}`];
  if (amount && amount > 0) parts.push(`am=${(Math.round(amount) / 100).toFixed(2)}`);
  parts.push('cu=INR');
  return `upi://pay?${parts.join('&')}`;
}

/** The shop's UPI link for an amount, or null when the shop has not set a valid UPI ID. */
export function shopUpiLink(settings: { upiId?: string | null; upiPayeeName?: string | null } | null | undefined, shopName: string, amount: number, note: string): string | null {
  const vpa = settings?.upiId?.trim();
  if (!vpa || !VPA_RX.test(vpa)) return null;
  return upiLink({ vpa, name: settings?.upiPayeeName?.trim() || shopName, amount, note });
}
