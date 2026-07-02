import express from 'express';
import mongoose from 'mongoose';
import AsinDirectory from '../models/AsinDirectory.js';
import AsinListProduct from '../models/AsinListProduct.js';
import { requireAuth, requireAuthSSE } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import {
  bulkAddAsinsSchema,
  csvImportAsinsSchema,
  updateAsinSchema,
  bulkDeleteAsinsSchema,
} from '../schemas/index.js';
import { fetchAmazonData } from '../utils/asinAutofill.js';
import { parsePagination } from '../utils/paginate.js';

// Scrape a batch of ASINs in parallel (max 5 at a time) and return enrichment map
// onAsinDone(completedSoFar, total) is called as each individual ASIN settles (optional)
async function scrapeAsinsBatched(asinList, region = 'US', batchSize = 5, onAsinDone = null) {
  const enrichmentMap = new Map();
  let completed = 0;
  for (let i = 0; i < asinList.length; i += batchSize) {
    const batch = asinList.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(asin =>
        fetchAmazonData(asin, region).finally(() => {
          completed++;
          if (onAsinDone) onAsinDone(completed, asinList.length);
        })
      )
    );
    results.forEach((result, idx) => {
      const asin = batch[idx];
      if (result.status === 'fulfilled') {
        enrichmentMap.set(asin, { ok: true, data: result.value });
      } else {
        enrichmentMap.set(asin, { ok: false, error: result.reason?.message || 'Scrape failed' });
      }
    });
  }
  return enrichmentMap;
}

const router = express.Router();

// Get all ASINs with pagination and search
/**
 * @swagger
 * /asin-directory:
 *   get:
 *     tags: [ASIN Directory]
 *     summary: List ASINs with pagination, search, and filtering
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 25 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search ASIN code or title
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, default: -addedAt }
 *       - in: query
 *         name: listProductId
 *         schema: { type: string }
 *       - in: query
 *         name: rangeId
 *         schema: { type: string }
 *       - in: query
 *         name: region
 *         schema: { type: string, example: US }
 *       - in: query
 *         name: addedByUserId
 *         schema: { type: string }
 *       - in: query
 *         name: priceMin
 *         schema: { type: number }
 *       - in: query
 *         name: priceMax
 *         schema: { type: number }
 *       - in: query
 *         name: showMoved
 *         schema: { type: boolean }
 *         description: Include ASINs already moved to a list (default false)
 *       - in: query
 *         name: movedAfter
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: movedBefore
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Paginated ASIN list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 asins:      { type: array, items: { $ref: '#/components/schemas/AsinDirectoryEntry' } }
 *                 total:      { type: integer }
 *                 page:       { type: integer }
 *                 totalPages: { type: integer }
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 500 });
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || '-addedAt'; // Default: newest first
    const listProductId = req.query.listProductId || '';
    const rangeId = req.query.rangeId || '';
    const priceMin = req.query.priceMin !== undefined && req.query.priceMin !== '' ? parseFloat(req.query.priceMin) : null;
    const priceMax = req.query.priceMax !== undefined && req.query.priceMax !== '' ? parseFloat(req.query.priceMax) : null;
    const addedByUserId = req.query.addedByUserId || '';

    // Build query
    let query = {};
    if (search) {
      query.$or = [
        { asin: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
      ];
    }
    if (listProductId) {
      // Specific product selected — exact match (existing behaviour)
      query.listProductId = listProductId;
    } else if (rangeId) {
      // Range selected but no product — show all ASINs across every product in this range
      const productIds = await AsinListProduct.find({ rangeId }).select('_id').lean();
      query.listProductId = { $in: productIds.map(p => p._id) };
    } else if (req.query.showMoved !== 'true') {
      // Default: hide ASINs already moved to a list
      query.listProductId = null;
    }

    const region = req.query.region || '';
    if (region) query.region = region;

    if (addedByUserId) {
      if (!mongoose.Types.ObjectId.isValid(addedByUserId)) {
        return res.status(400).json({ error: 'Invalid addedByUserId' });
      }
      query.addedByUserId = addedByUserId;
    }

    // Moved-to-list date range filter
    const movedAfter = req.query.movedAfter || '';
    const movedBefore = req.query.movedBefore || '';
    if (movedAfter || movedBefore) {
      query.movedAt = {};
      if (movedAfter) query.movedAt.$gte = new Date(movedAfter);
      if (movedBefore) {
        const end = new Date(movedBefore);
        end.setHours(23, 59, 59, 999);
        query.movedAt.$lte = end;
      }
    }

    // Price range filter — price is stored as a string (e.g. "$12.99"), use $expr to cast
    if (priceMin !== null || priceMax !== null) {
      const numericPrice = {
        $toDouble: {
          $cond: {
            if: { $or: [{ $eq: ['$price', ''] }, { $eq: ['$price', null] }] },
            then: null,
            else: { $replaceAll: { input: '$price', find: { $literal: '$' }, replacement: '' } }
          }
        }
      };
      const priceConditions = [];
      if (priceMin !== null) priceConditions.push({ $gte: [numericPrice, priceMin] });
      if (priceMax !== null) priceConditions.push({ $lte: [numericPrice, priceMax] });
      query.$expr = priceConditions.length === 1 ? priceConditions[0] : { $and: priceConditions };
    }
    const total = await AsinDirectory.countDocuments(query);

    // Get paginated results
    const asins = await AsinDirectory.find(query)
      .sort(sortBy)
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      asins,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching ASINs:', error);
    res.status(500).json({ error: 'Failed to fetch ASINs' });
  }
});

// Get multiple ASINs by exact ASIN list (used by Proof Read flow)
/**
 * @swagger
 * /asin-directory/by-asins:
 *   get:
 *     tags: [ASIN Directory]
 *     summary: Fetch ASIN documents by comma-separated ASIN codes
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: asins
 *         required: true
 *         schema: { type: string }
 *         description: Comma-separated list of ASIN codes
 *     responses:
 *       200:
 *         description: Array of matching ASIN documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AsinDirectoryEntry'
 *       400:
 *         description: asins query param required
 *       500:
 *         description: Internal server error
 */
