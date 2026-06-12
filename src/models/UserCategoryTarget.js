import mongoose from 'mongoose';

const UserCategoryTargetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    dailyDesiredQuantity: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true }
);

UserCategoryTargetSchema.index({ user: 1, seller: 1, category: 1 }, { unique: true });

export default mongoose.model('UserCategoryTarget', UserCategoryTargetSchema);
