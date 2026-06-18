import express from 'express';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import PriceChangeLog from '../models/PriceChangeLog.js';
import { parsePagination } from '../utils/paginate.js';

const router = express.Router();

// GET /api/price-change-logs — Get price change history with filters
/**
 * @swagger
 * /price-change-logs:
 *   get:
 *     tags: [Price Change Logs]
 *     summary: Get eBay price change audit log (paginated)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: legacyItemId
 *         schema: { type: string }
 *       - in: query
 *         name: orderId
 *         schema: { type: string }
 *       - in: query
 *         name: userId
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         schema: { type: string }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: successOnly
 *         schema: { type: string, enum: ['true','false'] }
 *       - in: query
 *         name: failedOnly
 *         schema: { type: string, enum: ['true','false'] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated price change logs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 logs:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PriceChangeLog'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:      { type: integer }
 *                     page:       { type: integer }
 *                     limit:      { type: integer }
 *                     totalPages: { type: integer }
 *       500:
 *         description: Internal server error
 */
router.get('/', requireAuth, requirePageAccess('PriceChangeHistory'), async (req, res) => {
  try {
    const {
      legacyItemId,
      orderId,
      userId,
      sellerId,
      startDate,
      endDate,
      successOnly,
      failedOnly
    } = req.query;

    const query = {};

    if (legacyItemId) query.legacyItemId = legacyItemId;
    if (orderId) query.orderId = orderId;
    if (userId) query.user = userId;
    if (sellerId) query.seller = sellerId;
    if (successOnly === 'true') query.success = true;
    if (failedOnly === 'true') query.success = false;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });

    const [logs, total] = await Promise.all([
      PriceChangeLog.find(query)
        .populate('user', 'username email')
        .populate('seller', 'user')
        .populate({
          path: 'seller',
          populate: { path: 'user', select: 'username' }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PriceChangeLog.countDocuments(query)
    ]);

    res.json({
      logs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('[Price Change Logs] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
