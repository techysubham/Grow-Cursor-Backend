import mongoose from 'mongoose';

/**
 * OrderMetrics — satellite collection for micro-order computed fields.
 * Keyed by orderId (string) to avoid cluttering the Orders collection.
 * These values can be backfilled via scripts/backfill-order-metrics.js.
 *
 * Fields computed from Order.subtotal and Order.pBalanceINR:
 *   sellerCost       = subtotal (USD)
 *   sellerMarkupFee  = subtotal × 90 × 0.04  (INR)
 *   sellerIGST       = sellerMarkupFee × 0.18 (INR)
 *   profitFake       = pBalanceINR − sellerMarkupFee − sellerIGST (INR)
 */
const OrderMetricsSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    order:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },

    // Computed financial metrics (all INR unless annotated)
    sellerCost:      { type: Number, default: 0 }, // USD — same as subtotal
    sellerMarkupFee: { type: Number, default: 0 }, // INR
    sellerIGST:      { type: Number, default: 0 }, // INR
    profitFake:      { type: Number, default: 0 }, // INR
  },
  { timestamps: true }
);

export default mongoose.model('OrderMetrics', OrderMetricsSchema);
