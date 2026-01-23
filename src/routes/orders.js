import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Order from '../models/Order.js';
import Seller from '../models/Seller.js';
import Return from '../models/Return.js';
import Case from '../models/Case.js';
import PaymentDispute from '../models/PaymentDispute.js';
import Message from '../models/Message.js';

const router = Router();

// Get daily order statistics for all sellers
router.get('/daily-statistics', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { startDate, endDate, sellerId } = req.query;

    // Build the query - NO CANCELSTATE FILTER (matches FulfillmentDashboard)
    const query = {};

    // Add date filter if provided
    // Use the SAME timezone logic as FulfillmentDashboard (PST - UTC-8)
    if (startDate || endDate) {
      query.dateSold = {}; // Use dateSold field, not creationDate
      const PST_OFFSET_HOURS = 8;

      if (startDate) {
        const start = new Date(startDate);
        start.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);
        query.dateSold.$gte = start;
      }

      if (endDate) {
        const end = new Date(endDate);
        end.setDate(end.getDate() + 1);
        end.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);
        query.dateSold.$lte = end;
      }
    }

    // Add seller filter if provided
    if (sellerId) {
      query.seller = sellerId;
    }

    // Aggregate orders by seller, date, and marketplace
    const statistics = await Order.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'sellers',
          localField: 'seller',
          foreignField: '_id',
          as: 'sellerInfo'
        }
      },
      { $unwind: '$sellerInfo' },
      {
        $lookup: {
          from: 'users',
          localField: 'sellerInfo.user',
          foreignField: '_id',
          as: 'userInfo'
        }
      },
      { $unwind: '$userInfo' },
      {
        $project: {
          seller: '$seller',
          sellerUsername: '$userInfo.username',
          orderDate: {
            // Convert UTC date to PST date string (matching FulfillmentDashboard)
            $dateToString: { 
              format: '%Y-%m-%d', 
              date: '$dateSold', // Use dateSold field
              timezone: 'America/Los_Angeles' // PST/PDT timezone
            }
          },
          marketplace: { $ifNull: ['$purchaseMarketplaceId', 'Unknown'] }
        }
      },
      {
        $group: {
          _id: {
            seller: '$seller',
            sellerUsername: '$sellerUsername',
            date: '$orderDate',
            marketplace: '$marketplace'
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: {
            seller: '$_id.seller',
            sellerUsername: '$_id.sellerUsername',
            date: '$_id.date'
          },
          totalOrders: { $sum: '$count' },
          marketplaceBreakdown: {
            $push: {
              marketplace: '$_id.marketplace',
              count: '$count'
            }
          }
        }
      },
      {
        $sort: { '_id.date': -1, '_id.sellerUsername': 1 }
      }
    ]);

    // Transform the data for easier consumption on the frontend
    const formattedStatistics = statistics.map(stat => ({
      seller: {
        id: stat._id.seller,
        username: stat._id.sellerUsername
      },
      date: stat._id.date,
      totalOrders: stat.totalOrders,
      marketplaceBreakdown: stat.marketplaceBreakdown
    }));

    res.json(formattedStatistics);
  } catch (error) {
    console.error('Error fetching daily order statistics:', error);
    res.status(500).json({ error: 'Failed to fetch order statistics' });
  }
});

