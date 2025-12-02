import { Router } from 'express';
import axios from 'axios';
import qs from 'qs';
import EbayVehicleModel from '../models/EbayVehicleModel.js';
import Seller from '../models/Seller.js';
import Range from '../models/Range.js';
import Assignment from '../models/Assignment.js';
import ListingCompletion from '../models/ListingCompletion.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// ============================================
// CACHING SYSTEM FOR VEHICLE MODELS
// ============================================
// This avoids fetching 8702 documents from MongoDB on every request
// and pre-computes normalized strings for faster matching

let vehicleModelsCache = null;
let cacheLastUpdated = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour cache TTL

// Helper: Normalize text (remove hyphens, extra spaces, lowercase)
const normalizeText = (text) => {
  return text
    .toLowerCase()
    .replace(/[-_]/g, '') // Remove hyphens and underscores (Ma-z-da → mazda)
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();
};

// Load and cache vehicle models with pre-computed normalized strings
async function getVehicleModelsCache(forceRefresh = false) {
  const now = Date.now();
  
  // Return cached data if valid
  if (!forceRefresh && vehicleModelsCache && cacheLastUpdated && (now - cacheLastUpdated < CACHE_TTL)) {
    return vehicleModelsCache;
  }
  
  console.log('[Cache] Loading vehicle models into cache...');
  const startTime = Date.now();
  
  // Fetch all models from database
  const models = await EbayVehicleModel.find().select('fullName make model').lean();
  
  // Pre-compute normalized strings for each model
  vehicleModelsCache = models.map(m => ({
    fullName: m.fullName,
    make: m.make,
    model: m.model,
    makeLower: m.make.toLowerCase(),
    modelLower: m.model.toLowerCase(),
    makeNormalized: normalizeText(m.make),
    modelNormalized: normalizeText(m.model),
    fullNameLower: `${m.make.toLowerCase()} ${m.model.toLowerCase()}`,
    fullNameNormalized: `${normalizeText(m.make)} ${normalizeText(m.model)}`
  }));
  
  cacheLastUpdated = now;
  console.log(`[Cache] Loaded ${vehicleModelsCache.length} models in ${Date.now() - startTime}ms`);
  
  return vehicleModelsCache;
}

// Invalidate cache (call this after sync)
function invalidateVehicleModelsCache() {
  vehicleModelsCache = null;
  cacheLastUpdated = null;
  console.log('[Cache] Vehicle models cache invalidated');
}

// ============================================

// Helper: Ensure Seller Token is Valid (Refreshes if < 2 mins left)
async function ensureValidToken(seller) {
  const now = Date.now();
  const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
  const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
  const bufferTime = 2 * 60 * 1000; // 2 minutes buffer

  if (fetchedAt && (now - fetchedAt < expiresInMs - bufferTime)) {
    return seller.ebayTokens.access_token;
  }

  console.log(`[Token Refresh] Refreshing token for range analysis...`);
  
  const refreshRes = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    qs.stringify({
      grant_type: 'refresh_token',
      refresh_token: seller.ebayTokens.refresh_token,
      scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment'
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
      },
    }
  );

  seller.ebayTokens.access_token = refreshRes.data.access_token;
  seller.ebayTokens.expires_in = refreshRes.data.expires_in;
  seller.ebayTokens.fetchedAt = new Date();
  await seller.save();

  return refreshRes.data.access_token;
}

// Helper: Fetch compatibility values from eBay Taxonomy API
async function fetchEbayCompatibilityValues(token, propertyName, constraints = []) {
  let filterParam = '';
  if (constraints && constraints.length > 0) {
    const filters = constraints.map(c => {
      const cleanValue = String(c.value).replace(/,/g, '\\,');
      return `${c.name}:${cleanValue}`;
    });
    filterParam = filters.join(',');
  }

  const response = await axios.get(
    `https://api.ebay.com/commerce/taxonomy/v1/category_tree/100/get_compatibility_property_values`, 
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' 
      },
      params: {
        category_id: '33559', // eBay Motors Parts & Accessories
        compatibility_property: propertyName,
        filter: filterParam || undefined
      }
    }
  );

  const rawValues = response.data.compatibilityPropertyValues || [];
  return rawValues.map(item => item.value);
}

