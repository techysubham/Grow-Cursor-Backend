import mongoose from 'mongoose';

const UserSellerAssignmentSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        seller: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true, unique: true }, // One seller -> one user
    },
    { timestamps: true }
);

export default mongoose.model('UserSellerAssignment', UserSellerAssignmentSchema);
