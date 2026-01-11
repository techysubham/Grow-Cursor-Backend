import mongoose from 'mongoose';

const customColumnSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  dataType: {
    type: String,
    enum: ['text', 'number', 'multiselect', 'boolean'],
    default: 'text'
  },
  defaultValue: {
    type: String,
    default: ''
  },
  isRequired: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    required: true
  },
  placeholder: {
    type: String,
    default: ''
  }
}, { _id: false });

const listingTemplateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    default: ''
  },
  ebayCategory: {
    id: {
      type: Number
    },
    name: {
      type: String
    }
  },
  customColumns: [customColumnSchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

listingTemplateSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('ListingTemplate', listingTemplateSchema);