// GET /api/range-analysis/ebay-models
// Get all eBay vehicle models from our database
router.get('/ebay-models', requireAuth, async (req, res) => {
  try {
    const models = await EbayVehicleModel.find().sort({ fullName: 1 });
    res.json({ success: true, count: models.length, models });
  } catch (error) {
    console.error('Error fetching eBay models:', error);
    res.status(500).json({ error: 'Failed to fetch eBay models' });
  }
});

// POST /api/range-analysis/sync-ebay-models
// Fetch ALL vehicle models from eBay Taxonomy API and store in database
router.post('/sync-ebay-models', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    // 1. Find a seller with valid eBay tokens
    const seller = await Seller.findOne({ 
      'ebayTokens.access_token': { $exists: true, $ne: null } 
    }).populate('user', 'username');
    
    if (!seller) {
      return res.status(400).json({ 
        error: 'No seller with eBay connection found. Please connect an eBay account first.' 
      });
    }

    console.log(`[Range Sync] Using seller: ${seller.user?.username || seller._id}`);

    // 2. Get valid token
    const token = await ensureValidToken(seller);

    // 3. Fetch ALL Makes from eBay
    console.log('[Range Sync] Fetching all Makes from eBay...');
    const makes = await fetchEbayCompatibilityValues(token, 'Make');
    console.log(`[Range Sync] Found ${makes.length} Makes`);

    if (makes.length === 0) {
      return res.status(400).json({ error: 'No makes returned from eBay API' });
    }

    let added = 0;
    let skipped = 0;
    let errors = 0;
    const totalMakes = makes.length;
    let processedMakes = 0;

    // 4. For each Make, fetch ALL Models
    for (const make of makes) {
      processedMakes++;
      try {
        console.log(`[Range Sync] [${processedMakes}/${totalMakes}] Fetching models for: ${make}`);
        
        const models = await fetchEbayCompatibilityValues(token, 'Model', [
          { name: 'Make', value: make }
        ]);
        
        console.log(`  -> Found ${models.length} models for ${make}`);

        // 5. Save each Make+Model to database
        for (const model of models) {
          const fullName = `${make} ${model}`;
          try {
            await EbayVehicleModel.findOneAndUpdate(
              { fullName },
              { 
                make: make, 
                model: model, 
                fullName,
                source: 'ebay-api'
              },
              { upsert: true, new: true }
            );
            added++;
          } catch (e) {
            if (e.code === 11000) {
              skipped++; // Duplicate
            } else {
              errors++;
              console.error(`  Error saving ${fullName}:`, e.message);
            }
          }
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (makeError) {
        errors++;
        console.error(`[Range Sync] Error fetching models for ${make}:`, makeError.message);
      }
    }

    const totalCount = await EbayVehicleModel.countDocuments();
    
    // Invalidate cache so new models are picked up
    invalidateVehicleModelsCache();
    
    console.log(`[Range Sync] Complete! Added: ${added}, Skipped: ${skipped}, Errors: ${errors}, Total: ${totalCount}`);

    res.json({ 
      success: true, 
      message: `Synced ${added} new models from ${totalMakes} makes. ${skipped} already existed. ${errors} errors. Total in database: ${totalCount}`,
      stats: {
        makesProcessed: totalMakes,
        modelsAdded: added,
        modelsSkipped: skipped,
        errors: errors,
        totalInDatabase: totalCount
      }
    });

  } catch (error) {
    console.error('Sync Error:', error);
    res.status(500).json({ error: error.message || 'Failed to sync eBay models' });
  }
});

