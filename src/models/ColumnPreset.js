import mongoose from 'mongoose';

const ColumnPresetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    columns: [{ type: String }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

export default mongoose.model('ColumnPreset', ColumnPresetSchema);
