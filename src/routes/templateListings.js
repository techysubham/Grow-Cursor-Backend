import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import TemplateListing from '../models/TemplateListing.js';
import ListingTemplate from '../models/ListingTemplate.js';
import { fetchAmazonData, applyFieldConfigs } from '../utils/asinAutofill.js';

const router = express.Router();

// Get all listings for a template
router.get('/', requireAuth, async (req, res) => {
  try {
    const { templateId, page = 1, limit = 50 } = req.query;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [listings, total] = await Promise.all([
      TemplateListing.find({ templateId })
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments({ templateId })
    ]);
    
    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single listing by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const listing = await TemplateListing.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('templateId');
    
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    res.json(listing);
  } catch (error) {
    console.error('Error fetching listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new listing
router.post('/', requireAuth, async (req, res) => {
  try {
    const listingData = req.body;
    
    if (!listingData.templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!listingData.customLabel) {
      return res.status(400).json({ error: 'SKU (Custom label) is required' });
    }
    
    if (!listingData.title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    if (!listingData.startPrice && listingData.startPrice !== 0) {
      return res.status(400).json({ error: 'Start price is required' });
    }
    
    // Convert customFields object to Map
    if (listingData.customFields && typeof listingData.customFields === 'object') {
      listingData.customFields = new Map(Object.entries(listingData.customFields));
    }
    
    const listing = new TemplateListing({
      ...listingData,
      createdBy: req.user.userId
    });
    
    await listing.save();
    await listing.populate('createdBy', 'name email');
    
    res.status(201).json(listing);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A listing with this SKU already exists in this template' });
    }
    console.error('Error creating listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update listing
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const listingData = req.body;
    
    // Convert customFields object to Map
    if (listingData.customFields && typeof listingData.customFields === 'object') {
      listingData.customFields = new Map(Object.entries(listingData.customFields));
    }
    
    listingData.updatedAt = Date.now();
    
    const listing = await TemplateListing.findByIdAndUpdate(
      req.params.id,
      listingData,
      { new: true, runValidators: true }
    )
      .populate('createdBy', 'name email')
      .populate('templateId');
    
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    res.json(listing);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A listing with this SKU already exists in this template' });
    }
    console.error('Error updating listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete listing
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const listing = await TemplateListing.findByIdAndDelete(req.params.id);
    
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting listing:', error);
    res.status(500).json({ error: error.message });
  }
});

// ASIN Autofill endpoint
router.post('/autofill-from-asin', requireAuth, async (req, res) => {
  try {
    const { asin, templateId } = req.body;
    
    if (!asin || !templateId) {
      return res.status(400).json({ 
        error: 'ASIN and Template ID are required' 
      });
    }
    
    // 1. Fetch template with automation config
    const template = await ListingTemplate.findById(templateId);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({ 
        error: 'ASIN automation is not enabled for this template' 
      });
    }
    
    // 2. Fetch fresh Amazon data
    console.log(`Fetching Amazon data for ASIN: ${asin}`);
    const amazonData = await fetchAmazonData(asin);
    
    // 3. Apply field configurations (AI + direct mappings)
    console.log(`Processing ${template.asinAutomation.fieldConfigs.length} field configs`);
    const autoFilledData = await applyFieldConfigs(
      amazonData,
      template.asinAutomation.fieldConfigs
    );
    
    // 4. Return auto-filled data
    res.json({
      success: true,
      asin,
      autoFilledData,
      amazonSource: {
        title: amazonData.title,
        brand: amazonData.brand,
        price: amazonData.price,
        imageCount: amazonData.images.length
      }
    });
    
  } catch (error) {
    console.error('ASIN autofill error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to fetch and process ASIN data' 
    });
  }
});

// Bulk delete listings
router.post('/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { listingIds } = req.body;
    
    if (!listingIds || !Array.isArray(listingIds) || listingIds.length === 0) {
      return res.status(400).json({ error: 'Listing IDs array is required' });
    }
    
    const result = await TemplateListing.deleteMany({
      _id: { $in: listingIds }
    });
    
    res.json({ 
      message: 'Listings deleted successfully',
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    console.error('Error bulk deleting listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk import from CSV
router.post('/bulk-import', requireAuth, async (req, res) => {
  try {
    const { templateId, listings } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }
    
    // Add metadata to each listing
    const listingsToInsert = listings.map(listing => ({
      ...listing,
      templateId,
      createdBy: req.user.userId,
      customFields: listing.customFields 
        ? new Map(Object.entries(listing.customFields))
        : new Map()
    }));
    
    const result = await TemplateListing.insertMany(listingsToInsert, { 
      ordered: false // Continue on error
    });
    
    res.json({ 
      message: 'Listings imported successfully',
      importedCount: result.length 
    });
  } catch (error) {
    if (error.code === 11000) {
      // Some duplicates were found
      const insertedCount = error.insertedDocs ? error.insertedDocs.length : 0;
      return res.status(207).json({ 
        message: 'Import completed with some duplicates skipped',
        importedCount: insertedCount,
        errors: error.writeErrors || []
      });
    }
    console.error('Error bulk importing listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export listings as eBay CSV
router.get('/export-csv/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    
    // Fetch template and all listings
    const [template, listings] = await Promise.all([
      ListingTemplate.findById(templateId),
      TemplateListing.find({ templateId }).sort({ createdAt: -1 })
    ]);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Build core headers (38 columns)
    const coreHeaders = [
      '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)',
      'Custom label (SKU)',
      'Category ID',
      'Category name',
      'Title',
      'Relationship',
      'Relationship details',
      'Schedule Time',
      'P:UPC',
      'P:EPID',
      'Start price',
      'Quantity',
      'Item photo URL',
      'VideoID',
      'Condition ID',
      'Description',
      'Format',
      'Duration',
      'Buy It Now price',
      'Best Offer Enabled',
      'Best Offer Auto Accept Price',
      'Minimum Best Offer Price',
      'Immediate pay required',
      'Location',
      'Shipping service 1 option',
      'Shipping service 1 cost',
      'Shipping service 1 priority',
      'Shipping service 2 option',
      'Shipping service 2 cost',
      'Shipping service 2 priority',
      'Max dispatch time',
      'Returns accepted option',
      'Returns within option',
      'Refund option',
      'Return shipping cost paid by',
      'Shipping profile name',
      'Return profile name',
      'Payment profile name'
    ];
    
    // Add custom column headers
    const customHeaders = template.customColumns
      .sort((a, b) => a.order - b.order)
      .map(col => col.name);
    
    const allHeaders = [...coreHeaders, ...customHeaders];
    const columnCount = allHeaders.length;
    
    // Generate #INFO lines (must match column count exactly)
    const emptyRow = new Array(columnCount).fill('');
    
    // INFO Line 1: Created timestamp + required field indicator
    const infoLine1 = ['#INFO', `Created=${Date.now()}`, '', '', '', '', 
                       ' Indicates missing required fields', '', '', '', '',
                       ' Indicates missing field that will be required soon',
                       ...new Array(columnCount - 12).fill('')];
    
    // INFO Line 2: Version + recommended field indicator  
    const infoLine2 = ['#INFO', 'Version=1.0', '', 
                       'Template=fx_category_template_EBAY_US', '', '',
                       ' Indicates missing recommended field', '', '', '', '',
                       ' Indicates field does not apply to this item/category',
                       ...new Array(columnCount - 12).fill('')];
    
    // INFO Line 3: All empty commas
    const infoLine3 = new Array(columnCount).fill('')
    infoLine3[0] = '#INFO';
    
    // Map listings to CSV rows
    const dataRows = listings.map(listing => {
      // Add leading slash to category name if not present
      let categoryName = listing.categoryName || '';
      if (categoryName && !categoryName.startsWith('/')) {
        categoryName = '/' + categoryName;
      }
      
      const coreValues = [
        listing.action || 'Add',
        listing.customLabel || '',
        listing.categoryId || '',
        categoryName,
        listing.title || '',
        listing.relationship || '',
        listing.relationshipDetails || '',
        listing.scheduleTime || '',
        listing.upc || '',
        listing.epid || '',
        listing.startPrice || '',
        listing.quantity || '',
        listing.itemPhotoUrl || '',
        listing.videoId || '',
        listing.conditionId || '1000-New',
        listing.description || '',
        listing.format || 'FixedPrice',
        listing.duration || 'GTC',
        listing.buyItNowPrice || '',
        listing.bestOfferEnabled || '',
        listing.bestOfferAutoAcceptPrice || '',
        listing.minimumBestOfferPrice || '',
        listing.immediatePayRequired || '',
        listing.location || 'UnitedStates',
        listing.shippingService1Option || '',
        listing.shippingService1Cost || '',
        listing.shippingService1Priority || '',
        listing.shippingService2Option || '',
        listing.shippingService2Cost || '',
        listing.shippingService2Priority || '',
        listing.maxDispatchTime || '',
        listing.returnsAcceptedOption || '',
        listing.returnsWithinOption || '',
        listing.refundOption || '',
        listing.returnShippingCostPaidBy || '',
        listing.shippingProfileName || '',
        listing.returnProfileName || '',
        listing.paymentProfileName || ''
      ];
      
      // Get custom field values in order
      const customValues = template.customColumns
        .sort((a, b) => a.order - b.order)
        .map(col => listing.customFields.get(col.name) || '');
      
      return [...coreValues, ...customValues];
    });
    
    // Combine all rows
    const allRows = [infoLine1, infoLine2, infoLine3, allHeaders, ...dataRows];
    
    // Convert to CSV string with proper escaping
    const csvContent = allRows.map(row => 
      row.map(cell => {
        const value = String(cell || '');
        // Escape quotes and wrap in quotes if contains comma/quote/newline
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    ).join('\n');
    
    // Send as downloadable file
    const filename = `${template.name.replace(/\s+/g, '_')}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
    
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
