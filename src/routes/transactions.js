import express from 'express';
import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import Order from '../models/Order.js';
import { requireAuth, requirePageAccess } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { createTransactionSchema, updateTransactionSchema } from '../schemas/index.js';
import { parsePagination } from '../utils/paginate.js';
import { getCache, setCache, delCache } from '../lib/redis.js';

const router = express.Router();

const TX_CACHE_KEYS = ['tx:balance-summary', 'tx:credit-card-summary'];

// GET /api/transactions/balance-summary - Get balance per bank account
router.get('/balance-summary', requireAuth, requirePageAccess('Transactions'), async (req, res) => {
    try {
        const cached = await getCache('tx:balance-summary');
        if (cached) return res.json(cached);

        const summary = await Transaction.aggregate([
            {
                $group: {
                    _id: '$bankAccount',
                    totalCredit: {
                        $sum: {
                            $cond: [{ $eq: ['$transactionType', 'Credit'] }, '$amount', 0]
                        }
                    },
                    totalDebit: {
                        $sum: {
                            $cond: [{ $eq: ['$transactionType', 'Debit'] }, '$amount', 0]
                        }
                    }
                }
            },
            {
                $lookup: {
                    from: 'bankaccounts',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'bankDetails'
                }
            },
            {
                $unwind: '$bankDetails'
            },
            {
                $project: {
                    bankName: '$bankDetails.name',
                    balance: { $subtract: ['$totalCredit', '$totalDebit'] }
                }
            },
            {
                $sort: { bankName: 1 }
            }
        ]);
        res.json(summary);
        await setCache('tx:balance-summary', summary, 300);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/transactions/credit-card-summary
router.get('/credit-card-summary', requireAuth, requirePageAccess('Transactions'), async (req, res) => {
    try {
        const cached = await getCache('tx:credit-card-summary');
        if (cached) return res.json(cached);

        // Step 1: Get total transferred TO each credit card via transactions
        const transactionSummary = await Transaction.aggregate([
            {
                $match: {
                    creditCardName: { $exists: true, $ne: null }
                }
            },
            {
                $group: {
                    _id: '$creditCardName',
                    totalTransferred: { $sum: '$amount' }
                }
            },
            {
                $lookup: {
                    from: 'creditcardnames',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'cardDetails'
                }
            },
            {
                $unwind: '$cardDetails'
            },
            {
                $project: {
                    _id: 1,
                    cardName: '$cardDetails.name',
                    totalTransferred: 1
                }
            }
        ]);

        // Step 2: Get total spent FROM each credit card via orders
        const orderSummary = await Order.aggregate([
            {
                $match: {
                    cardName: { $exists: true, $ne: null, $ne: '' }
                }
            },
            {
                $group: {
                    _id: '$cardName',
                    totalSpent: {
                        $sum: {
                            $add: [
                                { $ifNull: ['$amazonTotalINR', 0] },
                                { $ifNull: ['$totalCC', 0] }
                            ]
                        }
                    }
                }
            }
        ]);

        // Step 3: Combine and calculate remaining balance
        const summary = transactionSummary.map(trans => {
            const orderData = orderSummary.find(order => order._id === trans.cardName);
            const totalSpent = orderData ? orderData.totalSpent : 0;
            
            return {
                _id: trans._id,
                cardName: trans.cardName,
                totalTransferred: trans.totalTransferred,
                totalSpent: totalSpent,
                balance: trans.totalTransferred - totalSpent
            };
        });

        res.json(summary);
        await setCache('tx:credit-card-summary', summary, 300);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/transactions - List all
router.get('/', requireAuth, requirePageAccess('Transactions'), async (req, res) => {
    try {
        const { startDate, endDate, bankAccount, transactionType } = req.query;
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });

        const query = {};
        if (startDate || endDate) {
            query.date = {};
            if (startDate) query.date.$gte = new Date(startDate);
            // End date should include the full day
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.date.$lte = end;
            }
        }
        if (bankAccount) query.bankAccount = new mongoose.Types.ObjectId(bankAccount);
        if (transactionType) query.transactionType = transactionType;

        const [transactions, totalTransactions, aggregateSum] = await Promise.all([
            Transaction.find(query)
                .populate('bankAccount', 'name')
                .populate('creditCardName', 'name')
                .sort({ date: -1 })
                .skip(skip)
                .limit(limit),
            Transaction.countDocuments(query),
            Transaction.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: null,
                        totalCredit: {
                            $sum: { $cond: [{ $eq: ['$transactionType', 'Credit'] }, '$amount', 0] }
                        },
                        totalDebit: {
                            $sum: { $cond: [{ $eq: ['$transactionType', 'Debit'] }, '$amount', 0] }
                        }
                    }
                }
            ])
        ]);

        const summary = aggregateSum[0] || { totalCredit: 0, totalDebit: 0 };

        res.json({
            transactions,
            totalPages: Math.ceil(totalTransactions / limit),
            currentPage: page,
            totalTransactions,
            summary
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/transactions - Create Manual Transaction
router.post('/', requireAuth, requirePageAccess('Transactions'), validate(createTransactionSchema), async (req, res) => {
    try {
        const { date, bankAccount, transactionType, amount, remark, creditCardName } = req.body;

        if (!date || !bankAccount || !transactionType || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const newTransaction = new Transaction({
            date,
            bankAccount,
            transactionType,
            amount,
            remark,
            source: 'MANUAL',
            creditCardName: transactionType === 'Debit' && creditCardName ? creditCardName : undefined
        });

        await newTransaction.save();
        await newTransaction.populate('bankAccount', 'name');
        await newTransaction.populate('creditCardName', 'name');

        await delCache(...TX_CACHE_KEYS);
        res.status(201).json(newTransaction);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/transactions/:id - Update Manual Transaction
router.put('/:id', requireAuth, requirePageAccess('Transactions'), validate(updateTransactionSchema), async (req, res) => {
    try {
        const { id } = req.params;
        const { date, bankAccount, transactionType, amount, remark, creditCardName } = req.body;

        const transaction = await Transaction.findById(id);
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        if (transaction.source !== 'MANUAL') {
            return res.status(403).json({ error: 'Cannot edit auto-generated transactions manually.' });
        }

        if (date) transaction.date = date;
        if (bankAccount) transaction.bankAccount = bankAccount;
        if (transactionType) transaction.transactionType = transactionType;
        if (amount) transaction.amount = amount;
        if (remark !== undefined) transaction.remark = remark;
        if (creditCardName !== undefined) transaction.creditCardName = transactionType === 'Debit' && creditCardName ? creditCardName : undefined;

        await transaction.save();
        await transaction.populate('bankAccount', 'name');
        await transaction.populate('creditCardName', 'name');

        await delCache(...TX_CACHE_KEYS);
        res.json(transaction);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/transactions/:id - Delete Manual Transaction
router.delete('/:id', requireAuth, requirePageAccess('Transactions'), async (req, res) => {
    try {
        const { id } = req.params;
        const transaction = await Transaction.findById(id);

        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        if (transaction.source !== 'MANUAL') {
            return res.status(403).json({ error: 'Cannot delete auto-generated transactions manually.' });
        }

        await Transaction.findByIdAndDelete(id);
        await delCache(...TX_CACHE_KEYS);
        res.json({ message: 'Transaction deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
