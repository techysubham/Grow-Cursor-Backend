import mongoose from 'mongoose';

const ExchangeRateSchema = new mongoose.Schema(
  {
    rate: {
      type: Number,
      required: true
    },
    effectiveDate: {
      type: Date,
      required: true
    },
    marketplace: {
      type: String,
      default: 'EBAY',
      enum: ['EBAY', 'AMAZON', 'OTHER']
    },
    createdBy: {
      type: String,
      default: 'system'
    },
    notes: String
  },
  { timestamps: true }
);

// Index for faster queries
ExchangeRateSchema.index({ effectiveDate: -1, marketplace: 1 });

export default mongoose.model('ExchangeRate', ExchangeRateSchema);
