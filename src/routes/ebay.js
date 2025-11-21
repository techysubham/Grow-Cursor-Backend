import express from 'express';
import axios from 'axios';
import qs from 'qs';
import jwt from 'jsonwebtoken';
import { requireAuth, requireRole } from '../middleware/auth.js';
import Seller from '../models/Seller.js';
import Order from '../models/Order.js';
import Return from '../models/Return.js';
import Message from '../models/Message.js';
const router = express.Router();

// Helper function to extract tracking number from fulfillmentHrefs
async function extractTrackingNumber(fulfillmentHrefs, accessToken) {
  if (!fulfillmentHrefs || fulfillmentHrefs.length === 0) return null;
  try {
    // fulfillmentHrefs contains URLs to fulfillment details
    // Example: "https://api.ebay.com/sell/fulfillment/v1/order/00-00000-00000/fulfillment/00000000000000"
    const fulfillmentUrl = fulfillmentHrefs[0];
    const response = await axios.get(fulfillmentUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    // Extract tracking number from the fulfillment response
    const trackingNumber = response.data?.shipmentTrackingNumber || 
                          response.data?.lineItems?.[0]?.shipmentTrackingNumber ||
                          null;
    return trackingNumber;
  } catch (err) {
    console.error('Failed to extract tracking number:', err.message);
    return null;
  }
}

// 1. Start OAuth: Redirect to eBay
router.get('/connect', (req, res) => {
  const { token } = req.query; // Get JWT from query param
  if (!token) return res.status(400).send('Missing authentication token');
  
  const clientId = process.env.EBAY_CLIENT_ID;
  const ruName = process.env.EBAY_RU_NAME;
  const scope = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment'
  ].join(' ');
  
  // Pass the user's JWT as state parameter so we can identify them in callback
  const state = encodeURIComponent(token);
  const redirectUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(ruName)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
  res.redirect(redirectUrl);
});

