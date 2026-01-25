import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import TemplateListing from '../models/TemplateListing.js';
import ListingTemplate from '../models/ListingTemplate.js';
import Seller from '../models/Seller.js';
import SellerPricingConfig from '../models/SellerPricingConfig.js';
import { fetchAmazonData, applyFieldConfigs } from '../utils/asinAutofill.js';
import { generateSKUFromASIN } from '../utils/skuGenerator.js';

const router = express.Router();

// Get all listings for a template
router.get('/', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, page = 1, limit = 50, batchFilter = 'active', batchId, status = 'active' } = req.query;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build filter with optional seller filtering
    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Filter by status (default to 'active' to only show active listings)
    if (status && status !== 'all') {
      filter.status = status;
    }
    
    // Apply batch filtering
    if (batchId) {
      // Specific batch
      filter.downloadBatchId = batchId;
    } else if (batchFilter === 'active') {
      // Active batch only (not downloaded)
      filter.downloadBatchId = null;
    } else if (batchFilter === 'all') {
      // All batches (no filter on downloadBatchId)
    }
    
    const [listings, total] = await Promise.all([
      TemplateListing.find(filter)
        .populate('createdBy', 'name email')
        .populate({
          path: 'sellerId',
          populate: {
            path: 'user',
            select: 'username email'
          }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(filter)
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

// Database view endpoint with comprehensive filters (MUST be before /:id route)
router.get('/database-view', requireAuth, async (req, res) => {
  try {
    const { 
      sellerId, 
      templateId, 
      status, 
      search, 
      page = 1, 
      limit = 50 
    } = req.query;
    
    // Build query - exclude soft-deleted items
    const query = { deletedAt: null };
    
    if (sellerId) query.sellerId = sellerId;
    if (templateId) query.templateId = templateId;
    if (status) query.status = status;
    
    // Search across ASIN, SKU (customLabel), and Title
    if (search) {
      query.$or = [
        { _asinReference: new RegExp(search, 'i') },
        { customLabel: new RegExp(search, 'i') },
        { title: new RegExp(search, 'i') }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Fetch with populated fields
    const [listings, total] = await Promise.all([
      TemplateListing.find(query)
        .select('+_asinReference') // Include ASIN in results
        .populate({
          path: 'sellerId',
          populate: {
            path: 'user',
            select: 'username email'
          }
        })
        .populate('templateId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(query)
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
    console.error('Database view error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database statistics endpoint (MUST be before /:id route)
router.get('/database-stats', requireAuth, async (req, res) => {
  try {
    const stats = await TemplateListing.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: null,
          totalListings: { $sum: 1 },
          uniqueSellers: { $addToSet: '$sellerId' },
          uniqueTemplates: { $addToSet: '$templateId' },
          draftCount: {
            $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] }
          },
          activeCount: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          inactiveCount: {
            $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] }
          }
        }
      }
    ]);
    
    res.json({
      total: stats[0]?.totalListings || 0,
      sellers: stats[0]?.uniqueSellers?.length || 0,
      templates: stats[0]?.uniqueTemplates?.length || 0,
      draft: stats[0]?.draftCount || 0,
      active: stats[0]?.activeCount || 0,
      inactive: stats[0]?.inactiveCount || 0
    });
  } catch (error) {
    console.error('Database stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get statistics for template listings (today, week, month, total)
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId } = req.query;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Calculate date ranges
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    
    // Run queries in parallel
    const [todayCount, weekCount, monthCount, totalCount] = await Promise.all([
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: todayStart, $lte: todayEnd }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: weekStart }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active',
        createdAt: { $gte: monthStart }
      }),
      TemplateListing.countDocuments({
        ...filter,
        status: 'active'
      })
    ]);
    
    res.json({
      today: todayCount,
      thisWeek: weekCount,
      thisMonth: monthCount,
      total: totalCount
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get detailed analytics for template listings
router.get('/analytics', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, startDate, endDate, userId, page = 1, limit = 100 } = req.query;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    const filter = { templateId };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Apply date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }
    
    // Apply user filter
    if (userId && userId !== 'all') {
      filter.createdBy = userId;
    }
    
    // Get paginated listings
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [listings, total] = await Promise.all([
      TemplateListing.find(filter)
        .populate('createdBy', 'username email role')
        .select('customLabel title _asinReference createdBy createdAt status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TemplateListing.countDocuments(filter)
    ]);
    
    // Get daily breakdown using aggregation
    const dailyBreakdown = await TemplateListing.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            userId: "$createdBy"
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.date",
          total: { $sum: "$count" },
          users: {
            $push: {
              userId: "$_id.userId",
              count: "$count"
            }
          }
        }
      },
      {
        $sort: { _id: -1 }
      },
      {
        $limit: 30 // Last 30 days
      }
    ]);
    
    // Populate user details in daily breakdown
    const userIds = [...new Set(dailyBreakdown.flatMap(d => d.users.map(u => u.userId)))].filter(Boolean);
    const users = await TemplateListing.model('User').find({ _id: { $in: userIds } }).select('username email role');
    const userMap = new Map(users.map(u => [u._id.toString(), u]));
    
    // Enrich daily breakdown with user details
    const enrichedDailyBreakdown = dailyBreakdown.map(day => ({
      date: day._id,
      total: day.total,
      users: day.users
        .filter(u => u.userId)
        .map(u => ({
          userId: u.userId,
          username: userMap.get(u.userId.toString())?.username || 'Unknown',
          count: u.count
        }))
    }));
    
    // Get user breakdown
    const userBreakdown = await TemplateListing.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: "$createdBy",
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    // Populate user details in user breakdown
    const enrichedUserBreakdown = await Promise.all(
      userBreakdown
        .filter(u => u._id)
        .map(async (u) => {
          const user = userMap.get(u._id.toString());
          return {
            userId: u._id,
            username: user?.username || 'Unknown',
            role: user?.role || 'N/A',
            count: u.count
          };
        })
    );
    
    res.json({
      listings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      dailyBreakdown: enrichedDailyBreakdown,
      userBreakdown: enrichedUserBreakdown,
      summary: {
        totalInPeriod: total,
        uniqueUsers: enrichedUserBreakdown.length
      }
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
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
    
    if (!listingData.sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    // Validate seller exists
    const seller = await Seller.findById(listingData.sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
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
    
    // Check if SKU exists as active (block duplicate)
    const activeExists = await TemplateListing.findOne({
      templateId: listingData.templateId,
      sellerId: listingData.sellerId,
      customLabel: listingData.customLabel,
      status: 'active'
    });
    
    if (activeExists) {
      return res.status(409).json({ 
        error: 'An active listing with this SKU already exists' 
      });
    }
    
    // Check if SKU exists as inactive (reactivate instead of creating new)
    const inactiveExists = await TemplateListing.findOne({
      templateId: listingData.templateId,
      sellerId: listingData.sellerId,
      customLabel: listingData.customLabel,
      status: 'inactive'
    });
    
    let listing;
    let wasReactivated = false;
    
    if (inactiveExists) {
      // Reactivate existing inactive listing and update with new data
      Object.assign(inactiveExists, {
        ...listingData,
        customFields: listingData.customFields,
        status: 'active',
        updatedAt: Date.now()
      });
      
      await inactiveExists.save();
      listing = inactiveExists;
      wasReactivated = true;
      
      console.log(`✅ Reactivated inactive listing: ${listingData.customLabel}`);
    } else {
      // Create new listing
      listing = new TemplateListing({
        ...listingData,
        status: 'active',
        createdBy: req.user.userId
      });
      
      await listing.save();
    }
    
    await listing.populate([
      { path: 'createdBy', select: 'name email' },
      { 
        path: 'sellerId',
        populate: {
          path: 'user',
          select: 'username email'
        }
      }
    ]);
    
    res.status(201).json({
      listing,
      wasReactivated
    });
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
    const { asin, templateId, sellerId } = req.body;
    
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
    
    // 1.5. Get seller-specific pricing config if sellerId is provided
    let pricingConfig = template.pricingConfig;
    if (sellerId) {
      const sellerConfig = await SellerPricingConfig.findOne({
        sellerId,
        templateId
      });
      if (sellerConfig) {
        pricingConfig = sellerConfig.pricingConfig;
      }
    }
    
    // 2. Fetch fresh Amazon data
    console.log(`Fetching Amazon data for ASIN: ${asin}`);
    const amazonData = await fetchAmazonData(asin);
    
    // 3. Apply field configurations (AI + direct mappings)
    console.log(`Processing ${template.asinAutomation.fieldConfigs.length} field configs`);
    const { coreFields, customFields, pricingCalculation } = await applyFieldConfigs(
      amazonData,
      template.asinAutomation.fieldConfigs,
      pricingConfig  // Use seller-specific or template default pricing config
    );
    
    // 4. Return auto-filled data (separated by type)
    res.json({
      success: true,
      asin,
      autoFilledData: {
        coreFields,
        customFields
      },
      amazonSource: {
        title: amazonData.title,
        brand: amazonData.brand,
        price: amazonData.price,
        imageCount: amazonData.images.length
      },
      pricingCalculation: pricingCalculation || null
    });
    
  } catch (error) {
    console.error('ASIN autofill error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to fetch and process ASIN data' 
    });
  }
});

// Bulk auto-fill from multiple ASINs
router.post('/bulk-autofill-from-asins', requireAuth, async (req, res) => {
  try {
    const { asins, templateId, sellerId } = req.body;
    
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ 
        error: 'ASINs array is required and must not be empty' 
      });
    }
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    // Validate batch size
    if (asins.length > 50) {
      return res.status(400).json({ 
        error: 'Maximum 50 ASINs allowed per batch' 
      });
    }
    
    // Fetch template with automation config
    const template = await ListingTemplate.findById(templateId);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!template.asinAutomation?.enabled) {
      return res.status(400).json({ 
        error: 'ASIN automation is not enabled for this template' 
      });
    }
    
    // Get seller-specific pricing config if available
    let pricingConfig = template.pricingConfig;
    const sellerConfig = await SellerPricingConfig.findOne({
      sellerId,
      templateId
    });
    if (sellerConfig) {
      pricingConfig = sellerConfig.pricingConfig;
    }
    
    // Clean and deduplicate ASINs
    const cleanedAsins = [...new Set(
      asins.map(asin => asin.trim().toUpperCase()).filter(asin => asin.length > 0)
    )];
    
    console.log(`Processing ${cleanedAsins.length} ASINs in batch`);
    
    // Check for existing ACTIVE listings with these ASINs (filter by seller and status)
    const existingListings = await TemplateListing.find({
      templateId,
      sellerId,
      _asinReference: { $in: cleanedAsins },
      status: 'active'
    }).select('_asinReference _id');
    
    const existingAsinMap = new Map(
      existingListings.map(listing => [listing._asinReference, listing._id])
    );
    
    const startTime = Date.now();
    const results = [];
    
    // Process ASINs in batches of 5 (parallel within batch, sequential between batches)
    const batchSize = 5;
    for (let i = 0; i < cleanedAsins.length; i += batchSize) {
      const batch = cleanedAsins.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (asin) => {
        // Check if ASIN already exists
        if (existingAsinMap.has(asin)) {
          return {
            asin,
            status: 'duplicate',
            existingListingId: existingAsinMap.get(asin).toString(),
            error: 'ASIN already exists in this template'
          };
        }
        
        try {
          // Fetch Amazon data
          const amazonData = await fetchAmazonData(asin);
          
          // Apply field configurations
          const { coreFields, customFields, pricingCalculation } = await applyFieldConfigs(
            amazonData,
            template.asinAutomation.fieldConfigs,
            pricingConfig  // Use seller-specific or template default pricing config
          );
          
          return {
            asin,
            status: 'success',
            autoFilledData: {
              coreFields,
              customFields
            },
            amazonSource: {
              title: amazonData.title,
              brand: amazonData.brand,
              price: amazonData.price,
              imageCount: amazonData.images.length
            },
            pricingCalculation: pricingCalculation || null
          };
        } catch (error) {
          console.error(`Error processing ASIN ${asin}:`, error);
          return {
            asin,
            status: 'error',
            error: error.message || 'Failed to fetch or process ASIN data'
          };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Add small delay between batches to avoid rate limiting
      if (i + batchSize < cleanedAsins.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;
    const duplicates = results.filter(r => r.status === 'duplicate').length;
    
    console.log(`Bulk autofill completed: ${successful} successful, ${failed} failed, ${duplicates} duplicates in ${processingTime}s`);
    
    res.json({
      success: true,
      total: cleanedAsins.length,
      successful,
      failed,
      duplicates,
      results,
      processingTime: `${processingTime}s`
    });
    
  } catch (error) {
    console.error('Bulk ASIN autofill error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to process bulk ASIN autofill' 
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

// Bulk create listings from auto-fill results
router.post('/bulk-create', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, listings, options = {} } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    // Validate seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    if (!listings || !Array.isArray(listings) || listings.length === 0) {
      return res.status(400).json({ error: 'Listings array is required' });
    }
    
    // Validate batch size
    if (listings.length > 50) {
      return res.status(400).json({ 
        error: 'Maximum 50 listings allowed per batch' 
      });
    }
    
    const {
      autoGenerateSKU = true,
      skipDuplicates = true
    } = options;
    
    // Fetch template to get next SKU counter
    const template = await ListingTemplate.findById(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const results = [];
    const errors = [];
    let skippedCount = 0;
    
    // Get existing ACTIVE SKUs to avoid duplicates
    const existingActiveSKUs = await TemplateListing.find({ 
      templateId,
      sellerId,
      status: 'active'
    }).distinct('customLabel');
    
    // Get existing INACTIVE listings for potential reactivation
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      status: 'inactive'
    }).select('+_asinReference');
    
    const inactiveMap = new Map(
      inactiveListings.map(l => [l.customLabel, l])
    );
    
    const skuSet = new Set(existingActiveSKUs);
    let skuCounter = Date.now();
    
    console.log(`📊 Pre-check: ${existingActiveSKUs.length} active SKUs, ${inactiveListings.length} inactive listings`);
    console.log(`📋 Inactive SKUs: ${Array.from(inactiveMap.keys()).join(', ')}`);
    
    // Process each listing
    for (const listingData of listings) {
      try {
        // Validate required fields
        if (!listingData.title) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Title is required',
            details: 'Missing required field: title'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Title is required'
          });
          continue;
        }
        
        if (listingData.startPrice === undefined || listingData.startPrice === null) {
          errors.push({
            asin: listingData._asinReference,
            error: 'Start price is required',
            details: 'Missing required field: startPrice'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'Start price is required'
          });
          continue;
        }
        
        // Generate SKU if not provided
        let sku = listingData.customLabel;
        if (!sku && autoGenerateSKU) {
          // Generate SKU using GRW25 + last 5 chars of ASIN
          if (listingData._asinReference) {
            sku = generateSKUFromASIN(listingData._asinReference);
          } else {
            sku = `SKU-${skuCounter++}`;
          }
          
          // Ensure uniqueness
          while (skuSet.has(sku)) {
            // If collision, append timestamp suffix
            sku = `${generateSKUFromASIN(listingData._asinReference)}-${skuCounter++}`;
          }
        }
        
        if (!sku) {
          errors.push({
            asin: listingData._asinReference,
            error: 'SKU (Custom label) is required',
            details: 'No SKU provided and auto-generation disabled'
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: 'SKU is required'
          });
          continue;
        }
        
        console.log(`🔍 Processing SKU: ${sku}, inInactiveMap: ${inactiveMap.has(sku)}, inActiveSet: ${skuSet.has(sku)}`);
        
        // Check if SKU exists as inactive - reactivate instead of create
        const inactiveListing = inactiveMap.get(sku);
        
        if (inactiveListing) {
          // Found an inactive listing with this SKU - reactivate it
          // Convert customFields object to Map
          const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
            ? new Map(Object.entries(listingData.customFields))
            : new Map();
          
          // Update existing inactive listing
          Object.assign(inactiveListing, {
            ...listingData,
            customLabel: sku,
            customFields: customFieldsMap,
            templateId,
            sellerId,
            status: 'active',
            updatedAt: Date.now()
          });
          
          await inactiveListing.save();
          skuSet.add(sku);
          
          results.push({
            status: 'reactivated',
            listing: inactiveListing.toObject(),
            asin: listingData._asinReference,
            sku
          });
          
          console.log(`✅ Reactivated: ${sku}`);
          continue;
        }
        
        // Check for duplicate SKU in active listings (within this batch or existing)
        if (skuSet.has(sku)) {
          if (skipDuplicates) {
            skippedCount++;
            results.push({
              status: 'skipped',
              asin: listingData._asinReference,
              sku,
              error: 'Duplicate SKU (active listing exists)'
            });
            console.log(`⏭️ Skipped duplicate: ${sku}`);
            continue;
          } else {
            // Make SKU unique by appending suffix
            const baseSKU = sku;
            let suffix = 1;
            
            do {
              sku = `${baseSKU}-${suffix++}`;
            } while (skuSet.has(sku) || inactiveMap.has(sku));
            
            console.log(`SKU collision detected: ${baseSKU} → ${sku}`);
          }
        }
        
        // Convert customFields object to Map
        const customFieldsMap = listingData.customFields && typeof listingData.customFields === 'object'
          ? new Map(Object.entries(listingData.customFields))
          : new Map();
        
        // Create new listing
        const listing = new TemplateListing({
          ...listingData,
          customLabel: sku,
          customFields: customFieldsMap,
          templateId,
          sellerId,
          status: 'active',
          createdBy: req.user.userId
        });
        
        await listing.save();
        skuSet.add(sku);
        
        results.push({
          status: 'created',
          listing: listing.toObject(),
          asin: listingData._asinReference,
          sku
        });
        
      } catch (error) {
        console.error('Error creating listing:', error);
        
        if (error.code === 11000) {
          // Duplicate key error
          skippedCount++;
          results.push({
            status: 'skipped',
            asin: listingData._asinReference,
            error: 'Duplicate SKU'
          });
        } else {
          errors.push({
            asin: listingData._asinReference,
            error: error.message,
            details: error.toString()
          });
          results.push({
            status: 'failed',
            asin: listingData._asinReference,
            error: error.message
          });
        }
      }
    }
    
    const created = results.filter(r => r.status === 'created').length;
    const reactivated = results.filter(r => r.status === 'reactivated').length;
    const failed = results.filter(r => r.status === 'failed').length;
    
    console.log(`Bulk create completed: ${created} created, ${reactivated} reactivated, ${failed} failed, ${skippedCount} skipped`);
    
    res.json({
      success: true,
      total: listings.length,
      created,
      reactivated,
      failed,
      skipped: skippedCount,
      results,
      errors
    });
    
  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to bulk create listings' 
    });
  }
});

