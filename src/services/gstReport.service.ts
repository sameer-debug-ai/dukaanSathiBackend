import type { Types } from 'mongoose';
import { NOT_CANCELLED, Sale } from '../models/sale.model';
import { GST_STATES } from '../utils/gst';
import { istDayKey, resolveRange } from '../utils/istDate';
import type { Report } from './report.service';

/**
 * GST reports from saved tax invoices (cancelled bills left out). Rows use GSTR-1 style
 * columns so the CSV can be handed to an accountant or pasted into the offline tool.
 */

interface Range {
  from?: string;
  to?: string;
}

const placeOfSupply = (code?: string | null) => (code ? `${code}-${GST_STATES[code] ?? ''}` : '');

/** One row per invoice per tax rate: invoice no, buyer, place of supply, taxable value and tax. */
export async function gstRegisterReport(shopId: Types.ObjectId, q: Range): Promise<Report> {
  const r = resolveRange(q.from, q.to, 30);
  const sales = await Sale.find({ shopId, docType: 'tax_invoice', date: { $gte: r.from, $lte: r.to }, ...NOT_CANCELLED }).sort({ date: 1, billNumber: 1 });
  const rows: Record<string, unknown>[] = [];
  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, value: 0 };
  for (const s of sales) {
    const sellerState = s.seller?.stateCode ?? '';
    const pos = s.buyer?.stateCode || sellerState;
    const summary = s.taxSummary ?? [];
    summary.forEach((t, i) => {
      // Invoice value goes on the first rate line only, like GSTR-1.
      const value = i === 0 ? s.totalAmount : 0;
      rows.push({
        invoiceNo: s.invoiceNo ?? `#${s.billNumber}`,
        date: istDayKey(s.date),
        type: s.buyer?.gstin ? 'B2B' : 'B2C',
        buyer: s.buyer?.name || s.customerName || 'Walk-in',
        gstin: s.buyer?.gstin ?? '',
        pos: placeOfSupply(pos),
        rate: t.rate,
        taxable: t.taxable,
        cgst: t.cgst,
        sgst: t.sgst,
        igst: t.igst,
        value,
      });
      totals.taxable += t.taxable;
      totals.cgst += t.cgst;
      totals.sgst += t.sgst;
      totals.igst += t.igst;
      totals.value += value;
    });
  }
  return {
    title: 'GST sales register',
    from: istDayKey(r.from),
    to: istDayKey(r.to),
    columns: [
      { key: 'invoiceNo', label: 'Invoice No', type: 'text' },
      { key: 'date', label: 'Invoice Date', type: 'date' },
      { key: 'type', label: 'Type', type: 'text' },
      { key: 'buyer', label: 'Buyer', type: 'text' },
      { key: 'gstin', label: 'GSTIN/UIN of Recipient', type: 'text' },
      { key: 'pos', label: 'Place Of Supply', type: 'text' },
      { key: 'rate', label: 'Rate (%)', type: 'number' },
      { key: 'taxable', label: 'Taxable Value', type: 'money' },
      { key: 'cgst', label: 'CGST', type: 'money' },
      { key: 'sgst', label: 'SGST', type: 'money' },
      { key: 'igst', label: 'IGST', type: 'money' },
      { key: 'value', label: 'Invoice Value', type: 'money' },
    ],
    rows,
    totals,
  };
}

/** HSN-wise summary (GSTR-1 table 12): quantity, taxable value and tax per HSN code and rate. */
export async function gstHsnReport(shopId: Types.ObjectId, q: Range): Promise<Report> {
  const r = resolveRange(q.from, q.to, 30);
  const groups = await Sale.aggregate<{
    _id: { hsn: string; rate: number; unit: string };
    name: string;
    qty: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
  }>([
    { $match: { shopId, docType: 'tax_invoice', date: { $gte: r.from, $lte: r.to }, ...NOT_CANCELLED } },
    { $unwind: '$items' },
    {
      $group: {
        _id: { hsn: { $ifNull: ['$items.hsnCode', ''] }, rate: { $ifNull: ['$items.gstRate', 0] }, unit: '$items.unit' },
        name: { $first: '$items.name' },
        qty: { $sum: '$items.qty' },
        taxable: { $sum: { $ifNull: ['$items.taxable', 0] } },
        cgst: { $sum: { $ifNull: ['$items.cgst', 0] } },
        sgst: { $sum: { $ifNull: ['$items.sgst', 0] } },
        igst: { $sum: { $ifNull: ['$items.igst', 0] } },
      },
    },
    { $sort: { '_id.hsn': 1, '_id.rate': 1 } },
  ]);
  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, value: 0 };
  const rows = groups.map((g) => {
    const value = g.taxable + g.cgst + g.sgst + g.igst;
    totals.taxable += g.taxable;
    totals.cgst += g.cgst;
    totals.sgst += g.sgst;
    totals.igst += g.igst;
    totals.value += value;
    return {
      hsn: g._id.hsn || '(no HSN)',
      description: g.name,
      uqc: UQC[g._id.unit] ?? 'OTH-OTHERS',
      qty: Math.round(g.qty * 1000) / 1000,
      rate: g._id.rate,
      value,
      taxable: g.taxable,
      igst: g.igst,
      cgst: g.cgst,
      sgst: g.sgst,
    };
  });
  return {
    title: 'GST HSN summary',
    from: istDayKey(r.from),
    to: istDayKey(r.to),
    columns: [
      { key: 'hsn', label: 'HSN', type: 'text' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'uqc', label: 'UQC', type: 'text' },
      { key: 'qty', label: 'Total Quantity', type: 'number' },
      { key: 'rate', label: 'Rate (%)', type: 'number' },
      { key: 'value', label: 'Total Value', type: 'money' },
      { key: 'taxable', label: 'Taxable Value', type: 'money' },
      { key: 'igst', label: 'Integrated Tax Amount', type: 'money' },
      { key: 'cgst', label: 'Central Tax Amount', type: 'money' },
      { key: 'sgst', label: 'State/UT Tax Amount', type: 'money' },
    ],
    rows,
    totals,
  };
}

/** GST "Unit Quantity Code" for the app's units. */
const UQC: Record<string, string> = {
  kg: 'KGS-KILOGRAMS',
  g: 'GMS-GRAMMES',
  litre: 'LTR-LITRES',
  ml: 'MLT-MILILITRE',
  piece: 'PCS-PIECES',
  packet: 'PAC-PACKS',
  dozen: 'DOZ-DOZENS',
  box: 'BOX-BOX',
};
