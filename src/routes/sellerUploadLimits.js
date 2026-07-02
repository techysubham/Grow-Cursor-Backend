import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { sellerUploadLimitSchema, sellerUploadLimitCheckQuerySchema } from '../schemas/index.js';
import SellerUploadLimit from '../models/SellerUploadLimit.js';
import Seller from '../models/Seller.js';
import { checkUploadLimit } from '../lib/ebayFeedUpload.js';

const router = express.Router();

/**
 * @swagger
 * /seller-upload-limits:
 *   get:
 *     tags: [Seller Upload Limits]
 *     summary: List all seller upload limits with live counts
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of limit records with currentCount and isBlocked status
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SellerUploadLimit'
 *       500:
 *         description: Internal server error
 */
// ─── GET /seller-upload-limits ───────────────────────────────────────────────
// Returns all configured limits with live currentCount and isBlocked status.
router.get('/', requireAuth, requirePageAccess('SellerUploadLimits'), async (req, res) => {
    try {
        const limits = await SellerUploadLimit.find()
            .populate({ path: 'seller', populate: { path: 'user', select: 'username email' } })
            .sort({ createdAt: -1 });

        const limitsWithCounts = await Promise.all(limits.map(async (limit) => {
            const { isBlocked, currentCount } = await checkUploadLimit(
                limit.seller._id.toString(),
                limit.country
            );
            return {
                ...limit.toObject(),
                sellerName: limit.seller?.user?.username || limit.seller?.user?.email || 'Unknown',
                currentCount,
                isBlocked
            };
        }));

        return res.json(limitsWithCounts);
    } catch (err) {
        console.error('[SellerUploadLimits] GET / error:', err);
        return res.status(500).json({ error: 'Failed to fetch upload limits' });
    }
});

/**
 * @swagger
 * /seller-upload-limits/check:
 *   get:
 *     tags: [Seller Upload Limits]
 *     summary: Check upload limit status for a seller+country pair
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: country
 *         required: true
 *         schema:
 *           type: string
 *           enum: [US, UK, AU, Canada]
 *     responses:
 *       200:
 *         description: Upload limit check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isBlocked:
 *                   type: boolean
 *                 currentCount:
 *                   type: integer
 *       400:
 *         description: Missing or invalid sellerId / country
 *       500:
 *         description: Internal server error
 */
// ─── GET /seller-upload-limits/check ─────────────────────────────────────────
// Lightweight check used by FeedUploadPage and SelectSellerPage.
// Query params: sellerId, country
router.get('/check', requireAuth, validate(sellerUploadLimitCheckQuerySchema, 'query'), async (req, res) => {
    const { sellerId, country } = req.query;
    if (!mongoose.Types.ObjectId.isValid(sellerId)) {
        return res.status(400).json({ error: 'Invalid sellerId' });
    }
    try {
        const result = await checkUploadLimit(sellerId, country);
        return res.json(result);
    } catch (err) {
        console.error('[SellerUploadLimits] GET /check error:', err);
        return res.status(500).json({ error: 'Failed to check upload limit' });
    }
});

/**
 * @swagger
 * /seller-upload-limits:
 *   post:
 *     tags: [Seller Upload Limits]
 *     summary: Create or update a daily upload limit (upsert)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sellerId, country, limit]
 *             properties:
 *               sellerId:
 *                 type: string
 *               country:
 *                 type: string
 *                 enum: [US, UK, AU, Canada]
 *               limit:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       200:
 *         description: Created or updated limit record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SellerUploadLimit'
 *       400:
 *         description: Bad request
 *       404:
 *         description: Seller not found
 *       500:
 *         description: Internal server error
 */
// ─── POST /seller-upload-limits ──────────────────────────────────────────────
// Creates or updates a daily limit for a seller+country pair (upsert).
router.post('/', requireAuth, requirePageAccess('SellerUploadLimits'), validate(sellerUploadLimitSchema), async (req, res) => {
    const { sellerId, country, limit } = req.body;

    if (!mongoose.Types.ObjectId.isValid(sellerId)) {
        return res.status(400).json({ error: 'Invalid sellerId' });
    }

    const sellerExists = await Seller.exists({ _id: sellerId });
    if (!sellerExists) return res.status(404).json({ error: 'Seller not found' });

    try {
        const record = await SellerUploadLimit.findOneAndUpdate(
            { seller: sellerId, country },
            { seller: sellerId, country, limit },
            { upsert: true, new: true, runValidators: true }
        );
        return res.status(200).json(record);
    } catch (err) {
        console.error('[SellerUploadLimits] POST / error:', err);
        return res.status(500).json({ error: 'Failed to save upload limit' });
    }
});

/**
 * @swagger
 * /seller-upload-limits/{id}:
 *   delete:
 *     tags: [Seller Upload Limits]
 *     summary: Delete a seller upload limit
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: Invalid id
 *       404:
 *         description: Limit not found
 *       500:
 *         description: Internal server error
 */
// ─── DELETE /seller-upload-limits/:id ────────────────────────────────────────
router.delete('/:id', requireAuth, requirePageAccess('SellerUploadLimits'), async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    try {
        const deleted = await SellerUploadLimit.findByIdAndDelete(id);
        if (!deleted) return res.status(404).json({ error: 'Limit not found' });
        return res.json({ success: true });
    } catch (err) {
        console.error('[SellerUploadLimits] DELETE /:id error:', err);
        return res.status(500).json({ error: 'Failed to delete upload limit' });
    }
});

export default router;
