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

const fieldConfigSchema = new mongoose.Schema({
  ebayField: {
    type: String,
    required: true,
    enum: [
      'title', 'startPrice', 'buyItNowPrice', 'description', 
      'itemPhotoUrl', 'categoryName', 'brand', 'location',
      'videoId', 'upc', 'relationship', 'relationshipDetails'
    ]
  },
  source: {
    type: String,
    enum: ['ai', 'direct'],
    default: 'ai'
  },
  promptTemplate: String,
  amazonField: String,
  transform: {
    type: String,
    enum: ['none', 'pipeSeparated', 'removeSymbol', 'htmlFormat', 'truncate80'],
    default: 'none'
  },
  enabled: {
    type: Boolean,
    default: true
  }
}, { _id: false });

const asinAutomationSchema = new mongoose.Schema({
  enabled: {
    type: Boolean,
    default: false
  },
  fieldConfigs: [fieldConfigSchema]
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
  asinAutomation: {
    type: asinAutomationSchema,
    default: { enabled: false, fieldConfigs: [] }
  },
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
