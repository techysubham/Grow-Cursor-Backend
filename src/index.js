import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables FIRST before any other imports
dotenv.config();

import { connectToDatabase } from './lib/db.js';
import User from './models/User.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import platformRoutes from './routes/platforms.js';
import storeRoutes from './routes/stores.js';
import taskRoutes from './routes/tasks.js';
import rangeRoutes from './routes/ranges.js';
import categoryRoutes from './routes/categories.js';
import subcategoryRoutes from './routes/subcategories.js';

import assignmentsRouter from './routes/assignments.js';
import compatibilityRoutes from './routes/compatibility.js';
import listingCompletionsRoutes from './routes/listingCompletions.js';

import ebayRoutes from './routes/ebay.js';
import sellersRoutes from './routes/sellers.js';
import employeeProfilesRoutes from './routes/employeeProfiles.js';
import storeWiseTasksRoutes from './routes/storeWiseTasks.js';
import listerInfoRoutes from './routes/listerInfo.js';

import amazonAccountRoutes from './routes/amazonAccounts.js';
import rangeAnalysisRoutes from './routes/rangeAnalysis.js';
import ideasRoutes from './routes/ideas.js';
import ordersRoutes from './routes/orders.js';
import uploadRoutes from './routes/upload.js';
import creditCardRoutes from './routes/creditCards.js';
import creditCardNameRoutes from './routes/creditCardNames.js';
import exchangeRatesRoutes from './routes/exchangeRates.js';
import internalMessagesRoutes from './routes/internalMessages.js';
import payoneerRoutes from './routes/payoneer.js';
import paymentAccountRoutes from './routes/paymentAccounts.js';
import transactionRoutes from './routes/transactions.js';
import bankAccountRoutes from './routes/bankAccounts.js';
import columnPresetRoutes from './routes/columnPresets.js';
import amazonLookupRoutes from './routes/amazonLookup.js';
import productUmbrellaRoutes from './routes/productUmbrellas.js';
import customColumnsRoutes from './routes/customColumns.js';
import listingTemplateRoutes from './routes/listingTemplates.js';
import templateListingsRoutes from './routes/templateListings.js';
import templateOverridesRoutes from './routes/templateOverrides.js';
import sellerPricingConfigRoutes from './routes/sellerPricingConfig.js';
import accountHealthRoutes from './routes/accountHealth.js';

import cron from 'node-cron';
import Order from './models/Order.js';
import Seller from './models/Seller.js';
import { sendAutoMessage } from './routes/ebay.js';

const app = express();

app.use(helmet());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']
}));
app.use(express.json());
app.use(morgan('dev'));

// Serve static uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'public/uploads')));

// Disable caching globally for all API routes
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});



app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/platforms', platformRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/ranges', rangeRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subcategories', subcategoryRoutes);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/compatibility', compatibilityRoutes);
app.use('/api/listing-completions', listingCompletionsRoutes);

app.use('/api/ebay', ebayRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/employee-profiles', employeeProfilesRoutes);
app.use('/api/store-wise-tasks', storeWiseTasksRoutes);
app.use('/api/lister-info', listerInfoRoutes);
app.use('/api/amazon-accounts', amazonAccountRoutes);
app.use('/api/range-analysis', rangeAnalysisRoutes);
app.use('/api/ideas', ideasRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/credit-cards', creditCardRoutes);
app.use('/api/credit-card-names', creditCardNameRoutes);
app.use('/api/exchange-rates', exchangeRatesRoutes);
app.use('/api/internal-messages', internalMessagesRoutes);
app.use('/api/payoneer', payoneerRoutes);
app.use('/api/payment-accounts', paymentAccountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/bank-accounts', bankAccountRoutes);
app.use('/api/column-presets', columnPresetRoutes);
app.use('/api/amazon-lookup', amazonLookupRoutes);
app.use('/api/product-umbrellas', productUmbrellaRoutes);
app.use('/api/custom-columns', customColumnsRoutes);
app.use('/api/listing-templates', listingTemplateRoutes);
app.use('/api/template-listings', templateListingsRoutes);
app.use('/api/template-overrides', templateOverridesRoutes);
app.use('/api/seller-pricing-config', sellerPricingConfigRoutes);
app.use('/api/account-health', accountHealthRoutes);


const port = process.env.PORT || 5000;

// Auto-message start date: Jan 27, 2026
const AUTO_MESSAGE_START_DATE = new Date('2026-01-27T00:00:00Z');

// Auto-message cron job function
async function runAutoMessageJob() {
  console.log('[AutoMessage Cron] Starting hourly auto-message job...');
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find all eligible orders
    const orders = await Order.find({
      creationDate: { 
        $lte: twentyFourHoursAgo,
        $gte: AUTO_MESSAGE_START_DATE 
      },
      autoMessageSent: { $ne: true },
      autoMessageDisabled: { $ne: true },
      orderFulfillmentStatus: { $ne: 'FULFILLED' }, // Skip if already shipped
      $or: [
        { cancelState: { $exists: false } },
        { cancelState: null },
        { cancelState: { $nin: ['CANCELED', 'CANCELLED'] } }
      ]
    }).populate({
      path: 'seller',
      populate: { path: 'user' }
    }).limit(50);

    console.log(`[AutoMessage Cron] Found ${orders.length} orders to process`);

    let successCount = 0;
    let failCount = 0;

    for (const order of orders) {
      if (!order.seller) {
        console.log(`[AutoMessage Cron] Skip order ${order.orderId}: No seller`);
        failCount++;
        continue;
      }

      const result = await sendAutoMessage(order, order.seller);
      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[AutoMessage Cron] Completed: ${successCount} sent, ${failCount} failed`);
  } catch (err) {
    console.error('[AutoMessage Cron] Error:', err);
  }
}

connectToDatabase()
  .then(async () => {
    // Ensure email index is sparse unique to allow multiple nulls
    try {
      // Drop existing non-sparse unique index if present
      await User.collection.dropIndex('email_1');
    } catch (e) {
      // Ignore if index does not exist
    }
    try {
      await User.collection.createIndex({ email: 1 }, { unique: true, sparse: true });
    } catch (e) {
      console.error('Failed to create sparse unique index on email:', e?.message || e);
    }

    app.listen(port, () => {
      console.log(`API listening on :${port}`);
    });

    // Schedule auto-message cron job - runs every hour at minute 0
    cron.schedule('0 * * * *', runAutoMessageJob);
    console.log('[AutoMessage Cron] Scheduled to run every hour');
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });


