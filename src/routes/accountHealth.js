import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Order from '../models/Order.js';
import Case from '../models/Case.js';
import Return from '../models/Return.js';

const router = Router();

// SNAD-related return reasons
const SNAD_RETURN_REASONS = [
  'NOT_AS_DESCRIBED',
  'DEFECTIVE',
  'WRONG_ITEM',
  'MISSING_PARTS',
  'ARRIVED_DAMAGED',
  'DOESNT_MATCH',
  'NOT_AUTHENTIC'
];

/**
 * GET /account-health/details
 * Returns SNAD details for orders with SNAD cases or returns
 * Supports filters: sellerId, startDate, endDate
 */
router.get('/details', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { sellerId, startDate, endDate } = req.query;

    // Build date range filter
    const dateMatch = {};
    if (startDate || endDate) {
      dateMatch.dateSold = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setUTCHours(0, 0, 0, 0);
        dateMatch.dateSold.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999);
        dateMatch.dateSold.$lte = end;
      }
    }

    // Build seller filter
    const sellerMatch = sellerId ? { seller: new mongoose.Types.ObjectId(sellerId) } : {};

    // Get all SNAD cases
    const snadCases = await Case.find({
      ...sellerMatch,
      caseType: 'SNAD'
    }).lean();

    // Get all INR cases (for the INR column)
    const inrCases = await Case.find({
      ...sellerMatch,
      caseType: 'INR'
    }).lean();

    // Get SNAD-related returns
    const snadReturns = await Return.find({
      ...sellerMatch,
      returnReason: { $in: SNAD_RETURN_REASONS }
    }).lean();

    // Collect unique order IDs from SNAD cases and returns
    const snadOrderIds = new Set();
    const orderSnadCount = new Map();
    const orderInrCount = new Map();

    // Process SNAD cases - check both orderId and legacyOrderId
    snadCases.forEach(c => {
      if (c.orderId) {
        snadOrderIds.add(c.orderId);
        orderSnadCount.set(c.orderId, (orderSnadCount.get(c.orderId) || 0) + 1);
      }
    });

    // Process SNAD returns - check both orderId and legacyOrderId
    snadReturns.forEach(r => {
      if (r.orderId) {
        snadOrderIds.add(r.orderId);
        orderSnadCount.set(r.orderId, (orderSnadCount.get(r.orderId) || 0) + 1);
      }
    });

    // Process INR cases - count them too
    inrCases.forEach(c => {
      if (c.orderId) {
        snadOrderIds.add(c.orderId); // Add to order IDs so we fetch these orders too
        orderInrCount.set(c.orderId, (orderInrCount.get(c.orderId) || 0) + 1);
      }
    });

    if (snadOrderIds.size === 0) {
      return res.json({ details: [], total: 0 });
    }

    // Fetch orders with SNAD/INR issues
    const orderQuery = {
      ...sellerMatch,
      ...dateMatch,
      $or: [
        { orderId: { $in: Array.from(snadOrderIds) } },
        { legacyOrderId: { $in: Array.from(snadOrderIds) } }
      ]
    };

    const orders = await Order.find(orderQuery)
      .populate({
        path: 'seller',
        populate: { path: 'user', select: 'username' }
      })
      .sort({ dateSold: -1 })
      .lean();

    // Build response
    const details = orders.map(order => {
      const orderId = order.orderId || order.legacyOrderId;
      
      // Try to match with orderId first, then legacyOrderId (but not both to avoid double-counting)
      let snadCount = 0;
      if (order.orderId && orderSnadCount.has(order.orderId)) {
        snadCount = orderSnadCount.get(order.orderId);
      } else if (order.legacyOrderId && orderSnadCount.has(order.legacyOrderId)) {
        snadCount = orderSnadCount.get(order.legacyOrderId);
      }
      
      let inrCount = 0;
      if (order.orderId && orderInrCount.has(order.orderId)) {
        inrCount = orderInrCount.get(order.orderId);
      } else if (order.legacyOrderId && orderInrCount.has(order.legacyOrderId)) {
        inrCount = orderInrCount.get(order.legacyOrderId);
      }
      
      // Calculate remark date (3 months from order date)
      let remarkDate = null;
      if (order.dateSold) {
        const d = new Date(order.dateSold);
        d.setMonth(d.getMonth() + 3);
        remarkDate = d.toISOString();
      }

      return {
        _id: order._id,
        orderId: order.orderId,
        legacyOrderId: order.legacyOrderId,
        orderDate: order.dateSold,
        itemId: order.itemNumber || (order.lineItems?.[0]?.legacyItemId) || '',
        itemTitle: order.productName || (order.lineItems?.[0]?.title) || '',
        snadCount,
        sellerFault: order.sellerFault || 'No', // Default to 'No'
        hasInr: inrCount,
        remarkDate,
        seller: {
          _id: order.seller?._id,
          username: order.seller?.user?.username || 'Unknown'
        }
      };
    });

    res.json({ details, total: details.length });
  } catch (error) {
    console.error('Error fetching account health details:', error);
    res.status(500).json({ error: 'Failed to fetch account health details' });
  }
});

