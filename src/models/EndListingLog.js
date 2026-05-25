import mongoose from 'mongoose';

const EndListingLogSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
  itemId: { type: String, required: true },
  source: {
    type: String,
    enum: ['duplicate_sku', 'expiry_listing'],
    required: true,
  },
  endedAt: { type: Date, default: Date.now },
}, { timestamps: false });

EndListingLogSchema.index({ seller: 1, endedAt: -1 });
EndListingLogSchema.index({ endedAt: -1 });

export default mongoose.model('EndListingLog', EndListingLogSchema);
