import express from 'express';
import Order from '../models/Order.js';
import AmazonAccount from '../models/AmazonAccount.js';
import AmazonAccountDailyBalance from '../models/AmazonAccountDailyBalance.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// PST offset used throughout the platform
const PST_OFFSET_HOURS = 8;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const CARRY_OVER_START_DATE = '2026-03-10';
const MAX_ORDERS_PER_AMAZON_ACCOUNT = 9;

/**
 * Builds a UTC date range for a given YYYY-MM-DD string (PST day boundaries)
 */
function buildDayRange(dateStr) {
    const start = new Date(dateStr);
    start.setUTCHours(PST_OFFSET_HOURS, 0, 0, 0);

    const end = new Date(dateStr);
    end.setDate(end.getDate() + 1);
    end.setUTCHours(PST_OFFSET_HOURS - 1, 59, 59, 999);

    return { start, end };
}

function getPlatformDayString(dateValue) {
    const shifted = new Date(new Date(dateValue).getTime() - PST_OFFSET_HOURS * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
}

function getCarryOverLabel(carryOverDays) {
    if (carryOverDays <= 0) return '';
    if (carryOverDays === 1) return 'Yesterday';
    return `${carryOverDays} days ago`;
}

function buildAffiliateQueueQuery(dateStr, excludeLowValue, extraFilters = []) {
    const { start, end } = buildDayRange(dateStr);
    const carryOverStart = buildDayRange(CARRY_OVER_START_DATE).start;
    const queueScopes = [{ dateSold: { $gte: start, $lte: end } }];

    if (start.getTime() > carryOverStart.getTime()) {
        queueScopes.push({
            dateSold: { $gte: carryOverStart, $lt: start },
            sourcingStatus: 'Not Yet',
        });
    }

    const filters = [
        { $or: queueScopes },
        ...extraFilters.filter(Boolean),
    ];

    if (excludeLowValue === 'true') {
        filters.push({
            $or: [
                { beforeTaxUSD: { $gte: 3 } },
                { beforeTaxUSD: { $exists: false } },
                { beforeTaxUSD: null }
            ]
        });
    }

    return {
        start,
        end,
        query: filters.length === 1 ? filters[0] : { $and: filters },
    };
}

// ---------------------------------------------------------------------------
// TAB 1 — Daily Orders
// GET /api/affiliate-orders/daily?date=YYYY-MM-DD
// Returns all orders sold on that date, with seller name populated
// ---------------------------------------------------------------------------
router.get('/daily', async (req, res) => {
    try {
        const { date, excludeLowValue } = req.query;
        if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

        const { query } = buildAffiliateQueueQuery(date, excludeLowValue);

        const orders = await Order.find(query)
            .populate({ path: 'seller', populate: { path: 'user', select: 'username' } })
            .sort({ dateSold: 1 })
            .lean();

        const selectedDayUtc = Date.parse(`${date}T00:00:00Z`);
        const enrichedOrders = orders
            .map((order) => {
                const sourceDay = getPlatformDayString(order.dateSold || order.creationDate || new Date());
                const sourceDayUtc = Date.parse(`${sourceDay}T00:00:00Z`);
                const carryOverDays = Math.max(0, Math.round((selectedDayUtc - sourceDayUtc) / DAY_IN_MS));
                const sellerName = order.seller?.user?.username || order.sellerId || 'Unknown Seller';

                return {
                    ...order,
                    sellerGroupName: sellerName,
                    isCarryOver: carryOverDays > 0 && order.sourcingStatus === 'Not Yet',
                    carryOverDays,
                    sourceDate: sourceDay,
                    carryOverLabel: getCarryOverLabel(carryOverDays),
                };
            })
            .sort((left, right) => {
                if (left.sellerGroupName !== right.sellerGroupName) {
                    return left.sellerGroupName.localeCompare(right.sellerGroupName);
                }

                return new Date(left.dateSold || left.creationDate || 0) - new Date(right.dateSold || right.creationDate || 0);
            });

        res.json(enrichedOrders);
    } catch (err) {
        console.error('GET /affiliate-orders/daily error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/affiliate-orders/:id/sourcing
// Update the sourcing-specific fields on an order
// ---------------------------------------------------------------------------
router.patch('/:id/sourcing', async (req, res) => {
    try {
        const ALLOWED_FIELDS = [
            'affiliateLink',
            'affiliateLinks',
            'sourcingStatus',
            'purchaser',
            'sourcingMessageStatus',
            'amazonAccount',
            'beforeTaxUSD',
            'fulfillmentNotes',
        ];

        const update = {};
        for (const field of ALLOWED_FIELDS) {
            if (req.body[field] !== undefined) {
                update[field] = req.body[field];
            }
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: 'No valid fields provided' });
        }

        const order = await Order.findByIdAndUpdate(
            req.params.id,
            { $set: update },
            { new: true, runValidators: true }
        ).lean();

        if (!order) return res.status(404).json({ error: 'Order not found' });

        res.json(order);
    } catch (err) {
        console.error('PATCH /affiliate-orders/:id/sourcing error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// TAB 2 — Gift Card Balances
// GET /api/affiliate-orders/balances?date=YYYY-MM-DD
// Returns one row per Amazon account with totalExpense (auto-calculated from orders)
// and the editable balance fields (upserted on first access)
// ---------------------------------------------------------------------------
router.get('/balances', async (req, res) => {
    try {
        const { date, excludeLowValue } = req.query;
        if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

        // All Amazon accounts
        const accounts = await AmazonAccount.find().sort({ name: 1 }).lean();

        const { query: matchQuery } = buildAffiliateQueueQuery(date, excludeLowValue, [
            { amazonAccount: { $exists: true, $ne: '' } },
        ]);

        // Aggregate expense per account for this day from orders
        const expenseAgg = await Order.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$amazonAccount',
                    totalExpense: { $sum: { $ifNull: ['$beforeTaxUSD', 0] } },
                    orderCount: { $sum: 1 },
                },
            },
        ]);

        const expenseMap = {};
        for (const row of expenseAgg) {
            if (row._id) expenseMap[row._id] = { totalExpense: row.totalExpense, orderCount: row.orderCount };
        }

        // Fetch existing balance records for this date
        const existingBalances = await AmazonAccountDailyBalance.find({ date }).lean();
        const balanceMap = {};
        for (const b of existingBalances) {
            balanceMap[b.amazonAccountName] = b;
        }

        // Build combined response — one entry per account
        const rows = accounts.map((acc) => {
            const bal = balanceMap[acc.name] || {};
            const exp = expenseMap[acc.name] || { totalExpense: 0, orderCount: 0 };
            const availableBalance = bal.availableBalance ?? 0;
            const addedBalance = bal.addedBalance ?? 0;
            const difference = availableBalance + addedBalance - exp.totalExpense;

            return {
                _id: bal._id || null,
                amazonAccountName: acc.name,
                date,
                totalExpense: exp.totalExpense,
                orderCount: exp.orderCount,
                availableBalance,
                addedBalance,
                giftCardStatus: bal.giftCardStatus ?? false,
                note: bal.note ?? '',
                difference,
            };
        });

        res.json(rows);
    } catch (err) {
        console.error('GET /affiliate-orders/balances error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/affiliate-orders/balances
// Upsert a daily balance record for one Amazon account
// Body: { amazonAccountName, date, availableBalance, addedBalance, giftCardStatus, note }
// ---------------------------------------------------------------------------
router.put('/balances', async (req, res) => {
    try {
        const { amazonAccountName, date, availableBalance, addedBalance, giftCardStatus, note } = req.body;
        if (!amazonAccountName || !date) {
            return res.status(400).json({ error: 'amazonAccountName and date are required' });
        }

        const update = {};
        if (availableBalance !== undefined) update.availableBalance = availableBalance;
        if (addedBalance !== undefined) update.addedBalance = addedBalance;
        if (giftCardStatus !== undefined) update.giftCardStatus = giftCardStatus;
        if (note !== undefined) update.note = note;

        const record = await AmazonAccountDailyBalance.findOneAndUpdate(
            { amazonAccountName, date },
            { $set: update },
            { new: true, upsert: true, runValidators: true }
        ).lean();

        res.json(record);
    } catch (err) {
        console.error('PUT /affiliate-orders/balances error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// TAB 3 — Daily Summary
// GET /api/affiliate-orders/summary?date=YYYY-MM-DD
// Returns per-purchaser counts and overall day totals
// ---------------------------------------------------------------------------
router.get('/summary', async (req, res) => {
    try {
        const { date, excludeLowValue } = req.query;
        if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

        const { start, end, query } = buildAffiliateQueueQuery(date, excludeLowValue);

        // All orders in the active sourcing queue for the selected day
        const orders = await Order.find(query)
            .select('purchaser sourcingStatus beforeTaxUSD amazonExchangeRate amazonAccount dateSold creationDate')
            .lean();

        const totalOrders = orders.length;
        const totalUSD = orders.reduce((s, o) => s + (o.beforeTaxUSD || 0), 0);
        const ordersDone = orders.filter((o) => o.sourcingStatus === 'Done').length;
        const ordersNotDone = totalOrders - ordersDone;

        // INR: use the most recent amazonExchangeRate stored on any order that day, or 0
        const rateOrder = orders.find((o) => o.amazonExchangeRate);
        const exchangeRate = rateOrder?.amazonExchangeRate || 0;
        const totalINR = totalUSD * exchangeRate;

        // Per-purchaser breakdown
        const purchaserMap = {};
        for (const o of orders) {
            const name = o.purchaser || '(Unassigned)';
            purchaserMap[name] = (purchaserMap[name] || 0) + 1;
        }
        const byPurchaser = Object.entries(purchaserMap).map(([name, count]) => ({ name, count }));

        const amazonAccountMap = {};
        for (const o of orders) {
            const name = o.amazonAccount || '(Unassigned)';
            const orderDate = new Date(o.dateSold || o.creationDate || 0);
            const isSelectedDayOrder = orderDate >= start && orderDate <= end;

            if (!amazonAccountMap[name]) {
                amazonAccountMap[name] = {
                    queueCount: 0,
                    count: 0,
                    carryOverCount: 0,
                };
            }

            amazonAccountMap[name].queueCount += 1;
            if (isSelectedDayOrder) {
                amazonAccountMap[name].count += 1;
            } else {
                amazonAccountMap[name].carryOverCount += 1;
            }
        }
        const byAmazonAccount = Object.entries(amazonAccountMap)
            .map(([name, stats]) => {
                if (name === '(Unassigned)') {
                    return {
                        name,
                        count: stats.count,
                        queueCount: stats.queueCount,
                        carryOverCount: stats.carryOverCount,
                        remaining: null,
                        max: null,
                        isFull: false,
                    };
                }

                return {
                    name,
                    count: stats.count,
                    queueCount: stats.queueCount,
                    carryOverCount: stats.carryOverCount,
                    remaining: Math.max(MAX_ORDERS_PER_AMAZON_ACCOUNT - stats.count, 0),
                    max: MAX_ORDERS_PER_AMAZON_ACCOUNT,
                    isFull: stats.count >= MAX_ORDERS_PER_AMAZON_ACCOUNT,
                };
            })
            .sort((left, right) => left.name.localeCompare(right.name));

        // Total added balance across all accounts that day
        const balances = await AmazonAccountDailyBalance.find({ date }).lean();
        const totalAmountAdded = balances.reduce((s, b) => s + (b.addedBalance || 0), 0);

        res.json({
            totalOrders,
            totalUSD,
            totalINR,
            exchangeRate,
            ordersDone,
            ordersNotDone,
            totalAmountAdded,
            byPurchaser,
            byAmazonAccount,
            maxOrdersPerAmazonAccount: MAX_ORDERS_PER_AMAZON_ACCOUNT,
        });
    } catch (err) {
        console.error('GET /affiliate-orders/summary error:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
