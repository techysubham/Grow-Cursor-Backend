import express from 'express';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Seller from '../models/Seller.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { microOrdersQuerySchema } from '../schemas/index.js';

const EXCLUDED_CLIENT_USERNAME = 'Vergo';

async function getExcludedClientSellerIds() {
  const sellers = await Seller.find({})
    .populate('user', 'username')
    .select('_id user')
    .lean();
  return sellers
    .filter((s) => s.user?.username?.trim().toLowerCase() === EXCLUDED_CLIENT_USERNAME.toLowerCase())
    .map((s) => s._id);
}

const router = express.Router();

// ── Computation constants ────────────────────────────────────────────────────
// sellerCostINR    = subtotal(USD) × 90
// sellerMarkupFee  = subtotal(USD) × 90 × 4%
// sellerIGST       = sellerMarkupFee × 18%
// profitFake       = pBalanceINR − sellerCostINR − sellerMarkupFee − sellerIGST
const COST_FACTOR   = 90;                 // subtotal → INR cost
const MARKUP_FACTOR = 90 * 0.04;          // 3.6  — subtotal → INR markup fee
const IGST_FACTOR   = 90 * 0.04 * 0.18;  // 0.648 — subtotal → INR IGST

/**
 * GET /api/micro-orders
 *
 * Returns paginated orders where 0.01 < subtotal < 3.00, with seller-wise
 * and date filters.  Computed metrics (sellerCost, sellerMarkupFee,
 * sellerIGST, profitFake) are added on-the-fly via aggregation.
 *
 * Query params:
 *   seller   — Seller ObjectId (optional)
 *   dateMode — 'none' | 'single' | 'range'
 *   date     — ISO date string (when dateMode='single')
 *   dateFrom — ISO date string (when dateMode='range')
 *   dateTo   — ISO date string (when dateMode='range')
 *   page     — page number (default 1)
 *   limit    — rows per page (default 50, max 200)
 *
 * Response:
 *   { orders, totalRecords, totalPages, currentPage, totalCount, totalProfitFake }
 */
/**
 * @swagger
 * /micro-orders:
 *   get:
 *     tags: [Micro Orders]
 *     summary: List micro orders (subtotal $0.01–$2.99) with computed INR profit
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: seller
 *         schema: { type: string }
 *       - in: query
 *         name: dateMode
 *         schema: { type: string, enum: ['none','single','range'], default: 'none' }
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: excludeClient
 *         schema: { type: string, enum: ['true','false'] }
 *         description: Exclude the Vergo client seller
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200:
 *         description: Paginated micro orders with computed metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orders:          { type: array, items: { type: object } }
 *                 totalRecords:    { type: integer }
 *                 totalPages:      { type: integer }
 *                 currentPage:     { type: integer }
 *                 totalCount:      { type: integer }
 *                 totalProfitFake: { type: number }
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, requirePageAccess('MicroOrders'), validate(microOrdersQuerySchema, 'query'), async (req, res) => {
  try {
    const {
      seller,
      dateMode = 'none',
      date,
      dateFrom,
      dateTo,
      excludeClient,
      page  = 1,
      limit = 50,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const skip     = (pageNum - 1) * limitNum;

    // ── Base filter ──────────────────────────────────────────────────────────
    const match = {
      subtotal: { $gt: 0.01, $lt: 3.00 },
    };

    if (seller) {
      match.seller = new mongoose.Types.ObjectId(seller);
    }

    // Exclude Vergo seller when flag is set
    if (excludeClient === 'true') {
      const excludedIds = await getExcludedClientSellerIds();
      if (excludedIds.length > 0) {
        if (match.seller) {
          // If a specific seller is selected and it's the excluded one, return empty
          if (excludedIds.some((id) => id.equals(match.seller))) {
            return res.json({ orders: [], totalRecords: 0, totalPages: 0, currentPage: 1, totalCount: 0, totalProfitFake: 0 });
          }
        } else {
          match.seller = { $nin: excludedIds };
        }
      }
    }

    // ── Date filter on dateSold ──────────────────────────────────────────────
    if (dateMode === 'single' && date) {
      const start = new Date(date);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setUTCHours(23, 59, 59, 999);
      match.dateSold = { $gte: start, $lte: end };
    } else if (dateMode === 'range' && dateFrom && dateTo) {
      const start = new Date(dateFrom);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(dateTo);
      end.setUTCHours(23, 59, 59, 999);
      match.dateSold = { $gte: start, $lte: end };
    }

    // ── Aggregation pipeline ─────────────────────────────────────────────────
    const pipeline = [
      { $match: match },

      // Resolve seller → user → username (two-stage lookup)
      {
        $lookup: {
          from: 'sellers',
          localField: 'seller',
          foreignField: '_id',
          as: '_sellerDoc',
        },
      },
      // Extract the user ObjectId so the next $lookup can use it as a plain field
      {
        $addFields: {
          _sellerUserId: { $arrayElemAt: ['$_sellerDoc.user', 0] },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_sellerUserId',
          foreignField: '_id',
          as: '_userDoc',
        },
      },

      // Add computed columns
      {
        $addFields: {
          sellerName:      { $arrayElemAt: ['$_userDoc.username', 0] },
          sellerCost:      { $multiply: ['$subtotal', COST_FACTOR] },
          sellerMarkupFee: { $multiply: ['$subtotal', MARKUP_FACTOR] },
          sellerIGST:      { $multiply: ['$subtotal', IGST_FACTOR] },
        },
      },
      {
        $addFields: {
          profitFake: {
            $subtract: [
              {
                $subtract: [
                  {
                    $subtract: [
                      { $ifNull: ['$pBalanceINR', 0] },
                      '$sellerCost',
                    ],
                  },
                  '$sellerMarkupFee',
                ],
              },
              '$sellerIGST',
            ],
          },
        },
      },

      // Parallel: aggregate totals + paginate data
      {
        $facet: {
          metadata: [
            {
              $group: {
                _id:            null,
                totalCount:     { $sum: 1 },
                totalProfitFake:{ $sum: '$profitFake' },
              },
            },
          ],
          data: [
            { $sort:    { dateSold: -1 } },
            { $skip:    skip },
            { $limit:   limitNum },
            { $project: { _sellerDoc: 0, _sellerUserId: 0, _userDoc: 0 } },
          ],
        },
      },
    ];

    const [result] = await Order.aggregate(pipeline);
    const meta   = result?.metadata?.[0] ?? { totalCount: 0, totalProfitFake: 0 };
    const orders = result?.data ?? [];

    return res.json({
      orders,
      totalRecords:    meta.totalCount,
      totalPages:      Math.ceil(meta.totalCount / limitNum),
      currentPage:     pageNum,
      totalCount:      meta.totalCount,
      totalProfitFake: meta.totalProfitFake,
    });
  } catch (err) {
    console.error('[micro-orders] GET error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;
