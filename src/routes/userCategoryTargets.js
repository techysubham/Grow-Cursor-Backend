import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import UserCategoryTarget from '../models/UserCategoryTarget.js';
import User from '../models/User.js';
import Seller from '../models/Seller.js';
import Category from '../models/Category.js';

const router = express.Router();

const pageAccess = requirePageAccess('UserCategoryTargets');

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

router.get('/', requireAuth, pageAccess, async (req, res) => {
  try {
    const targets = await UserCategoryTarget.find()
      .populate('user', 'username email role department')
      .populate({
        path: 'seller',
        select: 'storeName ebayMarketplaces user',
        populate: { path: 'user', select: 'username email' },
      })
      .populate('category', 'name')
      .sort({ updatedAt: -1 });

    res.json(targets);
  } catch (err) {
    console.error('[UserCategoryTargets] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch desired quantity targets' });
  }
});

router.post('/', requireAuth, pageAccess, async (req, res) => {
  const { userId, sellerId, categoryId, dailyDesiredQuantity } = req.body || {};

  if (!userId || !sellerId || !categoryId || dailyDesiredQuantity == null) {
    return res.status(400).json({ error: 'userId, sellerId, categoryId, and dailyDesiredQuantity are required' });
  }

  if (![userId, sellerId, categoryId].every(isValidObjectId)) {
    return res.status(400).json({ error: 'Invalid user, seller, or category id' });
  }

  const quantity = Number(dailyDesiredQuantity);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return res.status(400).json({ error: 'Daily desired quantity must be a number greater than or equal to 0' });
  }

  try {
    const [userExists, sellerExists, categoryExists] = await Promise.all([
      User.exists({ _id: userId }),
      Seller.exists({ _id: sellerId }),
      Category.exists({ _id: categoryId }),
    ]);

    if (!userExists) return res.status(404).json({ error: 'User not found' });
    if (!sellerExists) return res.status(404).json({ error: 'Seller not found' });
    if (!categoryExists) return res.status(404).json({ error: 'Category not found' });

    const target = await UserCategoryTarget.findOneAndUpdate(
      { user: userId, seller: sellerId, category: categoryId },
      { user: userId, seller: sellerId, category: categoryId, dailyDesiredQuantity: quantity },
      { upsert: true, new: true, runValidators: true }
    )
      .populate('user', 'username email role department')
      .populate({
        path: 'seller',
        select: 'storeName ebayMarketplaces user',
        populate: { path: 'user', select: 'username email' },
      })
      .populate('category', 'name');

    res.json(target);
  } catch (err) {
    console.error('[UserCategoryTargets] POST / error:', err);
    res.status(500).json({ error: 'Failed to save desired quantity target' });
  }
});

router.delete('/:id', requireAuth, pageAccess, async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid target id' });
  }

  try {
    const deleted = await UserCategoryTarget.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'Desired quantity target not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[UserCategoryTargets] DELETE /:id error:', err);
    res.status(500).json({ error: 'Failed to delete desired quantity target' });
  }
});

export default router;
