import mongoose from 'mongoose';


const SellerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    ebayMarketplaces: [{ type: String, required: true }], // e.g., ['EBAY_US', 'EBAY_UK']
    ebayTokens: {
      access_token: String,
      refresh_token: String,
      expires_in: Number,
      refresh_token_expires_in: Number,
      token_type: String,
      scope: String,
      fetchedAt: Date
    }
  },
  { timestamps: true }
);

export default mongoose.model('Seller', SellerSchema);