/**
 * GET /account-health/evaluation-windows
 * Returns evaluation window metrics (3-month rolling windows, calculated weekly)
 * Each window covers a 3-month period, and we generate a new window every week
 * BBE Rate = (SNAD count / Total Sales in that 3-month period) × 100
 */
router.get('/evaluation-windows', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { sellerId } = req.query;
    const sellerMatch = sellerId ? { seller: new mongoose.Types.ObjectId(sellerId) } : {};

    // We'll generate weekly windows, each spanning 3 months
    const windows = [];
    const today = new Date();
    
    // Align to the most recent Sunday (or today if Sunday)
    let currentWindowEnd = new Date(today);
    const dayOfWeek = currentWindowEnd.getDay();
    if (dayOfWeek !== 0) {
      currentWindowEnd.setDate(currentWindowEnd.getDate() - dayOfWeek);
    }
    currentWindowEnd.setHours(23, 59, 59, 999);

    // Generate windows going backwards week by week
    // We'll generate about 12 windows (3 months of weekly windows)
    const maxWindows = 12;
    
    for (let i = 0; i < maxWindows; i++) {
      // For each window, calculate the start date (3 months before the end)
      const windowStart = new Date(currentWindowEnd);
      windowStart.setMonth(windowStart.getMonth() - 3);
      windowStart.setHours(0, 0, 0, 0);

      // Get total sales in this 3-month window
      const totalSalesCount = await Order.countDocuments({
        ...sellerMatch,
        dateSold: { $gte: windowStart, $lte: currentWindowEnd }
      });

      // Get SNAD cases in this 3-month window
      const snadCount = await Case.countDocuments({
        ...sellerMatch,
        caseType: 'SNAD',
        creationDate: { $gte: windowStart, $lte: currentWindowEnd }
      });

      // Get SNAD returns in this 3-month window
      const snadReturnCount = await Return.countDocuments({
        ...sellerMatch,
        returnReason: { $in: SNAD_RETURN_REASONS },
        creationDate: { $gte: windowStart, $lte: currentWindowEnd }
      });

      const totalSnadCount = snadCount + snadReturnCount;
      const bbeRate = totalSalesCount > 0 ? (totalSnadCount / totalSalesCount) * 100 : 0;

      windows.push({
        windowStart: windowStart.toISOString(),
        windowEnd: currentWindowEnd.toISOString(),
        totalSales: totalSalesCount,
        snadCount: totalSnadCount,
        bbeRate: bbeRate.toFixed(2),
        marketAvg: 1.1, // Benchmark - could be made configurable
        evaluationDate: currentWindowEnd.toISOString()
      });

      // Move to previous week
      currentWindowEnd = new Date(currentWindowEnd);
      currentWindowEnd.setDate(currentWindowEnd.getDate() - 7);
      currentWindowEnd.setHours(23, 59, 59, 999);
    }

    res.json({ windows });
  } catch (error) {
    console.error('Error fetching evaluation windows:', error);
    res.status(500).json({ error: 'Failed to fetch evaluation windows' });
  }
});

/**
 * PATCH /account-health/details/:orderId
 * Update sellerFault field for an order
 */
router.patch('/details/:orderId', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { sellerFault } = req.body;

    if (!['Yes', 'No'].includes(sellerFault)) {
      return res.status(400).json({ error: 'sellerFault must be "Yes" or "No"' });
    }

    const order = await Order.findByIdAndUpdate(
      orderId,
      { sellerFault },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error('Error updating order seller fault:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

export default router;
