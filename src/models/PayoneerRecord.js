import mongoose from 'mongoose';

const PayoneerRecordSchema = new mongoose.Schema(
    {
        bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },

        paymentDate: { type: Date, required: true },
        amount: { type: Number, required: true }, // Amount in USD (presumably)
        exchangeRate: { type: Number, required: true },
        actualExchangeRate: { type: Number, required: true }, // Calculated: Rate + 2%
        bankDeposit: { type: Number, required: true }, // Calculated: Amount * ActualRate
        store: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true }
    },
    { timestamps: true }
);

export default mongoose.model('PayoneerRecord', PayoneerRecordSchema);
