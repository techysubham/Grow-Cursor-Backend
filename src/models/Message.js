import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    messageId: { type: String, required: true, unique: true }, // eBay message/inquiry ID
    orderId: String, // Related order ID (if applicable)
    legacyOrderId: String,
    
    // Buyer information
    buyerUsername: String,
    
    // Message details
    subject: String,
    messageText: String,
    messageType: String, // e.g., "INQUIRY", "QUESTION", "ISSUE"
    inquiryStatus: String, // e.g., "OPEN", "CLOSED", "PENDING_SELLER_RESPONSE"
    
    // Item details (if related to specific item)
    itemId: String,
    itemTitle: String,
    
    // Status tracking
    isResolved: { type: Boolean, default: false },
    resolvedAt: Date,
    resolvedBy: String, // Username who resolved it
    
    // Dates
    creationDate: Date,
    responseDate: Date, // When seller must respond by
    lastMessageDate: Date,
    
    // Full eBay response (for reference)
    rawData: Object
  },
  { timestamps: true }
);

// Indexes for faster queries
MessageSchema.index({ seller: 1, creationDate: -1 });
// Note: messageId already has unique index from schema definition
MessageSchema.index({ orderId: 1 });
MessageSchema.index({ isResolved: 1, creationDate: -1 });
MessageSchema.index({ inquiryStatus: 1, creationDate: -1 });

export default mongoose.model('Message', MessageSchema);