// 2. OAuth Callback: Exchange code for tokens and save to seller
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code');
  if (!state) return res.status(400).send('Missing state parameter');

  try {
    // Decode the JWT from state to identify the seller
    const token = decodeURIComponent(state);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    // Exchange code for tokens
    const tokenRes = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.EBAY_RU_NAME,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
        },
      }
    );

    // Save tokens to seller
    const seller = await Seller.findOne({ user: userId });
    if (!seller) return res.status(404).send('Seller not found');

    seller.ebayTokens = {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      expires_in: tokenRes.data.expires_in,
      refresh_token_expires_in: tokenRes.data.refresh_token_expires_in,
      token_type: tokenRes.data.token_type,
      scope: tokenRes.data.scope,
      fetchedAt: new Date()
    };
    await seller.save();

    // Fetch first 5 orders for new seller
    try {
      const ordersRes = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
        headers: {
          Authorization: `Bearer ${tokenRes.data.access_token}`,
          'Content-Type': 'application/json',
        },
        params: {
          limit: 15
        },
      });
      
      const ebayOrders = ordersRes.data.orders || [];
      
      // Save initial orders in database
      for (const order of ebayOrders) {
        const lineItem = order.lineItems?.[0] || {};
        const fulfillmentInstr = order.fulfillmentStartInstructions?.[0] || {};
        const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
        const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();
        
        // Extract tracking number if fulfillmentHrefs exists
        const trackingNumber = await extractTrackingNumber(order.fulfillmentHrefs, tokenRes.data.access_token);
        
        // Extract purchaseMarketplaceId from lineItems
        const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';
        
        await Order.findOneAndUpdate(
          { orderId: order.orderId },
          {
            seller: seller._id,
            orderId: order.orderId,
            legacyOrderId: order.legacyOrderId,
            creationDate: order.creationDate,
            lastModifiedDate: order.lastModifiedDate,
            orderFulfillmentStatus: order.orderFulfillmentStatus,
            orderPaymentStatus: order.orderPaymentStatus,
            sellerId: order.sellerId,
            buyer: order.buyer,
            buyerCheckoutNotes: order.buyerCheckoutNotes,
            pricingSummary: order.pricingSummary,
            cancelStatus: order.cancelStatus,
            paymentSummary: order.paymentSummary,
            fulfillmentStartInstructions: order.fulfillmentStartInstructions,
            lineItems: order.lineItems,
            ebayCollectAndRemitTax: order.ebayCollectAndRemitTax,
            salesRecordReference: order.salesRecordReference,
            totalFeeBasisAmount: order.totalFeeBasisAmount,
            totalMarketplaceFee: order.totalMarketplaceFee,
            dateSold: order.creationDate,
            shipByDate: lineItem.lineItemFulfillmentInstructions?.shipByDate,
            estimatedDelivery: lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate,
            productName: lineItem.title,
            itemNumber: lineItem.legacyItemId,
            buyerAddress: buyerAddr,
            shippingFullName: shipTo.fullName || '',
            shippingAddressLine1: shipTo.contactAddress?.addressLine1 || '',
            shippingAddressLine2: shipTo.contactAddress?.addressLine2 || '',
            shippingCity: shipTo.contactAddress?.city || '',
            shippingState: shipTo.contactAddress?.stateOrProvince || '',
            shippingPostalCode: shipTo.contactAddress?.postalCode || '',
            shippingCountry: shipTo.contactAddress?.countryCode || '',
            shippingPhone: '0000000000',
            quantity: lineItem.quantity,
            subtotal: parseFloat(order.pricingSummary?.priceSubtotal?.value || 0),
            salesTax: parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0),
            discount: parseFloat(order.pricingSummary?.priceDiscount?.value || 0),
            shipping: parseFloat(order.pricingSummary?.deliveryCost?.value || 0),
            transactionFees: parseFloat(order.totalMarketplaceFee?.value || 0),
            adFee: parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0),
            cancelState: order.cancelStatus?.cancelState || 'NONE_REQUESTED',
            refunds: order.paymentSummary?.refunds || [],
            trackingNumber: trackingNumber,
            purchaseMarketplaceId: purchaseMarketplaceId
          },
          { upsert: true, new: true }
        );
      }
    } catch (orderErr) {
      console.error('Failed to fetch initial orders:', orderErr.message);
    }

    // Redirect back to seller profile with success message
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    res.redirect(`${clientOrigin}/seller-ebay?connected=true`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Fetch Orders (for polling) by sellerId, region(s), with token refresh
router.get('/orders', async (req, res) => {
  const { sellerId, region } = req.query;
  if (!sellerId) return res.status(400).json({ error: 'Missing sellerId' });
  try {
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    if (!seller.ebayTokens || !seller.ebayTokens.access_token) {
      return res.status(400).json({ error: 'Seller does not have a connected eBay account' });
    }
    // Check token expiry (expires_in is in seconds, fetchedAt is Date)
    const now = Date.now();
    const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
    const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
    // Refresh if less than 2 minutes left
    let accessToken = seller.ebayTokens.access_token;
    if (fetchedAt && (now - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
      // Refresh token
      try {
        const refreshRes = await axios.post(
          'https://api.ebay.com/identity/v1/oauth2/token',
          qs.stringify({
            grant_type: 'refresh_token',
            refresh_token: seller.ebayTokens.refresh_token,
            scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment',
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
            },
          }
        );
        seller.ebayTokens.access_token = refreshRes.data.access_token;
        seller.ebayTokens.expires_in = refreshRes.data.expires_in;
        seller.ebayTokens.fetchedAt = new Date();
        await seller.save();
        accessToken = refreshRes.data.access_token;
      } catch (refreshErr) {
        return res.status(401).json({ error: 'Failed to refresh eBay token', details: refreshErr.message });
      }
    }
    
    // Get the last modified date from our database to fetch only new/updated orders
    const orderCount = await Order.countDocuments({ seller: seller._id });
    const lastOrder = await Order.findOne({ seller: seller._id }).sort({ lastModifiedDate: -1 });
    const lastModifiedDate = lastOrder ? lastOrder.lastModifiedDate : null;
    
    // Build eBay API params
    const params = {
      limit: orderCount === 0 ? 15 : 200 // If no orders exist, fetch only 5, else fetch all new/updated
    };
    
    // If we have orders already, only fetch orders modified after the last one
    if (lastModifiedDate) {
      params.filter = `lastmodifieddate:[${new Date(lastModifiedDate).toISOString()}..${new Date().toISOString()}]`;
    }
    
    // Fetch orders from eBay API
    const ordersRes = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      params
    });
    
    const ebayOrders = ordersRes.data.orders || [];
    
    // Save/update orders in database
    for (const order of ebayOrders) {
      const lineItem = order.lineItems?.[0] || {};
      const fulfillmentInstr = order.fulfillmentStartInstructions?.[0] || {};
      const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
      const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();
      
      // Extract tracking number if fulfillmentHrefs exists
      const trackingNumber = await extractTrackingNumber(order.fulfillmentHrefs, accessToken);
      
      // Extract purchaseMarketplaceId from lineItems
      const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';
      
      await Order.findOneAndUpdate(
        { orderId: order.orderId },
        {
          seller: seller._id,
          orderId: order.orderId,
          legacyOrderId: order.legacyOrderId,
          creationDate: order.creationDate,
          lastModifiedDate: order.lastModifiedDate,
          orderFulfillmentStatus: order.orderFulfillmentStatus,
          orderPaymentStatus: order.orderPaymentStatus,
          sellerId: order.sellerId,
          buyer: order.buyer,
          buyerCheckoutNotes: order.buyerCheckoutNotes,
          pricingSummary: order.pricingSummary,
          cancelStatus: order.cancelStatus,
          paymentSummary: order.paymentSummary,
          fulfillmentStartInstructions: order.fulfillmentStartInstructions,
          lineItems: order.lineItems,
          ebayCollectAndRemitTax: order.ebayCollectAndRemitTax,
          salesRecordReference: order.salesRecordReference,
          totalFeeBasisAmount: order.totalFeeBasisAmount,
          totalMarketplaceFee: order.totalMarketplaceFee,
          // Denormalized fields
          dateSold: order.creationDate,
          shipByDate: lineItem.lineItemFulfillmentInstructions?.shipByDate,
          estimatedDelivery: lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate,
          productName: lineItem.title,
          itemNumber: lineItem.legacyItemId,
          buyerAddress: buyerAddr,
          shippingFullName: shipTo.fullName || '',
          shippingAddressLine1: shipTo.contactAddress?.addressLine1 || '',
          shippingAddressLine2: shipTo.contactAddress?.addressLine2 || '',
          shippingCity: shipTo.contactAddress?.city || '',
          shippingState: shipTo.contactAddress?.stateOrProvince || '',
          shippingPostalCode: shipTo.contactAddress?.postalCode || '',
          shippingCountry: shipTo.contactAddress?.countryCode || '',
          shippingPhone: '0000000000',
          quantity: lineItem.quantity,
          subtotal: parseFloat(order.pricingSummary?.priceSubtotal?.value || 0),
          salesTax: parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0),
          discount: parseFloat(order.pricingSummary?.priceDiscount?.value || 0),
          shipping: parseFloat(order.pricingSummary?.deliveryCost?.value || 0),
          transactionFees: parseFloat(order.totalMarketplaceFee?.value || 0),
          adFee: parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0),
          cancelState: order.cancelStatus?.cancelState || 'NONE_REQUESTED',
          refunds: order.paymentSummary?.refunds || [],
          trackingNumber: trackingNumber,
          purchaseMarketplaceId: purchaseMarketplaceId
        },
        { upsert: true, new: true }
      );
    }
    
    // Return orders from database
    const dbOrders = await Order.find({ seller: seller._id }).sort({ creationDate: -1 }).limit(200);
    res.json({ orders: dbOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New endpoint: Get orders with IN_PROGRESS cancellation status (last 30 days only)
router.get('/cancelled-orders', async (req, res) => {
  try {
    // Calculate 30 days ago in UTC
    const nowUTC = Date.now();
    const thirtyDaysAgoMs = 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(nowUTC - thirtyDaysAgoMs);

    console.log(`[Cancelled Orders] Fetching IN_PROGRESS orders from last 30 days (since ${thirtyDaysAgo.toISOString()})`);

    // Query for orders with IN_PROGRESS cancellation AND within 30 days
    const cancelledOrders = await Order.find({
      cancelState: 'IN_PROGRESS', // Filter by cancel state
      creationDate: { $gte: thirtyDaysAgo } // Only last 30 days
    })
      .populate('seller', 'username ebayUserId')
      .sort({ creationDate: -1 }); // Newest first

    console.log(`[Cancelled Orders] Found ${cancelledOrders.length} IN_PROGRESS orders`);

    res.json({ 
      orders: cancelledOrders,
      totalOrders: cancelledOrders.length,
      filterDate: thirtyDaysAgo.toISOString()
    });
  } catch (err) {
    console.error('[Cancelled Orders] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// New endpoint: Get stored orders from database
// Get stored orders from database with pagination support
router.get('/stored-orders', async (req, res) => {
  const { sellerId, page = 1, limit = 50, searchOrderId, searchBuyerName, searchSoldDate, searchMarketplace } = req.query;
  
  try {
    // Build base query
    let query = {};
    if (sellerId) {
      query.seller = sellerId;
    }

    // Apply search filters
    if (searchOrderId) {
      query.$or = [
        { orderId: { $regex: searchOrderId, $options: 'i' } },
        { legacyOrderId: { $regex: searchOrderId, $options: 'i' } }
      ];
    }

    if (searchBuyerName) {
      query['buyer.buyerRegistrationAddress.fullName'] = { $regex: searchBuyerName, $options: 'i' };
    }

    if (searchSoldDate) {
      // Parse date as UTC and create range for the entire day (00:00:00 to 23:59:59.999 UTC)
      const dateMatch = searchSoldDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateMatch) {
        const year = parseInt(dateMatch[1], 10);
        const month = parseInt(dateMatch[2], 10) - 1; // JS months are 0-indexed
        const day = parseInt(dateMatch[3], 10);
        
        const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
        const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
        
        query.dateSold = {
          $gte: startOfDay,
          $lte: endOfDay
        };
      }
    }

    if (searchMarketplace && searchMarketplace !== '') {
      query.purchaseMarketplaceId = searchMarketplace;
    }

    // Calculate pagination
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination metadata
    const totalOrders = await Order.countDocuments(query);
    const totalPages = Math.ceil(totalOrders / limitNum);

    // Fetch orders with pagination
    const orders = await Order.find(query)
      .populate({
        path: 'seller',
        populate: {
          path: 'user',
          select: 'username email'
        }
      })
      .sort({ creationDate: -1 })
      .skip(skip)
      .limit(limitNum);
    
    console.log(`[Stored Orders] Query: ${JSON.stringify(query)}, Page: ${pageNum}/${totalPages}, Found ${orders.length}/${totalOrders} orders`);
    
    res.json({ 
      orders,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalOrders,
        ordersPerPage: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update ad fee general for an order
router.patch('/orders/:orderId/ad-fee-general', async (req, res) => {
  const { orderId } = req.params;
  const { adFeeGeneral } = req.body;
  
  if (adFeeGeneral === undefined || adFeeGeneral === null) {
    return res.status(400).json({ error: 'Missing adFeeGeneral value' });
  }
  
  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { adFeeGeneral: parseFloat(adFeeGeneral) },
      { new: true }
    );
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update manual tracking number for an order (does NOT affect fulfillment tracking)
router.patch('/orders/:orderId/manual-tracking', async (req, res) => {
  const { orderId } = req.params;
  const { manualTrackingNumber } = req.body;

  if (manualTrackingNumber === undefined || manualTrackingNumber === null) {
    return res.status(400).json({ error: 'Missing manualTrackingNumber value' });
  }

  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { manualTrackingNumber: String(manualTrackingNumber) },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Poll all sellers for new/updated orders with smart detection (PARALLEL + UTC-based)
router.post('/poll-all-sellers', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    // Helper function to normalize dates for comparison (ignore milliseconds/format)
    function normalizeDateForComparison(date) {
      if (!date) return null;
      if (date instanceof Date) {
        return Math.floor(date.getTime() / 1000); // Unix timestamp in seconds
      }
      if (typeof date === 'string') {
        return Math.floor(new Date(date).getTime() / 1000);
      }
      return null;
    }

    // Helper function to check if field actually changed
    function hasFieldChanged(oldValue, newValue, fieldName) {
      // Skip system fields
      const systemFields = ['_id', '__v', 'seller', 'updatedAt', 'createdAt'];
      if (systemFields.includes(fieldName)) return false;
      
      // Date fields - compare Unix timestamps (ignore milliseconds)
      const dateFields = ['creationDate', 'lastModifiedDate', 'dateSold', 'shipByDate', 'estimatedDelivery'];
      if (dateFields.includes(fieldName)) {
        const oldTime = normalizeDateForComparison(oldValue);
        const newTime = normalizeDateForComparison(newValue);
        return oldTime !== newTime;
      }
      
      // Null/undefined checks
      if (oldValue === null || oldValue === undefined) {
        return newValue !== null && newValue !== undefined;
      }
      
      // Objects/Arrays - deep comparison
      if (typeof newValue === 'object' && newValue !== null) {
        return JSON.stringify(oldValue) !== JSON.stringify(newValue);
      }
      
      // Primitives - direct comparison
      return oldValue !== newValue;
    }

    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');
    
    if (sellers.length === 0) {
      return res.json({ 
        message: 'No sellers with connected eBay accounts found',
        pollResults: [],
        totalPolled: 0,
        totalNewOrders: 0,
        totalUpdatedOrders: 0
      });
    }

    // Calculate 30 days ago in UTC
    const nowUTC = Date.now();
    const thirtyDaysAgoMs = 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(nowUTC - thirtyDaysAgoMs);

    console.log(`\n========== POLLING ${sellers.length} SELLERS IN PARALLEL ==========`);
    console.log(`UTC Time: ${new Date(nowUTC).toISOString()}`);
    console.log(`30-day window starts: ${thirtyDaysAgo.toISOString()}`);

    // Process all sellers in parallel using Promise.allSettled
    const pollingPromises = sellers.map(async (seller) => {
      const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();
      
      try {
        console.log(`\n[${sellerName}] Starting poll...`);
        
        // ========== TOKEN REFRESH CHECK ==========
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[${sellerName}] Token expired, refreshing...`);
          try {
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment',
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            seller.ebayTokens.access_token = refreshRes.data.access_token;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
            accessToken = refreshRes.data.access_token;
            console.log(`[${sellerName}] Token refreshed`);
          } catch (refreshErr) {
            console.error(`[${sellerName}] Token refresh failed:`, refreshErr.message);
            return {
              sellerId: seller._id,
              sellerName,
              success: false,
              error: 'Failed to refresh token'
            };
          }
        }

        // ========== DETERMINE POLLING STRATEGY ==========
        const orderCount = await Order.countDocuments({ seller: seller._id });
        const latestOrder = await Order.findOne({ seller: seller._id }).sort({ creationDate: -1 });
        const latestCreationDate = latestOrder ? latestOrder.creationDate : null;
        const lastPolledAt = seller.lastPolledAt || null;
        const initialSyncDate = seller.initialSyncDate || new Date(Date.UTC(2025, 9, 17, 0, 0, 0, 0));

        console.log(`[${sellerName}] Orders in DB: ${orderCount}, Latest: ${latestCreationDate?.toISOString() || 'NONE'}, LastPolled: ${lastPolledAt?.toISOString() || 'NEVER'}`);

        const newOrders = [];
        const updatedOrders = [];
        // Use 5-second buffer for clock skew (UTC-based)
        const currentTimeUTC = new Date(nowUTC - 5000);

        // ========== PHASE 1: FETCH NEW ORDERS ==========
        let newOrdersFilter = null;
        let newOrdersLimit = 15;

        if (orderCount === 0) {
          // First sync: get orders from Oct 17, 2025 onwards (UTC)
          newOrdersFilter = `creationdate:[${initialSyncDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
          newOrdersLimit = 200;
          console.log(`[${sellerName}] PHASE 1: Initial sync from ${initialSyncDate.toISOString()}`);
        } else if (latestCreationDate) {
          // Subsequent syncs: fetch orders created after our latest order
          const afterLatestMs = new Date(latestCreationDate).getTime() + 1000; // +1 sec
          const afterLatest = new Date(afterLatestMs);
          const timeDiffMinutes = (currentTimeUTC.getTime() - afterLatestMs) / (1000 * 60);
          
          if (timeDiffMinutes >= 1) {
            newOrdersFilter = `creationdate:[${afterLatest.toISOString()}..${currentTimeUTC.toISOString()}]`;
            newOrdersLimit = 200;
            console.log(`[${sellerName}] PHASE 1: New orders after ${afterLatest.toISOString()}`);
          } else {
            console.log(`[${sellerName}] PHASE 1: Skipped (too recent: ${timeDiffMinutes.toFixed(2)} min)`);
          }
        }

        // Fetch new orders if filter is set
        if (newOrdersFilter) {
          try {
            const newOrdersRes = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              params: {
                filter: newOrdersFilter,
                limit: newOrdersLimit
              }
            });

            const ebayNewOrders = newOrdersRes.data.orders || [];
            console.log(`[${sellerName}] PHASE 1: Got ${ebayNewOrders.length} new orders from eBay`);

            // Insert new orders
            for (const ebayOrder of ebayNewOrders) {
              const existingOrder = await Order.findOne({ orderId: ebayOrder.orderId });
              
              if (!existingOrder) {
                const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
                const newOrder = await Order.create(orderData);
                newOrders.push(newOrder);
                console.log(`  🆕 NEW: ${ebayOrder.orderId}`);
              } else {
                // Order exists, check if needs update
                const ebayModTime = new Date(ebayOrder.lastModifiedDate).getTime();
                const dbModTime = new Date(existingOrder.lastModifiedDate).getTime();
                
                if (ebayModTime > dbModTime) {
                  const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
                  Object.assign(existingOrder, orderData);
                  await existingOrder.save();
                  updatedOrders.push(existingOrder);
                  console.log(`  🔄 UPDATED: ${ebayOrder.orderId}`);
                }
              }
            }
          } catch (phase1Err) {
            console.error(`[${sellerName}] PHASE 1 error:`, phase1Err.message);
          }
        }

        // ========== PHASE 2: CHECK FOR UPDATES ON RECENT ORDERS ==========
        console.log(`[${sellerName}] PHASE 2: Checking orders < 30 days old`);

        const recentOrders = await Order.find({
          seller: seller._id,
          creationDate: { $gte: thirtyDaysAgo }
        }).select('orderId lastModifiedDate creationDate');

        console.log(`[${sellerName}] PHASE 2: ${recentOrders.length} orders < 30 days old`);

        if (recentOrders.length > 0) {
          const checkFromDate = lastPolledAt || thirtyDaysAgo;
          const modifiedFilter = `lastmodifieddate:[${checkFromDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
          
          console.log(`[${sellerName}] PHASE 2: Checking mods since ${checkFromDate.toISOString()}`);

          let offset = 0;
          const batchSize = 100;
          let hasMore = true;
          const recentOrderIdSet = new Set(recentOrders.map(o => o.orderId));

          while (hasMore) {
            try {
              const phase2Res = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                params: {
                  filter: modifiedFilter,
                  limit: batchSize,
                  offset: offset > 0 ? offset : undefined
                }
              });

              const batchOrders = phase2Res.data.orders || [];
              console.log(`[${sellerName}] PHASE 2: Got ${batchOrders.length} orders at offset ${offset}`);

              const relevantOrders = batchOrders.filter(o => recentOrderIdSet.has(o.orderId));
              console.log(`[${sellerName}] PHASE 2: ${relevantOrders.length} relevant`);

              for (const ebayOrder of relevantOrders) {
                const existingOrder = await Order.findOne({ 
                  orderId: ebayOrder.orderId,
                  seller: seller._id 
                });

                if (existingOrder) {
                  const ebayModTime = new Date(ebayOrder.lastModifiedDate).getTime();
                  const dbModTime = new Date(existingOrder.lastModifiedDate).getTime();
                  
                  // OPTIMIZATION: Skip if not actually modified
                  if (ebayModTime <= dbModTime) {
                    continue; // No changes, skip this order
                  }
                  
                  // ONLY NOW fetch full order data (includes expensive tracking lookup)
                  const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
                  
                  // Define fields that should trigger notifications
                  const notifiableFields = [
                    'cancelState',
                    'orderPaymentStatus',
                    'refunds',
                    'orderFulfillmentStatus',
                    'trackingNumber',
                    'shippingFullName',
                    'shippingAddressLine1',
                    'shippingAddressLine2',
                    'shippingCity',
                    'shippingState',
                    'shippingPostalCode',
                    'shippingCountry'
                    // NOTE: buyerCheckoutNotes is NOT included - updates DB silently
                  ];
                  
                  // Detect changed fields with smart comparison
                  const changedFields = [];
                  for (const key of Object.keys(orderData)) {
                    if (hasFieldChanged(existingOrder[key], orderData[key], key)) {
                      changedFields.push(key);
                    }
                  }
                  
                  // Filter to only notifiable fields (exclude lastModifiedDate)
                  const notifiableChanges = changedFields.filter(f => 
                    notifiableFields.includes(f) && f !== 'lastModifiedDate'
                  );
                  
                  // Always save ALL changes to DB (even non-notifiable)
                  Object.assign(existingOrder, orderData);
                  await existingOrder.save();
                  
                  // Only add to notification list if there are notifiable changes
                  if (notifiableChanges.length > 0) {
                    // Check if shipping address changed
                    const shippingFields = ['shippingFullName', 'shippingAddressLine1', 'shippingCity', 'shippingState', 'shippingPostalCode'];
                    const shippingChanged = notifiableChanges.some(f => shippingFields.includes(f));
                    
                    if (shippingChanged) {
                      console.log(`  🏠 SHIPPING ADDRESS CHANGED: ${ebayOrder.orderId}`);
                    }
                    
                    updatedOrders.push({
                      orderId: existingOrder.orderId,
                      changedFields: notifiableChanges
                    });
                    console.log(`  🔔 NOTIFY: ${ebayOrder.orderId} - ${notifiableChanges.join(', ')}`);
                  } else {
                    // Changes were made but not notifiable (e.g., buyerCheckoutNotes, dates, etc.)
                    console.log(`  ✅ UPDATED (silent): ${ebayOrder.orderId} - ${changedFields.join(', ')}`);
                  }
                }
              }

              // EARLY EXIT
              if (batchOrders.length < batchSize) {
                hasMore = false;
                console.log(`[${sellerName}] PHASE 2: Early exit`);
              } else {
                offset += batchSize;
              }
            } catch (phase2Err) {
              console.error(`[${sellerName}] PHASE 2 error:`, phase2Err.message);
              hasMore = false;
            }
          }
        }

        // ========== UPDATE SELLER METADATA ==========
        seller.lastPolledAt = new Date(nowUTC);
        await seller.save();
        console.log(`[${sellerName}] ✅ Complete: ${newOrders.length} new, ${updatedOrders.length} updated`);

        return {
          sellerId: seller._id,
          sellerName,
          success: true,
          newOrders: newOrders.map(o => o.orderId),
          updatedOrders, // Now contains { orderId, changedFields }
          totalNew: newOrders.length,
          totalUpdated: updatedOrders.length
        };

      } catch (sellerErr) {
        console.error(`[${sellerName}] ❌ Error:`, sellerErr.message);
        return {
          sellerId: seller._id,
          sellerName,
          success: false,
          error: sellerErr.message
        };
      }
    });

    // Wait for all sellers to complete (parallel execution)
    const results = await Promise.allSettled(pollingPromises);
    
    // Process results
    const pollResults = results.map(result => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          success: false,
          error: result.reason?.message || 'Unknown error'
        };
      }
    });

    const totalNewOrders = pollResults.reduce((sum, r) => sum + (r.totalNew || 0), 0);
    const totalUpdatedOrders = pollResults.reduce((sum, r) => sum + (r.totalUpdated || 0), 0);

    res.json({
      message: 'Polling complete',
      pollResults,
      totalPolled: sellers.length,
      totalNewOrders,
      totalUpdatedOrders
    });
    
    console.log('\n========== POLLING SUMMARY ==========');
    console.log(`Total sellers polled: ${sellers.length}`);
    console.log(`Total new orders: ${totalNewOrders}`);
    console.log(`Total updated orders: ${totalUpdatedOrders}`);

  } catch (err) {
    console.error('Error polling all sellers:', err);
    res.status(500).json({ error: err.message });
  }
});

// Poll all sellers for NEW ORDERS ONLY (Phase 1)
router.post('/poll-new-orders', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');
    
    if (sellers.length === 0) {
      return res.json({ 
        message: 'No sellers with connected eBay accounts found',
        pollResults: [],
        totalPolled: 0,
        totalNewOrders: 0
      });
    }

    const nowUTC = Date.now();
    console.log(`\n========== POLLING NEW ORDERS FOR ${sellers.length} SELLERS ==========`);
    console.log(`UTC Time: ${new Date(nowUTC).toISOString()}`);

    const pollingPromises = sellers.map(async (seller) => {
      const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();
      
      try {
        console.log(`\n[${sellerName}] Checking for new orders...`);
        
        // Token refresh
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[${sellerName}] Refreshing token...`);
          const refreshRes = await axios.post(
            'https://api.ebay.com/identity/v1/oauth2/token',
            qs.stringify({
              grant_type: 'refresh_token',
              refresh_token: seller.ebayTokens.refresh_token,
              scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment',
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
              },
            }
          );
          seller.ebayTokens.access_token = refreshRes.data.access_token;
          seller.ebayTokens.expires_in = refreshRes.data.expires_in;
          seller.ebayTokens.fetchedAt = new Date(nowUTC);
          await seller.save();
          accessToken = refreshRes.data.access_token;
        }

        const orderCount = await Order.countDocuments({ seller: seller._id });
        const latestOrder = await Order.findOne({ seller: seller._id }).sort({ creationDate: -1 });
        const latestCreationDate = latestOrder ? latestOrder.creationDate : null;
        const initialSyncDate = seller.initialSyncDate || new Date(Date.UTC(2025, 9, 17, 0, 0, 0, 0));
        const currentTimeUTC = new Date(nowUTC - 5000);

        const newOrders = [];
        let newOrdersFilter = null;
        let newOrdersLimit = 15;

        if (orderCount === 0) {
          newOrdersFilter = `creationdate:[${initialSyncDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
          newOrdersLimit = 200;
          console.log(`[${sellerName}] Initial sync from ${initialSyncDate.toISOString()}`);
        } else if (latestCreationDate) {
          const afterLatestMs = new Date(latestCreationDate).getTime() + 1000;
          const afterLatest = new Date(afterLatestMs);
          const timeDiffMinutes = (currentTimeUTC.getTime() - afterLatestMs) / (1000 * 60);
          
          if (timeDiffMinutes >= 1) {
            newOrdersFilter = `creationdate:[${afterLatest.toISOString()}..${currentTimeUTC.toISOString()}]`;
            newOrdersLimit = 200;
            console.log(`[${sellerName}] Checking new orders after ${afterLatest.toISOString()}`);
          } else {
            console.log(`[${sellerName}] Skipped (too recent: ${timeDiffMinutes.toFixed(2)} min)`);
          }
        }

        if (newOrdersFilter) {
          const newOrdersRes = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            params: { filter: newOrdersFilter, limit: newOrdersLimit }
          });

          const ebayNewOrders = newOrdersRes.data.orders || [];
          console.log(`[${sellerName}] Found ${ebayNewOrders.length} new orders`);

          for (const ebayOrder of ebayNewOrders) {
            const existingOrder = await Order.findOne({ orderId: ebayOrder.orderId });
            
            if (!existingOrder) {
              const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
              const newOrder = await Order.create(orderData);
              newOrders.push(newOrder);
              console.log(`  🆕 NEW: ${ebayOrder.orderId}`);
            }
          }
        }

        console.log(`[${sellerName}] ✅ Complete: ${newOrders.length} new orders`);

        return {
          sellerId: seller._id,
          sellerName,
          success: true,
          newOrders: newOrders.map(o => o.orderId),
          totalNew: newOrders.length
        };

      } catch (sellerErr) {
        console.error(`[${sellerName}] ❌ Error:`, sellerErr.message);
        return {
          sellerId: seller._id,
          sellerName,
          success: false,
          error: sellerErr.message
        };
      }
    });

    const results = await Promise.allSettled(pollingPromises);
    const pollResults = results.map(result => result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message || 'Unknown error' });
    const totalNewOrders = pollResults.reduce((sum, r) => sum + (r.totalNew || 0), 0);

    res.json({
      message: 'New orders polling complete',
      pollResults,
      totalPolled: sellers.length,
      totalNewOrders
    });
    
    console.log(`\n========== NEW ORDERS SUMMARY ==========`);
    console.log(`Total new orders: ${totalNewOrders}`);

  } catch (err) {
    console.error('Error polling new orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// Poll all sellers for ORDER UPDATES ONLY (Phase 2)
router.post('/poll-order-updates', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    // Helper function to normalize dates for comparison (ignore milliseconds/format)
    function normalizeDateForComparison(date) {
      if (!date) return null;
      if (date instanceof Date) {
        return Math.floor(date.getTime() / 1000); // Unix timestamp in seconds
      }
      if (typeof date === 'string') {
        return Math.floor(new Date(date).getTime() / 1000);
      }
      return null;
    }

    // Helper function to check if field actually changed
    function hasFieldChanged(oldValue, newValue, fieldName) {
      // Skip system fields
      const systemFields = ['_id', '__v', 'seller', 'updatedAt', 'createdAt'];
      if (systemFields.includes(fieldName)) return false;
      
      // Date fields - compare Unix timestamps (ignore milliseconds)
      const dateFields = ['creationDate', 'lastModifiedDate', 'dateSold', 'shipByDate', 'estimatedDelivery'];
      if (dateFields.includes(fieldName)) {
        const oldTime = normalizeDateForComparison(oldValue);
        const newTime = normalizeDateForComparison(newValue);
        return oldTime !== newTime;
      }
      
      // Null/undefined checks
      if (oldValue === null || oldValue === undefined) {
        return newValue !== null && newValue !== undefined;
      }
      
      // Objects/Arrays - deep comparison
      if (typeof newValue === 'object' && newValue !== null) {
        return JSON.stringify(oldValue) !== JSON.stringify(newValue);
      }
      
      // Primitives - direct comparison
      return oldValue !== newValue;
    }

    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true, $ne: null } })
      .populate('user', 'username email');
    
    if (sellers.length === 0) {
      return res.json({ 
        message: 'No sellers with connected eBay accounts found',
        pollResults: [],
        totalPolled: 0,
        totalUpdatedOrders: 0
      });
    }

    const nowUTC = Date.now();
    const thirtyDaysAgoMs = 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(nowUTC - thirtyDaysAgoMs);

    console.log(`\n========== POLLING ORDER UPDATES FOR ${sellers.length} SELLERS ==========`);
    console.log(`UTC Time: ${new Date(nowUTC).toISOString()}`);
    console.log(`Checking orders from: ${thirtyDaysAgo.toISOString()}`);

    const pollingPromises = sellers.map(async (seller) => {
      const sellerName = seller.user?.username || seller.user?.email || seller._id.toString();
      
      try {
        console.log(`\n[${sellerName}] Checking for order updates...`);
        
        // Token refresh
        const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
        const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
        let accessToken = seller.ebayTokens.access_token;

        if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
          console.log(`[${sellerName}] Refreshing token...`);
          const refreshRes = await axios.post(
            'https://api.ebay.com/identity/v1/oauth2/token',
            qs.stringify({
              grant_type: 'refresh_token',
              refresh_token: seller.ebayTokens.refresh_token,
              scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment',
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
              },
            }
          );
          seller.ebayTokens.access_token = refreshRes.data.access_token;
          seller.ebayTokens.expires_in = refreshRes.data.expires_in;
          seller.ebayTokens.fetchedAt = new Date(nowUTC);
          await seller.save();
          accessToken = refreshRes.data.access_token;
        }

        const lastPolledAt = seller.lastPolledAt || null;
        const currentTimeUTC = new Date(nowUTC - 5000);
        const updatedOrders = [];

        const recentOrders = await Order.find({
          seller: seller._id,
          creationDate: { $gte: thirtyDaysAgo }
        }).select('orderId lastModifiedDate creationDate');

        console.log(`[${sellerName}] ${recentOrders.length} orders < 30 days old`);

        if (recentOrders.length > 0) {
          const checkFromDate = lastPolledAt || thirtyDaysAgo;
          const modifiedFilter = `lastmodifieddate:[${checkFromDate.toISOString()}..${currentTimeUTC.toISOString()}]`;
          
          console.log(`[${sellerName}] Checking modifications since ${checkFromDate.toISOString()}`);

          let offset = 0;
          const batchSize = 100;
          let hasMore = true;
          const recentOrderIdSet = new Set(recentOrders.map(o => o.orderId));

          while (hasMore) {
            const phase2Res = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              params: {
                filter: modifiedFilter,
                limit: batchSize,
                offset: offset > 0 ? offset : undefined
              }
            });

            const batchOrders = phase2Res.data.orders || [];
            console.log(`[${sellerName}] Got ${batchOrders.length} orders at offset ${offset}`);

            const relevantOrders = batchOrders.filter(o => recentOrderIdSet.has(o.orderId));

            for (const ebayOrder of relevantOrders) {
              const existingOrder = await Order.findOne({ 
                orderId: ebayOrder.orderId,
                seller: seller._id 
              });

              if (existingOrder) {
                const ebayModTime = new Date(ebayOrder.lastModifiedDate).getTime();
                const dbModTime = new Date(existingOrder.lastModifiedDate).getTime();
                
                // OPTIMIZATION: Skip if not actually modified
                if (ebayModTime <= dbModTime) {
                  continue; // No changes, skip this order
                }
                
                // ONLY NOW fetch full order data (includes expensive tracking lookup)
                const orderData = await buildOrderData(ebayOrder, seller._id, accessToken);
                
                // Define fields that should trigger notifications
                const notifiableFields = [
                  'cancelState',
                  'orderPaymentStatus',
                  'refunds',
                  'orderFulfillmentStatus',
                  'trackingNumber',
                  'shippingFullName',
                  'shippingAddressLine1',
                  'shippingAddressLine2',
                  'shippingCity',
                  'shippingState',
                  'shippingPostalCode',
                  'shippingCountry'
                  // NOTE: buyerCheckoutNotes is NOT included - updates DB silently
                ];
                
                // Detect changed fields with smart comparison
                const changedFields = [];
                for (const key of Object.keys(orderData)) {
                  if (hasFieldChanged(existingOrder[key], orderData[key], key)) {
                    changedFields.push(key);
                  }
                }
                
                // Filter to only notifiable fields (exclude lastModifiedDate)
                const notifiableChanges = changedFields.filter(f => 
                  notifiableFields.includes(f) && f !== 'lastModifiedDate'
                );
                
                // Always save ALL changes to DB (even non-notifiable)
                Object.assign(existingOrder, orderData);
                await existingOrder.save();
                
                // Only add to notification list if there are notifiable changes
                if (notifiableChanges.length > 0) {
                  // Check if shipping address changed
                  const shippingFields = ['shippingFullName', 'shippingAddressLine1', 'shippingCity', 'shippingState', 'shippingPostalCode'];
                  const shippingChanged = notifiableChanges.some(f => shippingFields.includes(f));
                  
                  if (shippingChanged) {
                    console.log(`  🏠 SHIPPING ADDRESS CHANGED: ${ebayOrder.orderId}`);
                  }
                  
                  updatedOrders.push({
                    orderId: existingOrder.orderId,
                    changedFields: notifiableChanges
                  });
                  console.log(`  🔔 NOTIFY: ${ebayOrder.orderId} - ${notifiableChanges.join(', ')}`);
                } else {
                  // Changes were made but not notifiable (e.g., buyerCheckoutNotes, dates, etc.)
                  console.log(`  ✅ UPDATED (silent): ${ebayOrder.orderId} - ${changedFields.join(', ')}`);
                }
              }
            }

            if (batchOrders.length < batchSize) {
              hasMore = false;
            } else {
              offset += batchSize;
            }
          }
        }

        // Update lastPolledAt timestamp
        seller.lastPolledAt = new Date(nowUTC);
        await seller.save();
        
        console.log(`[${sellerName}] ✅ Complete: ${updatedOrders.length} updated`);

        return {
          sellerId: seller._id,
          sellerName,
          success: true,
          updatedOrders, // Now contains { orderId, changedFields }
          totalUpdated: updatedOrders.length
        };

      } catch (sellerErr) {
        console.error(`[${sellerName}] ❌ Error:`, sellerErr.message);
        return {
          sellerId: seller._id,
          sellerName,
          success: false,
          error: sellerErr.message
        };
      }
    });

    const results = await Promise.allSettled(pollingPromises);
    const pollResults = results.map(result => result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message || 'Unknown error' });
    const totalUpdatedOrders = pollResults.reduce((sum, r) => sum + (r.totalUpdated || 0), 0);

    res.json({
      message: 'Order updates polling complete',
      pollResults,
      totalPolled: sellers.length,
      totalUpdatedOrders
    });
    
    console.log(`\n========== ORDER UPDATES SUMMARY ==========`);
    console.log(`Total updated orders: ${totalUpdatedOrders}`);

  } catch (err) {
    console.error('Error polling order updates:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to build order data object for insert/update
async function buildOrderData(ebayOrder, sellerId, accessToken) {
  const lineItem = ebayOrder.lineItems?.[0] || {};
  const fulfillmentInstr = ebayOrder.fulfillmentStartInstructions?.[0] || {};
  const shipTo = fulfillmentInstr.shippingStep?.shipTo || {};
  const buyerAddr = `${shipTo.contactAddress?.addressLine1 || ''}, ${shipTo.contactAddress?.city || ''}, ${shipTo.contactAddress?.stateOrProvince || ''}, ${shipTo.contactAddress?.postalCode || ''}, ${shipTo.contactAddress?.countryCode || ''}`.trim();
  
  const trackingNumber = await extractTrackingNumber(ebayOrder.fulfillmentHrefs, accessToken);
  const purchaseMarketplaceId = lineItem.purchaseMarketplaceId || '';

  return {
    seller: sellerId,
    orderId: ebayOrder.orderId,
    legacyOrderId: ebayOrder.legacyOrderId,
    creationDate: ebayOrder.creationDate,
    lastModifiedDate: ebayOrder.lastModifiedDate,
    orderFulfillmentStatus: ebayOrder.orderFulfillmentStatus,
    orderPaymentStatus: ebayOrder.orderPaymentStatus,
    sellerId: ebayOrder.sellerId,
    buyer: ebayOrder.buyer,
    buyerCheckoutNotes: ebayOrder.buyerCheckoutNotes,
    pricingSummary: ebayOrder.pricingSummary,
    cancelStatus: ebayOrder.cancelStatus,
    paymentSummary: ebayOrder.paymentSummary,
    fulfillmentStartInstructions: ebayOrder.fulfillmentStartInstructions,
    lineItems: ebayOrder.lineItems,
    ebayCollectAndRemitTax: ebayOrder.ebayCollectAndRemitTax,
    salesRecordReference: ebayOrder.salesRecordReference,
    totalFeeBasisAmount: ebayOrder.totalFeeBasisAmount,
    totalMarketplaceFee: ebayOrder.totalMarketplaceFee,
    fulfillmentHrefs: ebayOrder.fulfillmentHrefs,
    // Denormalized fields
    dateSold: ebayOrder.creationDate,
    shipByDate: lineItem.lineItemFulfillmentInstructions?.shipByDate,
    estimatedDelivery: lineItem.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate,
    productName: lineItem.title,
    itemNumber: lineItem.legacyItemId,
    buyerAddress: buyerAddr,
    shippingFullName: shipTo.fullName || '',
    shippingAddressLine1: shipTo.contactAddress?.addressLine1 || '',
    shippingAddressLine2: shipTo.contactAddress?.addressLine2 || '',
    shippingCity: shipTo.contactAddress?.city || '',
    shippingState: shipTo.contactAddress?.stateOrProvince || '',
    shippingPostalCode: shipTo.contactAddress?.postalCode || '',
    shippingCountry: shipTo.contactAddress?.countryCode || '',
    shippingPhone: shipTo.primaryPhone?.phoneNumber || '0000000000',
    quantity: lineItem.quantity,
    subtotal: parseFloat(ebayOrder.pricingSummary?.priceSubtotal?.value || 0),
    salesTax: parseFloat(lineItem.ebayCollectAndRemitTaxes?.[0]?.amount?.value || 0),
    discount: parseFloat(ebayOrder.pricingSummary?.priceDiscount?.value || 0),
    shipping: parseFloat(ebayOrder.pricingSummary?.deliveryCost?.value || 0),
    transactionFees: parseFloat(ebayOrder.totalMarketplaceFee?.value || 0),
    adFee: parseFloat(lineItem.appliedPromotions?.[0]?.discountAmount?.value || 0),
    cancelState: ebayOrder.cancelStatus?.cancelState || 'NONE_REQUESTED',
    refunds: ebayOrder.paymentSummary?.refunds || [],
    trackingNumber,
    purchaseMarketplaceId
  };
}

// Update messaging status for an order
router.patch('/orders/:orderId/messaging-status', async (req, res) => {
  const { orderId } = req.params;
  const { messagingStatus } = req.body;

  if (!messagingStatus) {
    return res.status(400).json({ error: 'Missing messagingStatus value' });
  }

  // Validate enum values
  const validStatuses = ['Not Yet Started', 'Ongoing Conversation', 'Resolved'];
  if (!validStatuses.includes(messagingStatus)) {
    return res.status(400).json({ error: 'Invalid messagingStatus value' });
  }

  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { messagingStatus },
      { new: true }
    ).populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update item status for an order
router.patch('/orders/:orderId/item-status', async (req, res) => {
  const { orderId } = req.params;
  const { itemStatus, resolvedFrom } = req.body;

  if (!itemStatus) {
    return res.status(400).json({ error: 'Missing itemStatus value' });
  }

  // Validate enum values
  const validStatuses = ['None', 'Return', 'Replace', 'INR', 'Resolved'];
  if (!validStatuses.includes(itemStatus)) {
    return res.status(400).json({ error: 'Invalid itemStatus value' });
  }

  try {
    const updateData = { itemStatus };
    
    // If resolving, save the resolvedFrom field
    if (itemStatus === 'Resolved' && resolvedFrom) {
      updateData.resolvedFrom = resolvedFrom;
    }
    
    const order = await Order.findByIdAndUpdate(
      orderId,
      updateData,
      { new: true }
    ).populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update notes for an order
router.patch('/orders/:orderId/notes', async (req, res) => {
  const { orderId } = req.params;
  const { notes } = req.body;

  if (notes === undefined || notes === null) {
    return res.status(400).json({ error: 'Missing notes value' });
  }

  try {
    const order = await Order.findByIdAndUpdate(
      orderId,
      { notes: String(notes) },
      { new: true }
    ).populate({
      path: 'seller',
      populate: {
        path: 'user',
        select: 'username email'
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== RETURN REQUESTS ENDPOINTS =====

// Fetch return requests from eBay Post-Order API and store in DB

// Fetch return requests from eBay Post-Order API and store in DB
router.post('/fetch-returns', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true } })
      .populate('user', 'username');
    
    if (sellers.length === 0) {
      return res.json({ message: 'No sellers with eBay tokens found', totalReturns: 0 });
    }

    let totalNewReturns = 0;
    let totalUpdatedReturns = 0;
    const errors = [];

    console.log(`[Fetch Returns] Starting for ${sellers.length} sellers`);

    const results = await Promise.allSettled(
      sellers.map(async (seller) => {
        const sellerName = seller.user?.username || 'Unknown Seller';

        try {
          // Token refresh logic (Standard)
          const nowUTC = Date.now();
          const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
          const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
          let accessToken = seller.ebayTokens.access_token;

          if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
            console.log(`[Fetch Returns] Refreshing token for seller ${sellerName}`);
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment'
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            accessToken = refreshRes.data.access_token;
            seller.ebayTokens.access_token = accessToken;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
          }

          // Fetch return requests
          const returnUrl = 'https://api.ebay.com/post-order/v2/return/search';
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          
          const returnRes = await axios.get(returnUrl, {
            headers: {
              'Authorization': `IAF ${accessToken}`,
              'Content-Type': 'application/json',
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
            },
            params: {
              'creation_date_range_from': thirtyDaysAgo,
              'limit': 200
            }
          });

          const returns = returnRes.data.members || [];
          console.log(`[Fetch Returns] Seller ${sellerName}: Found ${returns.length} returns`);

          let newReturns = 0;
          let updatedReturns = 0;

          for (const ebayReturn of returns) {
            // 1. Safe Extraction
            const creationInfo = ebayReturn.creationInfo || {};
            const itemInfo = creationInfo.item || {};
            const sellerRefund = ebayReturn.sellerTotalRefund?.estimatedRefundAmount || {};

            // 2. Build Data Object (CASTING TO MATCH SCHEMA)
            const returnData = {
              seller: seller._id,
              returnId: ebayReturn.returnId,
              orderId: ebayReturn.orderId || ebayReturn.orderNumber,
              legacyOrderId: ebayReturn.legacyOrderId,
              buyerUsername: ebayReturn.buyerLoginName,
              returnReason: creationInfo.reason,
              returnStatus: ebayReturn.state || ebayReturn.status,
              returnType: creationInfo.type,
              itemId: itemInfo.itemId,
              itemTitle: itemInfo.title || itemInfo.itemId,
              returnQuantity: itemInfo.returnQuantity,
              refundAmount: {
                // FIX 1: Force String to match Mongoose Schema "String"
                value: String(sellerRefund.value || 0), 
                currency: sellerRefund.currency
              },
              creationDate: creationInfo.creationDate?.value ? new Date(creationInfo.creationDate.value) : null,
              responseDate: ebayReturn.sellerResponseDue?.respondByDate?.value ? new Date(ebayReturn.sellerResponseDue.respondByDate.value) : null,
              rmaNumber: ebayReturn.RMANumber,
              buyerComments: creationInfo.comments?.content,
              rawData: ebayReturn
            };

            const existing = await Return.findOne({ returnId: ebayReturn.returnId });
            
            if (existing) {
              // --- HELPER FUNCTIONS FOR COMPARISON ---
              // Convert to seconds (ignore milliseconds)
              const getUnix = (d) => d ? Math.floor(new Date(d).getTime() / 1000) : 0;
              // Convert to string to handle "63.95" vs 63.95 mismatch
              const safeStr = (v) => (v === undefined || v === null) ? '' : String(v);

              // --- COMPARISON LOGIC ---
              const statusChanged = existing.returnStatus !== returnData.returnStatus;
              
              // FIX 2: Compare as Strings
              const refundChanged = safeStr(existing.refundAmount?.value) !== safeStr(returnData.refundAmount?.value);
              
              // FIX 3: Compare as Unix Timestamps (seconds)
              const responseDateChanged = getUnix(existing.responseDate) !== getUnix(returnData.responseDate);
              const creationDateChanged = getUnix(existing.creationDate) !== getUnix(returnData.creationDate);

              if (statusChanged || refundChanged || responseDateChanged || creationDateChanged) {
                 
                 // DIAGNOSTIC LOG: This will show you exactly what changed in your terminal
                 console.log(`[Update Triggered] Return ${ebayReturn.returnId}:`);
                 if (statusChanged) console.log(`   - Status: ${existing.returnStatus} -> ${returnData.returnStatus}`);
                 if (refundChanged) console.log(`   - Refund: ${existing.refundAmount?.value} -> ${returnData.refundAmount?.value}`);
                 if (responseDateChanged) console.log(`   - RespDate: ${existing.responseDate} -> ${returnData.responseDate}`);
                 if (creationDateChanged) console.log(`   - CreateDate: ${existing.creationDate} -> ${returnData.creationDate}`);

                 // Use .set() to update fields
                 existing.set(returnData);
                 await existing.save();
                 updatedReturns++;
              } 
            } else {
              await Return.create(returnData);
              newReturns++;
            }
          }

          return {
            sellerName: sellerName,
            newReturns,
            updatedReturns,
            totalReturns: returns.length
          };

        } catch (err) {
          console.error(`[Fetch Returns] Error for seller ${sellerName}:`, err.message);
          throw new Error(`${sellerName}: ${err.message}`);
        }
      })
    );

    const successResults = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        successResults.push(result.value);
        totalNewReturns += result.value.newReturns;
        totalUpdatedReturns += result.value.updatedReturns;
      } else {
        errors.push(result.reason.message);
      }
    });

    res.json({
      message: `Fetched returns for ${successResults.length} sellers`,
      totalNewReturns,
      totalUpdatedReturns,
      results: successResults,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('[Fetch Returns] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
// Get stored returns from database

router.get('/stored-returns', async (req, res) => {
  const { sellerId, status, limit = 100 } = req.query;
  
  try {
    let query = {};
    if (sellerId) query.seller = sellerId;
    if (status) query.returnStatus = status;

    const returns = await Return.find(query)
      .populate({
        path: 'seller',
        select: 'user', // Select the 'user' field from Seller.js
        populate: {
          path: 'user', // Follow the link to User.js
          select: 'username' // Get the 'username' from User.js
        }
      })
      .sort({ creationDate: -1 })
      .limit(parseInt(limit));

    res.json({ returns, totalReturns: returns.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== BUYER MESSAGES ENDPOINTS =====

// Fetch buyer messages/inquiries from eBay Post-Order API and store in DB
// Fetch buyer messages/inquiries from eBay Post-Order API and store in DB
router.post('/fetch-messages', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  try {
    const sellers = await Seller.find({ 'ebayTokens.access_token': { $exists: true } })
      .populate('user', 'username');
    
    if (sellers.length === 0) {
      return res.json({ message: 'No sellers with eBay tokens found', totalMessages: 0 });
    }

    let totalNewMessages = 0;
    let totalUpdatedMessages = 0;
    const errors = [];

    console.log(`[Fetch Messages] Starting for ${sellers.length} sellers`);

    const results = await Promise.allSettled(
      sellers.map(async (seller) => {
        const sellerName = seller.user?.username || 'Unknown Seller';

        try {
          // Token refresh logic
          const nowUTC = Date.now();
          const fetchedAt = seller.ebayTokens.fetchedAt ? new Date(seller.ebayTokens.fetchedAt).getTime() : 0;
          const expiresInMs = (seller.ebayTokens.expires_in || 0) * 1000;
          let accessToken = seller.ebayTokens.access_token;

          if (fetchedAt && (nowUTC - fetchedAt > expiresInMs - 2 * 60 * 1000)) {
            console.log(`[Fetch Messages] Refreshing token for seller ${sellerName}`);
            const refreshRes = await axios.post(
              'https://api.ebay.com/identity/v1/oauth2/token',
              qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: seller.ebayTokens.refresh_token,
                scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment'
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: 'Basic ' + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64'),
                },
              }
            );
            accessToken = refreshRes.data.access_token;
            seller.ebayTokens.access_token = accessToken;
            seller.ebayTokens.expires_in = refreshRes.data.expires_in;
            seller.ebayTokens.fetchedAt = new Date(nowUTC);
            await seller.save();
          }

          // Fetch inquiries
          const inquiryUrl = 'https://api.ebay.com/post-order/v2/inquiry/search';
          const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          
          const inquiryRes = await axios.get(inquiryUrl, {
            headers: {
              'Authorization': `IAF ${accessToken}`,
              'Content-Type': 'application/json',
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
            },
            params: {
              'creation_date_range_from': ninetyDaysAgo,
              'limit': 200
            }
          });

          const inquiries = inquiryRes.data.members || [];
          console.log(`[Fetch Messages] Seller ${sellerName}: Found ${inquiries.length} inquiries`);

          let newMessages = 0;
          let updatedMessages = 0;

          for (const inquiry of inquiries) {
            // FIX: Access nested .value for dates and use correct field names
            const messageData = {
              seller: seller._id,
              messageId: inquiry.inquiryId,
              orderId: inquiry.orderId || inquiry.orderNumber,
              legacyOrderId: inquiry.legacyOrderId,
              buyerUsername: inquiry.buyerLoginName, // Fixed field name
              subject: inquiry.inquirySubject,
              messageText: inquiry.initialInquiryText || inquiry.message, // Check both
              messageType: 'INQUIRY',
              inquiryStatus: inquiry.state || inquiry.status, // API uses 'state' usually
              itemId: inquiry.itemId,
              itemTitle: inquiry.itemTitle, 
              isResolved: ['CLOSED', 'SELLER_CLOSED'].includes(inquiry.state),
              // FIX: Dates are objects { value: "..." }
              creationDate: inquiry.creationDate?.value ? new Date(inquiry.creationDate.value) : null,
              responseDate: inquiry.sellerResponseDue?.respondByDate?.value ? new Date(inquiry.sellerResponseDue.respondByDate.value) : null,
              lastMessageDate: inquiry.lastMessageDate?.value ? new Date(inquiry.lastMessageDate.value) : null,
              rawData: inquiry
            };

            const existing = await Message.findOne({ messageId: inquiry.inquiryId });
            if (existing) {
              Object.assign(existing, messageData);
              await existing.save();
              updatedMessages++;
            } else {
              await Message.create(messageData);
              newMessages++;
            }
          }

          return {
            sellerName: sellerName,
            newMessages,
            updatedMessages,
            totalMessages: inquiries.length
          };

        } catch (err) {
          console.error(`[Fetch Messages] Error for seller ${sellerName}:`, err.message);
          throw new Error(`${sellerName}: ${err.message}`);
        }
      })
    );

    const successResults = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        successResults.push(result.value);
        totalNewMessages += result.value.newMessages;
        totalUpdatedMessages += result.value.updatedMessages;
      } else {
        errors.push(result.reason.message);
      }
    });

    res.json({
      message: `Fetched messages for ${successResults.length} sellers`,
      totalNewMessages,
      totalUpdatedMessages,
      results: successResults,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('[Fetch Messages] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get stored messages from database
router.get('/stored-messages', async (req, res) => {
  const { sellerId, isResolved, limit = 100 } = req.query;
  
  try {
    let query = {};
    if (sellerId) {
      query.seller = sellerId;
    }
    if (isResolved !== undefined && isResolved !== '') {
      query.isResolved = isResolved === 'true';
    }

    const messages = await Message.find(query)
      .populate('seller', 'username ebayUserId')
      .sort({ creationDate: -1 })
      .limit(parseInt(limit));

    res.json({ 
      messages,
      totalMessages: messages.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark message as resolved
router.patch('/messages/:messageId/resolve', requireAuth, requireRole('fulfillmentadmin', 'superadmin'), async (req, res) => {
  const { messageId } = req.params;
  const { isResolved } = req.body;

  if (isResolved === undefined || isResolved === null) {
    return res.status(400).json({ error: 'isResolved field is required' });
  }

  try {
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    message.isResolved = isResolved;
    if (isResolved) {
      message.resolvedAt = new Date();
      message.resolvedBy = req.user?.username || 'admin';
    } else {
      message.resolvedAt = null;
      message.resolvedBy = null;
    }
    
    await message.save();

    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