// POST /api/range-analysis/analyze
// Analyze text against eBay vehicle models database - returns FIRST model per line only
// Uses CACHED models for faster performance
router.post('/analyze', requireAuth, requireRole('superadmin', 'listingadmin', 'lister', 'advancelister', 'trainee'), async (req, res) => {
  try {
    const startTime = Date.now();
    const { textToAnalyze } = req.body;

    if (!textToAnalyze) {
      return res.status(400).json({ error: 'No text provided for analysis.' });
    }

    // Get cached models (pre-normalized!)
    const models = await getVehicleModelsCache();
    
    if (models.length === 0) {
      return res.status(400).json({ 
        error: 'No vehicle models in database. Please sync eBay models first.',
        needsSync: true
      });
    }

    // Split text into lines
    const lines = textToAnalyze.split(/\r?\n/).map((line, idx) => ({ 
      lineNumber: idx + 1, 
      text: line.trim(),
      textLower: line.trim().toLowerCase(),
      normalized: normalizeText(line)
    })).filter(l => l.text.length > 0);

    // For each line, find the FIRST matching model only
    const lineResults = [];
    const modelCounts = new Map(); // Track counts per model

    for (const line of lines) {
      let foundModel = null;
      let earliestPosition = Infinity;

      // Check each model and find the one that appears earliest in the line
      // Using pre-computed normalized strings from cache!
      for (const m of models) {
        let position = -1;
        
        // Method 1: Full name match (e.g., "Honda Accord") - using pre-computed fullNameLower
        const fullNamePos = line.textLower.indexOf(m.fullNameLower);
        if (fullNamePos !== -1) {
          position = fullNamePos;
        }
        // Method 2: Normalized full name match - using pre-computed fullNameNormalized
        else {
          const normalizedPos = line.normalized.indexOf(m.fullNameNormalized);
          if (normalizedPos !== -1) {
            position = normalizedPos;
          }
        }
        // Method 3: Make appears + model with word boundary
        if (position === -1) {
          const makePos = line.textLower.indexOf(m.makeLower);
          const makeNormPos = line.normalized.indexOf(m.makeNormalized);
          
          if (makePos !== -1 || makeNormPos !== -1) {
            const modelPattern = m.modelLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const modelRegex = new RegExp(`\\b${modelPattern}\\b`, 'i');
            const modelMatch = line.text.match(modelRegex);
            
            if (modelMatch) {
              position = Math.min(makePos !== -1 ? makePos : Infinity, modelMatch.index);
            }
          }
        }
        
        // If found and earlier than current best, use this model
        if (position !== -1 && position < earliestPosition) {
          earliestPosition = position;
          foundModel = m;
        }
      }

      // Record result for this line
      lineResults.push({
        lineNumber: line.lineNumber,
        text: line.text.length > 200 ? line.text.substring(0, 200) + '...' : line.text,
        foundModel: foundModel ? foundModel.fullName : null,
        make: foundModel ? foundModel.make : null,
        model: foundModel ? foundModel.model : null
      });

      // Update count for found model
      if (foundModel) {
        const currentCount = modelCounts.get(foundModel.fullName) || 0;
        modelCounts.set(foundModel.fullName, currentCount + 1);
      }
    }

    // Build summary with counts
    const foundInDatabase = [];
    for (const [modelName, count] of modelCounts) {
      const matchedRows = lineResults
        .filter(lr => lr.foundModel === modelName)
        .map(lr => ({ lineNumber: lr.lineNumber, text: lr.text }));
      
      foundInDatabase.push({ modelName, count, matchedRows });
    }

    // Sort by count descending
    foundInDatabase.sort((a, b) => b.count - a.count);

    // Count lines with no match
    const linesWithNoMatch = lineResults.filter(lr => !lr.foundModel);
    const unmatchedCount = linesWithNoMatch.length;

    const processingTime = Date.now() - startTime;
    console.log(`[Analyze] Processed ${lines.length} lines in ${processingTime}ms`);

    res.json({ 
      success: true, 
      foundInDatabase,
      lineResults, // All lines with their detected model (or null)
      totalModelsInDatabase: models.length,
      totalLinesAnalyzed: lines.length,
      totalMatchCount: lines.length - unmatchedCount,
      unmatchedCount,
      unmatchedLines: linesWithNoMatch,
      uniqueModelsFound: foundInDatabase.length,
      processingTimeMs: processingTime
    });

  } catch (error) {
    console.error('Analysis Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/range-analysis/map-to-ranges
// Maps detected model names to Range IDs for a specific category
// Creates ranges if they don't exist
router.post('/map-to-ranges', requireAuth, requireRole('superadmin', 'listingadmin', 'lister', 'advancelister', 'trainee'), async (req, res) => {
  try {
    const { categoryId, modelCounts } = req.body;
    // modelCounts: [{ modelName: "Honda Accord", count: 5 }, ...]

    if (!categoryId) {
      return res.status(400).json({ error: 'categoryId is required' });
    }

    if (!modelCounts || !Array.isArray(modelCounts)) {
      return res.status(400).json({ error: 'modelCounts array is required' });
    }

    const rangeQuantities = [];

    for (const item of modelCounts) {
      const { modelName, count } = item;
      if (!modelName || !count || count <= 0) continue;

      // Try to find existing range with this name in the category
      let range = await Range.findOne({ 
        name: modelName, 
        category: categoryId 
      });

      // If not found, create it
      if (!range) {
        try {
          range = await Range.create({
            name: modelName,
            category: categoryId
          });
          console.log(`[Range Mapper] Created new range: ${modelName}`);
        } catch (e) {
          // Handle race condition - might have been created by another request
          if (e.code === 11000) {
            range = await Range.findOne({ name: modelName, category: categoryId });
          } else {
            console.error(`[Range Mapper] Error creating range ${modelName}:`, e.message);
            continue;
          }
        }
      }

      if (range) {
        rangeQuantities.push({
          rangeId: range._id,
          rangeName: range.name,
          quantity: count
        });
      }
    }

    res.json({
      success: true,
      rangeQuantities
    });

  } catch (error) {
    console.error('Map to Ranges Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/range-analysis/ensure-unknown-range
// Ensures "Unknown" range exists for a category
router.post('/ensure-unknown-range', requireAuth, requireRole('superadmin', 'listingadmin', 'lister', 'advancelister', 'trainee'), async (req, res) => {
  try {
    const { categoryId } = req.body;

    if (!categoryId) {
      return res.status(400).json({ error: 'categoryId is required' });
    }

    // Try to find or create "Unknown" range
    let unknownRange = await Range.findOne({ 
      name: 'Unknown', 
      category: categoryId 
    });

    if (!unknownRange) {
      try {
        unknownRange = await Range.create({
          name: 'Unknown',
          category: categoryId
        });
        console.log(`[Range] Created Unknown range for category ${categoryId}`);
      } catch (e) {
        if (e.code === 11000) {
          unknownRange = await Range.findOne({ name: 'Unknown', category: categoryId });
        } else {
          throw e;
        }
      }
    }

    res.json({
      success: true,
      unknownRange: {
        _id: unknownRange._id,
        name: unknownRange.name
      }
    });

  } catch (error) {
    console.error('Ensure Unknown Range Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/range-analysis/save-bulk-ranges
// Saves multiple range quantities to an assignment in ONE atomic operation
// This avoids race conditions from multiple parallel requests
// Supports auto-trim: if total exceeds remainingLimit, it trims proportionally
router.post('/save-bulk-ranges', requireAuth, requireRole('superadmin', 'listingadmin', 'lister', 'advancelister', 'trainee'), async (req, res) => {
  try {
    const { assignmentId, categoryId, modelCounts, unknownQty, remainingLimit } = req.body;
    // modelCounts: [{ modelName: "Honda CR-V", count: 5 }, ...]
    // remainingLimit: max total quantity that can be added (for auto-trim)

    if (!assignmentId) {
      return res.status(400).json({ error: 'assignmentId is required' });
    }
    if (!categoryId) {
      return res.status(400).json({ error: 'categoryId is required' });
    }

    // 1. Find the assignment
    const assignment = await Assignment.findById(assignmentId).populate('task', 'category subcategory');
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Check permission
    const me = req.user?.userId || req.user?.id;
    const isAdmin = ['superadmin', 'listingadmin'].includes(req.user?.role);
    if (!isAdmin && String(assignment.lister) !== String(me)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // 2. Map model names to Range IDs (create if needed)
    let rangeUpdates = []; // { rangeId, rangeName, quantity }

    for (const item of (modelCounts || [])) {
      const { modelName, count } = item;
      if (!modelName || !count || count <= 0) continue;

      let range = await Range.findOne({ name: modelName, category: categoryId });
      
      if (!range) {
        try {
          range = await Range.create({ name: modelName, category: categoryId });
          console.log(`[Bulk Save] Created new range: ${modelName}`);
        } catch (e) {
          if (e.code === 11000) {
            range = await Range.findOne({ name: modelName, category: categoryId });
          } else {
            console.error(`[Bulk Save] Error creating range ${modelName}:`, e.message);
            continue;
          }
        }
      }

      if (range) {
        // Validate range belongs to category
        if (String(range.category) !== String(categoryId)) {
          console.error(`[Bulk Save] Range ${modelName} doesn't belong to category`);
          continue;
        }
        rangeUpdates.push({ rangeId: range._id, rangeName: range.name, quantity: count });
      }
    }

    // 3. Handle Unknown range if needed
    if (unknownQty && unknownQty > 0) {
      let unknownRange = await Range.findOne({ name: 'Unknown', category: categoryId });
      
      if (!unknownRange) {
        try {
          unknownRange = await Range.create({ name: 'Unknown', category: categoryId });
          console.log(`[Bulk Save] Created Unknown range for category`);
        } catch (e) {
          if (e.code === 11000) {
            unknownRange = await Range.findOne({ name: 'Unknown', category: categoryId });
          }
        }
      }
      
      if (unknownRange) {
        rangeUpdates.push({ rangeId: unknownRange._id, rangeName: 'Unknown', quantity: unknownQty });
      }
    }

    // 4. AUTO-TRIM: If total exceeds remainingLimit, trim quantities proportionally
    const totalRequested = rangeUpdates.reduce((sum, u) => sum + u.quantity, 0);
    let totalTrimmed = 0;
    
    if (remainingLimit !== undefined && remainingLimit !== null && totalRequested > remainingLimit) {
      console.log(`[Bulk Save] Auto-trimming: ${totalRequested} requested, ${remainingLimit} remaining limit`);
      
      // Trim proportionally - each range gets a fair share of the limit
      let budgetLeft = remainingLimit;
      const trimmedUpdates = [];
      
      for (const update of rangeUpdates) {
        if (budgetLeft <= 0) {
          totalTrimmed += update.quantity;
          continue; // Skip this range entirely
        }
        
        const trimmedQty = Math.min(update.quantity, budgetLeft);
        if (trimmedQty > 0) {
          trimmedUpdates.push({ ...update, quantity: trimmedQty });
          budgetLeft -= trimmedQty;
          totalTrimmed += (update.quantity - trimmedQty);
        }
      }
      
      rangeUpdates = trimmedUpdates;
      console.log(`[Bulk Save] Trimmed ${totalTrimmed} items, adding ${rangeUpdates.reduce((s, u) => s + u.quantity, 0)}`);
    }

    // 5. Apply ALL range updates to assignment in ONE save
    for (const update of rangeUpdates) {
      const existingIdx = assignment.rangeQuantities.findIndex(
        rq => String(rq.range) === String(update.rangeId)
      );
      
      if (existingIdx >= 0) {
        // Add to existing quantity
        assignment.rangeQuantities[existingIdx].quantity += update.quantity;
      } else {
        // Add new
        assignment.rangeQuantities.push({ range: update.rangeId, quantity: update.quantity });
      }
    }

    // 6. Calculate totals
    const totalDistributed = assignment.rangeQuantities.reduce((sum, rq) => sum + (rq.quantity || 0), 0);
    assignment.completedQuantity = Math.min(totalDistributed, assignment.quantity);

    // 6. Save once
    await assignment.save();

    const totalAdded = rangeUpdates.reduce((sum, u) => sum + u.quantity, 0);
    console.log(`[Bulk Save] Saved ${rangeUpdates.length} ranges (${totalAdded} qty) to assignment ${assignmentId}${totalTrimmed > 0 ? `, trimmed ${totalTrimmed}` : ''}`);

    res.json({
      success: true,
      rangesAdded: rangeUpdates.length,
      quantityAdded: totalAdded,
      quantityTrimmed: totalTrimmed,
      totalDistributed,
      remaining: Math.max(0, assignment.quantity - totalDistributed)
    });

  } catch (error) {
    console.error('Bulk Save Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

export default router;