router.get('/by-asins', requireAuth, async (req, res) => {
  try {
    const { asins } = req.query; // comma-separated ASIN strings
    if (!asins) return res.status(400).json({ error: 'asins query param required' });
    const asinList = asins.split(',').map(a => a.trim().toUpperCase()).filter(Boolean);
    const docs = await AsinDirectory.find({ asin: { $in: asinList } }).lean();
    res.json(docs);
  } catch (error) {
    console.error('Error fetching ASINs by list:', error);
    res.status(500).json({ error: 'Failed to fetch ASINs' });
  }
});

// Get statistics
/**
 * @swagger
 * /asin-directory/stats:
 *   get:
 *     tags: [ASIN Directory]
 *     summary: Get ASIN directory statistics (total, unassigned, by period)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: addedByUserId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Statistics object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:      { type: integer }
 *                 unassigned: { type: integer }
 *                 assigned:   { type: integer }
 *                 recentlyAdded:
 *                   type: object
 *                   properties:
 *                     today:     { type: integer }
 *                     thisWeek:  { type: integer }
 *                     thisMonth: { type: integer }
 *       400:
 *         description: Invalid addedByUserId
 *       500:
 *         description: Internal server error
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const addedByUserId = req.query.addedByUserId || '';
    const baseQuery = {};

    if (addedByUserId) {
      if (!mongoose.Types.ObjectId.isValid(addedByUserId)) {
        return res.status(400).json({ error: 'Invalid addedByUserId' });
      }
      baseQuery.addedByUserId = addedByUserId;
    }

    const total = await AsinDirectory.countDocuments(baseQuery);
    const unassigned = await AsinDirectory.countDocuments({ ...baseQuery, listProductId: null });

    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const today = await AsinDirectory.countDocuments({ ...baseQuery, addedAt: { $gte: todayStart } });
    const thisWeek = await AsinDirectory.countDocuments({ ...baseQuery, addedAt: { $gte: weekStart } });
    const thisMonth = await AsinDirectory.countDocuments({ ...baseQuery, addedAt: { $gte: monthStart } });

    res.json({
      total,
      unassigned,
      assigned: total - unassigned,
      recentlyAdded: {
        today,
        thisWeek,
        thisMonth
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Bulk add ASINs manually — streaming SSE version (GET, token via query param)
/**
 * @swagger
 * /asin-directory/bulk-manual-stream:
 *   get:
 *     tags: [ASIN Directory]
 *     summary: Bulk-add ASINs with real-time SSE progress (auth via query token)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: asins
 *         required: true
 *         schema: { type: string }
 *         description: Comma-separated ASIN codes
 *       - in: query
 *         name: region
 *         schema: { type: string, default: US }
 *     responses:
 *       200:
 *         description: Server-sent event stream — events are `progress` and `complete`
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/bulk-manual-stream', requireAuthSSE, async (req, res) => {
  const asinsParam = req.query.asins || '';
  const region = req.query.region || 'US';

  const asins = asinsParam
    .split(',')
    .map(a => a.trim().toUpperCase())
    .filter(Boolean);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const results = { added: 0, duplicates: 0, errors: [] };
    const asinRegex = /^B[0-9A-Z]{9}$/;
    const validAsins = asins.filter(a => asinRegex.test(a));
    const invalidAsins = asins.filter(a => !asinRegex.test(a));
    invalidAsins.forEach(a => results.errors.push({ asin: a, reason: 'Invalid ASIN format' }));

    const total = validAsins.length;
    send('progress', { done: 0, total });

    const enrichmentMap = await scrapeAsinsBatched(validAsins, region, 5, (done) => {
      send('progress', { done, total });
    });

    for (const asin of validAsins) {
      try {
        const enrichment = enrichmentMap.get(asin);
        const doc = {
          asin,
          addedByUserId: req.user.userId || null,
        };
        if (enrichment?.ok) {
          const d = enrichment.data;
          doc.title = d.title || '';
          doc.brand = d.brand || '';
          doc.price = d.price ? String(d.price) : '';
          doc.images = Array.isArray(d.images) ? d.images : [];
          doc.description = d.description || '';
          doc.color = d.color || '';
          doc.compatibility = d.compatibility || '';
          doc.model = d.model || '';
          doc.material = d.material || '';
          doc.specialFeatures = d.specialFeatures || '';
          doc.size = d.size || '';
          doc.scraped = true;
          doc.scrapedAt = new Date();
          doc.scrapeError = null;
        } else {
          doc.scraped = false;
          doc.scrapeError = enrichment?.error || 'Scrape failed';
        }
        doc.region = region;
        await AsinDirectory.create(doc);
        results.added++;
      } catch (err) {
        if (err.code === 11000) {
          results.duplicates++;
        } else {
          results.errors.push({ asin, reason: err.message });
        }
      }
    }

    send('complete', results);
  } catch (err) {
    console.error('SSE bulk-manual-stream error:', err);
    send('error', { message: err.message || 'Failed to add ASINs' });
  } finally {
    res.end();
  }
});

// Bulk add ASINs manually
/**
 * @swagger
 * /asin-directory/bulk-manual:
 *   post:
 *     tags: [ASIN Directory]
 *     summary: Bulk-add ASINs with Amazon enrichment (synchronous)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asins]
 *             properties:
 *               asins:  { type: array, items: { type: string }, description: List of ASIN codes }
 *               region: { type: string, default: US }
 *     responses:
 *       200:
 *         description: Bulk add results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 added:      { type: integer }
 *                 duplicates: { type: integer }
 *                 errors:     { type: array, items: { type: object } }
 *       400:
 *         description: ASINs array is required
 *       500:
 *         description: Internal server error
 */
