import { createHash, randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { Customer } from '../models/customer.model';
import { CustomerLedger } from '../models/customerLedger.model';
import { KhataLink } from '../models/khataLink.model';
import { User } from '../models/user.model';
import { AppError } from '../utils/AppError';
import { shopUpiLink } from '../utils/upi';
import { getCustomer } from './customer.service';
import { computeRunningBalance } from './ledger.service';

/** 32 random bytes, base64url: 43 characters, impossible to guess. */
const TOKEN_RX = /^[A-Za-z0-9_-]{43}$/;
/** Most recent entries shown on the public page. */
export const PUBLIC_ENTRIES = 200;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** One message for every failure, so a visitor cannot tell a revoked link from one that never existed. */
const notFound = () => AppError.notFound('This khata link is not valid. Please ask the shop for a new one.');

export interface KhataLinkStatus {
  active: boolean;
  createdAt: Date | null;
  lastViewedAt: Date | null;
  views: number;
}

export async function khataLinkStatus(shopId: Types.ObjectId, customerId: string): Promise<KhataLinkStatus> {
  await getCustomer(shopId, customerId);
  const link = await KhataLink.findOne({ shopId, customerId, revokedAt: null }).sort({ createdAt: -1 });
  return { active: !!link, createdAt: link?.createdAt ?? null, lastViewedAt: link?.lastViewedAt ?? null, views: link?.views ?? 0 };
}

/**
 * New link for a customer; any earlier link stops working. The token is returned only here
 * (it is stored hashed), so the shopkeeper copies / shares it now or generates a new one later.
 */
export async function createKhataLink(shopId: Types.ObjectId, customerId: string): Promise<{ token: string } & KhataLinkStatus> {
  const customer = await getCustomer(shopId, customerId);
  await KhataLink.updateMany({ shopId, customerId: customer._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  const token = randomBytes(32).toString('base64url');
  const link = await KhataLink.create({ shopId, customerId: customer._id, tokenHash: hashToken(token) });
  return { token, active: true, createdAt: link.createdAt, lastViewedAt: null, views: 0 };
}

export async function revokeKhataLink(shopId: Types.ObjectId, customerId: string): Promise<KhataLinkStatus> {
  const customer = await getCustomer(shopId, customerId);
  await KhataLink.updateMany({ shopId, customerId: customer._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return { active: false, createdAt: null, lastViewedAt: null, views: 0 };
}

export interface PublicKhata {
  shop: { name: string; phone: string; address: string };
  customer: { name: string };
  balance: number;
  entries: { date: Date; type: 'credit' | 'payment'; amount: number; note: string; items: { name: string; qty: number }[]; balance: number }[];
  /** True when older entries were left out. */
  truncated: boolean;
  upiLink: string | null;
  upiId: string | null;
  generatedAt: Date;
}

/**
 * The public, read-only khata. Returns only what the customer may see about their own account:
 * no ids, no other customers, no internal fields.
 */
export async function publicKhata(token: string): Promise<PublicKhata> {
  if (!TOKEN_RX.test(token)) throw notFound();
  const link = await KhataLink.findOne({ tokenHash: hashToken(token), revokedAt: null });
  if (!link) throw notFound();
  const { shopId, customerId } = link;
  const [customer, shop] = await Promise.all([
    Customer.findOne({ _id: customerId, shopId, isDeleted: false }).select('name currentBalance'),
    User.findById(shopId).select('shopName phone shopAddress settings'),
  ]);
  if (!customer || !shop) throw notFound();

  const total = await CustomerLedger.countDocuments({ shopId, customerId });
  const recent = await CustomerLedger.find({ shopId, customerId })
    .sort({ date: -1, createdAt: -1 })
    .limit(PUBLIC_ENTRIES)
    .select('type amount date note items');
  const chronological = recent.reverse();
  // Opening balance for the shown part = current balance minus what the shown entries add up to.
  const shownDelta = chronological.reduce((s, e) => s + (e.type === 'credit' ? e.amount : -e.amount), 0);
  const rows = computeRunningBalance(
    chronological.map((e) => ({ type: e.type as 'credit' | 'payment', amount: e.amount, date: e.date, note: e.note ?? '', items: e.items ?? [] })),
    customer.currentBalance - shownDelta,
  );

  await KhataLink.updateOne({ _id: link._id }, { $set: { lastViewedAt: new Date() }, $inc: { views: 1 } });

  const upiLink = customer.currentBalance > 0 ? shopUpiLink(shop.settings, shop.shopName, customer.currentBalance, `Udhaar ${customer.name}`) : null;
  return {
    shop: { name: shop.shopName, phone: shop.phone, address: shop.shopAddress ?? '' },
    customer: { name: customer.name },
    balance: customer.currentBalance,
    entries: rows
      .map((r) => ({
        date: r.entry.date,
        type: r.entry.type,
        amount: r.entry.amount,
        note: r.entry.note,
        items: r.entry.items.map((i) => ({ name: i.name, qty: i.qty })),
        balance: r.balance,
      }))
      .reverse(),
    truncated: total > PUBLIC_ENTRIES,
    upiLink,
    upiId: upiLink ? (shop.settings?.upiId ?? null) : null,
    generatedAt: new Date(),
  };
}
