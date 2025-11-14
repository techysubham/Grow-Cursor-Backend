// routes/listingCompletions.js
import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import ListingCompletion from '../models/ListingCompletion.js';

const router = express.Router();

// Get listing completion history with filters
router.get('/', requireAuth, requireRole('superadmin', 'listingadmin', 'productadmin'), async (req, res) => {
  try {
    const { platformId, storeId, marketplace, startDate, endDate, listerId } = req.query;
    
    const query = {};
    
    if (platformId) query.listingPlatform = platformId;
    if (storeId) query.store = storeId;
    if (marketplace) query.marketplace = marketplace;
    if (listerId) query.lister = listerId;
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }
    
    const completions = await ListingCompletion.find(query)
      .populate('listingPlatform', 'name')
      .populate('store', 'name')
      .populate('lister', 'username email')
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .populate('rangeCompletions.range', 'name')
      .sort({ date: -1 });
    
    res.json(completions);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch listing completions.' });
  }
});

// Get aggregated listing sheet data
router.get('/sheet', requireAuth, requireRole('superadmin', 'listingadmin', 'productadmin'), async (req, res) => {
  try {
    const { platformId, storeId, marketplace, startDate, endDate } = req.query;
    
    const match = {};
    if (platformId) match.listingPlatform = new mongoose.Types.ObjectId(platformId);
    if (storeId) match.store = new mongoose.Types.ObjectId(storeId);
    if (marketplace) match.marketplace = marketplace;
    
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = new Date(startDate);
      if (endDate) match.date.$lte = new Date(endDate);
    }
    
    const pipeline = [
      { $match: match },
      { $unwind: '$rangeCompletions' },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            platform: '$listingPlatform',
            store: '$store',
            marketplace: '$marketplace',
            category: '$category',
            subcategory: '$subcategory',
            range: '$rangeCompletions.range'
          },
          totalQuantity: { $sum: '$rangeCompletions.quantity' }
        }
      },
      {
        $lookup: {
          from: 'platforms',
          localField: '_id.platform',
          foreignField: '_id',
          as: 'platformDoc'
        }
      },
      { $unwind: { path: '$platformDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'stores',
          localField: '_id.store',
          foreignField: '_id',
          as: 'storeDoc'
        }
      },
      { $unwind: { path: '$storeDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'categories',
          localField: '_id.category',
          foreignField: '_id',
          as: 'categoryDoc'
        }
      },
      { $unwind: { path: '$categoryDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'subcategories',
          localField: '_id.subcategory',
          foreignField: '_id',
          as: 'subcategoryDoc'
        }
      },
      { $unwind: { path: '$subcategoryDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'ranges',
          localField: '_id.range',
          foreignField: '_id',
          as: 'rangeDoc'
        }
      },
      { $unwind: { path: '$rangeDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          date: '$_id.date',
          platform: { $ifNull: ['$platformDoc.name', 'Unknown'] },
          store: { $ifNull: ['$storeDoc.name', 'Unknown'] },
          marketplace: '$_id.marketplace',
          category: { $ifNull: ['$categoryDoc.name', 'Unknown'] },
          subcategory: { $ifNull: ['$subcategoryDoc.name', 'Unknown'] },
          range: { $ifNull: ['$rangeDoc.name', 'Unknown'] },
          quantity: '$totalQuantity'
        }
      },
      { $sort: { date: -1, marketplace: 1, platform: 1, store: 1, category: 1, subcategory: 1, range: 1 } }
    ];
    
    const results = await ListingCompletion.aggregate(pipeline);
    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch listing sheet.' });
  }
});

export default router;
