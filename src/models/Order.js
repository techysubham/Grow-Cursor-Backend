import mongoose from 'mongoose';

const OrderSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    orderId: { type: String, required: true, unique: true },
    legacyOrderId: String,
    creationDate: Date,
    lastModifiedDate: Date,
    orderFulfillmentStatus: String,
    orderPaymentStatus: String,
    sellerId: String, // eBay seller ID
    buyer: Object,
    buyerCheckoutNotes: String,
    pricingSummary: Object,
    cancelStatus: Object,
    paymentSummary: Object,
    fulfillmentStartInstructions: Array,
    lineItems: Array,
    ebayCollectAndRemitTax: Boolean,
    salesRecordReference: String,
    totalFeeBasisAmount: Object,
    totalMarketplaceFee: Object,
    // Denormalized fields for easy display
    dateSold: Date,
    shipByDate: Date,
    estimatedDelivery: Date,
    productName: String,
    itemNumber: String,
    buyerAddress: String,
    // Shipping address fields
    shippingFullName: String,
    shippingAddressLine1: String,
  shippingAddressLine2: String,
    shippingCity: String,
    shippingState: String,
    shippingPostalCode: String,
    shippingCountry: String,
    shippingPhone: String,
    quantity: Number,
    subtotal: Number,
    salesTax: Number,
    discount: Number,
    shipping: Number,
    transactionFees: Number,
    adFee: Number,
    adFeeGeneral: Number, // Manually editable ad fee
    // USD converted values
    subtotalUSD: Number,
    shippingUSD: Number,
    salesTaxUSD: Number,
    discountUSD: Number,
    transactionFeesUSD: Number,
    refundTotalUSD: Number, // Total refund amount in USD
    beforeTaxUSD: Number, // Amazon order before tax amount in USD
    estimatedTaxUSD: Number, // Amazon estimated tax in USD
    conversionRate: Number, // Stored conversion rate for reference
    cancelState: String, // NONE_REQUESTED, CANCEL_REQUESTED, CANCELED, etc.
    refunds: Array, // Array of refund objects from paymentSummary.refunds
    trackingNumber: String, // Extracted from fulfillmentHrefs
    manualTrackingNumber: String, // Manually entered tracking number (separate from trackingNumber)
    purchaseMarketplaceId: String, // e.g., EBAY_US, EBAY_AUS, EBAY_Canada
    messagingStatus: { 
      type: String, 
      enum: ['Not Yet Started', 'Ongoing Conversation', 'Resolved'],
      default: 'Not Yet Started'
    },
    itemStatus: {
      type: String,
      enum: ['None', 'Out of Stock', 'Delayed Delivery', 'Label Created', 'Other'],
      default: 'None'
    },
    resolvedFrom: String, // Track which page it was resolved from: 'Return', 'Replace', or 'INR'
    notes: String, // Notes field for internal use
    fulfillmentNotes: String,
    amazonAccount: String,
    arrivingDate: String,
    beforeTax: Number,
    estimatedTax: Number,
    azOrderId: String,
    amazonRefund: Number,
    cardName: String, // Reference to credit card name
  },
  { timestamps: true }
);

// Index for faster queries
OrderSchema.index({ seller: 1, orderId: 1 });
OrderSchema.index({ seller: 1, creationDate: -1 });
OrderSchema.index({ seller: 1, lastModifiedDate: -1 });
OrderSchema.index({ seller: 1, creationDate: -1, lastModifiedDate: -1 }); // Compound index for polling queries
OrderSchema.index({ dateSold: 1 }); // Index for date range searches
OrderSchema.index({ cancelState: 1, creationDate: -1 }); // Index for cancelled orders queries

export default mongoose.model('Order', OrderSchema);