// Get worksheet statistics for cancellations, returns, INR/disputes, and inquiries
router.get('/worksheet-statistics', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { startDate, endDate, sellerId } = req.query;

    // Build seller filter if sellerId is provided
    const sellerMatch = sellerId ? { seller: new mongoose.Types.ObjectId(sellerId) } : {};

    // Use UTC boundaries for filtering (matches frontend local date selection)
    const buildDateRangeMatch = (field) => {
      if (!startDate && !endDate) return {};
      const range = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setUTCHours(0, 0, 0, 0); // Start of day in UTC
        range.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999); // End of day in UTC
        range.$lte = end;
      }
      return { [field]: range };
    };

    // Project date in UTC (for grouping - matches frontend selection)
    const utcDateProjection = (field) => ({
      $dateToString: {
        format: '%Y-%m-%d',
        date: field,
        timezone: 'UTC'
      }
    });

    // Project date in PST (for database reference)
    const pstDateProjection = (field) => ({
      $dateToString: {
        format: '%Y-%m-%d',
        date: field,
        timezone: 'America/Los_Angeles'
      }
    });

    const cancellationStates = ['CANCEL_REQUESTED', 'IN_PROGRESS', 'CANCELED', 'CANCELLED'];
    const cancellationPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$dateSold', '$creationDate'] } } },
      {
        $match: {
          ...sellerMatch,
          cancelState: { $in: cancellationStates },
          ...buildDateRangeMatch('worksheetDate')
        }
      },
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] },
          date: utcDateProjection('$worksheetDate'),
          pstDate: pstDateProjection('$worksheetDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$worksheetStatus' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const returnsPipeline = [
      { $match: { ...sellerMatch, ...buildDateRangeMatch('creationDate') } },
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] },
          date: utcDateProjection('$creationDate'),
          pstDate: pstDateProjection('$creationDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$worksheetStatus' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const casesPipeline = [
      { $match: { ...sellerMatch, ...buildDateRangeMatch('creationDate') } },
      {
        $project: {
          status: '$status',
          date: utcDateProjection('$creationDate'),
          pstDate: pstDateProjection('$creationDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$status' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const disputesPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$openDate', '$createdAt'] } } },
      { $match: { ...sellerMatch, ...buildDateRangeMatch('worksheetDate') } },
      {
        $project: {
          status: '$paymentDisputeStatus',
          date: utcDateProjection('$worksheetDate'),
          pstDate: pstDateProjection('$worksheetDate')
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$status' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    // Inquiries: count buyer inquiry messages per day
    // messageType != 'ORDER' AND no orderId (matches chat INQUIRY filter)
    const inquiriesPipeline = [
      {
        $match: {
          ...sellerMatch,
          sender: 'BUYER',
          messageType: { $ne: 'ORDER' },
          $or: [{ orderId: null }, { orderId: { $exists: false } }, { orderId: '' }],
          ...buildDateRangeMatch('messageDate')
        }
      },
      {
        $project: {
          date: utcDateProjection('$messageDate'),
          pstDate: pstDateProjection('$messageDate')
        }
      },
      {
        $group: {
          _id: { date: '$date' },
          pstDate: { $first: '$pstDate' },
          count: { $sum: 1 }
        }
      }
    ];

    const [
      cancellationStats,
      returnStats,
      caseStats,
      disputeStats,
      inquiryStats
    ] = await Promise.all([
      Order.aggregate(cancellationPipeline),
      Return.aggregate(returnsPipeline),
      Case.aggregate(casesPipeline),
      PaymentDispute.aggregate(disputesPipeline),
      Message.aggregate(inquiriesPipeline)
    ]);

    const dateMap = new Map();
    const pstDateMap = new Map(); // Track PST dates for each UTC date
    
    const ensureDate = (date, pstDate) => {
      if (!dateMap.has(date)) {
        dateMap.set(date, {
          date,
          pstDate: pstDate || date, // PST date for database reference
          cancellations: { open: 0, attended: 0, resolved: 0 },
          returns: { open: 0, attended: 0, resolved: 0 },
          inrDisputes: { open: 0, attended: 0, resolved: 0 },
          inquiries: { total: 0 }
        });
      } else if (pstDate && !dateMap.get(date).pstDate) {
        // Update PST date if we have one
        dateMap.get(date).pstDate = pstDate;
      }
      return dateMap.get(date);
    };

    const addCount = (date, pstDate, category, bucket, count) => {
      const entry = ensureDate(date, pstDate);
      entry[category][bucket] += count;
    };

    const caseOpen = new Set(['OPEN', 'WAITING_SELLER_RESPONSE', 'WAITING_FOR_SELLER']);
    const caseAttended = new Set(['ON_HOLD', 'WAITING_BUYER_RESPONSE', 'WAITING_FOR_BUYER']);
    const caseResolved = new Set(['CLOSED', 'RESOLVED']);

    const disputeOpen = new Set(['OPEN', 'WAITING_FOR_SELLER_RESPONSE']);
    const disputeAttended = new Set(['UNDER_REVIEW']);
    const disputeResolved = new Set(['RESOLVED_BUYER_FAVOUR', 'RESOLVED_SELLER_FAVOUR', 'CLOSED']);

    // Cancellations use manual worksheetStatus
    cancellationStats.forEach((stat) => {
      const { date, status } = stat._id;
      addCount(date, stat.pstDate, 'cancellations', status, stat.count);
    });

    // Returns use manual worksheetStatus
    returnStats.forEach((stat) => {
      const { date, status } = stat._id;
      addCount(date, stat.pstDate, 'returns', status, stat.count);
    });

    // Cases use automatic status logic
    caseStats.forEach((stat) => {
      const { date, status } = stat._id;
      if (caseOpen.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'open', stat.count);
      } else if (caseAttended.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      } else if (caseResolved.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'resolved', stat.count);
      } else {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      }
    });

    // Disputes use automatic status logic
    disputeStats.forEach((stat) => {
      const { date, status } = stat._id;
      if (disputeOpen.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'open', stat.count);
      } else if (disputeAttended.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      } else if (disputeResolved.has(status)) {
        addCount(date, stat.pstDate, 'inrDisputes', 'resolved', stat.count);
      } else {
        addCount(date, stat.pstDate, 'inrDisputes', 'attended', stat.count);
      }
    });

    inquiryStats.forEach((stat) => {
      const date = stat._id.date;
      const entry = ensureDate(date, stat.pstDate);
      entry.inquiries.total += stat.count;
    });

    const worksheetStats = Array.from(dateMap.values()).sort((a, b) =>
      a.date < b.date ? 1 : -1
    );

    res.json(worksheetStats);
  } catch (error) {
    console.error('Error fetching worksheet statistics:', error);
    res.status(500).json({ error: 'Failed to fetch worksheet statistics' });
  }
});

// Worksheet summary for cards (totals + open counts + totalOrders) based on the same filter as worksheet-statistics
router.get('/worksheet-summary', requireAuth, requireRole('fulfillmentadmin', 'superadmin', 'hoc', 'compliancemanager'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Use UTC boundaries for filtering (matches frontend local date selection)
    const buildDateRangeMatch = (field) => {
      if (!startDate && !endDate) return {};
      const range = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setUTCHours(0, 0, 0, 0); // Start of day in UTC
        range.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999); // End of day in UTC
        range.$lte = end;
      }
      return { [field]: range };
    };

    // Total orders denominator (uses dateSold like order analytics)
    const totalOrdersQuery = {
      ...buildDateRangeMatch('dateSold')
    };

    // Define status mappings first (needed for overall open counts)
    const caseOpen = new Set(['OPEN', 'WAITING_SELLER_RESPONSE', 'WAITING_FOR_SELLER']);
    const caseAttended = new Set(['ON_HOLD', 'WAITING_BUYER_RESPONSE', 'WAITING_FOR_BUYER']);
    const caseResolved = new Set(['CLOSED', 'RESOLVED']);

    const disputeOpen = new Set(['OPEN', 'WAITING_FOR_SELLER_RESPONSE']);
    const disputeAttended = new Set(['UNDER_REVIEW']);
    const disputeResolved = new Set(['RESOLVED_BUYER_FAVOUR', 'RESOLVED_SELLER_FAVOUR', 'CLOSED']);

    // Cancellations: orders with cancelState in list, date is worksheetDate (dateSold || creationDate)
    const cancellationStates = ['CANCEL_REQUESTED', 'IN_PROGRESS', 'CANCELED', 'CANCELLED'];
    const cancellationsMatchStage = {
      $match: {
        cancelState: { $in: cancellationStates }
      }
    };

    const cancellationsPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$dateSold', '$creationDate'] } } },
      cancellationsMatchStage,
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('worksheetDate') }] : []),
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] }
        }
      },
      {
        $group: {
          _id: '$worksheetStatus',
          count: { $sum: 1 }
        }
      }
    ];

    // Returns: Return.creationDate, manual worksheetStatus default open
    const returnsPipeline = [
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('creationDate') }] : []),
      {
        $project: {
          worksheetStatus: { $ifNull: ['$worksheetStatus', 'open'] }
        }
      },
      {
        $group: {
          _id: '$worksheetStatus',
          count: { $sum: 1 }
        }
      }
    ];

    // INR: Case.creationDate, automatic status based on Case.status (same mapping as worksheet table)
    const inrPipeline = [
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('creationDate') }] : []),
      {
        $project: {
          status: '$status'
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ];

    // Disputes: PaymentDispute.openDate || createdAt, automatic status based on paymentDisputeStatus (same mapping as worksheet table)
    const disputesPipeline = [
      { $addFields: { worksheetDate: { $ifNull: ['$openDate', '$createdAt'] } } },
      ...(startDate || endDate ? [{ $match: buildDateRangeMatch('worksheetDate') }] : []),
      {
        $project: {
          status: '$paymentDisputeStatus'
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ];

    // Open counts on cards should be overall (ignore date filter).
    // Rates (based on totals + totalOrders) should still respect date filter.
    const [totalOrders, cancellationsByStatus, returnsByStatus, inrByStatus, disputesByStatus, cancellationsOpenOverall, returnsOpenOverall, inrOpenOverall, disputesOpenOverall] = await Promise.all([
      Order.countDocuments(totalOrdersQuery),
      Order.aggregate(cancellationsPipeline),
      Return.aggregate(returnsPipeline),
      Case.aggregate(inrPipeline),
      PaymentDispute.aggregate(disputesPipeline),
      Order.countDocuments({
        cancelState: { $in: cancellationStates },
        $or: [{ worksheetStatus: 'open' }, { worksheetStatus: { $exists: false } }, { worksheetStatus: null }]
      }),
      Return.countDocuments({
        $or: [{ worksheetStatus: 'open' }, { worksheetStatus: { $exists: false } }, { worksheetStatus: null }]
      }),
      Case.countDocuments({ status: { $in: Array.from(caseOpen) } }),
      PaymentDispute.countDocuments({ paymentDisputeStatus: { $in: Array.from(disputeOpen) } })
    ]);

    const toWorksheetBuckets = (rows) => {
      const base = { open: 0, attended: 0, resolved: 0, total: 0 };
      rows.forEach((r) => {
        const key = r._id;
        const count = r.count || 0;
        if (key === 'open' || key === 'attended' || key === 'resolved') {
          base[key] += count;
          base.total += count;
        }
      });
      return base;
    };

    const cancellations = toWorksheetBuckets(cancellationsByStatus);
    const returns = toWorksheetBuckets(returnsByStatus);
    cancellations.open = cancellationsOpenOverall || 0;
    returns.open = returnsOpenOverall || 0;

    const inr = { open: 0, attended: 0, resolved: 0, total: 0 };
    inrByStatus.forEach((r) => {
      const status = r._id;
      const count = r.count || 0;
      if (caseOpen.has(status)) inr.open += count;
      else if (caseResolved.has(status)) inr.resolved += count;
      else if (caseAttended.has(status)) inr.attended += count;
      else inr.attended += count;
      inr.total += count;
    });
    inr.open = inrOpenOverall || 0;

    const disputes = { open: 0, attended: 0, resolved: 0, total: 0 };
    disputesByStatus.forEach((r) => {
      const status = r._id;
      const count = r.count || 0;
      if (disputeOpen.has(status)) disputes.open += count;
      else if (disputeAttended.has(status)) disputes.attended += count;
      else if (disputeResolved.has(status)) disputes.resolved += count;
      else disputes.attended += count;
      disputes.total += count;
    });
    disputes.open = disputesOpenOverall || 0;

    res.json({
      totalOrders,
      cancellations,
      returns,
      inr,
      disputes
    });
  } catch (error) {
    console.error('Error fetching worksheet summary:', error);
    res.status(500).json({ error: 'Failed to fetch worksheet summary' });
  }
});

export default router;
