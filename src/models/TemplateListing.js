import mongoose from 'mongoose';

const templateListingSchema = new mongoose.Schema({
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ListingTemplate',
    required: true
  },
  
  // CORE COLUMNS (38 fixed fields)
  action: {
    type: String,
    default: 'Add'
  },
  customLabel: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  categoryId: Number,
  categoryName: String,
  title: {
    type: String,
    required: true,
    maxlength: 80
  },
  relationship: String,
  relationshipDetails: String,
  scheduleTime: Date,
  upc: String,
  epid: String,
  startPrice: {
    type: Number,
    required: true
  },
  quantity: {
    type: Number,
    default: 1
  },
  itemPhotoUrl: String,
  videoId: String,
  conditionId: {
    type: String,
    default: '1000-New'
  },
  description: String,
  format: {
    type: String,
    default: 'FixedPrice'
  },
  duration: {
    type: String,
    default: 'GTC'
  },
  buyItNowPrice: Number,
  bestOfferEnabled: Boolean,
  bestOfferAutoAcceptPrice: Number,
  minimumBestOfferPrice: Number,
  immediatePayRequired: Boolean,
  location: {
    type: String,
    default: 'UnitedStates'
  },
  shippingService1Option: String,
  shippingService1Cost: Number,
  shippingService1Priority: Number,
  shippingService2Option: String,
  shippingService2Cost: Number,
  shippingService2Priority: Number,
  maxDispatchTime: Number,
  returnsAcceptedOption: String,
  returnsWithinOption: String,
  refundOption: String,
  returnShippingCostPaidBy: String,
  shippingProfileName: String,
  returnProfileName: String,
  paymentProfileName: String,
  
  // ASIN reference for tracking (NOT exported to CSV)
  _asinReference: {
    type: String,
    trim: true,
    select: false
  },
  
  // CUSTOM COLUMNS (flexible Map structure)
  customFields: {
    type: Map,
    of: String,
    default: new Map()
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

// Compound index for SKU uniqueness per template
templateListingSchema.index({ templateId: 1, customLabel: 1 }, { unique: true });

templateListingSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model('TemplateListing', templateListingSchema);
