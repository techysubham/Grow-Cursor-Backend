import express from 'express';
const router = express.Router();
import { requireAuth } from '../middleware/auth.js';
import TemplateOverride from '../models/TemplateOverride.js';
import ListingTemplate from '../models/ListingTemplate.js';
import SellerPricingConfig from '../models/SellerPricingConfig.js';
import { 
  getEffectiveTemplate, 
  mergeTemplate, 
  hasOverride,
  getOverrideCount,
  getOverriddenSellers 
} from '../utils/templateMerger.js';

/**
 * Get count of sellers who have overridden a template
 * GET /api/template-overrides/:templateId/count
 */
/**
 * @swagger
 * /template-overrides/{templateId}/count:
 *   get:
 *     tags: [Template Overrides]
 *     summary: Count sellers who have customised a template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Count of sellers with any override or pricing config
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:      { type: integer }
 *                 templateId: { type: string }
 *       500:
 *         description: Internal server error
 */
router.get('/:templateId/count', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;

    const [overrides, pricingConfigs] = await Promise.all([
      TemplateOverride.find({ baseTemplateId: templateId }).select('sellerId').lean(),
      SellerPricingConfig.find({ templateId }).select('sellerId').lean()
    ]);

    const sellerSet = new Set([
      ...overrides.map(o => o.sellerId.toString()),
      ...pricingConfigs.map(p => p.sellerId.toString())
    ]);

    res.json({ count: sellerSet.size, templateId });
  } catch (error) {
    console.error('Error counting overrides:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get effective template for seller (base + overrides merged)
 * GET /api/template-overrides/:templateId/effective?sellerId=xxx
 */
/**
 * @swagger
 * /template-overrides/{templateId}/effective:
 *   get:
 *     tags: [Template Overrides]
 *     summary: Get the merged (base + seller override) template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Effective template with seller overrides applied
 *       400:
 *         description: sellerId is required
 *       500:
 *         description: Internal server error
 */
router.get('/:templateId/effective', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    if (!sellerId) {
      return res.status(400).json({ error: 'sellerId is required' });
    }
    
    const effectiveTemplate = await getEffectiveTemplate(templateId, sellerId);
    res.json(effectiveTemplate);
  } catch (error) {
    console.error('Error getting effective template:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get seller's override for a template (if exists)
 * GET /api/template-overrides/:templateId/override?sellerId=xxx
 */
/**
 * @swagger
 * /template-overrides/{templateId}/override:
 *   get:
 *     tags: [Template Overrides]
 *     summary: Get a seller's override document for a template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Override document or null if none exists
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/TemplateOverride'
 *                 - nullable: true
 *       400:
 *         description: sellerId is required
 *       500:
 *         description: Internal server error
 *   put:
 *     tags: [Template Overrides]
 *     summary: Create or replace a seller's full override
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sellerId, overrides]
 *             properties:
 *               sellerId:  { type: string }
 *               overrides: { type: object, description: Override data for each section }
 *     responses:
 *       200:
 *         description: Saved override document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TemplateOverride'
 *       400:
 *         description: Missing sellerId or overrides
 *       404:
 *         description: Base template not found
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags: [Template Overrides]
 *     summary: Delete a seller's full override (revert to base template)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Override deleted
 *       400:
 *         description: sellerId is required
 *       404:
 *         description: Override not found
 *       500:
 *         description: Internal server error
 */
router.get('/:templateId/override', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    if (!sellerId) {
      return res.status(400).json({ error: 'sellerId is required' });
    }
    
    const override = await TemplateOverride.findOne({
      baseTemplateId: templateId,
      sellerId: sellerId
    });
    
    res.json(override || null);
  } catch (error) {
    console.error('Error getting override:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Check if seller has override for template
 * GET /api/template-overrides/:templateId/has-override?sellerId=xxx
 */
/**
 * @swagger
 * /template-overrides/{templateId}/has-override:
 *   get:
 *     tags: [Template Overrides]
 *     summary: Check whether a seller has any override for a template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Boolean flag
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hasOverride: { type: boolean }
 *       400:
 *         description: sellerId is required
 *       500:
 *         description: Internal server error
 */
router.get('/:templateId/has-override', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    if (!sellerId) {
      return res.status(400).json({ error: 'sellerId is required' });
    }
    
    const exists = await hasOverride(templateId, sellerId);
    res.json({ hasOverride: exists });
  } catch (error) {
    console.error('Error checking override:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get override count for template (how many sellers customized it)
 * GET /api/template-overrides/:templateId/count
 */
router.get('/:templateId/count', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const count = await getOverrideCount(templateId);
    res.json({ count });
  } catch (error) {
    console.error('Error getting override count:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create or update seller's override (full replacement)
 * PUT /api/template-overrides/:templateId/override
 */
router.put('/:templateId/override', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId, overrides, ...overrideData } = req.body;
    
    if (!sellerId) {
      return res.status(400).json({ error: 'sellerId is required' });
    }
    
    if (!overrides) {
      return res.status(400).json({ error: 'overrides object is required' });
    }
    
    // Verify base template exists
    const baseTemplate = await ListingTemplate.findById(templateId);
    if (!baseTemplate) {
      return res.status(404).json({ error: 'Base template not found' });
    }
    
    // Upsert override
    const override = await TemplateOverride.findOneAndUpdate(
      { baseTemplateId: templateId, sellerId: sellerId },
      { 
        $set: {
          overrides,
          ...overrideData,
          updatedAt: Date.now()
        }
      },
      { new: true, upsert: true }
    );
    
    console.log(`Template override saved for seller ${sellerId} on template ${templateId}`);
    res.json(override);
  } catch (error) {
    console.error('Error saving override:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Partially update specific override section
 * PATCH /api/template-overrides/:templateId/override/:section
 */
/**
 * @swagger
 * /template-overrides/{templateId}/override/{section}:
 *   patch:
 *     tags: [Template Overrides]
 *     summary: Update a single section of a seller's override
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: section
 *         required: true
 *         schema:
 *           type: string
 *           enum: [customColumns, asinAutomation, pricingConfig, coreFieldDefaults, customActionField]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sellerId, data]
 *             properties:
 *               sellerId: { type: string }
 *               data:     { type: object }
 *     responses:
 *       200:
 *         description: Updated override document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TemplateOverride'
 *       400:
 *         description: Missing sellerId/data or invalid section
 *       404:
 *         description: Base template not found
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags: [Template Overrides]
 *     summary: Reset a single override section back to base template
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: section
 *         required: true
 *         schema:
 *           type: string
 *           enum: [customColumns, asinAutomation, pricingConfig, coreFieldDefaults, customActionField]
 *       - in: query
 *         name: sellerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated override or deletion message if all sections cleared
 *       400:
 *         description: Missing sellerId or invalid section
 *       404:
 *         description: Override not found
 *       500:
 *         description: Internal server error
 */
router.patch('/:templateId/override/:section', requireAuth, async (req, res) => {
  try {
    const { templateId, section } = req.params;
    const { sellerId, data } = req.body;
    
    if (!sellerId) {
      return res.status(400).json({ error: 'sellerId is required' });
    }
    
    // Validate section
    const validSections = ['customColumns', 'asinAutomation', 'pricingConfig', 'coreFieldDefaults', 'customActionField'];
    if (!validSections.includes(section)) {
      return res.status(400).json({ error: `Invalid section. Must be one of: ${validSections.join(', ')}` });
    }
    
    // Verify base template exists
    const baseTemplate = await ListingTemplate.findById(templateId);
    if (!baseTemplate) {
      return res.status(404).json({ error: 'Base template not found' });
    }
    
    const update = {
      [`overrides.${section}`]: true,
      [section]: data,
      updatedAt: Date.now()
    };
    
    const override = await TemplateOverride.findOneAndUpdate(
      { baseTemplateId: templateId, sellerId: sellerId },
      { $set: update },
      { new: true, upsert: true }
    );
    
    console.log(`Template override section '${section}' updated for seller ${sellerId} on template ${templateId}`);
    res.json(override);
  } catch (error) {
    console.error('Error updating override section:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reset seller's override (revert to base template)
 * DELETE /api/template-overrides/:templateId/override?sellerId=xxx
 */
router.delete('/:templateId/override', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { sellerId } = req.query;
    
    if (!sellerId) {
      return res.status(400).json({ error: 'sellerId is required' });
    }
    
    const result = await TemplateOverride.deleteOne({
      baseTemplateId: templateId,
      sellerId: sellerId
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Override not found' });
    }
    
    console.log(`Template override deleted for seller ${sellerId} on template ${templateId}`);
    res.json({ message: 'Override deleted, reverted to base template' });
  } catch (error) {
    console.error('Error deleting override:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reset specific section of override (revert section to base template)
 * DELETE /api/template-overrides/:templateId/override/:section?sellerId=xxx
 */
router.delete('/:templateId/override/:section', requireAuth, async (req, res) => {
  try {
    const { templateId, section } = req.params;
    const { sellerId } = req.query;
    
    if (!sellerId) {
      return res.status(400).json({ error: 'sellerId is required' });
    }
    
    // Validate section
    const validSections = ['customColumns', 'asinAutomation', 'pricingConfig', 'coreFieldDefaults', 'customActionField'];
    if (!validSections.includes(section)) {
      return res.status(400).json({ error: `Invalid section. Must be one of: ${validSections.join(', ')}` });
    }
    
    const update = {
      [`overrides.${section}`]: false,
      [section]: undefined
    };
    
    const override = await TemplateOverride.findOneAndUpdate(
      { baseTemplateId: templateId, sellerId: sellerId },
      { $set: update },
      { new: true }
    );
    
    if (!override) {
      return res.status(404).json({ error: 'Override not found' });
    }
    
    // If all sections are now false, delete the override document
    const hasAnyOverride = Object.values(override.overrides).some(v => v === true);
    if (!hasAnyOverride) {
      await TemplateOverride.deleteOne({ _id: override._id });
      console.log(`All overrides cleared for seller ${sellerId} on template ${templateId}, document deleted`);
      return res.json({ message: 'All overrides cleared, override document deleted' });
    }
    
    console.log(`Template override section '${section}' cleared for seller ${sellerId} on template ${templateId}`);
    res.json(override);
  } catch (error) {
    console.error('Error clearing override section:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