router.post('/bulk-manual', requireAuth, validate(bulkAddAsinsSchema), async (req, res) => {
  try {
    const { asins, region = 'US' } = req.body;

    const results = {
      added: 0,
      duplicates: 0,
      errors: []
    };

    // Validate ASINs
    const validAsins = [];
    const asinRegex = /^B[0-9A-Z]{9}$/;

    for (const asin of asins) {
      const cleanAsin = asin.trim().toUpperCase();
      
      if (!asinRegex.test(cleanAsin)) {
        results.errors.push({ asin, reason: 'Invalid ASIN format' });
        continue;
      }

      validAsins.push(cleanAsin);
    }

    // Scrape all valid ASINs in parallel batches
    console.log(`🔍 Scraping ${validAsins.length} ASINs for directory enrichment (${region})...`);
    const enrichmentMap = await scrapeAsinsBatched(validAsins, region);

    // Insert ASINs with enrichment data
    for (const asin of validAsins) {
      try {
        const enrichment = enrichmentMap.get(asin);
        const doc = {
          asin,
          addedByUserId: req.user.userId || null,
        };

        if (enrichment?.ok) {
          const d = enrichment.data;
          doc.title = d.title || '';
          doc.brand = d.brand || '';
          doc.price = d.price ? String(d.price) : '';
          doc.images = Array.isArray(d.images) ? d.images : [];
          doc.description = d.description || '';
          doc.color = d.color || '';
          doc.compatibility = d.compatibility || '';
          doc.model = d.model || '';
          doc.material = d.material || '';
          doc.specialFeatures = d.specialFeatures || '';
          doc.size = d.size || '';
          doc.scraped = true;
          doc.scrapedAt = new Date();
          doc.scrapeError = null;
        } else {
          doc.scraped = false;
          doc.scrapeError = enrichment?.error || 'Scrape failed';
        }
        doc.region = region;

        await AsinDirectory.create(doc);
        results.added++;
      } catch (error) {
        if (error.code === 11000) {
          // Duplicate key error
          results.duplicates++;
        } else {
          results.errors.push({ asin, reason: error.message });
        }
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Error bulk adding ASINs:', error);
    res.status(500).json({ error: 'Failed to add ASINs' });
  }
});

// Bulk add from CSV
/**
 * @swagger
 * /asin-directory/bulk-csv:
 *   post:
 *     tags: [ASIN Directory]
 *     summary: Import ASINs from raw CSV text
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [csvData]
 *             properties:
 *               csvData: { type: string, description: Raw CSV content with optional ASIN column header }
 *               region:  { type: string, default: US }
 *     responses:
 *       200:
 *         description: Import results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 added:      { type: integer }
 *                 duplicates: { type: integer }
 *                 errors:     { type: array, items: { type: object } }
 *       400:
 *         description: CSV data is required
 *       500:
 *         description: Internal server error
 */
router.post('/bulk-csv', requireAuth, validate(csvImportAsinsSchema), async (req, res) => {
  try {
    const { csvData, region = 'US' } = req.body;

    const results = {
      added: 0,
      duplicates: 0,
      errors: []
    };

    const asins = [];
    const asinRegex = /^B[0-9A-Z]{9}$/;

    // Parse CSV data manually
    const lines = csvData.trim().split('\n');
    
    if (lines.length === 0) {
      return res.json(results);
    }

    // Parse header to find ASIN column
    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    let asinColumnIndex = header.findIndex(h => h.toUpperCase() === 'ASIN');
    
    // If no ASIN column found, assume first column
    if (asinColumnIndex === -1) {
      asinColumnIndex = 0;
    }

    // Parse data rows (skip header)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',').map(cell => cell.trim().replace(/"/g, ''));
      const asinValue = row[asinColumnIndex];

      if (!asinValue || !asinValue.trim()) {
        continue; // Skip empty rows
      }

      const cleanAsin = asinValue.trim().toUpperCase();

      if (!asinRegex.test(cleanAsin)) {
        results.errors.push({ row: i + 1, asin: asinValue, reason: 'Invalid ASIN format' });
        continue;
      }

      asins.push({ asin: cleanAsin, row: i + 1 });
    }

    // Scrape all valid ASINs in parallel batches
    const asinStrings = asins.map(a => a.asin);
    console.log(`🔍 Scraping ${asinStrings.length} ASINs for directory enrichment (${region})...`);
    const enrichmentMap = await scrapeAsinsBatched(asinStrings, region);

    // Insert ASINs with enrichment data
    for (const { asin, row } of asins) {
      try {
        const enrichment = enrichmentMap.get(asin);
        const doc = {
          asin,
          addedByUserId: req.user.userId || null,
        };

        if (enrichment?.ok) {
          const d = enrichment.data;
          doc.title = d.title || '';
          doc.brand = d.brand || '';
          doc.price = d.price ? String(d.price) : '';
          doc.images = Array.isArray(d.images) ? d.images : [];
          doc.description = d.description || '';
          doc.color = d.color || '';
          doc.compatibility = d.compatibility || '';
          doc.model = d.model || '';
          doc.material = d.material || '';
          doc.specialFeatures = d.specialFeatures || '';
          doc.size = d.size || '';
          doc.scraped = true;
          doc.scrapedAt = new Date();
          doc.scrapeError = null;
        } else {
          doc.scraped = false;
          doc.scrapeError = enrichment?.error || 'Scrape failed';
        }
        doc.region = region;

        await AsinDirectory.create(doc);
        results.added++;
      } catch (error) {
        if (error.code === 11000) {
          results.duplicates++;
        } else {
          results.errors.push({ row, asin, reason: error.message });
        }
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Error importing CSV:', error);
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

// Export ASINs to CSV
/**
 * @swagger
 * /asin-directory/export-csv:
 *   get:
 *     tags: [ASIN Directory]
 *     summary: Export ASIN list as a downloadable CSV file
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: CSV file download
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       500:
 *         description: Internal server error
 */
router.get('/export-csv', requireAuth, async (req, res) => {
  try {
    const search = req.query.search || '';

    let query = {};
    if (search) {
      query.asin = { $regex: search.toUpperCase(), $options: 'i' };
    }

    const asins = await AsinDirectory.find(query).sort({ asin: 1 }).lean();

    // Generate CSV
    let csv = 'ASIN\n';
    asins.forEach(item => {
      csv += `${item.asin}\n`;
    });

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=asin-directory-${date}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// Manually update price and/or description for a single ASIN
/**
 * @swagger
 * /asin-directory/{id}:
 *   patch:
 *     tags: [ASIN Directory]
 *     summary: Manually update an ASIN's price or description
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               price:       { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Updated ASIN document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AsinDirectoryEntry'
 *       400:
 *         description: At least one field required
 *       404:
 *         description: ASIN not found
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags: [ASIN Directory]
 *     summary: Delete a single ASIN from the directory
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deletion confirmed
 *       404:
 *         description: ASIN not found
 *       500:
 *         description: Internal server error
 */
router.patch('/:id', requireAuth, validate(updateAsinSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { price, description } = req.body;

    if (price === undefined && description === undefined) {
      return res.status(400).json({ error: 'At least one of price or description must be provided' });
    }

    const update = { manuallyEdited: true, manuallyEditedAt: new Date() };
    if (price !== undefined) update.price = String(price).trim();
    if (description !== undefined) update.description = String(description).trim();

    const doc = await AsinDirectory.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: false }
    );

    if (!doc) {
      return res.status(404).json({ error: 'ASIN not found' });
    }

    console.log(`✏️ [ASIN Directory] Manually edited ${doc.asin} (price: ${update.price ?? '—'}, description: ${description !== undefined ? 'updated' : '—'})`);
    res.json(doc);
  } catch (error) {
    console.error('Error updating ASIN:', error);
    res.status(500).json({ error: 'Failed to update ASIN' });
  }
});

// Delete single ASIN
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await AsinDirectory.findByIdAndDelete(id);

    if (!result) {
      return res.status(404).json({ error: 'ASIN not found' });
    }

    res.json({ message: 'ASIN deleted successfully' });
  } catch (error) {
    console.error('Error deleting ASIN:', error);
    res.status(500).json({ error: 'Failed to delete ASIN' });
  }
});

// Bulk delete ASINs
/**
 * @swagger
 * /asin-directory/bulk-delete:
 *   post:
 *     tags: [ASIN Directory]
 *     summary: Bulk-delete ASINs by their MongoDB IDs
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Deletion results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:      { type: string }
 *                 deletedCount: { type: integer }
 *       400:
 *         description: IDs array is required
 *       500:
 *         description: Internal server error
 */
router.post('/bulk-delete', requireAuth, validate(bulkDeleteAsinsSchema), async (req, res) => {
  try {
    const { ids } = req.body;

    const result = await AsinDirectory.deleteMany({ _id: { $in: ids } });

    res.json({
      message: 'ASINs deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error bulk deleting ASINs:', error);
    res.status(500).json({ error: 'Failed to delete ASINs' });
  }
});

export default router;
