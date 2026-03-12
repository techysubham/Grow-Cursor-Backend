import mongoose from 'mongoose';

const FitmentCacheSchema = new mongoose.Schema({
  // Unique Key to identify the list (e.g., "MAKES" or "MODELS_Ford" or "YEARS_Ford_F-150")
  cacheKey: { type: String, required: true, unique: true, index: true },
  
  // The actual list of values (e.g., ["Ford", "BMW", ...])
  values: [{ type: String }],
  
  lastUpdated: { type: Date, default: Date.now },

  // TTL: MongoDB will auto-delete this document after expireAt
  expireAt: { type: Date, required: true }
});

// MongoDB TTL index — deletes docs when current time >= expireAt
FitmentCacheSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('FitmentCache', FitmentCacheSchema);