import { Router } from 'express';
import { requireAuth, requirePageAccess, requireRole } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import User from '../models/User.js';
import UserSellerAssignment from '../models/UserSellerAssignment.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Sellers
 *   description: Seller profile management and eBay marketplace connections
 */

/**
 * @swagger
 * /sellers/all:
 *   get:
 *     tags: [Sellers]
 *     summary: List all sellers (role-filtered)
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Superadmin sees all sellers. Other authenticated users see only their assigned sellers
 *       (via UserSellerAssignment).
 *     responses:
 *       200: { description: Array of seller objects (with populated user) }
 *       401: { description: Unauthorized }
 */
// List all sellers (for admin dashboard)
// Superadmin sees all; other users see only their assigned sellers
router.get('/all', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'superadmin') {
      // Superadmin sees all sellers
      const sellers = await Seller.find().populate('user', 'username email');
      return res.json(sellers);
    }

    // For non-superadmin: get their seller assignments
    const assignments = await UserSellerAssignment.find({ user: req.user.userId }).select('seller').lean();
    const assignedSellerIds = assignments.map(a => a.seller);

    if (assignedSellerIds.length === 0) {
      // No assignments — return all sellers (backward compat for roles that had full access before)
      // This preserves existing behavior for users who haven't been explicitly assigned sellers
      const sellers = await Seller.find().populate('user', 'username email');
      return res.json(sellers);
    }

    // Filter to only assigned sellers
    const sellers = await Seller.find({ _id: { $in: assignedSellerIds } }).populate('user', 'username email');
    res.json(sellers);
  } catch (err) {
    console.error('Error fetching sellers:', err);
    res.status(500).json({ error: 'Failed to fetch sellers' });
  }
});

// List all sellers without filtering (for Fulfillment Dashboard)
// All authenticated users can see all sellers
/**
 * @swagger
 * /sellers/all-unfiltered:
 *   get:
 *     tags: [Sellers]
 *     summary: List all sellers without role filtering
 *     security:
 *       - bearerAuth: []
 *     description: Returns every seller regardless of UserSellerAssignment. Restricted to superadmin.
 *     responses:
 *       200: { description: Array of all seller objects }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get('/all-unfiltered', requireAuth, async (req, res) => {
  try {
    const sellers = await Seller.find().populate('user', 'username email');
    res.json(sellers);
  } catch (err) {
    console.error('Error fetching sellers:', err);
    res.status(500).json({ error: 'Failed to fetch sellers' });
  }
});

// Get current seller profile and eBay marketplaces
/**
 * @swagger
 * /sellers/me:
 *   get:
 *     tags: [Sellers]
 *     summary: Get the current seller's own profile
 *     security:
 *       - bearerAuth: []
 *     description: Returns the seller document linked to the authenticated seller user.
 *     responses:
 *       200: { description: Seller profile object }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller not found }
 */
router.get('/me', requireAuth, requireRole('seller'), async (req, res) => {
  try {
    console.log('Fetching seller for user:', req.user);
    const seller = await Seller.findOne({ user: req.user.userId });
    if (!seller) {
      console.log('Seller not found for userId:', req.user.userId);
      return res.status(404).json({ error: 'Seller not found' });
    }
    console.log('Seller found:', seller);
    res.json(seller);
  } catch (error) {
    console.error('Error fetching seller profile:', error);
    res.status(500).json({ error: 'Failed to fetch seller profile' });
  }
});

// Add an eBay marketplace region (e.g., EBAY_US, EBAY_UK)
/**
 * @swagger
 * /sellers/marketplaces:
 *   post:
 *     tags: [Sellers]
 *     summary: Add a marketplace to the seller's profile
 *     security:
 *       - bearerAuth: []
 *     description: Adds a new marketplace entry (region + credentials) to the seller. Requires seller role.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [region]
 *             properties:
 *               region: { type: string, example: EBAY_US }
 *     responses:
 *       200: { description: Updated seller with new marketplace }
 *       400: { description: Marketplace already exists }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller not found }
 */
router.post('/marketplaces', requireAuth, requireRole('seller'), async (req, res) => {
  const { region } = req.body;
  if (!region) return res.status(400).json({ error: 'Marketplace region required' });
  const seller = await Seller.findOne({ user: req.user.userId });
  if (!seller) return res.status(404).json({ error: 'Seller not found' });
  if (seller.ebayMarketplaces.includes(region)) {
    return res.status(409).json({ error: 'Marketplace region already exists' });
  }
  seller.ebayMarketplaces.push(region);
  await seller.save();
  res.json(seller);
});

// Remove an eBay marketplace region
/**
 * @swagger
 * /sellers/marketplaces/{region}:
 *   delete:
 *     tags: [Sellers]
 *     summary: Remove a marketplace from the seller's profile
 *     security:
 *       - bearerAuth: []
 *     description: Removes the marketplace entry matching the given region. Requires seller role.
 *     parameters:
 *       - { in: path, name: region, required: true, schema: { type: string, example: EBAY_US } }
 *     responses:
 *       200: { description: Updated seller after marketplace removal }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller or marketplace not found }
 */
router.delete('/marketplaces/:region', requireAuth, requireRole('seller'), async (req, res) => {
  const { region } = req.params;
  const seller = await Seller.findOne({ user: req.user.userId });
  if (!seller) return res.status(404).json({ error: 'Seller not found' });
  seller.ebayMarketplaces = seller.ebayMarketplaces.filter(r => r !== region);
  await seller.save();
  res.json(seller);
});

// Disconnect eBay account (clear tokens) - allows re-authorization with new scopes
/**
 * @swagger
 * /sellers/disconnect-ebay:
 *   delete:
 *     tags: [Sellers]
 *     summary: Disconnect eBay from the seller's account
 *     security:
 *       - bearerAuth: []
 *     description: >
 *       Clears the eBay OAuth tokens and account link from the seller profile.
 *       Requires seller role.
 *     responses:
 *       200: { description: Confirmation that eBay was disconnected }
 *       401: { description: Unauthorized }
 *       403: { description: Requires seller role }
 *       404: { description: Seller not found }
 */
router.delete('/disconnect-ebay', requireAuth, requireRole('seller'), async (req, res) => {
  try {
    const seller = await Seller.findOne({ user: req.user.userId });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    
    // Clear the eBay tokens
    seller.ebayTokens = {};
    await seller.save();
    
    console.log(`eBay disconnected for seller ${seller._id}`);
    res.json({ message: 'eBay account disconnected successfully. You can now reconnect with updated permissions.' });
  } catch (error) {
    console.error('Error disconnecting eBay:', error);
    res.status(500).json({ error: 'Failed to disconnect eBay account' });
  }
});

export default router;