import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import UserCategoryTarget from '../models/UserCategoryTarget.js';
import User from '../models/User.js';
import Seller from '../models/Seller.js';
import AsinListCategory from '../models/AsinListCategory.js';
import Listing from '../models/Listing.js';

const router = express.Router();
const PT_TIMEZONE = 'America/Los_Angeles';

const pageAccess = requirePageAccess('UserCategoryTargets');
const performancePageAccess = requirePageAccess(['UserCategoryTargets', 'UserListingPerformance']);

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

function getPTDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: PT_TIMEZONE }).format(date);
}

function getPTDayBoundsUTC(dateStr) {
  function findMidnightUTC(ds) {
    const pdt = new Date(`${ds}T07:00:00.000Z`);
    const ptStr = new Intl.DateTimeFormat('en-CA', { timeZone: PT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(pdt);
    const ptHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: PT_TIMEZONE, hour: 'numeric', hour12: false, hourCycle: 'h23' }).format(pdt), 10);
    if (ptStr === ds && ptHour === 0) return pdt;
    return new Date(`${ds}T08:00:00.000Z`);
  }

  const start = findMidnightUTC(dateStr);
  const tmp = new Date(`${dateStr}T12:00:00.000Z`);
  tmp.setUTCDate(tmp.getUTCDate() + 1);
  const nextDateStr = tmp.toISOString().split('T')[0];
  const end = new Date(findMidnightUTC(nextDateStr).getTime() - 1);
  return { start, end };
}

function countInclusiveDays(startDate, endDate) {
  const start = new Date(`${startDate}T12:00:00.000Z`);
  const end = new Date(`${endDate}T12:00:00.000Z`);
  return Math.max(1, Math.floor((end - start) / 86400000) + 1);
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getStatus(percent) {
  if (percent >= 95) return 'onTrack';
  if (percent >= 60) return 'behind';
  return 'critical';
}

router.get('/performance', requireAuth, performancePageAccess, async (req, res) => {
  const {
    startDate = getPTDate(),
    endDate = startDate,
    userId,
    sellerId,
    categoryId,
  } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate are required' });
  }

  if ([userId, sellerId, categoryId].filter(Boolean).some((id) => !isValidObjectId(id))) {
    return res.status(400).json({ error: 'Invalid filter id' });
  }

  try {
    const targetQuery = {};
    if (userId) targetQuery.user = userId;
    if (sellerId) targetQuery.seller = sellerId;
    if (categoryId) targetQuery.category = categoryId;

    const targets = await UserCategoryTarget.find(targetQuery)
      .populate('user', 'username email role department')
      .populate({
        path: 'seller',
        select: 'storeName ebayMarketplaces user',
        populate: { path: 'user', select: 'username email' },
      })
      .populate('category', 'name')
      .sort({ updatedAt: -1 });

    const { start } = getPTDayBoundsUTC(startDate);
    const { end } = getPTDayBoundsUTC(endDate);
    const days = countInclusiveDays(startDate, endDate);

    const cards = await Promise.all(targets.map(async (target) => {
      const categoryName = target.category?.name || '';
      const successfulListings = await Listing.countDocuments({
        seller: target.seller?._id || target.seller,
        startTime: { $gte: start, $lte: end },
        categoryName: { $regex: escapeRegex(categoryName), $options: 'i' },
      });

      const targetQuantity = (target.dailyDesiredQuantity || 0) * days;
      const completionPercent = targetQuantity > 0
        ? Math.round((successfulListings / targetQuantity) * 100)
        : (successfulListings > 0 ? 100 : 0);
      const status = getStatus(completionPercent);

      return {
        targetId: target._id,
        user: target.user,
        seller: target.seller,
        category: target.category,
        dailyDesiredQuantity: target.dailyDesiredQuantity || 0,
        targetQuantity,
        successfulListings,
        missedListings: Math.max(targetQuantity - successfulListings, 0),
        completionPercent,
        status,
      };
    }));

    const summary = cards.reduce((acc, card) => {
      acc.totalTargets += 1;
      acc.totalTargetQuantity += card.targetQuantity;
      acc.totalSuccessfulListings += card.successfulListings;
      acc.totalMissedListings += card.missedListings;
      acc[card.status] += 1;
      return acc;
    }, {
      totalTargets: 0,
      totalTargetQuantity: 0,
      totalSuccessfulListings: 0,
      totalMissedListings: 0,
      onTrack: 0,
      behind: 0,
      critical: 0,
    });

    summary.averageCompletionPercent = summary.totalTargetQuantity > 0
      ? Math.round((summary.totalSuccessfulListings / summary.totalTargetQuantity) * 100)
      : 0;

    res.json({
      filters: { startDate, endDate, days, userId: userId || null, sellerId: sellerId || null, categoryId: categoryId || null },
      summary,
      cards,
    });
  } catch (err) {
    console.error('[UserCategoryTargets] GET /performance error:', err);
    res.status(500).json({ error: 'Failed to fetch listing performance' });
  }
});

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
      AsinListCategory.exists({ _id: categoryId }),
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
