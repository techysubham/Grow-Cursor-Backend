import express from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import EndListingLog from '../models/EndListingLog.js';

const router = express.Router();

/**
 * GET /end-listing-logs/stats
 * Returns per-seller end-listing counts grouped by source (duplicate_sku / expiry_listing),
 * optionally filtered by sellerId and date range.
 *
 * Query params:
 *   sellerId   - optional, filter to one seller
 *   startDate  - optional, YYYY-MM-DD (IST)
 *   endDate    - optional, YYYY-MM-DD (IST)
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { sellerId, startDate, endDate } = req.query;

    const matchCriteria = {};

    if (sellerId) {
      if (!mongoose.Types.ObjectId.isValid(sellerId)) {
        return res.status(400).json({ error: 'Invalid sellerId' });
      }
      matchCriteria.seller = new mongoose.Types.ObjectId(sellerId);
    }

    if (startDate || endDate) {
      matchCriteria.endedAt = {};
      if (startDate) {
        matchCriteria.endedAt.$gte = new Date(startDate + 'T00:00:00.000+05:30');
      }
      if (endDate) {
        matchCriteria.endedAt.$lte = new Date(endDate + 'T23:59:59.999+05:30');
      }
    }

    const rows = await EndListingLog.aggregate([
      { $match: matchCriteria },
      {
        $group: {
          _id: { seller: '$seller', source: '$source' },
          count: { $sum: 1 },
        },
      },
      // Pivot sources into separate fields per seller
      {
        $group: {
          _id: '$_id.seller',
          sources: {
            $push: { source: '$_id.source', count: '$count' },
          },
        },
      },
      {
        $lookup: {
          from: 'sellers',
          localField: '_id',
          foreignField: '_id',
          as: 'sellerInfo',
        },
      },
      { $unwind: { path: '$sellerInfo', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'sellerInfo.user',
          foreignField: '_id',
          as: 'userInfo',
        },
      },
      { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          sellerId: '$_id',
          sellerName: '$userInfo.username',
          sources: 1,
        },
      },
      { $sort: { sellerName: 1 } },
    ]);

    // Flatten sources array into named fields
    const result = rows.map(row => {
      const duplicateSkuCount = row.sources.find(s => s.source === 'duplicate_sku')?.count || 0;
      const expiryListingCount = row.sources.find(s => s.source === 'expiry_listing')?.count || 0;
      return {
        sellerId: row.sellerId,
        sellerName: row.sellerName || 'Unknown',
        duplicateSkuCount,
        expiryListingCount,
        total: duplicateSkuCount + expiryListingCount,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('[EndListingLogs] Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch end-listing stats' });
  }
});

export default router;