// Bulk import ASINs (quick import without fetching Amazon data)
router.post('/bulk-import-asins', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, asins } = req.body;
    
    // Validate required fields
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!asins || !Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ error: 'ASINs array is required and must not be empty' });
    }
    
    console.log('📦 Bulk import request:', { templateId, sellerId, asinCount: asins.length });
    
    // Validate template and seller exist
    const [template, seller] = await Promise.all([
      ListingTemplate.findById(templateId),
      Seller.findById(sellerId)
    ]);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (!seller) {
      return res.status(404).json({ error: 'Seller not found' });
    }
    
    // Get existing SKUs for this seller to avoid duplicates
    const existingSKUs = await TemplateListing.find({ 
      templateId,
      sellerId
    }).distinct('customLabel');
    
    const skuSet = new Set(existingSKUs);
    let skuCounter = Date.now();
    
    // Process ASINs and generate SKUs
    const listingsToCreate = [];
    const skippedASINs = [];
    
    for (const asin of asins) {
      const cleanASIN = asin.trim().toUpperCase();
      
      // Basic ASIN validation (should start with B0 and be 10 chars)
      if (!cleanASIN || cleanASIN.length !== 10 || !cleanASIN.startsWith('B0')) {
        skippedASINs.push({
          asin: cleanASIN,
          reason: 'Invalid ASIN format'
        });
        continue;
      }
      
      // Generate SKU using GRW25 + last 5 chars
      let sku = generateSKUFromASIN(cleanASIN);
      
      // Check for duplicates and make unique
      if (skuSet.has(sku)) {
        // If collision, append timestamp suffix
        const baseSKU = sku;
        let suffix = 1;
        
        do {
          sku = `${baseSKU}-${suffix++}`;
        } while (skuSet.has(sku));
        
        console.log(`SKU collision detected: ${baseSKU} → ${sku}`);
      }
      
      skuSet.add(sku);
      
      // Create minimal listing object
      listingsToCreate.push({
        templateId,
        sellerId,
        _asinReference: cleanASIN,
        customLabel: sku,
        amazonLink: `https://www.amazon.com/dp/${cleanASIN}`,
        title: `Imported Product - ${cleanASIN}`,
        startPrice: 0.01, // Minimum placeholder
        quantity: 1,
        status: 'draft',
        conditionId: '1000-New',
        format: 'FixedPrice',
        duration: 'GTC',
        location: 'UnitedStates',
        createdBy: req.user.userId
      });
    }
    
    console.log(`📊 Prepared ${listingsToCreate.length} listings, ${skippedASINs.length} skipped (validation)`);
    
    // Check for existing listings with same ASINs (database duplicates)
    const existingByASIN = await TemplateListing.find({
      templateId,
      sellerId,
      _asinReference: { $in: listingsToCreate.map(l => l._asinReference) }
    }).select('customLabel _asinReference');
    
    const existingASINs = new Set(existingByASIN.map(l => l._asinReference));
    
    console.log(`🔍 Found ${existingASINs.size} existing ASINs in database`);
    
    // Filter out existing listings
    const newListings = listingsToCreate.filter(listing => {
      if (existingASINs.has(listing._asinReference)) {
        const existing = existingByASIN.find(e => e._asinReference === listing._asinReference);
        skippedASINs.push({
          asin: listing._asinReference,
          sku: listing.customLabel,
          reason: `Already exists in database (SKU: ${existing.customLabel})`
        });
        return false;
      }
      return true;
    });
    
    console.log(`✅ ${newListings.length} new listings to insert`);
    
    // Bulk insert new listings
    let importedCount = 0;
    let insertErrors = [];
    
    if (newListings.length > 0) {
      try {
        const result = await TemplateListing.insertMany(newListings, {
          ordered: false, // Continue on error
          rawResult: true
        });
        
        importedCount = result.insertedCount || newListings.length;
        
        // Handle any write errors
        if (result.writeErrors && result.writeErrors.length > 0) {
          result.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            if (err.code === 11000) {
              skippedASINs.push({
                asin: listing._asinReference,
                sku: listing.customLabel,
                reason: 'Duplicate key error'
              });
            } else {
              insertErrors.push({
                asin: listing._asinReference,
                sku: listing.customLabel,
                error: err.errmsg
              });
            }
          });
        }
      } catch (error) {
        // Handle bulk insert errors
        if (error.code === 11000 && error.writeErrors) {
          importedCount = error.insertedDocs ? error.insertedDocs.length : 0;
          
          error.writeErrors.forEach(err => {
            const listing = newListings[err.index];
            skippedASINs.push({
              asin: listing._asinReference,
              sku: listing.customLabel,
              reason: 'Duplicate key error'
            });
          });
        } else {
          throw error;
        }
      }
    }
    
    console.log(`🎉 Import complete: ${importedCount} imported, ${skippedASINs.length} skipped`);
    
    res.json({
      total: asins.length,
      imported: importedCount,
      skipped: skippedASINs.length,
      skippedDetails: skippedASINs,
      errors: insertErrors.length > 0 ? insertErrors : undefined
    });
    
  } catch (error) {
    console.error('❌ Bulk import error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to bulk import ASINs' 
    });
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
    const { sellerId } = req.query;
    
    // Build filter for ACTIVE listings only that haven't been downloaded yet
    // Inactive listings (deactivated by user) are excluded from CSV downloads
    // even if they have downloadBatchId=null, ensuring consistency with UI
    const filter = { 
      templateId,
      downloadBatchId: null, // Only active batch (not yet downloaded)
      status: 'active'       // Only active listings (exclude inactive/draft/sold/ended)
    };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Fetch template, seller, and filtered listings
    const [template, seller, listings] = await Promise.all([
      ListingTemplate.findById(templateId),
      sellerId ? Seller.findById(sellerId).populate('user', 'username email') : null,
      TemplateListing.find(filter).sort({ createdAt: -1 })
    ]);
    
    console.log('📊 Export CSV - Seller info:', seller?.user?.username || seller?.user?.email || 'No seller');
    console.log('📊 Export CSV - Listings count:', listings.length);
    console.log('📥 Exporting active listings only (excluded inactive/draft)');
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (listings.length === 0) {
      return res.status(400).json({ error: 'No active listings to download' });
    }
    
    // Generate batch ID and get next batch number
    const crypto = await import('crypto');
    const batchId = crypto.randomUUID();
    
    // Get next batch number for this template + seller combination
    const latestBatch = await TemplateListing.findOne({
      templateId,
      sellerId: sellerId || { $exists: true },
      downloadBatchNumber: { $ne: null }
    }).sort({ downloadBatchNumber: -1 });
    
    const batchNumber = (latestBatch?.downloadBatchNumber || 0) + 1;
    
    console.log('🔢 Batch number:', batchNumber);
    console.log('🆔 Batch ID:', batchId);
    
    // Mark listings as downloaded
    const updateResult = await TemplateListing.updateMany(
      filter,
      {
        downloadBatchId: batchId,
        downloadedAt: new Date(),
        downloadBatchNumber: batchNumber
      }
    );
    
    console.log('✅ Updated listings:', updateResult.modifiedCount);
    
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
    
    // Send as downloadable file with template, seller, batch number and date
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const sellerName = seller?.user?.username || seller?.user?.email || 'seller';
    const templateName = template.name.replace(/\s+/g, '_');
    const filename = `${templateName}_${sellerName}_batch_${batchNumber}_${dateStr}.csv`;
    
    console.log('📁 Generated filename:', filename);
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
    
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get download history for a template/seller
router.get('/download-history/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    console.log('📜 Download history request - Template:', templateId, 'Seller:', sellerId);
    
    // Convert string IDs to ObjectIds for aggregation
    const mongoose = await import('mongoose');
    const filter = {
      templateId: new mongoose.default.Types.ObjectId(templateId),
      downloadBatchId: { $ne: null }
    };
    
    if (sellerId) {
      filter.sellerId = new mongoose.default.Types.ObjectId(sellerId);
    }
    
    console.log('🔍 Filter:', JSON.stringify(filter));
    
    // First, let's check ALL listings for this template/seller
    const allListings = await TemplateListing.find({
      templateId,
      sellerId: sellerId || { $exists: true }
    }).select('downloadBatchId downloadBatchNumber downloadedAt customLabel');
    
    console.log('📋 Total listings found:', allListings.length);
    console.log('📊 All listings batch info:', allListings.map(l => ({
      sku: l.customLabel,
      batchId: l.downloadBatchId,
      batchNumber: l.downloadBatchNumber,
      downloadedAt: l.downloadedAt
    })));
    
    // Get unique batches with their metadata
    const batches = await TemplateListing.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$downloadBatchId',
          batchNumber: { $first: '$downloadBatchNumber' },
          downloadedAt: { $first: '$downloadedAt' },
          listingCount: { $sum: 1 }
        }
      },
      { $sort: { batchNumber: 1 } }
    ]);
    
    console.log('📊 Aggregation result:', batches);
    
    // Format response
    const history = batches.map(batch => ({
      batchId: batch._id,
      batchNumber: batch.batchNumber,
      downloadedAt: batch.downloadedAt,
      listingCount: batch.listingCount
    }));
    
    console.log('✅ Sending history:', history);
    
    res.json(history);
  } catch (error) {
    console.error('Error fetching download history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Re-download a specific batch
router.get('/re-download-batch/:templateId/:batchId', requireAuth, async (req, res) => {
  try {
    const { templateId, batchId } = req.params;
    const { sellerId } = req.query;
    
    // Build filter for specific batch
    const filter = { 
      templateId,
      downloadBatchId: batchId
    };
    if (sellerId) {
      filter.sellerId = sellerId;
    }
    
    // Fetch template, seller, and batch listings
    const [template, seller, listings] = await Promise.all([
      ListingTemplate.findById(templateId),
      sellerId ? Seller.findById(sellerId).populate('user', 'username email') : null,
      TemplateListing.find(filter).sort({ createdAt: -1 })
    ]);
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    if (listings.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    const batchNumber = listings[0].downloadBatchNumber;
    
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
      'Best offer enabled',
      'Best offer: Auto accept price',
      'Minimum best offer price',
      'Immediate pay required',
      'Location',
      'Shipping service 1: option',
      'Shipping service 1: cost',
      'Shipping service 1: priority',
      'Shipping service 2: option',
      'Shipping service 2: cost',
      'Shipping service 2: priority',
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
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',')
    ).join('\n');
    
    // Send as downloadable file with template, seller, batch number and date
    const dateStr = new Date().toISOString().split('T')[0];
    const sellerName = seller?.user?.username || seller?.user?.email || 'seller';
    const templateName = template.name.replace(/\s+/g, '_');
    const filename = `${templateName}_${sellerName}_batch_${batchNumber}_${dateStr}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
    
  } catch (error) {
    console.error('Error re-downloading batch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search for inactive listings by SKU
router.post('/search-inactive-skus', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required' });
    }
    
    // Find inactive listings
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'inactive'
    }).select('+_asinReference');
    
    // Find already active listings
    const activeListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'active'
    }).select('customLabel');
    
    const foundSKUs = new Set(inactiveListings.map(l => l.customLabel));
    const activeSKUs = activeListings.map(l => l.customLabel);
    const notFoundSKUs = skus.filter(sku => !foundSKUs.has(sku) && !activeSKUs.includes(sku));
    
    console.log(`🔍 Search inactive SKUs: ${inactiveListings.length} found, ${activeSKUs.length} already active, ${notFoundSKUs.length} not found`);
    
    res.json({
      found: inactiveListings,
      notFound: notFoundSKUs,
      alreadyActive: activeSKUs
    });
  } catch (error) {
    console.error('Error searching inactive SKUs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk reactivate inactive listings
router.post('/bulk-reactivate', requireAuth, async (req, res) => {
  try {
    const { listingIds } = req.body;
    
    if (!listingIds || !Array.isArray(listingIds) || listingIds.length === 0) {
      return res.status(400).json({ error: 'listingIds array is required' });
    }
    
    // Update status to active
    const result = await TemplateListing.updateMany(
      {
        _id: { $in: listingIds },
        status: 'inactive'
      },
      {
        $set: {
          status: 'active',
          updatedAt: Date.now()
        }
      }
    );
    
    // Get updated listings for response
    const reactivatedListings = await TemplateListing.find({
      _id: { $in: listingIds },
      status: 'active'
    }).select('customLabel title _asinReference');
    
    console.log(`✅ Reactivated ${result.modifiedCount} listings`);
    
    res.json({
      success: true,
      reactivated: result.modifiedCount,
      details: reactivatedListings
    });
  } catch (error) {
    console.error('Error reactivating listings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk deactivate active listings
router.post('/bulk-deactivate', requireAuth, async (req, res) => {
  try {
    const { templateId, sellerId, skus } = req.body;
    
    if (!templateId) {
      return res.status(400).json({ error: 'Template ID is required' });
    }
    
    if (!sellerId) {
      return res.status(400).json({ error: 'Seller ID is required' });
    }
    
    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: 'SKUs array is required' });
    }
    
    // Find active listings
    const activeListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'active'
    }).select('customLabel title _asinReference');
    
    // Find already inactive
    const inactiveListings = await TemplateListing.find({
      templateId,
      sellerId,
      customLabel: { $in: skus },
      status: 'inactive'
    }).select('customLabel');
    
    const foundSKUs = new Set(activeListings.map(l => l.customLabel));
    const alreadyInactiveSKUs = inactiveListings.map(l => l.customLabel);
    const notFoundSKUs = skus.filter(sku => 
      !foundSKUs.has(sku) && !alreadyInactiveSKUs.includes(sku)
    );
    
    // Deactivate
    const result = await TemplateListing.updateMany(
      {
        templateId,
        sellerId,
        customLabel: { $in: Array.from(foundSKUs) },
        status: 'active'
      },
      {
        $set: {
          status: 'inactive',
          updatedAt: Date.now()
        }
      }
    );
    
    console.log(`⏸️ Deactivated ${result.modifiedCount} listings`);
    
    res.json({
      success: true,
      summary: {
        total: skus.length,
        deactivated: result.modifiedCount,
        notFound: notFoundSKUs.length,
        alreadyInactive: alreadyInactiveSKUs.length
      },
      details: {
        deactivated: activeListings,
        notFound: notFoundSKUs,
        alreadyInactive: alreadyInactiveSKUs
      }
    });
  } catch (error) {
    console.error('Error deactivating listings:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
