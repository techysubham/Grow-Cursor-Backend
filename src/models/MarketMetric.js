import mongoose from 'mongoose';

const marketMetricSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['bbe_market_avg'],
    default: 'bbe_market_avg'
  },
  value: {
    type: Number,
    required: true
  },
  effectiveDate: {
    type: Date,
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Index for efficient querying by date
marketMetricSchema.index({ type: 1, effectiveDate: -1 });

const MarketMetric = mongoose.model('MarketMetric', marketMetricSchema);

export default MarketMetric;
