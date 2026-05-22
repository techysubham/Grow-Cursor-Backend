import express from 'express';
import ItemCategoryMap from '../models/ItemCategoryMap.js';
import Order from '../models/Order.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * /item-category-map:
 *   get:
 *     tags: [Item Category Map]
 *     summary: Get all CRP mappings
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All item-category mappings with populated category/range/product
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ItemCategoryMap'
 *       500:
 *         description: Internal server error
 */
// Get all mappings (for bulk lookup during page load)
router.get('/', requireAuth, requirePageAccess('Fulfillment'), async (req, res) => {
  try {
    const mappings = await ItemCategoryMap.find()
      .populate('categoryId', 'name')
      .populate('rangeId', 'name')
      .populate('productId', 'name')
      .lean();
    res.json(mappings);
  } catch (error) {
    console.error('Error fetching item category mappings:', error);
    res.status(500).json({ error: 'Failed to fetch mappings' });
  }
});

/**
 * @swagger
 * /item-category-map/lookup:
 *   post:
 *     tags: [Item Category Map]
 *     summary: Batch lookup mappings by item numbers
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [itemNumbers]
 *             properties:
 *               itemNumbers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ['123456789012', '987654321098']
 *     responses:
 *       200:
 *         description: Object keyed by itemNumber with populated mapping values
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 $ref: '#/components/schemas/ItemCategoryMap'
 *       400:
 *         description: itemNumbers array is required
 *       500:
 *         description: Internal server error
 */
// Get mappings for specific item numbers (batch lookup)
router.post('/lookup', requireAuth, requirePageAccess('Fulfillment'), async (req, res) => {
  try {
    const { itemNumbers } = req.body;
    if (!itemNumbers || !Array.isArray(itemNumbers)) {
      return res.status(400).json({ error: 'itemNumbers array is required' });
    }

    const mappings = await ItemCategoryMap.find({ itemNumber: { $in: itemNumbers } })
      .populate('categoryId', 'name')
      .populate('rangeId', 'name')
      .populate('productId', 'name')
      .lean();

    // Return as a map for easy lookup: { itemNumber: mapping }
    const mappingIndex = {};
    mappings.forEach(m => {
      mappingIndex[m.itemNumber] = m;
    });
    res.json(mappingIndex);
  } catch (error) {
    console.error('Error looking up item category mappings:', error);
    res.status(500).json({ error: 'Failed to lookup mappings' });
  }
});

/**
 * @swagger
 * /item-category-map/{itemNumber}:
 *   put:
 *     tags: [Item Category Map]
 *     summary: Set or update CRP for an item number
 *     description: Upserts the mapping and propagates categoryId/rangeId/productId to all matching orders.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: itemNumber
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [categoryId]
 *             properties:
 *               categoryId:
 *                 type: string
 *               rangeId:
 *                 type: string
 *               productId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated mapping and count of orders affected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 mapping:
 *                   $ref: '#/components/schemas/ItemCategoryMap'
 *                 ordersUpdated:
 *                   type: integer
 *       400:
 *         description: categoryId is required
 *       500:
 *         description: Internal server error
 */
// Set/update CRP for an item (and propagate to all orders with that itemNumber)
router.put('/:itemNumber', requireAuth, requirePageAccess('Fulfillment'), async (req, res) => {
  try {
    const { itemNumber } = req.params;
    const { categoryId, rangeId, productId } = req.body;

    if (!categoryId) {
      return res.status(400).json({ error: 'categoryId is required' });
    }

    // Upsert the mapping
    const mapping = await ItemCategoryMap.findOneAndUpdate(
      { itemNumber },
      {
        categoryId,
        rangeId: rangeId || null,
        productId: productId || null,
        assignedBy: req.user.userId
      },
      { upsert: true, new: true }
    )
      .populate('categoryId', 'name')
      .populate('rangeId', 'name')
      .populate('productId', 'name');

    // Propagate to all orders with this itemNumber
    const orderUpdate = {
      orderCategoryId: categoryId,
      orderRangeId: rangeId || null,
      orderProductId: productId || null
    };
    const updateResult = await Order.updateMany({ itemNumber }, orderUpdate);

    res.json({
      mapping,
      ordersUpdated: updateResult.modifiedCount
    });
  } catch (error) {
    console.error('Error setting item category mapping:', error);
    res.status(500).json({ error: 'Failed to set mapping' });
  }
});

/**
 * @swagger
 * /item-category-map/{itemNumber}:
 *   delete:
 *     tags: [Item Category Map]
 *     summary: Remove CRP mapping for an item number
 *     description: Deletes the mapping and clears orderCategoryId/orderRangeId/orderProductId from all matching orders.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: itemNumber
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Mapping removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       500:
 *         description: Internal server error
 */
// Remove CRP from an item (and clear from all orders)
router.delete('/:itemNumber', requireAuth, requirePageAccess('Fulfillment'), async (req, res) => {
  try {
    const { itemNumber } = req.params;

    await ItemCategoryMap.deleteOne({ itemNumber });

    // Clear CRP from all orders with this itemNumber
    await Order.updateMany({ itemNumber }, {
      orderCategoryId: null,
      orderRangeId: null,
      orderProductId: null
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing item category mapping:', error);
    res.status(500).json({ error: 'Failed to remove mapping' });
  }
});

export default router;
